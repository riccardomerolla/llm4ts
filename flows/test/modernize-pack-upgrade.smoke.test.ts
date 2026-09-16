import { execFileSync } from "node:child_process"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
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
 * The fork story (guide chapter 7): a spec pack an OLDER llm4ts extracted is
 * continued with the current release. The estate is extracted with the stub,
 * then made to look old — no version stamp in the README, one feature file
 * gone, one traceability fragment gone, a stale rules universe. The upgrade
 * check finds exactly that, re-indexes under the current rules, stamps the
 * README, marks the programs for deepen, and `modernize-refine` re-extracts
 * them with the current prompts. A second pack declaring `spec-schema:
 * pagespec` shows the 2.0 identifier rule flagging every old block.
 */
const respond = `(prompt) => {
  const program = /(?:DEEPEN the behavioural spec of|Extract the behavioural spec for) ONE source unit of this repository: \\S*?([A-Z0-9]+)\\.(cbl|jcl)/.exec(prompt)
  if (program !== null) {
    const name = program[1]
    const trace = {
      FEECALC: "0100-COMPUTE-FEE — Scenario: happy path\\n",
      ACCTXFR: "0100-VALIDATE-INPUT — Scenario: happy path\\n0200-POST-LEDGER — Scenario: happy path\\n",
      RUNJOB: "STEP1 — Scenario: happy path\\n"
    }
    return JSON.stringify({
      spec: "# " + name + "\\n\\nRule 1: the unit performs its documented work.\\n",
      feature: "Feature: " + name + "\\n\\n  Scenario: happy path\\n    Given a valid request\\n    When " + name + " runs\\n    Then it succeeds\\n",
      traceability: trace[name] ?? "",
      mapping: "LEDGER table -> Ledger entity\\n"
    })
  }
  if (prompt.includes("Name the domain features of this legacy estate")) {
    return JSON.stringify({
      features: [
        {
          id: "fees",
          name: "Fees",
          programs: ["ACCTXFR", "FEECALC", "RUNJOB"],
          scenarios: [
            { program: "ACCTXFR", title: "happy path" },
            { program: "FEECALC", title: "happy path" },
            { program: "RUNJOB", title: "happy path" }
          ],
          evidence: "one job"
        }
      ],
      openPoints: []
    })
  }
  if (prompt.includes("planning assistant")) {
    return JSON.stringify({
      epicId: "fees",
      tasks: [{ title: "Implement fees", description: "Rule 1", completed: false }]
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

/** Makes a freshly extracted pack look like an older release wrote it. */
const ageThePack = (legacy: string): void => {
  const readmePath = join(legacy, "docs/modernization/README.md")
  writeFileSync(
    readmePath,
    read(legacy, "docs/modernization/README.md").replace(/^Written by llm4ts .*\n/m, "")
  )
  rmSync(join(legacy, "docs/modernization/features/feecalc.feature"))
  rmSync(join(legacy, "docs/modernization/traceability/ACCTXFR.md"))
  writeFileSync(join(legacy, "docs/modernization/rules.txt"), "STALE-UNIT\n")
  commitAll(legacy, "a pack from an older release")
}

describe("modernize-pack-upgrade (no model)", () => {
  it("checks an older pack, re-indexes it, marks the programs to deepen, and refine re-extracts them", () => {
    const fixture = makeFixture()
    installStub(fixture, stubProgram(respond))
    estate(fixture.legacy)
    const extract = runFlow(fixture, "modernize-extract", fixture.legacy)
    assert.strictEqual(extract.status, 0, failureReport("extract", extract))
    assert.match(
      read(fixture.legacy, "docs/modernization/README.md"),
      /^Written by llm4ts \d+\.\d+\.\d+\.$/m
    )
    ageThePack(fixture.legacy)

    // Dry: findings and the suggested marks, nothing marked.
    const dry = runFlow(fixture, "modernize-pack-upgrade", fixture.legacy)
    const dryOutput = `${dry.stdout}${dry.stderr}`
    assert.strictEqual(dry.status, 0, failureReport("upgrade (dry)", dry))
    assert.include(dryOutput, "an llm4ts older than 2.2.0 (no version stamp)")
    assert.include(dryOutput, "finding: FEECALC — feature file missing")
    assert.include(dryOutput, "finding: ACCTXFR — traceability fragment missing")
    assert.include(
      dryOutput,
      "uncovered under the current rules: uncovered cobol-paragraph: 0100-VALIDATE-INPUT"
    )
    assert.include(dryOutput, "rerun with LLM4TS_MARK_DEEPEN=1")
    const rules = read(fixture.legacy, "docs/modernization/rules.txt")
    assert.notInclude(rules, "STALE-UNIT")
    assert.include(rules, "0100-COMPUTE-FEE")
    const readme = read(fixture.legacy, "docs/modernization/README.md")
    assert.match(readme, /^Written by llm4ts \d+\.\d+\.\d+\.$/m)
    assert.include(readme, "upgraded from an llm4ts older than 2.2.0")
    assert.include(readme, "- [ ] Approved")
    assert.notInclude(
      execFileSync("ls", [join(fixture.legacy, "docs/modernization")], { encoding: "utf8" }),
      "decisions.md"
    )

    // Marked: decisions.md gets one deepen mark per incompatible program.
    const marked = runFlow(fixture, "modernize-pack-upgrade", fixture.legacy, {
      LLM4TS_MARK_DEEPEN: "1"
    })
    assert.strictEqual(marked.status, 0, failureReport("upgrade (mark)", marked))
    assert.include(`${marked.stdout}${marked.stderr}`, "2 deepen mark(s) written")
    const decisions = read(fixture.legacy, "docs/modernization/decisions.md")
    assert.match(
      decisions,
      /^- FEECALC: regenerate the artifacts under the current llm4ts .* — feature file missing$/m
    )
    assert.match(decisions, /^- ACCTXFR: regenerate .* — traceability fragment missing$/m)

    // Idempotent: a rerun adds no second mark.
    const again = runFlow(fixture, "modernize-pack-upgrade", fixture.legacy, {
      LLM4TS_MARK_DEEPEN: "1"
    })
    assert.strictEqual(again.status, 0, failureReport("upgrade (again)", again))
    assert.include(`${again.stdout}${again.stderr}`, "0 deepen mark(s) written")

    // The fork continues with the current release: refine re-extracts the two.
    const refine = runFlow(fixture, "modernize-refine", fixture.legacy)
    assert.strictEqual(refine.status, 0, failureReport("refine", refine))
    const refined = read(fixture.legacy, "docs/modernization/decisions.md")
    assert.match(refined, /- FEECALC: regenerate .*\[done [0-9a-f]{7}\]/)
    assert.match(refined, /- ACCTXFR: regenerate .*\[done [0-9a-f]{7}\]/)
    assert.include(
      read(fixture.legacy, "docs/modernization/features/feecalc.feature"),
      "Scenario: happy path"
    )
    assert.include(
      read(fixture.legacy, "docs/modernization/traceability/ACCTXFR.md"),
      "0100-VALIDATE-INPUT"
    )
    assert.notInclude(read(fixture.legacy, "docs/modernization/rules.txt"), "# waived")
    const log = execFileSync("git", ["log", "--oneline"], { cwd: fixture.legacy, encoding: "utf8" })
    assert.include(log, "pack upgrade check as llm4ts")
    assert.include(log, "deepen FEECALC")
    assert.include(log, "deepen ACCTXFR")
  })

  it("flags every pagespec block the current schema rejects when the pack declares spec-schema", () => {
    const fixture = makeFixture()
    installStub(fixture, stubProgram(respond))
    estate(fixture.legacy)
    const extract = runFlow(fixture, "modernize-extract", fixture.legacy)
    assert.strictEqual(extract.status, 0, failureReport("extract", extract))
    // The same pack, now demanding a pagespec block the older specs never had.
    write(
      fixture.root,
      "packs/paged/pack.md",
      read(fixture.root, "packs/smoke/pack.md").replace(
        "source: cobol",
        "source: cobol\nspec-schema: pagespec"
      )
    )
    const result = runFlow(fixture, "modernize-pack-upgrade", fixture.legacy, {
      LLM4TS_PACK: "packs/paged"
    })
    const output = `${result.stdout}${result.stderr}`
    assert.strictEqual(result.status, 0, failureReport("upgrade (pagespec)", result))
    for (const name of ["ACCTXFR", "FEECALC", "RUNJOB"]) {
      assert.include(
        output,
        `finding: ${name} — pagespec block does not decode under the current schema`
      )
    }
    assert.include(output, "3 program(s) need re-extraction")
  })
})
