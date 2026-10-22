import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import { approveMarkdown } from "@llm4ts/flow/Approval"
import { PersistenceError } from "@llm4ts/flow/FlowError"
import {
  InvalidKnob,
  NotAllowed,
  OperatorRun,
  ReadFailed,
  RunInProgress,
  RunWaitResult,
  UnknownEpic,
  UnknownFlow,
  UnknownRepo,
  UnknownRun,
  type OperatorKnobs,
  type OperatorRunState
} from "@llm4ts/flow/OperatorSchemas"
import { retroApprovalOf, retroPaths } from "@llm4ts/flow/Retro"
import { emptyTree } from "@llm4ts/runner/AgentTree"
import {
  TraceUnreadable,
  foldTrace,
  meaningfulEventsAfter,
  runStatusOf,
  type TraceFold
} from "@llm4ts/runner/RunReaders"
import { FlowLaunchError } from "./FlowProcess.ts"
import { resolveRepo, type OperatorDeps } from "./OperatorTools.ts"
import {
  epicDirOf,
  epicOfRun,
  readEpicRunsStrict,
  readFailed,
  resolveRun,
  tracePending,
  type Repo
} from "./OperatorRuns.ts"

/**
 * The operator's `run_wait` and act tools (`llm4ts mcp`, ADR 0041): waiting on
 * a run without polling from the client, and starting, stopping, retro-ing and
 * approving through the run supervisor. `run_wait` only reads, so it has its
 * own toolkit the server registers beside the read tools; the act toolkit is
 * registered only when the configuration allows runs or approvals.
 */

const repoParam = Schema.optional(Schema.String)

// ---- run_wait -----------------------------------------------------------------------------

export const runWaitTool = Tool.make("run_wait", {
  description:
    "Wait for a run's next meaningful events after sinceSeq: returns as soon as one appears or the run is no longer running, else after timeoutSeconds (default 120, at most 300) with no events.",
  parameters: Schema.Struct({
    runId: Schema.String,
    sinceSeq: Schema.optional(Schema.Int),
    timeoutSeconds: Schema.optional(Schema.Int)
  }),
  success: RunWaitResult,
  failure: Schema.Union([UnknownRun, TraceUnreadable, ReadFailed])
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const waitToolkit = Toolkit.make(runWaitTool)

const pollInterval = "500 millis"
const defaultWaitSeconds = 120
const maxWaitSeconds = 300

const isActive = (state: OperatorRunState): boolean => state === "starting" || state === "running"

const emptyFold = (): TraceFold => ({ lines: [], state: emptyTree(), seq: 0 })

export const waitHandlers = (
  deps: OperatorDeps
): Toolkit.HandlersFrom<Toolkit.Tools<typeof waitToolkit>> =>
  waitToolkit.of({
    run_wait: ({ runId, sinceSeq, timeoutSeconds }) =>
      Effect.gen(function* () {
        const since = sinceSeq ?? 0
        const timeoutMs =
          Math.min(Math.max(0, timeoutSeconds ?? defaultWaitSeconds), maxWaitSeconds) * 1_000
        const run = yield* resolveRun(deps, runId)
        const epic = yield* epicOfRun(deps, run)
        const startedAt = yield* Clock.currentTimeMillis
        for (;;) {
          const fold = (yield* tracePending(deps.files, run))
            ? emptyFold()
            : yield* foldTrace(deps.files, run.tracePath, epic?.dir)
          // A supervised run's state is the supervisor's; a run found on disk ends with its trace.
          const state: OperatorRunState =
            run.supervised === undefined
              ? fold.lines.some((line) => line.kind === "RunEnded")
                ? "exited"
                : run.state
              : ((yield* deps.supervisor.get(runId))?.state ?? run.state)
          const events = meaningfulEventsAfter(fold.lines, since)
          const exited = !isActive(state)
          const elapsed = (yield* Clock.currentTimeMillis) - startedAt
          if (events.length > 0 || exited || elapsed >= timeoutMs) {
            const status = runStatusOf(fold, { ...run, state }, yield* deps.now)
            return RunWaitResult.make({
              events,
              seq: Math.max(fold.seq, since),
              ...(status.ended === undefined ? {} : { ended: status.ended }),
              exited,
              summary: status.summary
            })
          }
          yield* Effect.sleep(pollInterval)
        }
      })
  })

// ---- Act tools ----------------------------------------------------------------------------

export const StartedRun = Schema.Struct({
  runId: Schema.String,
  tracePath: Schema.optionalKey(Schema.String),
  pid: Schema.optionalKey(Schema.Int)
})

const startFailures = Schema.Union([
  NotAllowed,
  InvalidKnob,
  UnknownRepo,
  UnknownEpic,
  UnknownRun,
  UnknownFlow,
  ReadFailed,
  FlowLaunchError,
  RunInProgress,
  PersistenceError
])

const StartRunParams = Schema.Struct({
  repo: repoParam,
  flow: Schema.String,
  task: Schema.optional(Schema.String),
  epic: Schema.optional(Schema.String),
  pack: Schema.optional(Schema.String),
  executors: Schema.optional(Schema.Array(Schema.String)),
  coder: Schema.optional(Schema.String),
  judgeRounds: Schema.optional(Schema.Int),
  mergeRevisions: Schema.optional(Schema.Int),
  land: Schema.optional(Schema.String),
  flags: Schema.optional(Schema.Array(Schema.String)),
  requestId: Schema.optional(Schema.String)
})

export const startRunTool = Tool.make("start_run", {
  description:
    "Start a flow by name in the background with typed knobs; returns the run id at once. Repeating a call is safe only with the same requestId, which returns the run it already started; without one, every call starts a new run.",
  parameters: StartRunParams,
  success: StartedRun,
  failure: startFailures
}).annotate(Tool.Destructive, false)

export const stopRunTool = Tool.make("stop_run", {
  description:
    "Stop a run this server started: SIGINT, then SIGTERM after a grace period; returns its final record.",
  parameters: Schema.Struct({ runId: Schema.String }),
  success: OperatorRun,
  failure: Schema.Union([NotAllowed, UnknownRun])
}).annotate(Tool.Destructive, true)

export const retroStartTool = Tool.make("retro_start", {
  description:
    "Start epic-retro for an epic, optionally for one of its recorded runs; the retro report then waits for approve.",
  parameters: Schema.Struct({
    repo: repoParam,
    epic: Schema.String,
    run: Schema.optional(Schema.String)
  }),
  success: StartedRun,
  failure: startFailures
}).annotate(Tool.Destructive, false)

export const approveTool = Tool.make("approve", {
  description:
    "Approve a retro report: ticks its approval marker so the next epic run applies its fixes.",
  parameters: Schema.Struct({
    repo: repoParam,
    kind: Schema.Literals(["retro"]),
    epic: Schema.String,
    id: Schema.String
  }),
  success: Schema.Struct({ path: Schema.String, approved: Schema.Boolean }),
  failure: Schema.Union([
    NotAllowed,
    UnknownRepo,
    UnknownEpic,
    UnknownRun,
    ReadFailed,
    PersistenceError
  ])
}).annotate(Tool.Destructive, false)

export const actToolkit = Toolkit.make(startRunTool, stopRunTool, retroStartTool, approveTool)

const knobsOf = (params: typeof StartRunParams.Type): OperatorKnobs => ({
  ...(params.task === undefined ? {} : { task: params.task }),
  ...(params.epic === undefined ? {} : { epic: params.epic }),
  ...(params.pack === undefined ? {} : { pack: params.pack }),
  ...(params.executors === undefined ? {} : { executors: params.executors }),
  ...(params.coder === undefined ? {} : { coder: params.coder }),
  ...(params.judgeRounds === undefined ? {} : { judgeRounds: params.judgeRounds }),
  ...(params.mergeRevisions === undefined ? {} : { mergeRevisions: params.mergeRevisions }),
  ...(params.land === undefined ? {} : { land: params.land }),
  ...(params.flags === undefined ? {} : { flags: params.flags }),
  ...(params.requestId === undefined ? {} : { requestId: params.requestId })
})

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const packPattern = /^[\w.-]+(\/[\w.-]+)?$/u
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u

const flagPattern = /^--[a-z][a-z0-9-]*(=[A-Za-z0-9][A-Za-z0-9._/-]*)?$/u
const flagValuePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u
/**
 * Flags a client may never pass through `flags`, with or without `=value`.
 * `-C` already fails the shape pattern; it is named so a looser pattern
 * cannot reopen it.
 */
const reservedFlags: ReadonlyArray<string> = [
  // Points the flow at another directory (`FlowArgs.ts`).
  "--repo",
  // Alias of --repo in the flow argument parser.
  "-C",
  // Reads the prompt from any file on the server.
  "--prompt-file",
  // Typed knob: epic.
  "--epic",
  // Typed knob: land.
  "--land",
  // Typed knob: judgeRounds.
  "--judge-rounds",
  // Typed knob: mergeRevisions.
  "--merge-revisions",
  // Lets soap flows send mutating calls to a real ESB.
  "--allow-mutating",
  // Auto-confirms prompts a human is meant to answer.
  "--yes",
  // Selects which environment's credentials a flow uses.
  "--env",
  // A filesystem path in epic-design.
  "--target"
]

const reservedFlagOf = (entry: string): string | undefined =>
  reservedFlags.find((flag) => entry === flag || entry.startsWith(`${flag}=`))

/** Why a flags list is refused, or undefined when every entry has a safe shape. */
const flagsProblem = (flags: ReadonlyArray<string>): string | undefined => {
  let previousWasFlag = false
  for (const entry of flags) {
    const reserved = reservedFlagOf(entry)
    if (reserved !== undefined) return `${reserved} may not be passed through flags`
    const flag = flagPattern.exec(entry)
    if (flag !== null) {
      previousWasFlag = flag[1] === undefined
      continue
    }
    if (!previousWasFlag || !flagValuePattern.test(entry)) {
      return "every entry must be a --flag[=value] or a plain value right after a flag"
    }
    previousWasFlag = false
  }
  return undefined
}

const invalid = (knob: string, message: string): Effect.Effect<never, InvalidKnob> =>
  Effect.fail(InvalidKnob.make({ knob, message }))

/**
 * Every client value that reaches the flow's argv or environment, checked
 * before the supervisor sees it. Names stay names, never paths or flags:
 * `pack` is a kit or kit/pack name (no `.`/`..` segment), `epic`, `coder` and
 * executors are ids, `land` is a branch name. `task` is the flow's first
 * positional argument, so it may not start with `-` (it would parse as a
 * flag) or `@` (the flow parser reads `@<path>` as a prompt file on the
 * server). `flags` is an allowlist of shapes: `--flag[=value]`, or a plain
 * value right after a flag, never a reserved flag (`reservedFlags`).
 */
export const validateKnobs = (knobs: OperatorKnobs): Effect.Effect<OperatorKnobs, InvalidKnob> => {
  if (
    knobs.pack !== undefined &&
    (!packPattern.test(knobs.pack) ||
      knobs.pack.split("/").some((segment) => segment === "." || segment === ".."))
  ) {
    return invalid("pack", "pack must be a kit or kit/pack name, not a path")
  }
  if (knobs.epic !== undefined && !namePattern.test(knobs.epic)) {
    return invalid("epic", "epic must be an epic id")
  }
  if (knobs.coder !== undefined && !namePattern.test(knobs.coder)) {
    return invalid("coder", "coder must be an executor or connector id")
  }
  if (knobs.executors?.some((id) => !namePattern.test(id)) === true) {
    return invalid("executors", "every executor must be an executor id")
  }
  if (knobs.land !== undefined && !branchPattern.test(knobs.land)) {
    return invalid("land", "land must be a branch name")
  }
  const nonNegative = (value: number | undefined) =>
    value === undefined || (Number.isInteger(value) && value >= 0)
  if (!nonNegative(knobs.judgeRounds)) {
    return invalid("judgeRounds", "judgeRounds must be an integer of 0 or more")
  }
  if (!nonNegative(knobs.mergeRevisions)) {
    return invalid("mergeRevisions", "mergeRevisions must be an integer of 0 or more")
  }
  if (knobs.task !== undefined && (knobs.task.startsWith("-") || knobs.task.startsWith("@"))) {
    return invalid("task", "task must not start with '-' or '@'")
  }
  const problem = knobs.flags === undefined ? undefined : flagsProblem(knobs.flags)
  if (problem !== undefined) return invalid("flags", problem)
  return Effect.succeed(knobs)
}

/** A run or retro id names one file, never a path. */
const isPlainId = (id: string): boolean => /^[\w.-]+$/u.test(id) && id !== "." && id !== ".."

export const actHandlers = (
  deps: OperatorDeps
): Toolkit.HandlersFrom<Toolkit.Tools<typeof actToolkit>> => {
  const requireRun = deps.config.allowRun
    ? Effect.void
    : Effect.fail(NotAllowed.make({ message: "this server was not started with --allow-run" }))
  const requireApprove = deps.config.allowApprove
    ? Effect.void
    : Effect.fail(NotAllowed.make({ message: "this server was not started with --allow-approve" }))

  const startFlow = (repo: Repo, name: string, knobs: OperatorKnobs) =>
    Effect.gen(function* () {
      const flows = yield* deps.flows(repo.path).pipe(Effect.mapError(readFailed))
      const flow = flows.find((candidate) => candidate.name === name)
      if (flow === undefined) {
        return yield* UnknownFlow.make({
          message: `unknown flow '${name}' in ${repo.id}: list_flows names the flows it can start`
        })
      }
      const run = yield* deps.supervisor.start({
        repo,
        flow: { name: flow.name, path: flow.path },
        knobs,
        baseEnvironment: deps.environment
      })
      return {
        runId: run.runId,
        ...(run.tracePath === undefined ? {} : { tracePath: run.tracePath }),
        ...(run.pid === undefined ? {} : { pid: run.pid })
      }
    })

  return actToolkit.of({
    start_run: (params) =>
      Effect.gen(function* () {
        yield* requireRun
        const repo = yield* resolveRepo(deps.config, params.repo)
        const knobs = yield* validateKnobs(knobsOf(params))
        return yield* startFlow(repo, params.flow, knobs)
      }),

    stop_run: ({ runId }) => Effect.andThen(requireRun, deps.supervisor.stop(runId)),

    retro_start: ({ repo: repoId, epic, run }) =>
      Effect.gen(function* () {
        yield* requireRun
        const repo = yield* resolveRepo(deps.config, repoId)
        const dir = yield* epicDirOf(deps, repo, epic)
        if (run !== undefined) {
          const recorded = yield* readEpicRunsStrict(deps.files, dir)
          if (!recorded.some((entry) => entry.runId === run)) {
            return yield* UnknownRun.make({
              message: `epic '${epic}' has no recorded run '${run}'`
            })
          }
        }
        // The client's values, checked like start_run's; the --epic flag itself is ours.
        yield* validateKnobs({ epic, ...(run === undefined ? {} : { flags: ["--run", run] }) })
        return yield* startFlow(repo, "epic-retro", {
          flags: ["--epic", epic, ...(run === undefined ? [] : ["--run", run])]
        })
      }),

    approve: ({ repo: repoId, epic, id }) =>
      Effect.gen(function* () {
        yield* requireApprove
        const repo = yield* resolveRepo(deps.config, repoId)
        const dir = yield* epicDirOf(deps, repo, epic)
        const unknown = UnknownRun.make({ message: `no retro '${id}' for epic '${epic}'` })
        if (!isPlainId(id)) return yield* unknown
        const path = retroPaths(dir, id).report
        const markdown = yield* deps.files.read(path).pipe(Effect.mapError(readFailed))
        if (markdown === undefined) return yield* unknown
        const approved = approveMarkdown(markdown)
        if (approved !== markdown) yield* deps.files.writeAtomic(path, approved)
        return { path, approved: retroApprovalOf(approved).approved }
      })
  })
}
