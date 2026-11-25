import { assert, describe, it } from "@effect/vitest"
import { ApplicationFailure, CancelledFailure } from "@temporalio/common"
import { MockActivityEnvironment } from "@temporalio/testing"
import { DefaultLogger } from "@temporalio/worker"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import {
  makeFlowActivities,
  runFlowProgram,
  steerProgram,
  type AttemptScope
} from "@llm4ts/temporal/Activities"
import { makeFakeHost, tracePath, type FakeHost } from "./FakeHost.ts"

const timings = { heartbeatMs: 5, pollMs: 2, graceMs: 20 }
const input = { repo: "/repo", flow: "implement", args: ["Add multiply"] }

const scopeOf = (attempt: number, beats: { count: number } = { count: 0 }): AttemptScope => ({
  workflowId: "wf",
  activityId: "1",
  attempt,
  heartbeat: Effect.sync(() => {
    beats.count += 1
  })
})

const idOf = (attempt: number): string => `tw-wf-1-${attempt}`

/** Lets the forked program reach its next wait. */
const settle = Effect.sleep(15)

const run = (fake: FakeHost, attempt = 1, raw: unknown = input) =>
  runFlowProgram(fake.host, scopeOf(attempt), raw, timings)

describe("runFlowProgram", () => {
  it.live("runs the flow as `llm4ts run` with a derived run id and returns that run", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost({ PATH: "/bin", TEMPORAL_API_KEY: "k" })
      const fiber = yield* Effect.forkChild(
        run(fake, 1, {
          ...input,
          settings: { LLM4TS_CODER: "codex" }
        })
      )
      yield* settle
      const [request] = fake.started
      assert.deepStrictEqual(request?.args, ["run", "implement", "--", "Add multiply"])
      assert.strictEqual(request?.cwd, "/repo")
      assert.strictEqual(request?.environment.LLM4TS_RUN_ID, idOf(1))
      assert.strictEqual(request?.environment.LLM4TS_TRACE_PATH, tracePath("/repo", idOf(1)))
      assert.strictEqual(request?.environment.LLM4TS_CODER, "codex")
      assert.strictEqual(request?.environment.LLM4TS_CHILD_ENV_DROP, "TEMPORAL_*")
      yield* fake.writeEnd("/repo", idOf(1), "completed")
      yield* fake.finish(100)
      assert.deepStrictEqual(yield* Fiber.join(fiber), {
        runId: idOf(1),
        tracePath: tracePath("/repo", idOf(1)),
        outcome: "completed",
        attempt: 1,
        adopted: false
      })
    })
  )

  it.live("heartbeats while the run is alive", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost()
      const beats = { count: 0 }
      const fiber = yield* Effect.forkChild(
        runFlowProgram(fake.host, scopeOf(1, beats), input, timings)
      )
      yield* Effect.sleep(40)
      assert.isAtLeast(beats.count, 3)
      yield* fake.writeEnd("/repo", idOf(1), "completed")
      yield* fake.finish(100)
      yield* Fiber.join(fiber)
    })
  )

  it.live("does not trust exit 0: a run that never wrote its end was cut off", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost()
      const fiber = yield* Effect.forkChild(Effect.flip(run(fake)))
      yield* settle
      yield* fake.finish(100, { code: 0 })
      const error = yield* Fiber.join(fiber)
      assert.strictEqual(error.type, "RunCutOff")
      assert.isTrue(error.retryable)
    })
  )

  it.live("a red epic is a final failure that names its run", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost()
      const fiber = yield* Effect.forkChild(Effect.flip(run(fake)))
      yield* settle
      yield* fake.writeEnd("/repo", idOf(1), "failed", "EpicUnfinished")
      yield* fake.finish(100, { code: 1 })
      const error = yield* Fiber.join(fiber)
      assert.strictEqual(error.type, "FlowFailed")
      assert.isFalse(error.retryable)
      assert.strictEqual(error.runId, idOf(1))
    })
  )

  it.live("a task that is not started again ends the retries", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost()
      const fiber = yield* Effect.forkChild(Effect.flip(run(fake, 4)))
      yield* settle
      yield* fake.writeEnd("/repo", idOf(4), "failed", "TaskCutOff")
      yield* fake.finish(100, { code: 1 })
      const error = yield* Fiber.join(fiber)
      assert.strictEqual(error.type, "TaskCutOff")
      assert.isFalse(error.retryable)
    })
  )

  it.live("starts nothing on a checkout another run is writing", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost()
      fake.hold("run-of-someone-else", 7)
      const error = yield* Effect.flip(run(fake))
      assert.strictEqual(error.type, "CheckoutBusy")
      assert.isTrue(error.retryable)
      assert.deepStrictEqual(fake.started, [])
    })
  )

  it.live("returns the run an earlier attempt completed, without starting another", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost()
      yield* fake.writeEnd("/repo", idOf(1), "completed")
      const result = yield* run(fake, 2)
      assert.deepStrictEqual(result, {
        runId: idOf(1),
        tracePath: tracePath("/repo", idOf(1)),
        outcome: "completed",
        attempt: 2,
        adopted: true
      })
      assert.deepStrictEqual(fake.started, [])
    })
  )

  it.live("waits for an earlier attempt's run that outlived its worker, and reports that run", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost()
      fake.hold(idOf(1), 55)
      const fiber = yield* Effect.forkChild(run(fake, 2))
      yield* settle
      assert.deepStrictEqual(fake.started, [])
      yield* fake.writeEnd("/repo", idOf(1), "completed")
      yield* fake.finish(55)
      const result = yield* Fiber.join(fiber)
      assert.strictEqual(result.runId, idOf(1))
      assert.isTrue(result.adopted)
      assert.deepStrictEqual(fake.started, [])
    })
  )

  it.live("resumes with its own run when the earlier attempt's run was cut off", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost()
      fake.hold(idOf(1), 55)
      const fiber = yield* Effect.forkChild(run(fake, 2))
      yield* settle
      yield* fake.finish(55, { signal: "SIGKILL" })
      yield* settle
      assert.strictEqual(fake.started.length, 1)
      assert.strictEqual(fake.started[0]?.environment.LLM4TS_RUN_ID, idOf(2))
      yield* fake.writeEnd("/repo", idOf(2), "completed")
      yield* fake.finish(100)
      const result = yield* Fiber.join(fiber)
      assert.strictEqual(result.runId, idOf(2))
      assert.isFalse(result.adopted)
    })
  )

  it.live("an interruption stops the run and returns only once it is gone", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost()
      const fiber = yield* Effect.forkChild(run(fake))
      yield* settle
      yield* Fiber.interrupt(fiber)
      assert.deepStrictEqual(fake.signals, ["interrupt 100", "kill 100"])
      assert.isFalse(fake.host.isAlive(100))
    })
  )

  it.live("kills a run that ignores the interrupt, and the processes it started", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost()
      fake.onInterrupt = () => Effect.void
      const fiber = yield* Effect.forkChild(run(fake))
      yield* settle
      fake.hold(idOf(1), 100, [201, 202])
      yield* Fiber.interrupt(fiber)
      assert.deepStrictEqual(fake.signals, ["interrupt 100", "kill 100", "kill 201", "kill 202"])
      assert.isFalse(fake.host.isAlive(100))
    })
  )

  it.live("an interruption also stops an adopted run", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost()
      fake.hold(idOf(1), 55)
      const fiber = yield* Effect.forkChild(run(fake, 2))
      yield* settle
      yield* Fiber.interrupt(fiber)
      assert.strictEqual(fake.signals[0], "interrupt 55")
      assert.isFalse(fake.host.isAlive(55))
      assert.deepStrictEqual(fake.started, [])
    })
  )

  it.live("a drop list in the request adds to the worker's and never replaces it", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost({ PATH: "/bin", LLM4TS_CHILD_ENV_DROP: "AWS_*" })
      const fiber = yield* Effect.forkChild(
        run(fake, 1, { ...input, settings: { LLM4TS_CHILD_ENV_DROP: "GH_TOKEN" } })
      )
      yield* settle
      assert.strictEqual(
        fake.started[0]?.environment.LLM4TS_CHILD_ENV_DROP,
        "AWS_*,GH_TOKEN,TEMPORAL_*"
      )
      yield* fake.writeEnd("/repo", idOf(1), "completed")
      yield* fake.finish(100)
      yield* Fiber.join(fiber)
    })
  )

  it.live("a setting the worker lists is accepted from a workflow", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost()
      const fiber = yield* Effect.forkChild(
        runFlowProgram(
          fake.host,
          scopeOf(1),
          { ...input, settings: { LLM4TS_ROSTER: "none" } },
          { ...timings, acceptSettings: ["LLM4TS_ROSTER"] }
        )
      )
      yield* settle
      assert.strictEqual(fake.started[0]?.environment.LLM4TS_ROSTER, "none")
      yield* fake.writeEnd("/repo", idOf(1), "completed")
      yield* fake.finish(100)
      yield* Fiber.join(fiber)
    })
  )

  it.live("refuses a request that cannot run as written", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost()
      const refused = (raw: unknown) =>
        Effect.map(Effect.flip(run(fake, 1, raw)), (error) => [
          error.type,
          error.retryable,
          error.message
        ])
      assert.deepStrictEqual((yield* refused({ flow: "implement" })).slice(0, 2), [
        "InvalidRequest",
        false
      ])
      assert.match(
        String((yield* refused({ ...input, repo: "relative/repo" }))[2]),
        /absolute path/
      )
      assert.match(
        String((yield* refused({ ...input, settings: { PATH: "/x" } }))[2]),
        /'PATH' is not an llm4ts setting/
      )
      assert.match(
        String((yield* refused({ ...input, settings: { LLM4TS_RUN_ID: "mine" } }))[2]),
        /set by the activity/
      )
      assert.match(
        String((yield* refused({ ...input, settings: { LLM4TS_MCP_TOKEN: "t" } }))[2]),
        /is a secret/
      )
      for (const settings of [
        { LLM4TS_GATES: "sh -c id" },
        { LLM4TS_CODER_FLAGS: "x=y" },
        { LLM4TS_PACK: "/tmp/pack" },
        { LLM4TS_ROSTER: "/tmp/roster.json" },
        { LLM4TS_WORKTREE_ROOT: "/tmp" }
      ]) {
        assert.match(
          String((yield* refused({ ...input, settings }))[2]),
          /is not accepted from a workflow/
        )
      }
      assert.match(
        String((yield* refused({ ...input, settings: { LLM4TS_WRITER_LOCK: "off" } }))[2]),
        /set by the activity/
      )
      for (const flow of ["../flows/evil.ts", "--set", "/tmp/flow.js", ""]) {
        assert.match(String((yield* refused({ ...input, flow }))[2]), /is not a flow's name/)
      }
      assert.deepStrictEqual(fake.started, [])
      // The run flags left the contract: an unknown key does not become an argument.
      const fiber = yield* Effect.forkChild(
        run(fake, 1, { ...input, runFlags: ["--set", "LLM4TS_GATES=id"] })
      )
      yield* settle
      assert.deepStrictEqual(fake.started[0]?.args, ["run", "implement", "--", "Add multiply"])
      yield* fake.writeEnd("/repo", idOf(1), "completed")
      yield* fake.finish(100)
      yield* Fiber.join(fiber)
    })
  )
})

describe("steerProgram", () => {
  const retry = {
    repo: "/repo",
    epic: "calc-1",
    id: "tw-wf-steer-1",
    by: "temporal:wf",
    action: "retry",
    story: "add"
  }

  it.live("writes a command once, however often the activity is retried", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost()
      assert.deepStrictEqual(yield* steerProgram(fake.host, retry), { id: retry.id, written: true })
      assert.deepStrictEqual(yield* steerProgram(fake.host, retry), {
        id: retry.id,
        written: false
      })
      const log = (yield* fake.files)["/state/control/repo/calc-1.jsonl"] ?? ""
      const lines = log.trim().split("\n")
      assert.strictEqual(lines.length, 1)
      const written: unknown = JSON.parse(lines[0] ?? "")
      assert.deepInclude(written, { id: retry.id, by: "temporal:wf" })
      assert.deepInclude(written, { command: { _tag: "RetryStory", story: "add" } })
    })
  )

  it.live("refuses a skip without a reason and an epic that is not a folder name", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost()
      const skip = yield* Effect.flip(steerProgram(fake.host, { ...retry, action: "skip" }))
      assert.strictEqual(skip.type, "InvalidRequest")
      assert.match(skip.message, /needs a reason/)
      const escape = yield* Effect.flip(steerProgram(fake.host, { ...retry, epic: "../other" }))
      assert.match(escape.message, /not an epic's state folder name/)
      assert.deepStrictEqual(yield* fake.files, {})
    })
  )
})

describe("makeFlowActivities", () => {
  const environment = () =>
    new MockActivityEnvironment(
      { attempt: 1, activityId: "1", workflowExecution: { workflowId: "wf", runId: "r" } },
      // Temporal logs every failed activity at WARN; the failures here are the point.
      { logger: new DefaultLogger("ERROR") }
    )

  it.live("returns the run's result to Temporal", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost()
      const activities = makeFlowActivities(fake.host, timings)
      const pending = environment().run(activities.runFlow, input)
      yield* settle
      yield* fake.writeEnd("/repo", idOf(1), "completed")
      yield* fake.finish(100)
      const result = yield* Effect.promise(() => pending)
      assert.strictEqual(result.runId, idOf(1))
    })
  )

  it.live("turns a typed failure into an ApplicationFailure the retry policy can read", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost()
      const activities = makeFlowActivities(fake.host, timings)
      const pending = environment()
        .run(activities.runFlow, input)
        .then(
          () => undefined,
          (error: unknown) => error
        )
      yield* settle
      yield* fake.writeEnd("/repo", idOf(1), "failed", "EpicUnfinished")
      yield* fake.finish(100, { code: 1 })
      const error = yield* Effect.promise(() => pending)
      assert.instanceOf(error, ApplicationFailure)
      assert.strictEqual(error.type, "FlowFailed")
      assert.isTrue(error.nonRetryable)
      assert.deepStrictEqual(error.details, [idOf(1)])
    })
  )

  it.live("reports a cancellation to Temporal only after the run is stopped", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHost()
      const activities = makeFlowActivities(fake.host, timings)
      const mock = environment()
      const pending = mock.run(activities.runFlow, input).then(
        () => undefined,
        (error: unknown) => ({ error, aliveWhenReported: fake.host.isAlive(100) })
      )
      yield* settle
      mock.cancel()
      const reported = yield* Effect.promise(() => pending)
      assert.instanceOf(reported?.error, CancelledFailure)
      assert.isFalse(reported?.aliveWhenReported)
      assert.deepStrictEqual(fake.signals, ["interrupt 100", "kill 100"])
    })
  )
})
