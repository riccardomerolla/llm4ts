import { assert, describe, it } from "@effect/vitest"
import { ApiConnectorConfig, toLlmConfig } from "@llm4ts/core/ConnectorConfig"
import { ConnectorId, connectorIds } from "@llm4ts/core/Models"

const providerFor = (id: string): string =>
  toLlmConfig(ApiConnectorConfig.make({ connectorId: new ConnectorId({ value: id }) })).provider

describe("toLlmConfig", () => {
  it("reads each connector's provider from its row, OpenAI where the row has none", () => {
    assert.deepStrictEqual(
      connectorIds.map((id) => [id.value, providerFor(id.value)]),
      [
        ["openai", "OpenAI"],
        ["anthropic", "Anthropic"],
        ["gemini-api", "GeminiApi"],
        ["lm-studio", "LmStudio"],
        ["ollama", "Ollama"],
        ["mlx-lm", "MlxLm"],
        ["claude-cli", "OpenAI"],
        ["gemini-cli", "GeminiCli"],
        ["opencode", "OpenAI"],
        ["codex", "OpenAI"],
        ["pi", "OpenAI"],
        ["antigravity-cli", "OpenAI"],
        ["grok", "OpenAI"],
        ["cursor", "OpenAI"],
        ["mock", "Mock"]
      ]
    )
  })

  it("reads an id the table does not name as OpenAI, the wire most servers speak", () => {
    assert.strictEqual(providerFor("my-gateway"), "OpenAI")
  })
})
