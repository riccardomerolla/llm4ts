import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { ApiConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import {
  AuthenticationError,
  ConfigError,
  ParseError,
  RateLimitError,
  TimeoutError
} from "@llm4ts/core/Errors"
import { ConnectorIds, type ConnectorId } from "@llm4ts/core/Models"
import { collect } from "@llm4ts/core/Streaming"
import { nodeFlowRunnerDependencies } from "@llm4ts/runner/FlowRunner"

export const JsProvider = Schema.Literals([
  "mock",
  "openai",
  "anthropic",
  "gemini",
  "lm-studio",
  "ollama"
])
export type JsProvider = typeof JsProvider.Type

export class ClientConfig extends Schema.Class<ClientConfig>("ClientConfig")({
  provider: JsProvider,
  model: Schema.optionalKey(Schema.String),
  baseUrl: Schema.optionalKey(Schema.String),
  apiKey: Schema.optionalKey(Schema.String),
  timeoutSeconds: Schema.optionalKey(Schema.Number),
  temperature: Schema.optionalKey(Schema.Number),
  maxTokens: Schema.optionalKey(Schema.Int)
}) {}

export class CompletionUsage extends Schema.Class<CompletionUsage>("CompletionUsage")({
  prompt: Schema.Int,
  completion: Schema.Int,
  total: Schema.Int,
  cached: Schema.optionalKey(Schema.Int)
}) {}

export class Completion extends Schema.Class<Completion>("Completion")({
  content: Schema.String,
  usage: Schema.optionalKey(CompletionUsage),
  metadata: Schema.Record(Schema.String, Schema.String)
}) {}

export class ClientHealth extends Schema.Class<ClientHealth>("ClientHealth")({
  available: Schema.Boolean,
  availability: Schema.String,
  authentication: Schema.String
}) {}

export type ErrorCategory =
  | "Configuration"
  | "Authentication"
  | "RateLimit"
  | "Timeout"
  | "Parse"
  | "Provider"
  | "Interrupted"
  | "Unknown"

export class Llm4tsError extends Error {
  readonly category: ErrorCategory
  readonly detail: unknown

  constructor(category: ErrorCategory, message: string, detail?: unknown) {
    super(message, { cause: detail })
    this.name = "Llm4tsError"
    this.category = category
    this.detail = detail
  }
}

export interface CallOptions {
  readonly signal?: AbortSignal
}

export interface LlmClient {
  readonly complete: (prompt: string, options?: CallOptions) => Promise<Completion>
  readonly health: (options?: CallOptions) => Promise<ClientHealth>
}

const connectorId = (provider: JsProvider): ConnectorId => {
  switch (provider) {
    case "mock":
      return ConnectorIds.Mock
    case "openai":
      return ConnectorIds.OpenAI
    case "anthropic":
      return ConnectorIds.Anthropic
    case "gemini":
      return ConnectorIds.GeminiApi
    case "lm-studio":
      return ConnectorIds.LmStudio
    case "ollama":
      return ConnectorIds.Ollama
  }
}

const categoryOf = (error: unknown): ErrorCategory =>
  error instanceof ConfigError
    ? "Configuration"
    : error instanceof AuthenticationError
      ? "Authentication"
      : error instanceof RateLimitError
        ? "RateLimit"
        : error instanceof TimeoutError
          ? "Timeout"
          : error instanceof ParseError
            ? "Parse"
            : "Provider"

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : String(error)

const bridge = async <A, E>(effect: Effect.Effect<A, E>, options?: CallOptions): Promise<A> => {
  try {
    const result = await Effect.runPromise(Effect.result(effect), {
      ...(options?.signal === undefined ? {} : { signal: options.signal })
    })
    if (result._tag === "Failure") {
      const failure = result.failure
      const category = categoryOf(failure)
      throw new Llm4tsError(category, messageOf(failure), failure)
    }
    return result.success
  } catch (error) {
    if (error instanceof Llm4tsError) {
      throw error
    }
    const interrupted = options?.signal?.aborted === true
    throw new Llm4tsError(
      interrupted ? "Interrupted" : "Unknown",
      interrupted ? "operation interrupted" : messageOf(error),
      error
    )
  }
}

const decodeConfig = (input: unknown): ClientConfig => {
  try {
    return Schema.decodeUnknownSync(ClientConfig)(input)
  } catch (error) {
    throw new Llm4tsError(
      "Configuration",
      `invalid client configuration: ${messageOf(error)}`,
      error
    )
  }
}

const apiConfig = (config: ClientConfig): ApiConnectorConfig =>
  ApiConnectorConfig.make({
    connectorId: connectorId(config.provider),
    model: config.model ?? (config.provider === "mock" ? "mock" : ""),
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.apiKey === undefined ? {} : { apiKey: Redacted.make(config.apiKey) }),
    ...(config.timeoutSeconds === undefined
      ? {}
      : { timeout: Duration.seconds(config.timeoutSeconds) }),
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens })
  })

export const createClient = (input: unknown): LlmClient => {
  const config = apiConfig(decodeConfig(input))
  const connector = nodeFlowRunnerDependencies().registry.resolve(config)
  return {
    complete: (prompt, options) =>
      bridge(
        Effect.flatMap(connector, (service) => collect(service.executeStream(prompt))).pipe(
          Effect.map((response) =>
            Completion.make({
              content: response.content,
              metadata: response.metadata,
              ...(response.usage === undefined
                ? {}
                : { usage: CompletionUsage.make(response.usage) })
            })
          )
        ),
        options
      ),
    health: (options) =>
      bridge(
        Effect.flatMap(connector, (service) => service.healthCheck).pipe(
          Effect.map((health) =>
            ClientHealth.make({
              available: health.availability === "Healthy" || health.availability === "Degraded",
              availability: health.availability,
              authentication: health.authStatus
            })
          )
        ),
        options
      )
  }
}

export const mockClient = (): LlmClient => createClient({ provider: "mock", model: "mock" })
