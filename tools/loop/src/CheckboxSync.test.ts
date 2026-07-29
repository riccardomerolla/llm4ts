import assert from "node:assert/strict"
import { test } from "node:test"
import { parseChecklist, syncCheckboxes } from "./CheckboxSync.ts"

const spec = ["# Spec", "", "- [ ] one", "- [ ] two", "- [ ] three", ""].join("\n")

test("checks the first N boxes when a run is partial", () => {
  const result = syncCheckboxes(spec, 2, false, 3)
  assert.equal(result.total, 3)
  assert.equal(result.flipped, 2)
  assert.match(result.markdown, /- \[x\] one/)
  assert.match(result.markdown, /- \[x\] two/)
  assert.match(result.markdown, /- \[ \] three/)
})

test("checks every box when the plan is fully complete", () => {
  const result = syncCheckboxes(spec, 1, true, 10)
  assert.equal(result.flipped, 3)
  assert.doesNotMatch(result.markdown, /- \[ \]/)
})

test("never unchecks an already-checked box", () => {
  const partial = ["- [x] done", "- [ ] pending"].join("\n")
  const result = syncCheckboxes(partial, 0, false, 2)
  assert.equal(result.flipped, 0)
  assert.equal(result.markdown, partial)
})

test("is idempotent", () => {
  const once = syncCheckboxes(spec, 3, true, 3)
  const twice = syncCheckboxes(once.markdown, 3, true, 3)
  assert.equal(twice.flipped, 0)
  assert.equal(twice.markdown, once.markdown)
})

test("preserves indentation and documents with no checkboxes", () => {
  assert.equal(syncCheckboxes("# nothing here", 5, true, 5).total, 0)
  const nested = "  - [ ] indented"
  assert.equal(syncCheckboxes(nested, 1, false, 1).markdown, "  - [x] indented")
})

test("refuses partial sync when plan tasks and spec checkboxes disagree", () => {
  const result = syncCheckboxes(spec, 2, false, 10)
  assert.equal(result.flipped, 0)
  assert.equal(result.markdown, spec)
})

test("still checks every box on full completion despite a count mismatch", () => {
  const result = syncCheckboxes(spec, 10, true, 10)
  assert.equal(result.flipped, 3)
  assert.doesNotMatch(result.markdown, /- \[ \]/)
})

test("parses checklist items with continuation lines and checked state", () => {
  const doc = [
    "# Spec",
    "",
    "- [ ] first task title",
    "      with a continuation line",
    "- [x] second, already done",
    "",
    "Some prose that is not a checklist item.",
    "",
    "- [ ] third"
  ].join("\n")
  const items = parseChecklist(doc)
  assert.equal(items.length, 3)
  assert.equal(items[0]?.text, "first task title\nwith a continuation line")
  assert.equal(items[0]?.checked, false)
  assert.equal(items[1]?.text, "second, already done")
  assert.equal(items[1]?.checked, true)
  assert.equal(items[2]?.text, "third")
})

test("returns an empty checklist for documents without checkboxes", () => {
  assert.equal(parseChecklist("# just prose\n\nnothing here").length, 0)
})
