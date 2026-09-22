import { describe, it, assert } from "@effect/vitest"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  commitAll,
  failureReport,
  initRepo,
  installStub,
  makeFixture,
  runFlow,
  smokeTimeout,
  stubProgram,
  write
} from "./support/smoke.ts"

/**
 * The plain `implement` flow, end to end against a stubbed coding agent.
 *
 * It had no smoke of its own, which is how a run that completed every task
 * and then never terminated reached a user: the flow spine was covered only
 * through the modernization phases. The seat here reports NO usage, the case
 * the runner meters itself, and the assertion is the last thing a run does —
 * print its cost summary — so a drain that never finishes fails this as a
 * timeout rather than passing quietly.
 */
const responder = [
  "(prompt) => {",
  '  if (prompt.includes("planning assistant")) {',
  "    return JSON.stringify({",
  '      epicId: "calculator",',
  "      tasks: [",
  '        { title: "Add multiply", description: "Add a multiply function", completed: false },',
  '        { title: "Test multiply", description: "Cover multiply with a test", completed: false }',
  "      ]",
  "    })",
  "  }",
  '  if (prompt.includes("Report problems as JSON")) {',
  '    return JSON.stringify({ issues: [], summary: "clean" })',
  "  }",
  '  fs.appendFileSync("calculator.txt", "step\\n")',
  '  return "Implemented the task."',
  "}"
].join("\n")

// No `usage` on the result event: the seat measures nothing, so every token
// figure in the summary is the runner's own estimate.
const withoutUsage = (script: string): string =>
  script.replace(
    'emit({ type: "result", usage: { input_tokens: 100, output_tokens: 40 } })',
    'emit({ type: "result" })'
  )

describe("implement flow smoke", () => {
  it(
    "implements every task and terminates with a cost summary",
    () => {
      const fixture = makeFixture()
      initRepo(fixture.target)
      write(fixture.target, "README.md", "# calculator\n")
      commitAll(fixture.target, "init")
      installStub(fixture, withoutUsage(stubProgram(responder)))

      const result = runFlow(fixture, "implement", fixture.target, {}, "Add a multiply function")

      assert.strictEqual(result.status, 0, failureReport("implement", result))
      // The summary is written only after every consumer reports drained, so
      // this is what a hang in that drain costs.
      assert.include(result.stdout, "Total:", failureReport("implement", result))
      assert.include(result.stdout, "estimated:", failureReport("implement", result))
      assert.isTrue(existsSync(join(fixture.target, "calculator.txt")))
    },
    smokeTimeout
  )
})
