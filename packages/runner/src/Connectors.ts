import * as Duration from "effect/Duration"
import * as Redacted from "effect/Redacted"
import {
  ApiConnectorConfig,
  CliConnectorConfig,
  type ConnectorConfig
} from "@llm4ts/core/ConnectorConfig"
import { ConnectorIds, defaultBaseUrl, type LlmProvider } from "@llm4ts/core/Models"

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

export const openAI = ApiConnectorConfig.make({
  connectorId: ConnectorIds.OpenAI
})

export const anthropic = ApiConnectorConfig.make({
  connectorId: ConnectorIds.Anthropic
})

export const geminiApi = ApiConnectorConfig.make({
  connectorId: ConnectorIds.GeminiApi
})

export const ollama = ApiConnectorConfig.make({
  connectorId: ConnectorIds.Ollama
})

export const mock = ApiConnectorConfig.make({
  connectorId: ConnectorIds.Mock,
  model: "mock"
})

export function withModel(config: CliConnectorConfig, model: string): CliConnectorConfig
export function withModel(config: ApiConnectorConfig, model: string): ApiConnectorConfig
export function withModel(
  config: CliConnectorConfig | ApiConnectorConfig,
  model: string
): CliConnectorConfig | ApiConnectorConfig {
  return config instanceof CliConnectorConfig
    ? CliConnectorConfig.make({ ...config, model })
    : ApiConnectorConfig.make({ ...config, model })
}

export const withTurnLimit = (config: CliConnectorConfig, turnLimit: number): CliConnectorConfig =>
  CliConnectorConfig.make({
    ...config,
    turnLimit
  })

export const withEnvironment = (
  config: CliConnectorConfig,
  environment: Readonly<Record<string, string>>
): CliConnectorConfig =>
  CliConnectorConfig.make({
    ...config,
    envVars: {
      ...config.envVars,
      ...environment
    }
  })

export const asReadOnly = (config: CliConnectorConfig): CliConnectorConfig =>
  CliConnectorConfig.make({ ...config, readOnly: true })

export const withTimeoutSeconds = (
  config: ApiConnectorConfig,
  seconds: number
): ApiConnectorConfig =>
  ApiConnectorConfig.make({
    ...config,
    timeout: Duration.seconds(seconds)
  })

const providerFor = (config: ApiConnectorConfig): LlmProvider => {
  switch (config.connectorId.value) {
    case "openai":
      return "OpenAI"
    case "anthropic":
      return "Anthropic"
    case "gemini-api":
      return "GeminiApi"
    case "lm-studio":
      return "LmStudio"
    case "ollama":
      return "Ollama"
    case "mock":
      return "Mock"
    default:
      return "OpenAI"
  }
}

const environmentApiKey = (
  config: ApiConnectorConfig,
  environment: Readonly<Record<string, string | undefined>>
): string | undefined => {
  switch (config.connectorId.value) {
    case "openai":
      return environment.OPENAI_API_KEY
    case "anthropic":
      return environment.ANTHROPIC_API_KEY
    case "gemini-api":
      return environment.GEMINI_API_KEY ?? environment.GOOGLE_API_KEY
    default:
      return undefined
  }
}

export const enrichApiConnector = (
  config: ApiConnectorConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env
): ApiConnectorConfig => {
  const baseUrl = config.baseUrl ?? defaultBaseUrl(providerFor(config))
  const environmentKey = environmentApiKey(config, environment)
  return ApiConnectorConfig.make({
    ...config,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(config.apiKey !== undefined
      ? { apiKey: config.apiKey }
      : environmentKey === undefined
        ? {}
        : { apiKey: Redacted.make(environmentKey) })
  })
}

export const prepareConnector = (
  config: ConnectorConfig,
  workDir: string,
  environment: Readonly<Record<string, string | undefined>> = process.env
): ConnectorConfig =>
  config instanceof ApiConnectorConfig
    ? enrichApiConnector(config, environment)
    : CliConnectorConfig.make({ ...config, workingDir: workDir })

export const coderFromEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env
): CliConnectorConfig => {
  switch (env.LLM4TS_CODER ?? env.LLM4ZIO_CODER ?? "claude") {
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
