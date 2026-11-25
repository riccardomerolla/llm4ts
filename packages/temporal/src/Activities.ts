import { isAbsolute, join } from "node:path"
import { ApplicationFailure, Context } from "@temporalio/activity"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { RetryStory, SkipStory, makeControlInbox } from "@llm4ts/flow/Control"
import { isSettingName, settingFacts, settingValue } from "@llm4ts/flow/Settings"
import {
  FlowRunFailure,
  FlowRunInput,
  SteerInput,
  type FlowRunResult,
  type SteerResult
} from "./Contract.ts"
import { readRunEnd, type FlowHost } from "./FlowHost.ts"
import { classifyEnding, dropListWith, isRetryable, runIdFor, type Verdict } from "./Policy.ts"

/**
 * The activities of the integration (ADR 0060). `runFlow` runs one
 * `llm4ts run` as a child process and reports how it really ended;
 * `steerRun` writes one command to a live epic's control inbox.
 *
 * The programs are Effects over a `FlowHost`; `makeFlowActivities` is the
 * only place that touches Temporal's promise API.
 */

export interface FlowActivityTimings {
  /** Between heartbeats; default 2 s. Must stay well under the heartbeat timeout. */
  readonly heartbeatMs?: number
  /** Between looks at a run this attempt did not start; default 500 ms. */
  readonly pollMs?: number
  /** How long a stopped run gets after the interrupt before it is killed; default 15 s. */
  readonly graceMs?: number
}

/** What a `runFlow` attempt knows about itself. */
export interface AttemptScope {
  readonly workflowId: string
  readonly activityId: string
  /** 1 for the first attempt. */
  readonly attempt: number
  /** Tells Temporal the attempt is alive; this is also how a cancellation arrives. */
  readonly heartbeat: Effect.Effect<void>
}

const failure = (type: FlowRunFailure["type"], message: string, runId?: string): FlowRunFailure =>
  FlowRunFailure.make({
    type,
    retryable: isRetryable(type),
    message,
    ...(runId === undefined ? {} : { runId })
  })

const invalid = (message: string): FlowRunFailure => failure("InvalidRequest", message)

/** The names a caller may not set: the run's identity is the activity's to give. */
const reserved = new Set(["LLM4TS_RUN_ID", "LLM4TS_TRACE_PATH", "LLM4TS_FLOW"])

const checkSettings = (
  settings: Readonly<Record<string, string>>
): Effect.Effect<void, FlowRunFailure> => {
  for (const name of Object.keys(settings)) {
    if (!isSettingName(name)) {
      return Effect.fail(invalid(`'${name}' is not an llm4ts setting`))
    }
    if (reserved.has(name)) {
      return Effect.fail(invalid(`${name} is set by the activity`))
    }
    if (settingFacts(name).scope === "secret") {
      // Workflow history is stored in plain text.
      return Effect.fail(
        invalid(`${name} is a secret: set it in the worker's environment, not in the workflow`)
      )
    }
  }
  return Effect.void
}

/** A run's trace, named after its id so a later attempt finds it without being told. */
export const tracePathFor = (repo: string, runId: string): string =>
  join(repo, ".llm4ts", `trace-${runId}.jsonl`)

const decodeRun = Schema.decodeUnknownEffect(FlowRunInput)
const decodeSteer = Schema.decodeUnknownEffect(SteerInput)

const persistence = (error: { readonly message: string }): FlowRunFailure =>
  failure("LaunchFailed", error.message)

/**
 * Runs one flow. Before starting anything it looks for the runs earlier
 * attempts of this activity started: one that completed is the result, and
 * one that is still alive is waited for, not doubled. Interrupting the
 * program stops the run it started or waits for, and returns only once that
 * run and the processes below it are gone.
 */
export const runFlowProgram = (
  host: FlowHost,
  scope: AttemptScope,
  raw: unknown,
  timings: FlowActivityTimings = {}
): Effect.Effect<FlowRunResult, FlowRunFailure> => {
  const heartbeatMs = timings.heartbeatMs ?? 2_000
  const pollMs = timings.pollMs ?? 500
  const graceMs = timings.graceMs ?? 15_000

  const program = Effect.gen(function* () {
    const input = yield* decodeRun(raw).pipe(
      Effect.mapError((error) => invalid(`the run request does not decode: ${error.message}`))
    )
    if (!isAbsolute(input.repo)) {
      return yield* invalid(`repo must be an absolute path, got '${input.repo}'`)
    }
    const settings = input.settings ?? {}
    yield* checkSettings(settings)

    const idOf = (attempt: number): string => runIdFor(scope.workflowId, scope.activityId, attempt)
    const result = (runId: string, adopted: boolean): FlowRunResult => ({
      runId,
      tracePath: tracePathFor(input.repo, runId),
      outcome: "completed",
      attempt: scope.attempt,
      adopted
    })
    const endOf = (runId: string) =>
      readRunEnd(host.files, tracePathFor(input.repo, runId)).pipe(Effect.mapError(persistence))
    const holder = host.holder(input.repo).pipe(Effect.mapError(persistence))
    const settle = (runId: string, verdict: Verdict, adopted: boolean) =>
      verdict._tag === "Completed"
        ? Effect.succeed(result(runId, adopted))
        : Effect.fail(failure(verdict.type, verdict.message, runId))

    // Ends a run and what it started, and waits until the checkout is free of it.
    const stop = (runId: string, pid: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* host.interrupt(pid)
        for (let waited = 0; waited < graceMs && host.isAlive(pid); waited += pollMs) {
          yield* Effect.sleep(pollMs)
        }
        const held = yield* host.holder(input.repo).pipe(Effect.orElseSucceed(() => undefined))
        const groups = held?.holder.runId === runId ? held.groups : []
        yield* host.killGroup(pid)
        for (const group of groups) yield* host.killGroup(group)
        for (let waited = 0; waited < graceMs; waited += pollMs) {
          const still = yield* host.holder(input.repo).pipe(Effect.orElseSucceed(() => undefined))
          if (!host.isAlive(pid) && still?.holder.runId !== runId) return
          yield* Effect.sleep(pollMs)
        }
      })

    const earlier = Array.from({ length: scope.attempt - 1 }, (_, index) =>
      idOf(scope.attempt - 1 - index)
    )
    for (const runId of earlier) {
      const ended = yield* endOf(runId)
      if (ended?.outcome === "completed") return result(runId, true)
    }

    const held = yield* holder
    if (held !== undefined) {
      const runId = held.holder.runId
      if (!earlier.includes(runId)) {
        return yield* failure(
          "CheckoutBusy",
          `${input.repo} is being written by run ${runId}; nothing was started`,
          runId
        )
      }
      // An earlier attempt's run outlived its worker: wait for it.
      const pid = held.holder.pid
      yield* Effect.gen(function* () {
        for (;;) {
          const now = yield* holder
          if (now?.holder.runId !== runId) return
          yield* Effect.sleep(pollMs)
        }
      }).pipe(Effect.onInterrupt(() => stop(runId, pid)))
      const left = yield* endOf(runId)
      const verdict = classifyEnding({
        ...(left === undefined ? {} : { ended: left }),
        busy: false
      })
      if (verdict._tag === "Completed" || !isRetryable(verdict.type)) {
        return yield* settle(runId, verdict, true)
      }
      // It was cut off: this attempt resumes from the files it left.
    }

    const runId = idOf(scope.attempt)
    const child = yield* host
      .start({
        args: [
          "run",
          ...(input.runFlags ?? []),
          input.flow,
          ...(input.args.length === 0 ? [] : ["--", ...input.args])
        ],
        cwd: input.repo,
        environment: {
          ...host.environment,
          ...settings,
          LLM4TS_RUN_ID: runId,
          LLM4TS_TRACE_PATH: tracePathFor(input.repo, runId),
          // The worker's Temporal credentials stop at the flow (ADR 0059).
          LLM4TS_CHILD_ENV_DROP: dropListWith(
            settingValue("LLM4TS_CHILD_ENV_DROP", { ...host.environment, ...settings })
          )
        }
      })
      .pipe(Effect.mapError((error) => failure("LaunchFailed", error.message, runId)))
    const exit = yield* child.exited.pipe(
      Effect.onInterrupt(() => Effect.andThen(stop(runId, child.pid), child.exited))
    )
    const ended = yield* endOf(runId)
    const busy = ended === undefined && (yield* holder) !== undefined
    return yield* settle(
      runId,
      classifyEnding({
        ...(exit.code === undefined ? {} : { exitCode: exit.code }),
        ...(ended === undefined ? {} : { ended }),
        busy
      }),
      false
    )
  })

  const beats = Effect.forever(Effect.andThen(scope.heartbeat, Effect.sleep(heartbeatMs)))
  return Effect.raceFirst(program, beats)
}

/**
 * Writes one command to an epic's control inbox. The command's id comes
 * from the workflow, so an attempt that is retried after its write landed
 * finds the command and writes nothing.
 */
export const steerProgram = (
  host: FlowHost,
  raw: unknown
): Effect.Effect<SteerResult, FlowRunFailure> =>
  Effect.gen(function* () {
    const input = yield* decodeSteer(raw).pipe(
      Effect.mapError((error) => invalid(`the command does not decode: ${error.message}`))
    )
    if (!isAbsolute(input.repo)) {
      return yield* invalid(`repo must be an absolute path, got '${input.repo}'`)
    }
    if (!/^[A-Za-z0-9._-]+$/.test(input.epic)) {
      return yield* invalid(`'${input.epic}' is not an epic's state folder name`)
    }
    if (input.action === "skip" && (input.reason ?? "").trim().length === 0) {
      return yield* invalid("a skip needs a reason")
    }
    const inbox = makeControlInbox({ files: host.files, root: host.controlRoot(input.repo) })
    const known = (yield* inbox.log(input.epic).pipe(Effect.mapError(persistence))).commands.some(
      (command) => command.id === input.id
    )
    if (known) return { id: input.id, written: false }
    yield* inbox
      .submit(input.epic, {
        id: input.id,
        by: input.by,
        command:
          input.action === "retry"
            ? RetryStory.make({ story: input.story })
            : SkipStory.make({ story: input.story, reason: input.reason ?? "" })
      })
      .pipe(Effect.mapError(persistence))
    return { id: input.id, written: true }
  })

/**
 * Runs a program as a Temporal activity. A typed failure becomes an
 * `ApplicationFailure` whose `type` the retry policy reads; a cancellation
 * interrupts the program, waits for its cleanup and is then rethrown as
 * Temporal's own cancellation.
 */
const asActivity = async <A>(program: Effect.Effect<A, FlowRunFailure>): Promise<A> => {
  const context = Context.current()
  try {
    const result = await Effect.runPromise(Effect.result(program), {
      signal: context.cancellationSignal
    })
    if (result._tag === "Success") return result.success
    const failed = result.failure
    throw ApplicationFailure.create({
      type: failed.type,
      nonRetryable: !failed.retryable,
      message: failed.message,
      details: failed.runId === undefined ? [] : [failed.runId]
    })
  } catch (error) {
    if (!(error instanceof ApplicationFailure) && context.cancellationSignal.aborted) {
      // Rejects with the CancelledFailure Temporal expects.
      await context.cancelled
    }
    throw error
  }
}

export interface FlowActivities {
  readonly runFlow: (input: FlowRunInput) => Promise<FlowRunResult>
  readonly steerRun: (input: SteerInput) => Promise<SteerResult>
}

/** The activities to register on a worker. */
export const makeFlowActivities = (
  host: FlowHost,
  timings: FlowActivityTimings = {}
): FlowActivities => ({
  runFlow: (input) => {
    const context = Context.current()
    const info = context.info
    return asActivity(
      runFlowProgram(
        host,
        {
          // A standalone activity has no workflow: its own id names its runs.
          workflowId: info.workflowExecution?.workflowId ?? "standalone",
          activityId: info.activityId,
          attempt: info.attempt,
          // Nothing rides on the heartbeat: every run is found by its derived id.
          heartbeat: Effect.sync(() => context.heartbeat())
        },
        input,
        timings
      )
    )
  },
  steerRun: (input) => asActivity(steerProgram(host, input))
})
