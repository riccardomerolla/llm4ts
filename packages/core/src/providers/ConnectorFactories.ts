import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import {
  ApiConnectorConfig,
  CliConnectorConfig,
  toLlmConfig,
  type ConnectorConfig
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
import { ConnectorIds, LlmConfig, type ConnectorId, type ConnectorKind } from "../Models.ts"
import { ProcessExecutor, type ProcessExecutorShape } from "../ProcessExecutor.ts"
import { TemporaryFiles, type TemporaryFilesShape } from "../TemporaryFiles.ts"
import { makeAnthropicProvider } from "./AnthropicProvider.ts"
import { makeAntigravityConnector } from "./AntigravityConnector.ts"
import { makeClaudeCliConnector } from "./ClaudeCliConnector.ts"
import { makeCodexConnector } from "./CodexConnector.ts"
import { makeCopilotConnector } from "./CopilotConnector.ts"
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

export const createConnectorRegistry = (
  dependencies: ConnectorFactoryDependencies
): ConnectorRegistryShape =>
  makeConnectorRegistry([
    apiFactory(ConnectorIds.OpenAI, (config) =>
      makeOpenAIProvider(toLlmConfig(config), dependencies.http)
    ),
    apiFactory(ConnectorIds.Anthropic, (config) =>
      makeAnthropicProvider(toLlmConfig(config), dependencies.http)
    ),
    apiFactory(ConnectorIds.GeminiApi, (config) =>
      makeGeminiApiProvider(toLlmConfig(config), dependencies.http)
    ),
    apiFactory(ConnectorIds.LmStudio, (config) =>
      makeLmStudioProvider(toLlmConfig(config), dependencies.http)
    ),
    apiFactory(ConnectorIds.Ollama, (config) =>
      makeOllamaProvider(toLlmConfig(config), dependencies.http)
    ),
    cliFactory(ConnectorIds.ClaudeCli, (config) =>
      makeClaudeCliConnector(config, dependencies.process)
    ),
    cliFactory(ConnectorIds.OpenCode, (config) =>
      makeOpenCodeCliConnector(config, dependencies.process)
    ),
    cliFactory(ConnectorIds.GeminiCli, (config) =>
      makeGeminiCliProvider(
        LlmConfig.make({
          provider: "GeminiCli",
          model: config.model ?? "gemini-2.5-flash"
        }),
        dependencies.geminiCli,
        geminiCliExecutionContextFrom(config)
      )
    ),
    cliFactory(ConnectorIds.Codex, (config) =>
      makeCodexConnector(config, dependencies.process, dependencies.temporaryFiles)
    ),
    cliFactory(ConnectorIds.Copilot, (config) =>
      makeCopilotConnector(config, dependencies.process)
    ),
    cliFactory(ConnectorIds.Pi, (config) => makePiConnector(config, dependencies.process)),
    cliFactory(ConnectorIds.AntigravityCli, (config) =>
      makeAntigravityConnector(config, dependencies.process)
    ),
    cliFactory(ConnectorIds.Grok, (config) => makeGrokCliConnector(config, dependencies.process)),
    cliFactory(ConnectorIds.Cursor, (config) => makeCursorConnector(config, dependencies.process)),
    apiFactory(ConnectorIds.Mock, (config) => makeMockProvider(toLlmConfig(config)))
  ])

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
