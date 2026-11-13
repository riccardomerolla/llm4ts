import { assert, describe, it } from "@effect/vitest"
import { apiPresetFor, coderFor, coderIds } from "@llm4ts/runner/Connectors"

describe("connector names", () => {
  it("keeps every coder name and the connector it stands for", () => {
    assert.deepStrictEqual(coderIds, [
      "agy",
      "antigravity",
      "antigravity-cli",
      "claude",
      "claude-cli",
      "codex",
      "cursor",
      "gemini",
      "gemini-cli",
      "grok",
      "opencode",
      "pi"
    ])
    assert.isTrue(Object.isFrozen(coderIds))
    assert.deepStrictEqual(
      coderIds.map((name) => coderFor(name)?.connectorId.value),
      [
        "antigravity-cli",
        "antigravity-cli",
        "antigravity-cli",
        "claude-cli",
        "claude-cli",
        "codex",
        "cursor",
        "gemini-cli",
        "gemini-cli",
        "grok",
        "opencode",
        "pi"
      ]
    )
    assert.strictEqual(coderFor("  Claude ")?.connectorId.value, "claude-cli")
    assert.deepStrictEqual(coderFor("claude")?.flags, { "permission-mode": "acceptEdits" })
    assert.deepStrictEqual(coderFor("codex")?.flags, { sandbox: "workspace-write" })
    assert.deepStrictEqual(coderFor("agy")?.flags, { mode: "accept-edits" })
    for (const name of ["nope", "mock", "openai", "lm-studio", ""]) {
      assert.isUndefined(coderFor(name))
    }
  })

  it("keeps every API provider name and the connector it stands for", () => {
    const names = [
      "mock",
      "openai",
      "anthropic",
      "gemini",
      "gemini-api",
      "lm-studio",
      "lmstudio",
      "ollama",
      "mlx-lm",
      "mlxlm",
      "mlx"
    ]
    assert.deepStrictEqual(
      names.map((name) => {
        const preset = apiPresetFor(name)
        return [preset?.connectorId.value, preset?.model, preset?.baseUrl]
      }),
      [
        ["mock", "mock", undefined],
        ["openai", undefined, undefined],
        ["anthropic", undefined, undefined],
        ["gemini-api", undefined, undefined],
        ["gemini-api", undefined, undefined],
        ["lm-studio", undefined, "http://localhost:1234/v1"],
        ["lm-studio", undefined, "http://localhost:1234/v1"],
        ["ollama", undefined, undefined],
        ["mlx-lm", undefined, "http://localhost:8080"],
        ["mlx-lm", undefined, "http://localhost:8080"],
        ["mlx-lm", undefined, "http://localhost:8080"]
      ]
    )
    assert.strictEqual(apiPresetFor(" LMStudio ")?.connectorId.value, "lm-studio")
    for (const name of ["claude", "gemini-cli", "opencode", "nope", ""]) {
      assert.isUndefined(apiPresetFor(name))
    }
  })
})
