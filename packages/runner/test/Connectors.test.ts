import { assert, describe, it } from "@effect/vitest"
import {
  antigravity,
  claude,
  coderFromEnv,
  codex,
  cursor,
  gemini,
  grok,
  lmStudio,
  opencode,
  pi,
  withModel,
  withTurnLimit
} from "@llm4ts/runner/Connectors"

describe("runner connector presets", () => {
  it("targets edit-capable defaults", () => {
    assert.strictEqual(claude.connectorId.value, "claude-cli")
    assert.deepStrictEqual(claude.flags, {
      "permission-mode": "acceptEdits"
    })
    assert.deepStrictEqual(codex.flags, {
      sandbox: "workspace-write"
    })
    assert.strictEqual(gemini.connectorId.value, "gemini-cli")
    assert.strictEqual(pi.connectorId.value, "pi")
    assert.deepStrictEqual(antigravity.flags, {
      mode: "accept-edits"
    })
    assert.strictEqual(grok.connectorId.value, "grok")
    assert.strictEqual(cursor.connectorId.value, "cursor")
    assert.strictEqual(opencode.connectorId.value, "opencode")
  })

  it("provides a local LM Studio reasoning seat", () => {
    assert.strictEqual(lmStudio.connectorId.value, "lm-studio")
    assert.strictEqual(lmStudio.baseUrl, "http://localhost:1234/v1")
  })

  it("composes model and turn-limit transforms immutably", () => {
    const configured = withTurnLimit(withModel(gemini, "gemini-2.5-pro"), 40)

    assert.strictEqual(configured.model, "gemini-2.5-pro")
    assert.strictEqual(configured.turnLimit, 40)
    assert.strictEqual(gemini.model, undefined)
    assert.strictEqual(gemini.turnLimit, undefined)
  })

  it("selects from LLM4ZIO_CODER and defaults to Claude", () => {
    assert.strictEqual(coderFromEnv({}), claude)
    assert.strictEqual(coderFromEnv({ LLM4ZIO_CODER: "codex" }), codex)
    assert.strictEqual(coderFromEnv({ LLM4ZIO_CODER: "gemini" }), gemini)
    assert.strictEqual(coderFromEnv({ LLM4ZIO_CODER: "pi" }), pi)
    assert.strictEqual(coderFromEnv({ LLM4ZIO_CODER: "agy" }), antigravity)
    assert.strictEqual(coderFromEnv({ LLM4ZIO_CODER: "grok" }), grok)
    assert.strictEqual(coderFromEnv({ LLM4ZIO_CODER: "cursor" }), cursor)
    assert.strictEqual(coderFromEnv({ LLM4ZIO_CODER: "opencode" }), opencode)
    assert.strictEqual(coderFromEnv({ LLM4ZIO_CODER: "unknown" }), claude)
  })
})
