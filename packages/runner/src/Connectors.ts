import { ApiConnectorConfig, CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { ConnectorIds } from "@llm4ts/core/Models"

export const claude = CliConnectorConfig.make({
  connectorId: ConnectorIds.ClaudeCli,
  flags: {
    "permission-mode": "acceptEdits"
  }
})

export const codex = CliConnectorConfig.make({
  connectorId: ConnectorIds.Codex,
  flags: {
    sandbox: "workspace-write"
  }
})

export const gemini = CliConnectorConfig.make({
  connectorId: ConnectorIds.GeminiCli
})

export const pi = CliConnectorConfig.make({
  connectorId: ConnectorIds.Pi
})

export const antigravity = CliConnectorConfig.make({
  connectorId: ConnectorIds.AntigravityCli,
  flags: {
    mode: "accept-edits"
  }
})

export const grok = CliConnectorConfig.make({
  connectorId: ConnectorIds.Grok
})

export const cursor = CliConnectorConfig.make({
  connectorId: ConnectorIds.Cursor
})

export const opencode = CliConnectorConfig.make({
  connectorId: ConnectorIds.OpenCode
})

export const lmStudio = ApiConnectorConfig.make({
  connectorId: ConnectorIds.LmStudio,
  baseUrl: "http://localhost:1234/v1"
})

export const withModel = (config: CliConnectorConfig, model: string): CliConnectorConfig =>
  CliConnectorConfig.make({
    ...config,
    model
  })

export const withTurnLimit = (config: CliConnectorConfig, turnLimit: number): CliConnectorConfig =>
  CliConnectorConfig.make({
    ...config,
    turnLimit
  })

export const coderFromEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env
): CliConnectorConfig => {
  switch (env.LLM4ZIO_CODER ?? "claude") {
    case "codex":
      return codex
    case "gemini":
      return gemini
    case "pi":
      return pi
    case "agy":
      return antigravity
    case "grok":
      return grok
    case "cursor":
      return cursor
    case "opencode":
      return opencode
    default:
      return claude
  }
}
