import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { latestRuns, type OperatorRun } from "@llm4ts/flow/OperatorSchemas"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import type { InterruptSignal } from "@llm4ts/runner/FlowRunner"
import { makeFakeFlowProcess } from "@llm4ts/shell/FlowProcess"
import type { OperatorConfig } from "@llm4ts/shell/OperatorConfig"
import { nodeListFiles, runMcp } from "@llm4ts/shell/OperatorNode"

const repo = { id: "app", path: "/work/app" }
const registryPath = "/state/llm4ts/mcp/app/runs.jsonl"
const config: OperatorConfig = {
  transport: { _tag: "stdio" },
  repos: [repo],
  allowRun: true,
  allowApprove: false,
  parallelRuns: 1
}

const fakeSignals = () => {
  const handlers = new Map<InterruptSignal, () => void>()
  const exitCalls: Array<number> = []
  return {
    handlers,
    exitCalls,
    source: {
      once: (signal: InterruptSignal, handler: () => void) => {
        handlers.set(signal, handler)
      },
      off: (signal: InterruptSignal, handler: () => void) => {
        if (handlers.get(signal) === handler) handlers.delete(signal)
      },
      exit: (code: number) => {
        exitCalls.push(code)
      }
    }
  }
}

/** Yields until `ready` holds; the signal handler interrupts on another fiber. */
const until = (ready: Effect.Effect<boolean>): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt++) {
      if (yield* ready) return
      yield* Effect.yieldNow
    }
    assert.fail("condition never held")
  })

/**
 * Runs `runMcp` with a stand-in server that starts one fake flow and then
 * serves forever, fires `signal` once, and reports what happened.
 */
const interruptedBy = (signal: InterruptSignal) =>
  Effect.gen(function* () {
    const memory = yield* makeMemoryPlainFileStore()
    const fake = yield* makeFakeFlowProcess()
    const signals = fakeSignals()
    const started = yield* Deferred.make<OperatorRun>()
    const fiber = yield* runMcp(
      config,
      {
        operator: {
          config,
          files: memory.store,
          listTraces: () => [],
          listEpics: () => [],
          listFiles: () => [],
          transcripts: { read: () => Effect.succeed(undefined), list: () => [] },
          doctor: Effect.die("unused"),
          roster: () => Effect.die("unused"),
          probe: () => Effect.succeed(false),
          flows: () => Effect.succeed([]),
          now: Effect.succeed(0),
          environment: { HOME: "/home/op", XDG_STATE_HOME: "/state" }
        },
        flowProcess: fake.process,
        serve: (_config, deps) =>
          deps.supervisor
            .start({
              repo,
              flow: { name: "sleep", path: "/flows/sleep.ts" },
              knobs: {},
              baseEnvironment: {}
            })
            .pipe(
              Effect.flatMap((run) => Deferred.succeed(started, run)),
              Effect.orDie,
              Effect.andThen(Effect.never)
            )
      },
      signals.source
    ).pipe(Effect.forkChild)
    const run = yield* Deferred.await(started)
    const pid = run.pid ?? 0

    assert.isDefined(signals.handlers.get("SIGINT"))
    assert.isDefined(signals.handlers.get("SIGTERM"))
    signals.handlers.get(signal)?.()

    // The scope closing runs the supervisor's finalizer: the flow gets SIGINT.
    yield* until(fake.signals.pipe(Effect.map((sent) => sent.length > 0)))
    const sent = yield* fake.signals
    yield* fake.exit(pid, { code: 130, signal: undefined })
    const exit = yield* Fiber.await(fiber)
    const runs = latestRuns(((yield* memory.files)[registryPath] ?? "").split("\n"))
    return { exit, sent, pid, runs, signals }
  })

describe("runMcp", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it.effect(`${signal} interrupts the server and stops the flows it started`, () =>
      Effect.gen(function* () {
        const { exit, sent, pid, runs, signals } = yield* interruptedBy(signal)
        assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
        assert.deepStrictEqual(sent, [{ pid, signal: "SIGINT" }])
        assert.deepStrictEqual(
          runs.map((run) => run.state),
          ["interrupted"]
        )
        // No exit: the first signal only interrupts, and the handlers are gone.
        assert.deepStrictEqual(signals.exitCalls, [])
        assert.strictEqual(signals.handlers.size, 0)
      })
    )
  }

  it.effect("a server failure ends runMcp with that failure and removes the handlers", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const fake = yield* makeFakeFlowProcess()
      const signals = fakeSignals()
      const exit = yield* Effect.exit(
        runMcp(
          config,
          {
            operator: {
              config,
              files: memory.store,
              listTraces: () => [],
              listEpics: () => [],
              listFiles: () => [],
              transcripts: { read: () => Effect.succeed(undefined), list: () => [] },
              doctor: Effect.die("unused"),
              roster: () => Effect.die("unused"),
              probe: () => Effect.succeed(false),
              flows: () => Effect.succeed([]),
              now: Effect.succeed(0),
              environment: { HOME: "/home/op", XDG_STATE_HOME: "/state" }
            },
            flowProcess: fake.process,
            serve: () => Effect.fail("port in use" as const)
          },
          signals.source
        )
      )
      assert.deepStrictEqual(exit, Exit.fail("port in use"))
      assert.strictEqual(signals.handlers.size, 0)
    })
  )
})

describe("nodeListFiles", () => {
  it("lists regular files under a directory recursively, never directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "llm4ts-shell-mcp-"))
    try {
      mkdirSync(join(dir, "runs", "op-1"), { recursive: true })
      mkdirSync(join(dir, "empty"))
      writeFileSync(join(dir, "index.json"), "{}")
      writeFileSync(join(dir, "runs", "op-1", "log.txt"), "")
      assert.deepStrictEqual(nodeListFiles(dir), ["index.json", join("runs", "op-1", "log.txt")])
      assert.deepStrictEqual(nodeListFiles(join(dir, "missing")), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
