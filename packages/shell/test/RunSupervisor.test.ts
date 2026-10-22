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
import { PersistenceError } from "@llm4ts/flow/FlowError"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
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
  baseEnvironment: { PATH: "/usr/bin", LLM4TS_MCP_TOKEN: "s3cret" }
})

const setup = (
  initial: Readonly<Record<string, string>> = {},
  options: {
    readonly alive?: ReadonlyArray<number>
    readonly files?: (store: PlainFileStoreShape) => PlainFileStoreShape
  } = {}
) =>
  Effect.gen(function* () {
    const memory = yield* makeMemoryPlainFileStore(initial)
    const fake = yield* makeFakeFlowProcess()
    for (const pid of options.alive ?? []) yield* fake.setAlive(pid, true)
    let suffix = 0xbeef
    const supervisor = yield* makeRunSupervisor({
      repos: [repo],
      environment,
      files: options.files === undefined ? memory.store : options.files(memory.store),
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

const orphan = (pid: number) =>
  new OperatorRun({
    runId: "op-1-aaaa",
    repo: "app",
    flow: "implement",
    args: [],
    knobs: {},
    startedAt: 1,
    pid,
    logDir: "/state/llm4ts/mcp/app/runs/op-1-aaaa",
    state: "running"
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
          assert.isFalse("LLM4TS_MCP_TOKEN" in started.environment)
          assert.deepStrictEqual(started.args, ["bump deps", "--judge-rounds", "1"])
          assert.strictEqual(started.cwd, "/work/app")
          assert.isTrue(started.detached)
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

  it.effect("a cancelled stop still escalates to SIGTERM", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake, supervisor, registry } = yield* setup()
        const run = yield* supervisor.start(request("implement"))
        const pid = run.pid ?? 0
        const cancelled = yield* supervisor.stop(run.runId).pipe(Effect.forkChild)
        yield* TestClock.adjust("1 second")
        yield* Fiber.interrupt(cancelled)
        yield* TestClock.adjust("30 seconds")
        assert.deepStrictEqual(yield* fake.signals, [
          { pid, signal: "SIGINT" },
          { pid, signal: "SIGTERM" }
        ])
        // A later stop does not re-signal and returns the final record.
        const again = yield* supervisor.stop(run.runId).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* fake.exit(pid, { code: undefined, signal: "SIGTERM" })
        const stopped = yield* Fiber.join(again)
        assert.strictEqual(stopped.state, "interrupted")
        assert.deepStrictEqual(yield* fake.signals, [
          { pid, signal: "SIGINT" },
          { pid, signal: "SIGTERM" }
        ])
        const [latest] = yield* registry
        assert.strictEqual(latest?.state, "interrupted")
      })
    )
  )

  it.effect("a second stop after a cancelled one does not re-signal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake, supervisor } = yield* setup()
        const run = yield* supervisor.start(request("implement"))
        const pid = run.pid ?? 0
        const cancelled = yield* supervisor.stop(run.runId).pipe(Effect.forkChild)
        yield* TestClock.adjust("1 second")
        yield* Fiber.interrupt(cancelled)
        const again = yield* supervisor.stop(run.runId).pipe(Effect.forkChild)
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(yield* fake.signals, [{ pid, signal: "SIGINT" }])
        yield* fake.exit(pid, { code: 130, signal: undefined })
        const stopped = yield* Fiber.join(again)
        assert.strictEqual(stopped.state, "interrupted")
        assert.strictEqual(stopped.exitCode, 130)
        assert.deepStrictEqual(yield* fake.signals, [{ pid, signal: "SIGINT" }])
      })
    )
  )

  it.effect("the scope finalizer completes a pending escalation", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const { fake, supervisor, registry } = yield* setup().pipe(Scope.provide(scope))
      const run = yield* supervisor.start(request("implement"))
      const pid = run.pid ?? 0
      const cancelled = yield* supervisor.stop(run.runId).pipe(Effect.forkChild)
      yield* TestClock.adjust("1 second")
      yield* Fiber.interrupt(cancelled)
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild)
      yield* TestClock.adjust("31 seconds")
      assert.deepStrictEqual(yield* fake.signals, [
        { pid, signal: "SIGINT" },
        { pid, signal: "SIGTERM" }
      ])
      yield* fake.exit(pid, { code: undefined, signal: "SIGTERM" })
      yield* Fiber.join(closing)
      assert.deepStrictEqual(yield* fake.signals, [
        { pid, signal: "SIGINT" },
        { pid, signal: "SIGTERM" }
      ])
      const [latest] = yield* registry
      assert.strictEqual(latest?.state, "interrupted")
    })
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
  it.effect("concurrent stops send one SIGINT and the scope finalizer sends none", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const { fake, supervisor } = yield* setup().pipe(Scope.provide(scope))
      const run = yield* supervisor.start(request("implement"))
      const pid = run.pid ?? 0
      const first = yield* supervisor.stop(run.runId).pipe(Effect.forkChild)
      const second = yield* supervisor.stop(run.runId).pipe(Effect.forkChild)
      yield* TestClock.adjust("1 second")
      assert.deepStrictEqual(yield* fake.signals, [{ pid, signal: "SIGINT" }])
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild)
      yield* TestClock.adjust("1 second")
      assert.deepStrictEqual(yield* fake.signals, [{ pid, signal: "SIGINT" }])
      yield* fake.exit(pid, { code: 130, signal: undefined })
      const [a, b] = [yield* Fiber.join(first), yield* Fiber.join(second)]
      yield* Fiber.join(closing)
      assert.strictEqual(a.state, "interrupted")
      assert.strictEqual(b.state, "interrupted")
    })
  )

  it.effect("a failed final append still releases a pending stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let failNext = false
        const { fake, supervisor } = yield* setup(
          {},
          {
            files: (store) => ({
              ...store,
              append: (path, contents) => {
                if (!failNext) return store.append(path, contents)
                failNext = false
                return Effect.fail(new PersistenceError({ message: "disk full" }))
              }
            })
          }
        )
        const run = yield* supervisor.start(request("implement"))
        const pid = run.pid ?? 0
        const stopping = yield* supervisor.stop(run.runId).pipe(Effect.forkChild)
        // One turn for the stop to fork its escalation, one for the SIGINT.
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        failNext = true
        yield* fake.exit(pid, { code: 130, signal: undefined })
        const stopped = yield* Fiber.join(stopping)
        assert.strictEqual(stopped.state, "interrupted")
        assert.deepStrictEqual(yield* fake.signals, [{ pid, signal: "SIGINT" }])
        // The registry kept `running`; with the child gone it reads as lost.
        assert.strictEqual((yield* supervisor.get(run.runId))?.state, "lost")
      })
    )
  )

  it.effect("a surviving orphan blocks its repo until its pid dies, then reads lost", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake, supervisor } = yield* setup(
          { [registryPath]: `${encodeOperatorRunLine(orphan(4242))}\n` },
          { alive: [4242] }
        )
        assert.strictEqual((yield* supervisor.get("op-1-aaaa"))?.state, "running")
        const refused = yield* supervisor.start(request("implement")).pipe(Effect.flip)
        assert.instanceOf(refused, RunInProgress)
        yield* fake.setAlive(4242, false)
        const run = yield* supervisor.start(request("implement"))
        assert.strictEqual(run.state, "running")
        const listed = yield* supervisor.list("app")
        assert.strictEqual(listed.find((r) => r.runId === "op-1-aaaa")?.state, "lost")
        yield* fake.exit(run.pid ?? 0, { code: 0, signal: undefined })
      })
    )
  )

  it.effect("stop on a surviving orphan signals its pid once and records interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake, supervisor, registry } = yield* setup(
          { [registryPath]: `${encodeOperatorRunLine(orphan(4242))}\n` },
          { alive: [4242] }
        )
        const first = yield* supervisor.stop("op-1-aaaa").pipe(Effect.forkChild)
        const second = yield* supervisor.stop("op-1-aaaa").pipe(Effect.forkChild)
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(yield* fake.signals, [{ pid: 4242, signal: "SIGINT" }])
        yield* fake.setAlive(4242, false)
        yield* TestClock.adjust("1 second")
        assert.strictEqual((yield* Fiber.join(first)).state, "interrupted")
        assert.strictEqual((yield* Fiber.join(second)).state, "interrupted")
        assert.deepStrictEqual(yield* fake.signals, [{ pid: 4242, signal: "SIGINT" }])
        const [latest] = yield* registry
        assert.strictEqual(latest?.state, "interrupted")
        assert.isDefined(latest?.endedAt)
      })
    )
  )

  it.effect("a cancelled stop on an orphan still escalates to SIGTERM", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fake, supervisor, registry } = yield* setup(
          { [registryPath]: `${encodeOperatorRunLine(orphan(4242))}\n` },
          { alive: [4242] }
        )
        const cancelled = yield* supervisor.stop("op-1-aaaa").pipe(Effect.forkChild)
        yield* TestClock.adjust("1 second")
        yield* Fiber.interrupt(cancelled)
        yield* TestClock.adjust("30 seconds")
        assert.deepStrictEqual(yield* fake.signals, [
          { pid: 4242, signal: "SIGINT" },
          { pid: 4242, signal: "SIGTERM" }
        ])
        yield* fake.setAlive(4242, false)
        yield* TestClock.adjust("1 second")
        const [latest] = yield* registry
        assert.strictEqual(latest?.state, "interrupted")
        const again = yield* supervisor.stop("op-1-aaaa")
        assert.strictEqual(again.state, "interrupted")
        assert.strictEqual((yield* fake.signals).length, 2)
      })
    )
  )
})
