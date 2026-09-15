import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  capturedUnits,
  coverage,
  coverageReport,
  CoverageRule,
  specSchemaIssues
} from "@llm4ts/flow/SpecChecks"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"

const rules = [
  CoverageRule.make({ name: "paragraph", files: ".*\\.cbl", unit: "^ {7}(\\d{4}-[A-Z-]+)\\." }),
  CoverageRule.make({ name: "step", files: ".*\\.jcl", unit: "^//(\\w+) +EXEC" })
]

const estate = Effect.gen(function* () {
  const workspace = yield* makeMemoryWorkspace()
  yield* workspace.write("src/FEECALC.cbl", "       0100-COMPUTE-FEE.\n")
  yield* workspace.write("src/ACCTXFR.cbl", "       0100-VALIDATE.\n       0200-POST.\n")
  yield* workspace.write("jobs/RUNJOB.jcl", "//STEP1 EXEC PGM=ACCTXFR\n")
  return workspace
})

describe("coverage", () => {
  it.effect("captures every unit with the files it came from", () =>
    Effect.gen(function* () {
      const units = yield* capturedUnits(yield* estate, rules)
      assert.deepStrictEqual(
        units.map((unit) => [unit.rule, unit.unit, unit.paths]),
        [
          ["paragraph", "0100-VALIDATE", ["src/ACCTXFR.cbl"]],
          ["paragraph", "0200-POST", ["src/ACCTXFR.cbl"]],
          ["paragraph", "0100-COMPUTE-FEE", ["src/FEECALC.cbl"]],
          ["step", "STEP1", ["jobs/RUNJOB.jcl"]]
        ]
      )
    })
  )

  it.effect("gates every uncovered unit when no scope is given", () =>
    Effect.gen(function* () {
      const result = yield* coverage(yield* estate, rules, "| 0100-COMPUTE-FEE | FEECALC |")
      assert.deepStrictEqual(result.issues.map((issue) => issue.title).sort(), [
        "uncovered paragraph: 0100-VALIDATE",
        "uncovered paragraph: 0200-POST",
        "uncovered step: STEP1"
      ])
    })
  )

  it.effect("a waived unit never gates and is reported apart from out-of-scope ones", () =>
    Effect.gen(function* () {
      const report = yield* coverageReport(yield* estate, rules, "| 0100-COMPUTE-FEE | FEECALC |", {
        waived: new Set(["0200-POST"]),
        inScope: (path) => !path.endsWith(".jcl")
      })
      assert.deepStrictEqual(
        report.result.issues.map((issue) => issue.title),
        ["uncovered paragraph: 0100-VALIDATE"]
      )
      assert.deepStrictEqual(report.waived, ["paragraph: 0200-POST"])
      assert.deepStrictEqual(report.outOfScope, ["step: STEP1"])
    })
  )

  it.effect("a wave scope gates only units captured from the wave's own files", () =>
    Effect.gen(function* () {
      // wave-1 = FEECALC only: ACCTXFR's paragraphs and the JCL step belong to
      // later waves and must not fail this wave's gate — they are reported.
      const report = yield* coverageReport(yield* estate, rules, "nothing covered yet", {
        inScope: (path) => path.endsWith("FEECALC.cbl")
      })
      assert.deepStrictEqual(
        report.result.issues.map((issue) => issue.title),
        ["uncovered paragraph: 0100-COMPUTE-FEE"]
      )
      assert.deepStrictEqual(report.outOfScope, [
        "paragraph: 0100-VALIDATE",
        "paragraph: 0200-POST",
        "step: STEP1"
      ])
      const cleared = yield* coverageReport(yield* estate, rules, "| 0100-COMPUTE-FEE |", {
        inScope: (path) => path.endsWith("FEECALC.cbl")
      })
      assert.lengthOf(cleared.result.issues, 0)
      assert.strictEqual(cleared.result.summary, "coverage complete")
    })
  )
})

describe("specSchemaIssues", () => {
  const validBlock = [
    "# accountOverview",
    "",
    "```json pagespec",
    JSON.stringify({
      page: "accountOverview",
      route: "/accountOverview",
      title: "Account Overview",
      complexity: "low",
      forms: [],
      dtos: [],
      apiCalls: [],
      navigation: {},
      sessionState: [],
      openQuestions: []
    }),
    "```",
    ""
  ].join("\n")

  it.effect("is silent for packs without a declared schema", () =>
    Effect.gen(function* () {
      const issues = yield* specSchemaIssues(undefined, [{ name: "x", markdown: "prose only" }])
      assert.deepStrictEqual(issues, [])
    })
  )

  it.effect("flags a missing, prose-only, or malformed pagespec block per program", () =>
    Effect.gen(function* () {
      const issues = yield* specSchemaIssues("pagespec", [
        { name: "accountOverview", markdown: validBlock },
        { name: "login", markdown: "# login\n\nNo block at all.\n" },
        {
          name: "transfer",
          markdown:
            '# transfer\n\n```json pagespec\n{"page":"transfer","apiCalls":["GET /transfer -> prose"]}\n```\n'
        },
        { name: "missing", markdown: undefined }
      ])
      assert.deepStrictEqual(
        issues.map((issue) => [issue.title, issue.severity]),
        [
          ["judge[login]: invalid pagespec block", "Critical"],
          ["judge[transfer]: invalid pagespec block", "Critical"],
          ["judge[missing]: invalid pagespec block", "Critical"]
        ]
      )
      assert.include(issues[1]?.description ?? "", "invalid page spec block")
    })
  )
})
