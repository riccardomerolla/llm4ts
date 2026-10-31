import { assert, describe, it } from "@effect/vitest"
import {
  memoryDir,
  parseNote,
  recall,
  renderRunNote,
  RunNote,
  runNotesDir
} from "@llm4ts/flow/Memory"

describe("memory notes (ADR 0047 decision 10, ADR 0007 first slice)", () => {
  const notes = [
    parseNote(
      "auth",
      "# Auth module\n\n## Sessions\n\nSessions live in Redis.\n\n## Gateway\n\nKong fronts it."
    ),
    parseNote("billing", "# Billing\n\n## Invoices\n\nMonthly."),
    parseNote("untitled", "No heading here, but the gateway is mentioned once."),
    parseNote(
      "runs/2026-10-30-auth",
      "# Run: auth gateway spike\n\n## Decisions\n\n- Kong stays.\n\n## Failed\n\n- Envoy build."
    )
  ]

  it("a note's title is its first heading, else its name; headings are the ## lines", () => {
    assert.strictEqual(notes[0]?.title, "Auth module")
    assert.deepStrictEqual(notes[0]?.headings, ["Sessions", "Gateway"])
    assert.strictEqual(notes[2]?.title, "untitled")
    assert.deepStrictEqual(notes[2]?.headings, [])
  })

  it("recall ranks by keyword overlap with the goal, title and headings counting double, nothing by name order", () => {
    const found = recall("Move the auth gateway sessions to Envoy", notes, 5)
    assert.deepStrictEqual(
      found.map((note) => note.name),
      ["auth", "runs/2026-10-30-auth", "untitled"]
    )
    assert.deepStrictEqual(
      recall("Invoices", notes, 1).map((note) => note.name),
      ["billing"]
    )
    assert.deepStrictEqual(recall("nothing matches this", notes, 5), [])
  })

  it("a run note renders its four sections", () => {
    const text = renderRunNote(
      "auth-gateway",
      "Move auth behind the gateway.",
      RunNote.make({
        decisions: ["Kong stays."],
        preferences: ["The owner removed the Envoy brief."],
        failed: [],
        pointers: ["reports/B2.md"]
      })
    )
    assert.include(text, "# Run: auth-gateway")
    assert.include(text, "Goal: Move auth behind the gateway.")
    assert.include(text, "## Decisions\n\n- Kong stays.")
    assert.include(text, "## Failed\n\n- none")
    assert.include(text, "## Pointers\n\n- reports/B2.md")
  })

  it("places", () => {
    assert.strictEqual(memoryDir("/repo"), "/repo/.llm4ts/memory")
    assert.strictEqual(runNotesDir("/repo"), "/repo/.llm4ts/memory/runs")
  })
})
