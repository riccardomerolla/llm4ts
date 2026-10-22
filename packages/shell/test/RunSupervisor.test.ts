import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import {
  encodeOperatorRunLine,
  latestRuns,
  OperatorRun,
  RunInProgress
} from "@llm4ts/flow/OperatorSchemas"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { makeFakeFlowProcess } from "@llm4ts/shell/FlowProcess"
import {
  knobsToArgs,
  knobsToEnvironment,
  makeRunSupervisor,
  operatorStateDir
} from "@llm4ts/shell/RunSupervisor"
import type { StartRun, SupervisorRepo } from "@llm4ts/shell/RunSupervisor"

const environment = { HOME: "/home/op", XDG_STATE_HOME: "/state" }
const repo: SupervisorRepo = { id: "app", path: "/work/app" }
const registryPath = "/state/llm4ts/mcp/app/runs.jsonl"

const request = (flow: string, knobs: StartRun["knobs"] = {}): StartRun => ({
  repo,
  flow: { name: flow, path: `/flows/${flow}.ts` },
  knobs,
  baseEnvironment: { PATH: "/usr/bin" }
})

const setup = (initial: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const memory = yield* makeMemoryPlainFileStore(initial)
    const fake = yield* makeFakeFlowProcess()
    let suffix = 0xbeef
    const supervisor = yield* makeRunSupervisor({
      repos: [repo],
      environment,
      files: memory.store,
      process: fake.process,
      parallelRuns: 1,
      random: () => (suffix++).toString(16)
    })
    const registry = memory.files.pipe(
      Effect.map((files) => latestRuns((files[registryPath] ?? "").split("\n")))
    )
    return { memory, fake, supervisor, registry }
  })

describe("operatorStateDir", () => {
  it("uses XDG_STATE_HOME, falling back to ~/.local/state when empty", () => {
    assert.strictEqual(operatorStateDir(environment, "app"), "/state/llm4ts/mcp/app")
    assert.strictEqual(
      operatorStateDir({ HOME: "/home/op", XDG_STATE_HOME: "" }, "app"),
      "/home/op/.local/state/llm4ts/mcp/app"
    )
  })
})

describe("knobs", () => {
  it("map to argv and environment", () => {
    const knobs = {
      task: "t",
      epic: "E1",
      land: "feat/x",
      judgeRounds: 2,
      mergeRevisions: 3,
      flags: ["--refine"],
      executors: ["a", "b"],
      pack: "p",
      coder: "codex",
      requestId: "r"
    }
    assert.deepStrictEqual(knobsToArgs("epic-stories", knobs), [
      "t",
      "--epic",
      "E1",
      "--land=feat/x",
      "--judge-rounds",
      "2",
      "--merge-revisions",
      "3",
      "--refine"
    ])
    assert.deepStrictEqual(knobsToEnvironment(knobs), {
      LLM4TS_EXECUTORS: "a,b",
      LLM4TS_PACK: "p",
      LLM4TS_CODER: "codex"
    })
  })
})

describe("RunSupervisor", () => {
  it.effect(
    "start spawns the flow with the run id, trace path and knob variables and records running",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { fake, supervisor, registry } = yield* setup()
          const run = yield* supervisor.start(
            request("implement", {
              task: "bump deps",
              judgeRounds: 1,
              executors: ["claude", "codex"]
            })
          )
          const [started] = yield* fake.started
          assert.isDefined(started)
          if (started === undefined) return
          assert.strictEqual(run.runId, `op-${run.startedAt}-beef`)
          assert.strictEqual(started.environment.LLM4TS_RUN_ID, run.runId)
          assert.isTrue(
            (started.environment.LLM4TS_TRACE_PATH ?? "").endsWith(
              `/.llm4ts/trace-${run.startedAt}.jsonl`
            )
          )
          assert.strictEqual(started.environment.LLM4TS_EXECUTORS, "claude,codex")
          assert.strictEqual(started.environment.LLM4TS_FLOW, "implement")
          assert.strictEqual(started.environment.PATH, "/usr/bin")
          assert.deepStrictEqual(started.args, ["bump deps", "--judge-rounds", "1"])
          assert.strictEqual(started.cwd, "/work/app")
          assert.deepStrictEqual(started.stdio, {
            stdout: `/state/llm4ts/mcp/app/runs/${run.runId}/stdout.log`,
            stderr: `/state/llm4ts/mcp/app/runs/${run.runId}/stderr.log`
          })
          const [latest] = yield* registry
          assert.strictEqual(latest?.state, "running")
          assert.strictEqual(latest?.pid, run.pid)
          assert.isDefined(run.pid)
          assert.deepStrictEqual(yield* supervisor.get(run.runId), latest)
          yield* fake.exit(run.pid ?? 0, { code: 0, signal: undefined })
        })
      )
  )

  it.effect("a repeated requestId returns the same run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake, supervisor } = yield* setup()
        const first = yield* supervisor.start(request("implement", { requestId: "req-1" }))
        const second = yield* supervisor.start(request("implement", { requestId: "req-1" }))
        assert.strictEqual(second.runId, first.runId)
        assert.strictEqual((yield* fake.started).length, 1)
        yield* fake.exit(first.pid ?? 0, { code: 0, signal: undefined })
      })
    )
  )

  it.effect("a second run on a busy repo is refused unless the flow is read-only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake, supervisor } = yield* setup()
        const first = yield* supervisor.start(request("implement"))
        const refused = yield* supervisor.start(request("implement")).pipe(Effect.flip)
        assert.instanceOf(refused, RunInProgress)
        if (refused instanceof RunInProgress) {
          assert.strictEqual(refused.runId, first.runId)
        }
        const retro = yield* supervisor.start(request("epic-retro"))
        assert.strictEqual(retro.state, "running")
        assert.strictEqual((yield* supervisor.list("app")).length, 2)
        yield* fake.exit(first.pid ?? 0, { code: 0, signal: undefined })
        yield* fake.exit(retro.pid ?? 0, { code: 0, signal: undefined })
      })
    )
  )

  it.effect("stop sends SIGINT, then SIGTERM after the grace period", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake, supervisor, registry } = yield* setup()
        const run = yield* supervisor.start(request("implement"))
        const pid = run.pid ?? 0
        const stopping = yield* supervisor.stop(run.runId).pipe(Effect.forkChild)
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(yield* fake.signals, [{ pid, signal: "SIGINT" }])
        yield* TestClock.adjust("30 seconds")
        assert.deepStrictEqual(yield* fake.signals, [
          { pid, signal: "SIGINT" },
          { pid, signal: "SIGTERM" }
        ])
        yield* fake.exit(pid, { code: undefined, signal: "SIGTERM" })
        const stopped = yield* Fiber.join(stopping)
        assert.strictEqual(stopped.state, "interrupted")
        assert.strictEqual(stopped.signal, "SIGTERM")
        const [latest] = yield* registry
        assert.strictEqual(latest?.state, "interrupted")
      })
    )
  )

  it.effect("a running record whose pid is dead is marked lost on construction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stale = new OperatorRun({
          runId: "op-1-aaaa",
          repo: "app",
          flow: "implement",
          args: [],
          knobs: {},
          startedAt: 1,
          pid: 4242,
          logDir: "/state/llm4ts/mcp/app/runs/op-1-aaaa",
          state: "running"
        })
        const { supervisor, registry } = yield* setup({
          [registryPath]: `${encodeOperatorRunLine(stale)}\n`
        })
        const [latest] = yield* registry
        assert.strictEqual(latest?.state, "lost")
        assert.strictEqual((yield* supervisor.get("op-1-aaaa"))?.state, "lost")
      })
    )
  )

  it.effect("an exit is recorded with its code", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake, supervisor, registry } = yield* setup()
        const run = yield* supervisor.start(request("implement"))
        yield* fake.exit(run.pid ?? 0, { code: 3, signal: undefined })
        yield* Effect.yieldNow
        const [latest] = yield* registry
        assert.strictEqual(latest?.state, "exited")
        assert.strictEqual(latest?.exitCode, 3)
        assert.isDefined(latest?.endedAt)
      })
    )
  )

  it.effect("closing the scope stops every running run", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const { fake, supervisor, registry } = yield* setup().pipe(Scope.provide(scope))
      const run = yield* supervisor.start(request("implement"))
      const pid = run.pid ?? 0
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild)
      yield* TestClock.adjust("1 second")
      assert.deepStrictEqual(yield* fake.signals, [{ pid, signal: "SIGINT" }])
      yield* fake.exit(pid, { code: 130, signal: undefined })
      yield* Fiber.join(closing)
      const [latest] = yield* registry
      assert.strictEqual(latest?.state, "interrupted")
      assert.strictEqual(latest?.exitCode, 130)
    })
  )
})
