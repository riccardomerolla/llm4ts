import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { BenchRecord } from "@llm4ts/flow/Bench"
import {
  commitAll,
  failureReport,
  initRepo,
  installStub,
  makeFixture,
  runFlow,
  stubProgram,
  write,
  type Fixture
} from "./support/smoke.ts"

/**
 * The benchmark harness with the model stubbed. What this proves: a measured
 * run appends one schema-versioned record whose phases carry the tokens the
 * stub reported, the report mode renders those records, and the survey picks
 * the file up to project a wave's cost.
 */
const artifacts = {
  spec: "# ACCTXFR\n\nRule 1.\n",
  feature:
    "Feature: ACCTXFR\n\n  Scenario: happy\n    Given a request\n    When it runs\n    Then ok\n",
  traceability: "0100-VALIDATE-INPUT — Rule 1\n",
  mapping: "LEDGER -> Ledger\n"
}

const responder = [
  "(prompt) => {",
  '  if (prompt.includes("Extract the behavioural spec")) {',
  `    return ${JSON.stringify(JSON.stringify(artifacts))}`,
  "  }",
  '  if (prompt.includes("impartial evaluator") || prompt.includes("completeness")) {',
  "    return JSON.stringify({",
  '      scores: [{ name: "completeness", score: 2, reasoning: "captured" },',
  '               { name: "faithfulness", score: 2, reasoning: "grounded" }],',
  '      summary: "clean"',
  "    })",
  "  }",
  // Survey calls: graph refine, then triage.
  '  if (prompt.includes("refining the dependency graph")) {',
  "    return JSON.stringify({ edges: [], notes: [] })",
  "  }",
  '  if (prompt.includes("triaging a legacy estate")) {',
  "    return JSON.stringify({",
  '      triage: [{ name: "ACCTXFR", disposition: "rewrite", rationale: "live" }],',
  '      waves: [{ name: "wave-1", programs: ["ACCTXFR"], rationale: "leaf" }],',
  "      notes: []",
  "    })",
  "  }",
  '  return "{}"',
  "}"
].join("\n")

const seedEstate = (fixture: Fixture): void => {
  initRepo(fixture.legacy)
  write(
    fixture.legacy,
    "cobol/ACCTXFR.cbl",
    [
      "       IDENTIFICATION DIVISION.",
      "       PROGRAM-ID. ACCTXFR.",
      "       PROCEDURE DIVISION.",
      "       0100-VALIDATE-INPUT.",
      "           EXIT.",
      ""
    ].join("\n")
  )
  commitAll(fixture.legacy, "estate baseline")
}

describe("modernize-bench end to end (model stubbed)", () => {
  it("measures an extraction run, then reports and projects from the record", () => {
    const fixture = makeFixture()
    try {
      seedEstate(fixture)
      installStub(fixture, stubProgram(responder))

      const measure = runFlow(fixture, "modernize-bench", fixture.legacy)
      assert.strictEqual(measure.status, 0, failureReport("bench measure", measure))

      // One record, appended to the launch directory's ledger.
      const benchPath = join(fixture.root, "bench-results.jsonl")
      assert.isTrue(existsSync(benchPath), "bench should append a results ledger")
      const lines = readFileSync(benchPath, "utf8").trim().split("\n")
      assert.lengthOf(lines, 1)
      const record = Schema.decodeUnknownSync(BenchRecord)(JSON.parse(lines[0] ?? "{}"))

      assert.strictEqual(record.schemaVersion, 1)
      assert.strictEqual(record.pack, "smoke")
      assert.strictEqual(record.provider, "claude-cli")
      // The phases the harness measures, in order.
      assert.deepStrictEqual(
        record.phases.map((phase) => phase.name),
        ["inventory", "extract", "gate", "judge"]
      )
      // Tokens came from the stub's reported usage, through the event tap.
      assert.isAbove(record.totalTokens, 0, "the tap should observe the stub's token usage")
      assert.isAbove(record.totalMs, 0)
      assert.strictEqual(record.quality?.programs, 1)
      assert.isAbove(record.quality?.judgeScores.length ?? 0, 0)

      // A second run appends rather than replacing, so runs accumulate.
      const second = runFlow(fixture, "modernize-bench", fixture.legacy)
      assert.strictEqual(second.status, 0, failureReport("bench measure (second)", second))
      assert.lengthOf(readFileSync(benchPath, "utf8").trim().split("\n"), 2)

      // Report mode renders the ledger and projects a wave.
      const report = runFlow(fixture, "modernize-bench", fixture.legacy, {
        LLM4TS_BENCH_MODE: "report",
        LLM4TS_BENCH_PROJECT: "12"
      })
      assert.strictEqual(report.status, 0, failureReport("bench report", report))
      assert.include(report.stdout, "smoke", "the report should name the pack it grouped by")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("fails report mode cleanly when no runs have been measured", () => {
    const fixture = makeFixture()
    try {
      seedEstate(fixture)
      installStub(fixture, stubProgram(responder))

      const report = runFlow(fixture, "modernize-bench", fixture.legacy, {
        LLM4TS_BENCH_MODE: "report"
      })
      assert.notStrictEqual(report.status, 0)
      assert.include(`${report.stdout}${report.stderr}`, "no benchmark records")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("feeds the survey's per-wave cost projection", () => {
    const fixture = makeFixture()
    try {
      seedEstate(fixture)
      installStub(fixture, stubProgram(responder))

      // Without a ledger the plan ships bare...
      const bare = runFlow(fixture, "modernize-survey", fixture.legacy)
      assert.strictEqual(bare.status, 0, failureReport("survey (no bench)", bare))
      const planPath = join(fixture.legacy, "docs/modernization/wave-plan.md")
      assert.notInclude(readFileSync(planPath, "utf8"), "## Cost projection")

      // ...and once a run has been measured, the same survey embeds one.
      const measure = runFlow(fixture, "modernize-bench", fixture.legacy)
      assert.strictEqual(measure.status, 0, failureReport("bench measure", measure))
      rmSync(join(fixture.legacy, "docs/modernization"), { recursive: true, force: true })
      commitAll(fixture.legacy, "reset survey artifacts")

      const projected = runFlow(fixture, "modernize-survey", fixture.legacy)
      assert.strictEqual(projected.status, 0, failureReport("survey (with bench)", projected))
      const plan = readFileSync(planPath, "utf8")
      assert.include(plan, "## Cost projection")
      assert.include(plan, "wave-1, 1 program(s), from measured runs")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
