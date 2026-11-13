import { assert, describe, it } from "@effect/vitest"
import {
  ConnectorIds,
  LlmProvider,
  apiProviderConnector,
  apiProviderNames,
  cliExecutable,
  coderConnector,
  coderNames,
  connectorRow,
  connectorTable,
  credentialVariables,
  offeredApiProviderNames,
  offeredApiProviders,
  offeredCoderNames,
  offeredCoders,
  type ApiConnectorName,
  type ApiProviderName,
  type CliConnectorName,
  type CoderName,
  type ConnectorName
} from "@llm4ts/core/Models"

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const same = <A, B>(_proof: Same<A, B>): void => undefined

same<
  ConnectorName,
  | "OpenAI"
  | "Anthropic"
  | "GeminiApi"
  | "LmStudio"
  | "Ollama"
  | "MlxLm"
  | "ClaudeCli"
  | "GeminiCli"
  | "OpenCode"
  | "Codex"
  | "Pi"
  | "AntigravityCli"
  | "Grok"
  | "Cursor"
  | "Mock"
>(true)
same<
  CliConnectorName,
  "ClaudeCli" | "GeminiCli" | "OpenCode" | "Codex" | "Pi" | "AntigravityCli" | "Grok" | "Cursor"
>(true)
same<
  ApiConnectorName,
  "OpenAI" | "Anthropic" | "GeminiApi" | "LmStudio" | "Ollama" | "MlxLm" | "Mock"
>(true)
same<
  CoderName,
  | "agy"
  | "antigravity"
  | "antigravity-cli"
  | "claude"
  | "claude-cli"
  | "codex"
  | "cursor"
  | "gemini"
  | "gemini-cli"
  | "grok"
  | "opencode"
  | "pi"
>(true)
same<
  ApiProviderName,
  | "mock"
  | "openai"
  | "anthropic"
  | "gemini"
  | "gemini-api"
  | "lm-studio"
  | "lmstudio"
  | "ollama"
  | "mlx-lm"
  | "mlxlm"
  | "mlx"
>(true)
same<(typeof coderNames)[number], CoderName>(true)
same<(typeof apiProviderNames)[number], ApiProviderName>(true)
same<
  (typeof offeredCoderNames)[number],
  "claude" | "codex" | "gemini" | "pi" | "agy" | "grok" | "cursor" | "opencode"
>(true)
same<
  (typeof offeredApiProviderNames)[number],
  "mock" | "openai" | "anthropic" | "gemini" | "lm-studio" | "ollama" | "mlx-lm"
>(true)
same<ReturnType<typeof cliExecutable<"Cursor">>, "cursor-agent">(true)

describe("connector table", () => {
  it("lists every name an operator may write, each standing for one connector", () => {
    assert.deepStrictEqual([...coderNames].sort(), [
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
    assert.deepStrictEqual(apiProviderNames, [
      "openai",
      "anthropic",
      "gemini",
      "gemini-api",
      "lm-studio",
      "lmstudio",
      "ollama",
      "mlx-lm",
      "mlxlm",
      "mlx",
      "mock"
    ])
    assert.strictEqual(new Set(coderNames).size, coderNames.length)
    assert.strictEqual(new Set(apiProviderNames).size, apiProviderNames.length)
    assert.strictEqual(coderConnector("agy"), "AntigravityCli")
    assert.strictEqual(coderConnector("gemini"), "GeminiCli")
    assert.strictEqual(apiProviderConnector("gemini"), "GeminiApi")
    assert.strictEqual(apiProviderConnector("mlx"), "MlxLm")
    assert.isUndefined(coderConnector("openai"))
    assert.isUndefined(apiProviderConnector("claude"))
  })

  it("accepts a connector's own id wherever it is offered under a name", () => {
    for (const row of Object.values(connectorTable)) {
      const offered: ReadonlyArray<string> = row.names
      assert.isTrue(offered.length === 0 || offered.includes(row.id), row.id)
      assert.strictEqual(offered.join(), offered.join().toLowerCase())
    }
  })

  it("offers coders and providers in the order help and menus show", () => {
    assert.deepStrictEqual(offeredCoders, [
      "ClaudeCli",
      "Codex",
      "GeminiCli",
      "Pi",
      "AntigravityCli",
      "Grok",
      "Cursor",
      "OpenCode"
    ])
    assert.deepStrictEqual(offeredCoderNames, [
      "claude",
      "codex",
      "gemini",
      "pi",
      "agy",
      "grok",
      "cursor",
      "opencode"
    ])
    assert.deepStrictEqual(offeredApiProviders, [
      "Mock",
      "OpenAI",
      "Anthropic",
      "GeminiApi",
      "LmStudio",
      "Ollama",
      "MlxLm"
    ])
    assert.deepStrictEqual(offeredApiProviderNames, [
      "mock",
      "openai",
      "anthropic",
      "gemini",
      "lm-studio",
      "ollama",
      "mlx-lm"
    ])
  })

  it("names the credential variables and the executables", () => {
    assert.deepStrictEqual(credentialVariables, [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY"
    ])
    assert.deepStrictEqual(
      offeredCoders.map((name) => cliExecutable(name)),
      ["claude", "codex", "gemini", "pi", "agy", "grok", "cursor-agent", "opencode"]
    )
  })

  it("keeps every provider's row under the provider's own name", () => {
    for (const provider of LlmProvider.literals) {
      assert.strictEqual(connectorRow(ConnectorIds[provider])?.provider, provider)
    }
    assert.isUndefined(connectorRow(ConnectorIds.Cursor)?.provider)
  })
})
