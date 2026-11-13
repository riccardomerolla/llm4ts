import { describe, it, assert } from "@effect/vitest"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { unreadableInEnvironment } from "@llm4ts/flow/Settings"
import {
  commitAll,
  failureReport,
  initRepo,
  installStub,
  makeFixture,
  runFlow,
  smokeTimeout,
  write
} from "./support/smoke.ts"

const runImplement = (environment: Readonly<Record<string, string>>) => {
  const fixture = makeFixture()
  initRepo(fixture.target)
  write(fixture.target, "README.md", "# target\n")
  commitAll(fixture.target, "init")
  const called = join(fixture.root, "stub-called")
  installStub(
    fixture,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(called)}, "")\nprocess.exit(1)\n`
  )
  return { result: runFlow(fixture, "implement", fixture.target, environment), fixture, called }
}

describe("a flow started without the shell refuses an unreadable setting", () => {
  it(
    "stops before any agent starts, naming the setting and its grammar, never a value",
    () => {
      const { result, fixture, called } = runImplement({
        LLM4TS_JUDGE_ROUNDS: "abc",
        LLM4TS_MCP_TOKEN: "s3cret"
      })

      assert.strictEqual(result.status, 1, failureReport("implement", result))
      assert.include(
        result.stderr,
        unreadableInEnvironment("LLM4TS_JUDGE_ROUNDS"),
        failureReport("implement", result)
      )
      assert.notInclude(result.stderr, "abc")
      assert.notInclude(result.stderr, "s3cret")
      assert.isFalse(existsSync(called), "the stub agent was started")
      assert.isFalse(existsSync(join(fixture.target, ".llm4ts")), "a run started")
    },
    smokeTimeout
  )

  it(
    "starts the run when the same setting reads",
    () => {
      const { result, called } = runImplement({ LLM4TS_JUDGE_ROUNDS: "3" })

      assert.notInclude(result.stderr, "LLM4TS_JUDGE_ROUNDS", failureReport("implement", result))
      assert.isTrue(existsSync(called), failureReport("implement", result))
    },
    smokeTimeout
  )
})
