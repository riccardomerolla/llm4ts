import { assert, describe, it } from "@effect/vitest"
import { coderChoices, resolvedCoderToken } from "@llm4ts/shell/CoderChoice"

describe("coder choices", () => {
  it("offers the same coders, in the same order, each with its executable", () => {
    assert.deepStrictEqual(coderChoices, [
      { token: "claude", executable: "claude" },
      { token: "codex", executable: "codex" },
      { token: "gemini", executable: "gemini" },
      { token: "pi", executable: "pi" },
      { token: "agy", executable: "agy" },
      { token: "grok", executable: "grok" },
      { token: "cursor", executable: "cursor-agent" },
      { token: "opencode", executable: "opencode" }
    ])
  })

  it("reads an offered token and falls back to claude for anything else", () => {
    assert.strictEqual(resolvedCoderToken({ LLM4TS_CODER: "agy" }), "agy")
    assert.strictEqual(resolvedCoderToken({ LLM4TS_CODER: "copilot" }), "claude")
    assert.strictEqual(resolvedCoderToken({ LLM4TS_CODER: "claude-cli" }), "claude")
    assert.strictEqual(resolvedCoderToken({}), "claude")
    assert.strictEqual(resolvedCoderToken({ LLM4TS_CODER: " Grok " }), "grok")
    assert.strictEqual(resolvedCoderToken({ LLM4TS_CODER: "" }), "claude")
  })
})
