import assert from "node:assert/strict"
import { test } from "node:test"
import { syncCheckboxes } from "./CheckboxSync.ts"

const spec = ["# Spec", "", "- [ ] one", "- [ ] two", "- [ ] three", ""].join("\n")

test("checks the first N boxes when a run is partial", () => {
  const result = syncCheckboxes(spec, 2, false)
  assert.equal(result.total, 3)
  assert.equal(result.flipped, 2)
  assert.match(result.markdown, /- \[x\] one/)
  assert.match(result.markdown, /- \[x\] two/)
  assert.match(result.markdown, /- \[ \] three/)
})

test("checks every box when the plan is fully complete", () => {
  const result = syncCheckboxes(spec, 1, true)
  assert.equal(result.flipped, 3)
  assert.doesNotMatch(result.markdown, /- \[ \]/)
})

test("never unchecks an already-checked box", () => {
  const partial = ["- [x] done", "- [ ] pending"].join("\n")
  const result = syncCheckboxes(partial, 0, false)
  assert.equal(result.flipped, 0)
  assert.equal(result.markdown, partial)
})

test("is idempotent", () => {
  const once = syncCheckboxes(spec, 3, true)
  const twice = syncCheckboxes(once.markdown, 3, true)
  assert.equal(twice.flipped, 0)
  assert.equal(twice.markdown, once.markdown)
})

test("preserves indentation and documents with no checkboxes", () => {
  assert.equal(syncCheckboxes("# nothing here", 5, true).total, 0)
  const nested = "  - [ ] indented"
  assert.equal(syncCheckboxes(nested, 1, false).markdown, "  - [x] indented")
})
