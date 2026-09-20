import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
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

/**
 * A wave-scoped extraction (`LLM4TS_WAVE`) must be able to clear its gate:
 * the coverage rules capture units across the WHOLE estate, but only the
 * units captured from the wave's own program files gate this run — the rest
 * belong to later waves and are reported, not failed. Before this, no wave
 * but the last could ever clear, and every earlier wave burned its fix
 * rounds on findings it could not address (found in the 2026-09-14 workshop
 * rehearsal).
 */
const stubClaude = `#!/usr/bin/env node
const chunks = []
process.stdin.on("data", (chunk) => chunks.push(chunk))
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8")
  const program = /ONE source unit of this repository: \\S*?([A-Z0-9]+)\\.(cbl|CBL|jcl|JCL)/.exec(prompt)
  let reply
  if (program !== null) {
    const name = program[1]
    // Each analyst covers ONLY its own program's paragraphs.
    const trace = { FEECALC: "0100-COMPUTE-FEE — Rule 1\\n", ACCTXFR: "0100-VALIDATE-INPUT — Rule 1\\n0200-POST-LEDGER — Rule 1\\n", RUNJOB: "STEP1 — Rule 1\\n" }
    reply = {
      spec: "# " + name + "\\n\\nRule 1: the unit performs its documented work.\\n",
      feature: "Feature: " + name + "\\n\\n  Scenario: happy path\\n    Given a valid request\\n    When " + name + " runs\\n    Then it succeeds\\n",
      traceability: trace[name] ?? "",
      mapping: "LEDGER table -> Ledger entity\\n"
    }
  } else if (prompt.includes("planning assistant")) {
    reply = { epicId: "fees", tasks: [{ title: "Implement fee calculation", description: "Rule 1", completed: false }] }
  } else {
    reply = {
      scores: [
        { name: "completeness", score: 2, reasoning: "every rule captured" },
        { name: "faithfulness", score: 2, reasoning: "grounded in source" }
      ],
      summary: "clean"
    }
  }
  const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
  emit({ type: "system", subtype: "init", model: "stub-claude-1" })
  emit({ type: "assistant", message: { content: [{ type: "text", text: JSON.stringify(reply) }] } })
  emit({ type: "result", usage: { input_tokens: 100, output_tokens: 40 } })
})
`

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
  write(
    root,
    "docs/modernization/wave-plan.md",
    [
      "# Modernization wave plan",
      "",
      "## Wave: wave-1",
      "",
      "- FEECALC",
      "",
      "## Wave: wave-2",
      "",
      "- ACCTXFR",
      "- RUNJOB",
      "",
      "- [x] Approved",
      ""
    ].join("\n")
  )
  commitAll(root, "legacy estate with an approved wave plan")
}

describe("modernize-extract scoped to one wave (model stubbed)", { timeout: smokeTimeout }, () => {
  it("clears the gate on the wave's own units and reports the other waves' as not gating", () => {
    const fixture = makeFixture()
    installStub(fixture, stubClaude)
    estate(fixture.legacy)

    const extract = runFlow(fixture, "modernize-extract", fixture.legacy, { LLM4TS_WAVE: "wave-1" })
    const output = `${extract.stdout}${extract.stderr}`
    assert.strictEqual(extract.status, 0, failureReport("extract wave-1", extract))
    assert.include(output, "belong to other waves and do not gate 'wave-1'")
    assert.include(output, "cobol-paragraph: 0100-VALIDATE-INPUT")
    assert.include(output, "run modernize-extract without LLM4TS_WAVE after the last wave")

    const log = execFileSync("git", ["log", "--oneline"], { cwd: fixture.legacy, encoding: "utf8" })
    assert.include(log, "spec FEECALC")
    assert.notInclude(log, "spec ACCTXFR")
    assert.include(readFile(join(fixture.legacy, "docs/modernization/README.md")), "PASSED")
  })
})

const readFile = (path: string): string => execFileSync("cat", [path], { encoding: "utf8" })
