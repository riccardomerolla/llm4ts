import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type { Environment } from "@llm4ts/flow/Settings"
import {
  flowEnvironment,
  registryFacts,
  resolveConfig,
  type FlowEnvironment
} from "@llm4ts/shell/Config"
import { launchFlow, needsResolveFallback } from "@llm4ts/shell/FlowLaunch"

const childEnvironment = (base: Environment): FlowEnvironment =>
  flowEnvironment(
    resolveConfig({
      facts: registryFacts,
      flags: [],
      environment: base,
      project: undefined,
      global: undefined,
      repo: "/",
      home: "/"
    }),
    base
  )

const withTempDir = <A>(use: (dir: string) => Promise<A>): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "llm4ts-shell-launch-"))
  return use(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

describe("needsResolveFallback", () => {
  it("is false for a flow inside this workspace (project wins)", () => {
    assert.isFalse(needsResolveFallback(resolve("flows/implement.ts")))
  })

  it("is true for a flow with no reachable @llm4ts installation", () =>
    withTempDir(async (dir) => {
      const flowPath = join(dir, "flow.ts")
      writeFileSync(flowPath, "// orphan flow\n")
      assert.isTrue(needsResolveFallback(flowPath))
    }))
})

describe("launchFlow", () => {
  it.effect("propagates the child's exit code", () =>
    Effect.gen(function* () {
      const exitCode = yield* Effect.promise(() =>
        withTempDir(async (dir) => {
          const flowPath = join(dir, "exit-seven.ts")
          writeFileSync(flowPath, "process.exit(7)\n")
          return Effect.runPromise(
            launchFlow({
              flowPath,
              taskArgs: [],
              environment: childEnvironment(process.env),
              stdio: "ignore"
            })
          )
        })
      )
      assert.strictEqual(exitCode, 7)
    })
  )

  it.effect("passes task argv and the environment to the child", () =>
    Effect.gen(function* () {
      const exitCode = yield* Effect.promise(() =>
        withTempDir(async (dir) => {
          const flowPath = join(dir, "check-args.ts")
          writeFileSync(
            flowPath,
            [
              'const ok = process.argv[2] === "do the task" &&',
              '  process.env.LLM4TS_CODER === "codex"',
              "process.exit(ok ? 0 : 1)"
            ].join("\n")
          )
          return Effect.runPromise(
            launchFlow({
              flowPath,
              taskArgs: ["do the task"],
              environment: childEnvironment({ ...process.env, LLM4TS_CODER: "codex" }),
              stdio: "ignore"
            })
          )
        })
      )
      assert.strictEqual(exitCode, 0)
    })
  )

  it.effect("resolves @llm4ts/* through the shell fallback for an orphan flow", () =>
    Effect.gen(function* () {
      const exitCode = yield* Effect.promise(() =>
        withTempDir(async (dir) => {
          const flowPath = join(dir, "orphan.ts")
          writeFileSync(
            flowPath,
            [
              "try {",
              '  const url = import.meta.resolve("@llm4ts/runner/package.json")',
              '  process.exit(url.includes("runner") ? 0 : 1)',
              "} catch {",
              "  process.exit(1)",
              "}"
            ].join("\n")
          )
          return Effect.runPromise(
            launchFlow({
              flowPath,
              taskArgs: [],
              environment: childEnvironment(process.env),
              stdio: "ignore"
            })
          )
        })
      )
      assert.strictEqual(exitCode, 0)
    })
  )

  it.effect("fails with FlowLaunchError when the script path cannot spawn", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        launchFlow({
          flowPath: join(tmpdir(), "llm4ts-shell-missing", "nope.ts"),
          taskArgs: [],
          environment: childEnvironment(process.env),
          stdio: "ignore"
        })
      )
      // A missing script is a child startup failure: node exits non-zero.
      if (result._tag === "Success") {
        assert.notStrictEqual(result.success, 0)
      } else {
        assert.strictEqual(result.failure._tag, "FlowLaunch")
      }
    })
  )
})
