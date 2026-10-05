import { assert, describe, it } from "@effect/vitest"
import {
  appendNote,
  findingsIn,
  findingsRequest,
  notesHeading,
  withNotes
} from "@llm4ts/flow/CarriedNotes"

describe("findingsIn", () => {
  it("takes the text after the last Findings heading", () => {
    const reply = [
      "I added the page.",
      "",
      "## Findings",
      "- tests live beside the feature (page.test.tsx)",
      "- the kit Table takes `rows` and `columns`"
    ].join("\n")
    assert.strictEqual(
      findingsIn(reply),
      "- tests live beside the feature (page.test.tsx)\n- the kit Table takes `rows` and `columns`"
    )
    assert.strictEqual(findingsIn("### findings\nonly this"), "only this")
  })

  it("is undefined without a heading or with an empty section, and keeps BLOCKED_ON out of it", () => {
    assert.isUndefined(findingsIn("done, nothing to report"))
    assert.isUndefined(findingsIn("## Findings\n\n   "))
    assert.strictEqual(
      findingsIn("## Findings\n- the route exists\nBLOCKED_ON: src/kit/Money.ts from story kit"),
      "- the route exists"
    )
  })

  it("caps a long section", () => {
    const long = `## Findings\n${"x".repeat(5_000)}`
    const found = findingsIn(long)
    assert.isDefined(found)
    assert.isAtMost(found.length, 1_500)
  })
})

describe("appendNote and withNotes", () => {
  it("adds a titled section and drops the oldest when over the limit", () => {
    const first = appendNote(undefined, "first task", "- a")
    assert.strictEqual(first, "### first task\n- a")
    const second = appendNote(first, "second task", "- b")
    assert.strictEqual(second, "### first task\n- a\n\n### second task\n- b")
    const trimmed = appendNote(second, "third task", `- ${"c".repeat(40)}`, 60)
    assert.notInclude(trimmed, "### first task")
    assert.include(trimmed, "### third task")
  })

  it("the newest section always survives, even alone over the limit", () => {
    const only = appendNote(undefined, "big", "y".repeat(100), 20)
    assert.include(only, "### big")
  })

  it("withNotes prepends what earlier tasks learned, or leaves the prompt alone", () => {
    assert.strictEqual(withNotes("do it", undefined), "do it")
    assert.strictEqual(withNotes("do it", "   "), "do it")
    const prompt = withNotes("do it", "### first\n- tests live in src/x")
    assert.isTrue(prompt.startsWith("What earlier tasks of this story learned"))
    assert.include(prompt, "- tests live in src/x")
    assert.isTrue(prompt.endsWith("do it"))
  })

  it("the request names the heading and keeps BLOCKED_ON last", () => {
    assert.include(findingsRequest, notesHeading)
    assert.include(findingsRequest, "BLOCKED_ON:")
  })
})
