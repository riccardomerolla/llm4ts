import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import {
  failureReport,
  installStub,
  makeFixture,
  runFlow,
  smokeTimeout,
  stubProgram,
  write
} from "./support/smoke.ts"

// The stub plays every persona: the PO opens item 1 with a proposal, everyone
// else passes, the Scribe answers the draft prompt. Replies are chosen by
// prompt content, so the same program serves the agenda, every turn and the
// drafts.
const respondSource = `(prompt) => {
  if (prompt.includes("Propose the agenda")) {
    return JSON.stringify({ items: [
      { title: "Scope", question: "Which rails are in the first release?" },
      { title: "Integration", question: "Events or calls between the hub and the ledger?" },
      { title: "Operations", question: "What must be true to run it?" }
    ] })
  }
  if (prompt.includes('"outline":')) {
    return JSON.stringify({
      outline: "# Outline: Payments hub\\n\\n## Context\\n\\nCards first, per the bank's API standard.",
      plan: "# Plan: Payments hub\\n\\n## Phases\\n\\n1. Cards."
    })
  }
  if (prompt.includes("You are the PO") && prompt.includes("Agenda item 1.") && prompt.includes("(nobody has spoken yet)")) {
    return JSON.stringify({ kind: "proposal", answers: [], blocking: false, needsHuman: false, body: "Cards first." })
  }
  return JSON.stringify({ kind: "pass", answers: [], blocking: false, needsHuman: false, body: "" })
}`

describe("roundtable", { timeout: smokeTimeout }, () => {
  it("runs a meeting end to end from the command line and leaves the files", () => {
    const fixture = makeFixture()
    installStub(fixture, stubProgram(respondSource))
    write(fixture.target, "docs/standards/api.md", "# API standard\n\nEvery API is versioned.\n")

    const result = runFlow(fixture, "roundtable", fixture.target, {}, "Payments hub", [
      "--",
      "--goal",
      "An outline the committee can approve.",
      "--agents",
      "PO,SRE",
      "--context",
      "docs/standards",
      "--no-pause"
    ])
    assert.strictEqual(result.status, 0, failureReport("roundtable", result))

    const dir = join(fixture.target, ".llm4ts", "meetings", "payments-hub")
    const meeting = readFileSync(join(dir, "meeting.md"), "utf8")
    assert.include(meeting, "Status: done")
    assert.include(meeting, "Attendees: PO, SRE")
    assert.include(meeting, "1. Scope — Which rails are in the first release?")
    assert.include(readFileSync(join(dir, "discussion.md"), "utf8"), "Settled.")
    assert.include(readFileSync(join(dir, "decisions.md"), "utf8"), "## 1. Cards first.")
    assert.include(readFileSync(join(dir, "outline.md"), "utf8"), "# Outline: Payments hub")
    assert.include(readFileSync(join(dir, "plan.md"), "utf8"), "## Phases")
    assert.isTrue(existsSync(join(dir, "open-questions.md")))
    assert.isTrue(existsSync(join(dir, "turns.jsonl")))
    assert.include(result.stdout, "roundtable payments-hub done")

    // A second run finds nothing to do and asks nobody.
    const again = runFlow(fixture, "roundtable", fixture.target, {}, undefined, [
      "--",
      "--meeting",
      "payments-hub"
    ])
    assert.strictEqual(again.status, 0, failureReport("roundtable again", again))
    assert.include(again.stdout, "is done")
  })

  it("ejects the bundled persona cards and lists them", () => {
    const fixture = makeFixture()
    installStub(fixture, stubProgram(respondSource))
    mkdirSync(fixture.target, { recursive: true })
    const ejected = runFlow(fixture, "roundtable", fixture.target, {}, undefined, [
      "--",
      "--eject-personas"
    ])
    assert.strictEqual(ejected.status, 0, failureReport("eject", ejected))
    assert.isTrue(existsSync(join(fixture.target, ".llm4ts", "personas", "Cloud Architect.md")))
    assert.isTrue(existsSync(join(fixture.target, ".llm4ts", "personas", "Scribe.md")))
    const listed = runFlow(fixture, "roundtable", fixture.target, {}, undefined, ["--", "--list"])
    assert.strictEqual(listed.status, 0, failureReport("list", listed))
    assert.include(listed.stdout, "SRE")
    assert.include(listed.stdout, "no meetings")
  })
})
