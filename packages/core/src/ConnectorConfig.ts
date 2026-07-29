import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ConnectorId, ConnectorIds, LlmConfig, type LlmProvider } from "./Models.ts"

export class DockerSandbox extends Schema.TaggedClass<DockerSandbox>()("Docker", {
  image: Schema.String,
  mount: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(true))),
  network: Schema.optionalKey(Schema.String)
}) {}

export class PodmanSandbox extends Schema.TaggedClass<PodmanSandbox>()("Podman", {}) {}
export class SeatbeltMacOsSandbox extends Schema.TaggedClass<SeatbeltMacOsSandbox>()(
  "SeatbeltMacOS",
  {}
) {}
export class RunscSandbox extends Schema.TaggedClass<RunscSandbox>()("Runsc", {}) {}
export class LxcSandbox extends Schema.TaggedClass<LxcSandbox>()("Lxc", {}) {}

export const CliSandbox = Schema.Union([
  DockerSandbox,
  PodmanSandbox,
  SeatbeltMacOsSandbox,
  RunscSandbox,
  LxcSandbox
])
export type CliSandbox = typeof CliSandbox.Type

const emptyStringRecord: Readonly<Record<string, string>> = Object.freeze({})

export class ApiConnectorConfig extends Schema.TaggedClass<ApiConnectorConfig>()(
  "ApiConnectorConfig",
  {
    connectorId: ConnectorId,
    model: Schema.optionalKey(Schema.String),
    baseUrl: Schema.optionalKey(Schema.String),
    apiKey: Schema.optionalKey(
      Schema.Redacted(Schema.String, {
        disallowJsonEncode: true
      })
    ),
    timeout: Schema.Duration.pipe(
      Schema.withConstructorDefault(Effect.succeed(Duration.seconds(300)))
    ),
    maxRetries: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(3))),
    requestsPerMinute: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(60))),
    burstSize: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(10))),
    acquireTimeout: Schema.Duration.pipe(
      Schema.withConstructorDefault(Effect.succeed(Duration.seconds(30)))
    ),
    temperature: Schema.optionalKey(Schema.Number),
    maxTokens: Schema.optionalKey(Schema.Int)
  }
) {}

export class CliConnectorConfig extends Schema.TaggedClass<CliConnectorConfig>()(
  "CliConnectorConfig",
  {
    connectorId: ConnectorId,
    model: Schema.optionalKey(Schema.String),
    timeout: Schema.Duration.pipe(
      Schema.withConstructorDefault(Effect.succeed(Duration.seconds(300)))
    ),
    maxRetries: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(3))),
    flags: Schema.Record(Schema.String, Schema.String).pipe(
      Schema.withConstructorDefault(Effect.succeed(emptyStringRecord))
    ),
    sandbox: Schema.optionalKey(CliSandbox),
    turnLimit: Schema.optionalKey(Schema.Int),
    envVars: Schema.Record(Schema.String, Schema.String).pipe(
      Schema.withConstructorDefault(Effect.succeed(emptyStringRecord))
    ),
    workingDir: Schema.optionalKey(Schema.String),
    readOnly: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false)))
  }
) {}

export const ConnectorConfig = Schema.Union([ApiConnectorConfig, CliConnectorConfig])
export type ConnectorConfig = typeof ConnectorConfig.Type

const providerForConnector = (connectorId: ConnectorId): LlmProvider => {
  switch (connectorId.value) {
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

export const toLlmConfig = (config: ApiConnectorConfig): LlmConfig =>
  new LlmConfig({
    provider: providerForConnector(config.connectorId),
    model: config.model ?? "",
    timeout: config.timeout,
    maxRetries: config.maxRetries,
    requestsPerMinute: config.requestsPerMinute,
    burstSize: config.burstSize,
    acquireTimeout: config.acquireTimeout,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens })
  })

const emptyConnectors: ReadonlyArray<ConnectorConfig> = Object.freeze([])

export class FallbackChain extends Schema.Class<FallbackChain>("FallbackChain")({
  connectors: Schema.Array(ConnectorConfig).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyConnectors))
  )
}) {
  get isEmpty(): boolean {
    return this.connectors.length === 0
  }

  get nonEmpty(): boolean {
    return this.connectors.length > 0
  }
}

export const emptyFallbackChain = new FallbackChain()

export const defaultCliConnectorConfigs = Object.freeze({
  Claude: new CliConnectorConfig({ connectorId: ConnectorIds.ClaudeCli }),
  Codex: new CliConnectorConfig({ connectorId: ConnectorIds.Codex })
})

export const defaultReasoningConfig = (
  coder: ConnectorConfig,
  explicit?: ConnectorConfig
): ConnectorConfig => {
  if (explicit !== undefined) {
    return explicit
  }
  return coder instanceof CliConnectorConfig
    ? CliConnectorConfig.make({ ...coder, readOnly: true })
    : coder
}
