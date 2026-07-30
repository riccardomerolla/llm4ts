import { existsSync, readFileSync, rmSync } from "node:fs"
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
  write,
  writeExecutable,
  type Fixture
} from "./support/smoke.ts"

/**
 * Phase 4 with the model stubbed but the equivalence machinery real: vectors
 * are generated, written as JSONL, replayed through the pack's own `replay:`
 * command as a subprocess, and diffed under the pack's comparison policy.
 *
 * The replay script is a genuine harness — it reads a vector on stdin and
 * prints observations on stdout — so the wiring under test is the same one a
 * production run uses. Whether the run proves equivalence or files fixes is
 * decided by that script alone.
 */
const vectors = {
  vectors: [
    {
      id: "happy-path",
      rules: ["0100-VALIDATE-INPUT"],
      inputs: { amount: "100.00" },
      observations: [
        { kind: "record", channel: "LEDGER", op: "", key: {}, fields: { amount: "100.00" } }
      ]
    },
    {
      id: "reject-overdraft",
      rules: ["0200-POST-LEDGER"],
      inputs: { amount: "-1.00" },
      observations: [
        { kind: "record", channel: "REJECT", op: "", key: {}, fields: { reason: "OVERDRAFT" } }
      ]
    }
  ]
}

const triage = {
  fixes: [
    {
      title: "Reject reason must be OVERDRAFT",
      spec: "The spec requires reason=OVERDRAFT; the implementation emits DECLINED.",
      taskTitle: "Emit OVERDRAFT as the reject reason",
      taskDescription: "Align the reject record with rule 0200-POST-LEDGER."
    }
  ]
}

const responder = [
  "(prompt) => {",
  '  if (prompt.includes("Generate equivalence test vectors")) {',
  `    return ${JSON.stringify(JSON.stringify(vectors))}`,
  "  }",
  '  if (prompt.includes("replayed test vectors against the implementation")) {',
  `    return ${JSON.stringify(JSON.stringify(triage))}`,
  "  }",
  '  return "{}"',
  "}"
].join("\n")

/**
 * A faithful replay harness: it echoes back each vector's own expected
 * observations, so equivalence holds. `REPLAY_BREAK` makes it emit a wrong
 * reason code instead, which is what a real regression looks like.
 */
const replayScript = [
  "#!/bin/sh",
  "exec node -e '",
  "const chunks = []",
  'process.stdin.on("data", (c) => chunks.push(c))',
  'process.stdin.on("end", () => {',
  '  const vector = JSON.parse(Buffer.concat(chunks).toString("utf8"))',
  "  const actual = vector.observations.map((observation) => {",
  "    if (process.env.REPLAY_BREAK && observation.fields && observation.fields.reason) {",
  '      return { ...observation, fields: { ...observation.fields, reason: "DECLINED" } }',
  "    }",
  "    return observation",
  "  })",
  "  process.stdout.write(JSON.stringify(actual))",
  "})",
  "'"
].join("\n")

const seedTarget = (fixture: Fixture): void => {
  initRepo(fixture.target)
  write(fixture.target, "docs/specs/ACCTXFR.md", "# ACCTXFR\n\nRule 1: post the ledger.\n")
  write(fixture.target, "docs/specs/traceability.md", "0100-VALIDATE-INPUT — Rule 1\n")
  // The frozen rule universe extraction wrote; verify reports against it and
  // never re-enumerates from legacy source.
  write(
    fixture.target,
    "docs/specs/rules.txt",
    "0100-VALIDATE-INPUT\n0200-POST-LEDGER\n0300-AUDIT\n"
  )
  write(fixture.target, "features/acctxfr.feature", "Feature: ACCTXFR\n")
  write(
    fixture.target,
    "docs/modernization/plan.md",
    "# Plan: meridian-transfers\n\n## [x] Implement transfer posting\nDone.\n"
  )
  write(
    fixture.target,
    "docs/modernization/provenance.json",
    JSON.stringify({
      schema: 1,
      pack: "smoke",
      llm4tsVersion: "0.0.0-test",
      createdAt: "2026-01-01T00:00:00.000Z",
      seats: {},
      specs: {},
      gateVerdicts: {},
      fixSpecs: []
    })
  )
  writeExecutable(fixture.target, "scripts/replay.sh", replayScript)
  commitAll(fixture.target, "seeded target")
}

describe("modernize-verify end to end (model stubbed, replay real)", () => {
  it("generates vectors, replays them, and proves equivalence", () => {
    const fixture = makeFixture()
    try {
      seedTarget(fixture)
      installStub(fixture, stubProgram(responder))

      const result = runFlow(fixture, "modernize-verify", fixture.target)
      assert.strictEqual(result.status, 0, failureReport("verify", result))

      // Vectors are persisted per program so a rerun resumes.
      const vectorFile = join(fixture.target, "docs/modernization/vectors/ACCTXFR.jsonl")
      assert.isTrue(existsSync(vectorFile), "vectors should persist per program")
      const lines = readFileSync(vectorFile, "utf8").trim().split("\n")
      assert.lengthOf(lines, 2, "both generated vectors should be written")
      for (const line of lines) {
        const parsed: unknown = JSON.parse(line)
        assert.isObject(parsed)
      }

      // The report covers the FROZEN rule universe, including the rule no
      // vector exercises — that gap is the point of reporting against rules.txt.
      const report = readFileSync(join(fixture.target, "docs/modernization/equivalence.md"), "utf8")
      assert.include(report, "0100-VALIDATE-INPUT")
      assert.include(report, "0200-POST-LEDGER")
      assert.include(report, "UNEXERCISED", "0300-AUDIT has no vector and must be flagged")

      // Provenance carries the equivalence report's hash: the clean-room receipt.
      const provenance = readFileSync(
        join(fixture.target, "docs/modernization/provenance.json"),
        "utf8"
      )
      assert.include(provenance, '"equivalenceReport"')

      // No failures, so no fix specs and no plan increment.
      assert.isFalse(existsSync(join(fixture.target, "docs/specs/fixes")))
      const plan = readFileSync(join(fixture.target, "docs/modernization/plan.md"), "utf8")
      assert.notInclude(plan, "Emit OVERDRAFT as the reject reason")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("triages a mismatch into fix specs and plan tasks, and fails the run", () => {
    const fixture = makeFixture()
    try {
      seedTarget(fixture)
      installStub(fixture, stubProgram(responder))

      // The harness now emits the wrong reason code for the reject vector.
      const result = runFlow(fixture, "modernize-verify", fixture.target, { REPLAY_BREAK: "1" })
      assert.notStrictEqual(result.status, 0, "a failing vector must fail the phase")
      assert.include(`${result.stdout}${result.stderr}`, "equivalence not proven")

      // The mismatch is reported, not swallowed.
      const report = readFileSync(join(fixture.target, "docs/modernization/equivalence.md"), "utf8")
      assert.include(report, "DECLINED", "the actual value should appear in the report")

      // Triage filed a fix spec and appended a plan task for another pass.
      const fix = join(fixture.target, "docs/specs/fixes/fix-reject-reason-must-be-overdraft.md")
      assert.isTrue(existsSync(fix), "a fix spec should be filed for the root cause")
      assert.include(readFileSync(fix, "utf8"), "OVERDRAFT")
      const plan = readFileSync(join(fixture.target, "docs/modernization/plan.md"), "utf8")
      assert.include(plan, "## [ ] Emit OVERDRAFT as the reject reason")
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
