import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { failureReport, initRepo, makeFixture, runFlow, write } from "./support/smoke.ts"

/**
 * The LLM-free pack check: the pack loads exactly as survey/extract load it,
 * every rule is matched against a real estate on disk, and the verdict is
 * printed without any model, credential, or coding agent.
 */
const cobolEstate = (root: string): void => {
  initRepo(root)
  write(
    root,
    "src/ACCTXFR.cbl",
    [
      "       IDENTIFICATION DIVISION.",
      "       PROGRAM-ID. ACCTXFR.",
      "       PROCEDURE DIVISION.",
      "       0100-VALIDATE-INPUT.",
      "           CALL 'FEECALC' USING WS-AMOUNT.",
      "       0200-POST-LEDGER.",
      "           CALL 'AUDITLOG' USING WS-RECORD.",
      ""
    ].join("\n")
  )
  write(root, "src/FEECALC.cbl", "       0100-COMPUTE-FEE.\n")
  write(root, "jobs/RUNJOB.jcl", "//STEP1 EXEC PGM=ACCTXFR\n")
  write(root, "README.md", "# estate\n")
}

describe("modernize-pack-check", () => {
  it("reports the manifest and every rule's units against the estate, exit 0", () => {
    const fixture = makeFixture()
    cobolEstate(fixture.legacy)

    const result = runFlow(fixture, "modernize-pack-check", fixture.legacy)
    const output = `${result.stdout}${result.stderr}`
    assert.strictEqual(result.status, 0, failureReport("pack-check", result))
    assert.include(output, "pack 'smoke' (source: cobol)")
    assert.include(output, "gates: build → sh scripts/build.sh")
    assert.include(output, "prompts: 7/7 phase sidecars")
    assert.include(output, "reviewers: 1 lens — smoke-lens")
    assert.include(output, "sources: 3 files match")
    assert.include(output, "coverage 'cobol-paragraph': 3 units")
    assert.include(output, "0100-VALIDATE-INPUT")
    assert.include(output, "survey 'calls': 2 units — FEECALC, AUDITLOG")
    assert.include(output, "check passed with 0 warnings")
    assert.include(output, "modernize-survey --repo")
  })

  it("warns about a rule that captures nothing and a missing prompt, still exit 0", () => {
    const fixture = makeFixture()
    cobolEstate(fixture.legacy)
    write(
      fixture.root,
      "packs/typo/pack.md",
      [
        "# Pack: typo",
        "",
        "source: cobol",
        "sources: .*\\.(cbl|jcl)",
        "",
        "## Gates",
        "",
        "- test: sh scripts/test.sh",
        "",
        "## Judge",
        "",
        "- completeness (0..2): Is every rule captured?",
        "",
        "## Coverage: paragraph",
        "",
        "files: .*\\.cbl",
        "unit: ^ {7}(\\d{4}-[A-Z0-9-]+)\\.",
        "",
        "## Survey: copybooks",
        "",
        "files: .*\\.cbl",
        "unit: COPY ([A-Z0-9]+)",
        ""
      ].join("\n")
    )

    const result = runFlow(fixture, "modernize-pack-check", fixture.legacy, {
      LLM4TS_PACK: "packs/typo"
    })
    const output = `${result.stdout}${result.stderr}`
    assert.strictEqual(result.status, 0, failureReport("pack-check", result))
    assert.include(output, "warning: survey rule 'copybooks' captured no unit")
    assert.include(output, "warning: prompts/analysis.md not found (read by extract)")
    assert.include(output, "warning: no reviewers/*.md sidecar")
    assert.include(output, "check passed with 9 warnings")
  })

  it("fails when the sources regex matches nothing in the estate", () => {
    const fixture = makeFixture()
    const empty = join(mkdtempSync(join(tmpdir(), "llm4ts-pack-check-")), "estate")
    mkdirSync(empty, { recursive: true })
    initRepo(empty)
    write(empty, "notes.txt", "nothing legacy here\n")

    const result = runFlow(fixture, "modernize-pack-check", empty)
    assert.notStrictEqual(result.status, 0, "an estate with no sources must fail the check")
    assert.include(`${result.stdout}${result.stderr}`, "matched no file under")
  })

  it("fails when the manifest does not load", () => {
    const fixture = makeFixture()
    cobolEstate(fixture.legacy)
    write(fixture.root, "packs/broken/pack.md", "# Pack: broken\n\nsources: .*\n")

    const result = runFlow(fixture, "modernize-pack-check", fixture.legacy, {
      LLM4TS_PACK: "packs/broken"
    })
    assert.notStrictEqual(result.status, 0, "a manifest without 'source:' must fail the check")
    assert.include(`${result.stdout}${result.stderr}`, "missing a 'source:' field")
  })
})
