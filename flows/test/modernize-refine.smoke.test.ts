import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import {
  commitAll,
  failureReport,
  initRepo,
  installStub,
  makeFixture,
  runFlow,
  stubProgram,
  write
} from "./support/smoke.ts"

/**
 * The refinement phase end to end, model stubbed (ADR 0015): extract a small
 * estate, then refine it with a program dropped by hand, a `?` mark the
 * proposal resolves to `provided` against the target, and a deepen mark that
 * re-extracts one program with its focus. The first run halts on the open
 * point the proposal raised; answering it in the file and rerunning
 * consolidates, plans per domain feature, waives the dropped units, and
 * resets the README approval. A third run is a no-op.
 */
const respond = `(prompt) => {
  const deepen = /DEEPEN the behavioural spec of ONE source unit of this repository: \\S*?([A-Z0-9]+)\\.(cbl|jcl)/.exec(prompt)
  const extract = /Extract the behavioural spec for ONE source unit of this repository: \\S*?([A-Z0-9]+)\\.(cbl|jcl)/.exec(prompt)
  const program = deepen ?? extract
  if (program !== null) {
    const name = program[1]
    const trace = {
      FEECALC: "0100-COMPUTE-FEE — Scenario: happy path\\n",
      ACCTXFR: "0100-VALIDATE-INPUT — Scenario: happy path\\n0200-POST-LEDGER — Scenario: happy path\\n",
      RUNJOB: "STEP1 — Scenario: happy path\\n"
    }
    const extra = deepen !== null ? "\\nRule 2: fees round half-up (deepened).\\n" : ""
    return JSON.stringify({
      spec: "# " + name + "\\n\\nRule 1: the unit performs its documented work.\\n" + extra,
      feature: "Feature: " + name + "\\n\\n  Scenario: happy path\\n    Given a valid request\\n    When " + name + " runs\\n    Then it succeeds\\n",
      traceability: trace[name] ?? "",
      mapping: "LEDGER table -> Ledger entity\\n"
    })
  }
  if (prompt.includes("Propose dispositions for the marked programs")) {
    if (!prompt.includes("target workspace you are running in")) {
      throw new Error("the proposal must run with the target mounted")
    }
    return JSON.stringify({
      decisions: [
        { key: "ACCTXFR", disposition: "provided", reason: "the target's AuditListener writes the ledger rows", pointer: "src/Audit.java" }
      ],
      openPoints: ["Should FEECALC round half-up in the target?"]
    })
  }
  if (prompt.includes("Name the domain features of this legacy estate")) {
    if (!prompt.includes("Smoke consolidate guidance")) {
      throw new Error("the pack's consolidate sidecar must reach the prompt")
    }
    if (prompt.includes("ACCTXFR") || prompt.includes("RUNJOB")) {
      throw new Error("disposed programs must not be offered for consolidation")
    }
    return JSON.stringify({
      features: [
        {
          id: "fee-calculation",
          name: "Fee calculation",
          programs: ["FEECALC"],
          scenarios: [{ program: "FEECALC", title: "happy path" }],
          evidence: "the only surviving program"
        }
      ],
      openPoints: []
    })
  }
  if (prompt.includes("planning assistant")) {
    return JSON.stringify({
      epicId: "fees",
      tasks: [{ title: "Implement fee calculation", description: "Rule 1 and Rule 2", completed: false }]
    })
  }
  return JSON.stringify({
    scores: [
      { name: "completeness", score: 2, reasoning: "every rule captured" },
      { name: "faithfulness", score: 2, reasoning: "grounded in source" }
    ],
    summary: "clean"
  })
}`

const estate = (root: string): void => {
  initRepo(root)
  write(
    root,
    "src/FEECALC.cbl",
    "       0100-COMPUTE-FEE.\n           COMPUTE WS-FEE = WS-AMOUNT * 0.01.\n"
  )
  write(
    root,
    "src/ACCTXFR.cbl",
    "       0100-VALIDATE-INPUT.\n           CALL 'FEECALC' USING WS-AMOUNT.\n       0200-POST-LEDGER.\n"
  )
  write(root, "jobs/RUNJOB.jcl", "//STEP1 EXEC PGM=ACCTXFR\n")
  commitAll(root, "legacy estate")
}

const read = (root: string, relative: string): string => readFileSync(join(root, relative), "utf8")

describe("modernize-refine (model stubbed)", () => {
  it("deepens, proposes, halts on open points, then consolidates and plans per feature", () => {
    const fixture = makeFixture()
    installStub(fixture, stubProgram(respond))
    estate(fixture.legacy)
    write(fixture.target, "src/Audit.java", "class Audit {}\n")

    const extract = runFlow(fixture, "modernize-extract", fixture.legacy)
    assert.strictEqual(extract.status, 0, failureReport("extract", extract))
    assert.include(read(fixture.legacy, "docs/modernization/README.md"), "- [ ] Approved")

    write(
      fixture.legacy,
      "docs/modernization/decisions.md",
      [
        "# Decisions",
        "",
        "## Programs",
        "",
        "- RUNJOB: drop — the nightly job is retired (smoke, 2026-09-15)",
        "- ACCTXFR: ? — the target has an audit listener already",
        "",
        "## Deepen",
        "",
        "- FEECALC: the rounding rule is missing; check 0100-COMPUTE-FEE",
        "",
        "- [ ] Approved",
        ""
      ].join("\n")
    )
    commitAll(fixture.legacy, "mark the pack")

    const first = runFlow(fixture, "modernize-refine", fixture.legacy, {
      LLM4TS_TARGET_REPO: fixture.target
    })
    const firstOutput = `${first.stdout}${first.stderr}`
    assert.notStrictEqual(first.status, 0, "the first run must halt on the open point")
    assert.include(firstOutput, "1 open point(s) in docs/modernization")
    assert.include(firstOutput, "Should FEECALC round half-up in the target?")

    const decisions = read(fixture.legacy, "docs/modernization/decisions.md")
    assert.match(
      decisions,
      /- FEECALC: the rounding rule is missing; check 0100-COMPUTE-FEE \[done [0-9a-f]{7}\]/
    )
    assert.include(
      decisions,
      "- ACCTXFR: provided — src/Audit.java; the target's AuditListener writes the ledger rows (proposal, "
    )
    assert.include(decisions, "- RUNJOB: drop — the nightly job is retired (smoke, 2026-09-15)")
    assert.include(decisions, "1. Should FEECALC round half-up in the target?")
    assert.include(decisions, "## How to mark")
    assert.include(read(fixture.legacy, "docs/modernization/specs/FEECALC.md"), "deepened")
    const log = execFileSync("git", ["log", "--oneline"], { cwd: fixture.legacy, encoding: "utf8" })
    assert.include(log, "deepen FEECALC")
    assert.include(log, "refine — ")
    // No map and no plan yet: consolidation waits for the answer.
    assert.notInclude(
      execFileSync("ls", [join(fixture.legacy, "docs/modernization")], { encoding: "utf8" }),
      "domains.md"
    )

    writeFileSync(
      join(fixture.legacy, "docs/modernization/decisions.md"),
      decisions.replace(
        "1. Should FEECALC round half-up in the target?",
        "1. Should FEECALC round half-up in the target?\n   answer: yes, half-up like the mainframe"
      )
    )
    const second = runFlow(fixture, "modernize-refine", fixture.legacy, {
      LLM4TS_TARGET_REPO: fixture.target
    })
    const secondOutput = `${second.stdout}${second.stderr}`
    assert.strictEqual(second.status, 0, failureReport("refine (answered)", second))
    assert.include(secondOutput, "refined — review docs/modernization/README.md")

    const domains = read(fixture.legacy, "docs/modernization/domains.md")
    assert.include(domains, "## Feature: Fee calculation (fee-calculation)")
    assert.include(domains, "- FEECALC / happy path")
    assert.include(domains, "- [ ] Approved")
    const plan = read(fixture.legacy, "docs/modernization/plan.md")
    assert.include(plan, "# Plan: smoke-features")
    assert.include(plan, "## [ ] [fee-calculation] Implement fee calculation")
    const rules = read(fixture.legacy, "docs/modernization/rules.txt")
    assert.include(rules, "# waived")
    assert.include(rules, "STEP1 — waived by RUNJOB: drop")
    assert.include(rules, "0200-POST-LEDGER — waived by ACCTXFR: provided")
    const readme = read(fixture.legacy, "docs/modernization/README.md")
    assert.include(readme, "Refined after the gate passed:")
    assert.include(readme, "deepened FEECALC")
    assert.include(readme, "- [ ] Approved")

    const third = runFlow(fixture, "modernize-refine", fixture.legacy, {
      LLM4TS_TARGET_REPO: fixture.target
    })
    assert.strictEqual(third.status, 0, failureReport("refine (no-op)", third))
    assert.include(`${third.stdout}${third.stderr}`, "nothing to refine")
  })
})
