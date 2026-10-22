import { assert, describe, it } from "@effect/vitest"
import { approveMarkdown } from "@llm4ts/flow/Approval"

describe("approveMarkdown", () => {
  it("flips the draft marker and leaves an approved document alone", () => {
    assert.strictEqual(approveMarkdown("# x\n\n- [ ] Approved\n"), "# x\n\n- [x] Approved\n")
    assert.strictEqual(approveMarkdown("# x\n\n- [x] Approved\n"), "# x\n\n- [x] Approved\n")
    assert.strictEqual(approveMarkdown("# no marker\n"), "# no marker\n")
  })
})
