import { assert, describe, it } from "@effect/vitest"
import { autonomyContract, withContract } from "@llm4ts/flow/AutonomyContract"

describe("autonomyContract", () => {
  it("the full profile carries every rule: unattended, scope, workspace, minimal change, no gaming, evidence", () => {
    const text = autonomyContract("full")
    for (const phrase of [
      "Nobody is watching",
      "whole scope",
      "The tool that runs you is not part of the",
      "smallest change",
      "Never edit, skip, delete or weaken a test",
      "Finish with evidence"
    ]) {
      assert.include(text, phrase)
    }
  })

  it("the minimal profile keeps scope, the workspace rule and the no-gaming rule only", () => {
    const text = autonomyContract("minimal")
    assert.include(text, "whole scope")
    assert.include(text, "do not look for its installation, source code, processes or environment")
    assert.include(text, "Never edit, skip, delete or weaken a test")
    assert.notInclude(text, "Nobody is watching")
    assert.notInclude(text, "Finish with evidence")
  })

  it("off is empty, and withContract leaves the system prompt as it was", () => {
    assert.strictEqual(autonomyContract("off"), "")
    assert.strictEqual(withContract("House rules.", "off"), "House rules.")
    assert.strictEqual(withContract(undefined, "off"), "")
  })

  it("withContract puts the contract first and the flow's own rules after a blank line", () => {
    const text = withContract("House rules.")
    assert.isTrue(text.startsWith("Nobody is watching"))
    assert.isTrue(text.endsWith("\n\nHouse rules."))
    assert.strictEqual(withContract(undefined), autonomyContract("full"))
  })
})
