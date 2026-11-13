import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Record from "effect/Record"
import {
  ApiConnectorConfig,
  CliConnectorConfig,
  toLlmConfig,
  type ConnectorConfig,
  type ConnectorConfigOf
} from "../ConnectorConfig.ts"
import {
  ConnectorRegistry,
  makeConnectorRegistry,
  type ConnectorFactory,
  type ConnectorRegistryShape
} from "../ConnectorRegistry.ts"
import type { ConnectorShape } from "../Connector.ts"
import { ConfigError, type LlmError } from "../Errors.ts"
import { HttpClient, type HttpClientShape } from "../HttpClient.ts"
import {
  ConnectorIds,
  LlmConfig,
  isCliConnectorName,
  type ConnectorId,
  type ConnectorKind,
  type ConnectorName
} from "../Models.ts"
import { ProcessExecutor, type ProcessExecutorShape } from "../ProcessExecutor.ts"
import { TemporaryFiles, type TemporaryFilesShape } from "../TemporaryFiles.ts"
import { makeAnthropicProvider } from "./AnthropicProvider.ts"
import { makeAntigravityConnector } from "./AntigravityConnector.ts"
import { makeClaudeCliConnector } from "./ClaudeCliConnector.ts"
import { makeCodexConnector } from "./CodexConnector.ts"
import { makeCursorConnector } from "./CursorConnector.ts"
import { makeGeminiApiProvider } from "./GeminiApiProvider.ts"
import {
  GeminiCliExecutor,
  geminiCliExecutionContextFrom,
  makeGeminiCliProvider,
  type GeminiCliExecutorShape
} from "./GeminiCliProvider.ts"
import { makeGrokCliConnector } from "./GrokCliConnector.ts"
import { makeLmStudioProvider } from "./LmStudioProvider.ts"
import { makeMlxLmProvider } from "./MlxLmProvider.ts"
import { makeMockProvider } from "./MockProvider.ts"
import { makeOllamaProvider } from "./OllamaProvider.ts"
import { makeOpenAIProvider } from "./OpenAIProvider.ts"
import { makeOpenCodeCliConnector } from "./OpenCodeCliConnector.ts"
import { makePiConnector } from "./PiConnector.ts"

export interface ConnectorFactoryDependencies {
  readonly http: HttpClientShape
  readonly process: ProcessExecutorShape
  readonly temporaryFiles: TemporaryFilesShape
  readonly geminiCli: GeminiCliExecutorShape
}

const expectedConfig = (kind: ConnectorKind, id: ConnectorId): ConfigError =>
  ConfigError.make({
    message: `Expected ${kind === "Api" ? "ApiConnectorConfig" : "CliConnectorConfig"} for ${id.value}`
  })

const apiFactory = (
  id: ConnectorId,
  build: (config: ApiConnectorConfig) => ConnectorShape
): ConnectorFactory => ({
  connectorId: id,
  kind: "Api",
  create: (config: ConnectorConfig): Effect.Effect<ConnectorShape, LlmError> =>
    config instanceof ApiConnectorConfig
      ? Effect.succeed(build(config))
      : Effect.fail(expectedConfig("Api", id))
})

const cliFactory = (
  id: ConnectorId,
  build: (config: CliConnectorConfig) => ConnectorShape
): ConnectorFactory => ({
  connectorId: id,
  kind: "Cli",
  create: (config: ConnectorConfig): Effect.Effect<ConnectorShape, LlmError> =>
    config instanceof CliConnectorConfig
      ? Effect.succeed(build(config))
      : Effect.fail(expectedConfig("Cli", id))
})

// A connector without an entry here does not compile. The registry lists
// them in this order.
const builders: {
  readonly [K in ConnectorName]: (
    config: ConnectorConfigOf<K>,
    dependencies: ConnectorFactoryDependencies
  ) => ConnectorShape
} = {
  OpenAI: (config, { http }) => makeOpenAIProvider(toLlmConfig(config), http),
  Anthropic: (config, { http }) => makeAnthropicProvider(toLlmConfig(config), http),
  GeminiApi: (config, { http }) => makeGeminiApiProvider(toLlmConfig(config), http),
  LmStudio: (config, { http }) => makeLmStudioProvider(toLlmConfig(config), http),
  Ollama: (config, { http }) => makeOllamaProvider(toLlmConfig(config), http),
  MlxLm: (config, { http }) => makeMlxLmProvider(toLlmConfig(config), http),
  ClaudeCli: (config, { process }) => makeClaudeCliConnector(config, process),
  OpenCode: (config, { process }) => makeOpenCodeCliConnector(config, process),
  GeminiCli: (config, { geminiCli }) =>
    makeGeminiCliProvider(
      LlmConfig.make({
        provider: "GeminiCli",
        model: config.model ?? "gemini-2.5-flash"
      }),
      geminiCli,
      geminiCliExecutionContextFrom(config)
    ),
  Codex: (config, { process, temporaryFiles }) =>
    makeCodexConnector(config, process, temporaryFiles),
  Pi: (config, { process }) => makePiConnector(config, process),
  AntigravityCli: (config, { process }) => makeAntigravityConnector(config, process),
  Grok: (config, { process }) => makeGrokCliConnector(config, process),
  Cursor: (config, { process }) => makeCursorConnector(config, process),
  Mock: (config) => makeMockProvider(toLlmConfig(config))
}

export const createConnectorRegistry = (
  dependencies: ConnectorFactoryDependencies
): ConnectorRegistryShape =>
  makeConnectorRegistry(
    Record.keys(builders).map((name) =>
      isCliConnectorName(name)
        ? cliFactory(ConnectorIds[name], (config) => builders[name](config, dependencies))
        : apiFactory(ConnectorIds[name], (config) => builders[name](config, dependencies))
    )
  )

export const ConnectorRegistryLive = Layer.effect(
  ConnectorRegistry,
  Effect.gen(function* () {
    const http = yield* HttpClient
    const process = yield* ProcessExecutor
    const temporaryFiles = yield* TemporaryFiles
    const geminiCli = yield* GeminiCliExecutor
    return createConnectorRegistry({
      http,
      process,
      temporaryFiles,
      geminiCli
    })
  })
)
