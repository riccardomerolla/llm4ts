import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeFakeFlowProcess, nodeFlowProcess } from "@llm4ts/shell/FlowProcess"

const withTempDir = <A>(use: (dir: string) => Promise<A>): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "llm4ts-shell-process-"))
  return use(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

describe("nodeFlowProcess", () => {
  it.effect("reports the exit code and writes stdout to the file", () =>
    Effect.promise(() =>
      withTempDir(async (dir) => {
        const flowPath = join(dir, "hi.ts")
        writeFileSync(flowPath, 'console.log("hi"); process.exit(3)\n')
        const stdout = join(dir, "logs", "out.log")
        const exit = await Effect.runPromise(
          Effect.gen(function* () {
            const handle = yield* nodeFlowProcess.start({
              flowPath,
              args: [],
              environment: process.env,
              stdio: { stdout, stderr: join(dir, "logs", "err.log") }
            })
            return yield* handle.exited
          })
        )
        assert.strictEqual(exit.code, 3)
        assert.include(readFileSync(stdout, "utf8"), "hi")
      })
    )
  )

  it.effect("a SIGTERM ends the child with the signal", () =>
    Effect.promise(() =>
      withTempDir(async (dir) => {
        const flowPath = join(dir, "wait.ts")
        writeFileSync(flowPath, "setTimeout(() => {}, 60_000)\n")
        const exit = await Effect.runPromise(
          Effect.gen(function* () {
            const handle = yield* nodeFlowProcess.start({
              flowPath,
              args: [],
              environment: process.env,
              stdio: "ignore"
            })
            yield* handle.signal("SIGTERM")
            return yield* handle.exited
          })
        )
        assert.strictEqual(exit.signal, "SIGTERM")
      })
    )
  )

  it.effect("isAlive is false after exit", () =>
    Effect.promise(() =>
      withTempDir(async (dir) => {
        const flowPath = join(dir, "quick.ts")
        writeFileSync(flowPath, "process.exit(0)\n")
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const handle = yield* nodeFlowProcess.start({
              flowPath,
              args: [],
              environment: process.env,
              stdio: "ignore"
            })
            const during = nodeFlowProcess.isAlive(handle.pid)
            yield* handle.exited
            return { during, after: nodeFlowProcess.isAlive(handle.pid) }
          })
        )
        assert.isTrue(result.during)
        assert.isFalse(result.after)
      })
    )
  )
})

describe("makeFakeFlowProcess", () => {
  it.effect("records starts, resolves exits and signals", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeFlowProcess()
      const handle = yield* fake.process.start({
        flowPath: "a.ts",
        args: ["x"],
        environment: {},
        stdio: "inherit"
      })
      assert.strictEqual(handle.pid, 1000)
      assert.isTrue(fake.process.isAlive(1000))
      yield* handle.signal("SIGTERM")
      assert.deepStrictEqual(yield* fake.signals, [{ pid: 1000, signal: "SIGTERM" }])
      yield* fake.exit(1000, { code: undefined, signal: "SIGTERM" })
      assert.strictEqual((yield* handle.exited).signal, "SIGTERM")
      assert.isFalse(fake.process.isAlive(1000))
      assert.strictEqual((yield* fake.started).length, 1)
      yield* fake.setAlive(1000, true)
      assert.isTrue(fake.process.isAlive(1000))
    })
  )
})
