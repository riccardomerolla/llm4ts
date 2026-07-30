import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import {
  commitAll,
  failureReport,
  git,
  initRepo,
  installStub,
  makeFixture,
  runFlow,
  stubProgram,
  write,
  type Fixture
} from "./support/smoke.ts"

/**
 * Phase 5 with the model stubbed. What this proves without a provider: the
 * roster reviews a real branch diff, the distilled outcome is routed three
 * ways — fixes become fix specs AND plan tasks for another implement pass,
 * improvements become documents only, and lessons are appended to the PACK so
 * the next estate starts smarter — and the result is committed.
 */
const outcome = {
  fixes: [
    {
      title: "Rounding drops the half-cent",
      spec: "Rule 1 requires HALF_UP rounding; the implementation truncates.",
      taskTitle: "Round fees HALF_UP",
      taskDescription: "Apply HALF_UP rounding in the fee calculation."
    }
  ],
  improvements: [
    {
      title: "Extract the ledger mapper",
      spec: "The mapping logic would read better in its own class.",
      taskTitle: "Extract a ledger mapper",
      taskDescription: "Non-blocking cleanup."
    }
  ],
  lessons: ["Pin decimal rounding mode explicitly when porting packed-decimal money fields."]
}

const responder = [
  "(prompt) => {",
  '  if (prompt.includes("Distill them:")) {',
  `    return ${JSON.stringify(JSON.stringify(outcome))}`,
  "  }",
  '  if (prompt.includes("Report problems as JSON")) {',
  "    return JSON.stringify({",
  '      issues: [{ severity: "Critical", title: "rounding", description: "truncates" }],',
  '      summary: "one finding"',
  "    })",
  "  }",
  '  if (prompt.includes("spec-compliance")) {',
  "    return JSON.stringify({",
  "      scores: [",
  '        { name: "spec-compliance", score: 1, reasoning: "rounding differs" },',
  '        { name: "scenario-coverage", score: 2, reasoning: "all scenarios covered" }',
  "      ],",
  '      summary: "one gap"',
  "    })",
  "  }",
  '  return "{}"',
  "}"
].join("\n")

const seedTarget = (fixture: Fixture): void => {
  initRepo(fixture.target)
  write(fixture.target, "docs/specs/ACCTXFR.md", "# ACCTXFR\n\nRule 1: round HALF_UP.\n")
  write(
    fixture.target,
    "docs/modernization/plan.md",
    "# Plan: meridian-transfers\n\n## [x] Implement transfer posting\nDone.\n"
  )
  write(fixture.target, "src/Ledger.java", "class Ledger {}\n")
  commitAll(fixture.target, "seeded target")
  // The increment under review lives on its own branch, as implement leaves it.
  git(fixture.target, "checkout", "-q", "-b", "meridian-transfers")
  write(fixture.target, "src/Ledger.java", "class Ledger { int fee() { return 1; } }\n")
  commitAll(fixture.target, "meridian-transfers: implement transfer posting")
}

describe("modernize-review end to end (model stubbed)", () => {
  it("routes findings into fix specs, plan tasks, and pack lessons", () => {
    const fixture = makeFixture()
    try {
      seedTarget(fixture)
      installStub(fixture, stubProgram(responder))

      const result = runFlow(fixture, "modernize-review", fixture.target)
      assert.strictEqual(result.status, 0, failureReport("review", result))

      // A spec VIOLATION becomes both a document and a plan task.
      const fix = join(fixture.target, "docs/specs/fixes/fix-rounding-drops-the-half-cent.md")
      assert.isTrue(existsSync(fix), "a violation should be filed as a fix spec")
      assert.include(readFileSync(fix, "utf8"), "HALF_UP")

      // An improvement is documented but must NOT enter the plan.
      const improvement = join(
        fixture.target,
        "docs/specs/fixes/improvement-extract-the-ledger-mapper.md"
      )
      assert.isTrue(existsSync(improvement), "an improvement should be documented")

      const plan = readFileSync(join(fixture.target, "docs/modernization/plan.md"), "utf8")
      assert.include(plan, "## [ ] Round fees HALF_UP")
      assert.notInclude(
        plan,
        "Extract a ledger mapper",
        "improvements are not spec violations and must not enter the plan"
      )

      // Lessons are appended to the PACK, not the target: that is how the next
      // estate inherits what this one learned.
      const lessons = readFileSync(join(fixture.packDir, "lessons.md"), "utf8")
      assert.include(lessons, "Pin decimal rounding mode explicitly")

      // The review committed its own artifacts.
      const log = git(fixture.target, "log", "--oneline", "-1")
      assert.include(log, "modernize(smoke): review")
      assert.include(log, "1 fix(es)")
      assert.strictEqual(git(fixture.target, "status", "--porcelain").trim(), "")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("refuses to review a branch with no diff against the base", () => {
    const fixture = makeFixture()
    try {
      initRepo(fixture.target)
      write(fixture.target, "docs/specs/ACCTXFR.md", "# ACCTXFR\n")
      write(
        fixture.target,
        "docs/modernization/plan.md",
        "# Plan: meridian-transfers\n\n## [x] Done\nDone.\n"
      )
      commitAll(fixture.target, "seeded target")
      installStub(fixture, stubProgram(responder))

      const result = runFlow(fixture, "modernize-review", fixture.target)
      assert.notStrictEqual(result.status, 0, "an empty diff has nothing to review")
      assert.include(`${result.stdout}${result.stderr}`, "nothing to review")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
