import { assert, describe, it } from "@effect/vitest"
import {
  ConnectorIds,
  LlmProvider,
  apiConnectorIds,
  cliConnectorIds,
  connectorDefaultBaseUrl,
  connectorIds,
  connectorProvider,
  defaultBaseUrl,
  providerConnectorId
} from "@llm4ts/core/Models"

const values = (ids: ReadonlyArray<{ readonly value: string }>): ReadonlyArray<string> =>
  ids.map((id) => id.value)

describe("connector identity", () => {
  it("keeps every connector id under its name, in order", () => {
    assert.deepStrictEqual(
      Object.entries(ConnectorIds).map(([name, id]) => [name, id.value]),
      [
        ["OpenAI", "openai"],
        ["Anthropic", "anthropic"],
        ["GeminiApi", "gemini-api"],
        ["LmStudio", "lm-studio"],
        ["Ollama", "ollama"],
        ["MlxLm", "mlx-lm"],
        ["ClaudeCli", "claude-cli"],
        ["GeminiCli", "gemini-cli"],
        ["OpenCode", "opencode"],
        ["Codex", "codex"],
        ["Copilot", "copilot"],
        ["Pi", "pi"],
        ["AntigravityCli", "antigravity-cli"],
        ["Grok", "grok"],
        ["Cursor", "cursor"],
        ["Mock", "mock"]
      ]
    )
    assert.isTrue(Object.isFrozen(ConnectorIds))
  })

  it("keeps the id lists and their order", () => {
    assert.deepStrictEqual(values(apiConnectorIds), [
      "openai",
      "anthropic",
      "gemini-api",
      "lm-studio",
      "ollama",
      "mlx-lm"
    ])
    assert.deepStrictEqual(values(cliConnectorIds), [
      "claude-cli",
      "gemini-cli",
      "opencode",
      "codex",
      "copilot",
      "pi",
      "antigravity-cli",
      "grok",
      "cursor"
    ])
    assert.deepStrictEqual(values(connectorIds), [
      ...values(apiConnectorIds),
      ...values(cliConnectorIds),
      "mock"
    ])
    assert.isTrue(Object.isFrozen(apiConnectorIds))
    assert.isTrue(Object.isFrozen(cliConnectorIds))
    assert.isTrue(Object.isFrozen(connectorIds))
    assert.strictEqual(apiConnectorIds[0], ConnectorIds.OpenAI)
    assert.strictEqual(connectorIds[15], ConnectorIds.Mock)
  })

  it("keeps every provider's default base URL and connector", () => {
    assert.deepStrictEqual(
      LlmProvider.literals.map((provider) => [
        provider,
        defaultBaseUrl(provider),
        providerConnectorId(provider).value
      ]),
      [
        ["GeminiCli", undefined, "gemini-cli"],
        ["GeminiApi", "https://generativelanguage.googleapis.com", "gemini-api"],
        ["OpenAI", "https://api.openai.com/v1", "openai"],
        ["Anthropic", "https://api.anthropic.com", "anthropic"],
        ["LmStudio", "http://localhost:1234/v1", "lm-studio"],
        ["Ollama", "http://localhost:11434", "ollama"],
        ["MlxLm", "http://localhost:8080", "mlx-lm"],
        ["OpenCode", "http://localhost:4096", "opencode"],
        ["Mock", undefined, "mock"]
      ]
    )
    assert.strictEqual(providerConnectorId("OpenAI"), ConnectorIds.OpenAI)
  })

  it("keeps every connector's provider and default base URL", () => {
    assert.deepStrictEqual(
      connectorIds.map((id) => [id.value, connectorProvider(id), connectorDefaultBaseUrl(id)]),
      [
        ["openai", "OpenAI", "https://api.openai.com/v1"],
        ["anthropic", "Anthropic", "https://api.anthropic.com"],
        ["gemini-api", "GeminiApi", "https://generativelanguage.googleapis.com"],
        ["lm-studio", "LmStudio", "http://localhost:1234/v1"],
        ["ollama", "Ollama", "http://localhost:11434"],
        ["mlx-lm", "MlxLm", "http://localhost:8080"],
        ["claude-cli", undefined, undefined],
        ["gemini-cli", "GeminiCli", undefined],
        ["opencode", "OpenCode", "http://localhost:4096"],
        ["codex", undefined, undefined],
        ["copilot", undefined, undefined],
        ["pi", undefined, undefined],
        ["antigravity-cli", undefined, undefined],
        ["grok", undefined, undefined],
        ["cursor", undefined, undefined],
        ["mock", "Mock", undefined]
      ]
    )
  })
})
