import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import {
  ApiConnectorConfig,
  CliConnectorConfig,
  type ConnectorConfig
} from "@llm4ts/core/ConnectorConfig"
import { ConnectorIds, connectorDefaultBaseUrl } from "@llm4ts/core/Models"
import { ScriptUsage } from "./FlowArgs.ts"

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
  const baseUrl = config.baseUrl ?? connectorDefaultBaseUrl(config.connectorId)
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

export const apiConnectorFromEnvironment = Effect.fn(
  "@llm4ts/runner/Connectors.apiConnectorFromEnvironment"
)(function* (
  environment: Readonly<Record<string, string | undefined>> = process.env
): Effect.fn.Return<ApiConnectorConfig, ScriptUsage> {
  const provider = environment.LLM4TS_PROVIDER?.trim().toLowerCase() ?? "mock"
  const preset = (() => {
    switch (provider) {
      case "mock":
        return mock
      case "openai":
        return openAI
      case "anthropic":
        return anthropic
      case "gemini":
      case "gemini-api":
        return geminiApi
      case "lm-studio":
      case "lmstudio":
        return lmStudio
      case "ollama":
        return ollama
      default:
        return undefined
    }
  })()
  if (preset === undefined) {
    return yield* ScriptUsage.make({
      message:
        `unknown LLM4TS_PROVIDER '${provider}'; expected ` +
        "mock|openai|anthropic|gemini|lm-studio|ollama"
    })
  }
  const model = environment.LLM4TS_MODEL?.trim()
  if (provider !== "mock" && (model === undefined || model.length === 0)) {
    return yield* ScriptUsage.make({
      message: `LLM4TS_MODEL is required for provider '${provider}' (e.g. LLM4TS_MODEL=gpt-4o-mini)`
    })
  }
  return model === undefined || model.length === 0 ? preset : withModel(preset, model)
})

// Every coding CLI, with the names an operator may write for it. The
// connector's own id is always one of them, derived rather than repeated:
// `gemini-cli` is the string llm4ts prints in events, traces and errors,
// so it is the name an operator has actually seen — it must not resolve to
// a different vendor's CLI.
const coderAliases: ReadonlyArray<readonly [CliConnectorConfig, ReadonlyArray<string>]> = [
  [claude, ["claude"]],
  [codex, ["codex"]],
  [gemini, ["gemini"]],
  [pi, ["pi"]],
  [antigravity, ["agy", "antigravity"]],
  [grok, ["grok"]],
  [cursor, ["cursor"]],
  [opencode, ["opencode"]]
]

const coders = new Map<string, CliConnectorConfig>(
  coderAliases.flatMap(([preset, aliases]) =>
    [...aliases, preset.connectorId.value].map((name) => [name, preset] as const)
  )
)

export const coderIds: ReadonlyArray<string> = Object.freeze([...coders.keys()].sort())

export const coderFor = (name: string): CliConnectorConfig | undefined =>
  coders.get(name.trim().toLowerCase())

// Unchecked: an unrecognized name falls back to claude, which silently
// runs a CLI the operator did not ask for. Prefer coderFromEnvironment,
// which refuses and names the coders it knows.
export const coderFromEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env
): CliConnectorConfig => {
  const requested = (env.LLM4TS_CODER ?? env.LLM4ZIO_CODER ?? "").trim()
  return (requested.length === 0 ? claude : coderFor(requested)) ?? claude
}

// The checked reading, matching apiConnectorFromEnvironment above: an
// unset variable is the claude default, and an unknown one is a usage
// error rather than a different coder than the one asked for.
export const coderFromEnvironment = Effect.fn("@llm4ts/runner/Connectors.coderFromEnvironment")(
  function* (
    environment: Readonly<Record<string, string | undefined>> = process.env
  ): Effect.fn.Return<CliConnectorConfig, ScriptUsage> {
    const requested = (environment.LLM4TS_CODER ?? environment.LLM4ZIO_CODER ?? "").trim()
    if (requested.length === 0) {
      return claude
    }
    const preset = coderFor(requested)
    return preset === undefined
      ? yield* ScriptUsage.make({
          message: `unknown LLM4TS_CODER '${requested}'; expected ${coderIds.join("|")}`
        })
      : preset
  }
)
