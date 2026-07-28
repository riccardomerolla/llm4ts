import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { apiConnectorCapabilities, type ApiConnectorShape } from "../Connector.ts"
import { ConfigError, InvalidRequestError, ParseError, type LlmError } from "../Errors.ts"
import { HttpClient, type HttpClientShape } from "../HttpClient.ts"
import { LlmService, type StructuredResult } from "../LlmService.ts"
import {
  ConnectorIds,
  HealthStatus,
  LlmChunk,
  TokenUsage,
  type JsonSchema,
  type LlmConfig,
  type Message
} from "../Models.ts"
import { parseFromText } from "../StructuredOutput.ts"
import {
  OllamaChatRequest,
  OllamaChatResponse,
  OllamaGenerateRequest,
  OllamaGenerateResponse,
  OllamaMessage,
  OllamaOptions
} from "./OllamaModels.ts"

const noHeaders: Readonly<Record<string, string>> = Object.freeze({})

const baseUrlEffect = (config: LlmConfig): Effect.Effect<string, ConfigError> =>
  config.baseUrl === undefined
    ? Effect.fail(
        ConfigError.make({
          message: "Missing baseUrl for Ollama provider"
        })
      )
    : Effect.succeed(config.baseUrl.replace(/\/+$/, ""))

const options = (config: LlmConfig): OllamaOptions =>
  OllamaOptions.make({
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    ...(config.maxTokens === undefined ? {} : { num_predict: config.maxTokens })
  })

export const ollamaHistory = (messages: ReadonlyArray<Message>): ReadonlyArray<OllamaMessage> =>
  messages.map((message) =>
    OllamaMessage.make({
      role:
        message.role === "System" ? "system" : message.role === "Assistant" ? "assistant" : "user",
      content: message.content
    })
  )

const generateUsage = (response: OllamaGenerateResponse): TokenUsage | undefined =>
  response.prompt_eval_count === undefined || response.eval_count === undefined
    ? undefined
    : TokenUsage.make({
        prompt: response.prompt_eval_count,
        completion: response.eval_count,
        total: response.prompt_eval_count + response.eval_count
      })

const chatUsage = (response: OllamaChatResponse): TokenUsage | undefined =>
  response.prompt_eval_count === undefined || response.eval_count === undefined
    ? undefined
    : TokenUsage.make({
        prompt: response.prompt_eval_count,
        completion: response.eval_count,
        total: response.prompt_eval_count + response.eval_count
      })

const decodeGenerate = (
  raw: string,
  stream: boolean
): Effect.Effect<OllamaGenerateResponse, ParseError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OllamaGenerateResponse))(raw).pipe(
    Effect.mapError((error) =>
      ParseError.make({
        message:
          `${stream ? "Failed to parse Ollama stream chunk" : "Failed to decode Ollama response"}: ` +
          String(error),
        raw
      })
    )
  )

const decodeChat = (raw: string): Effect.Effect<OllamaChatResponse, ParseError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OllamaChatResponse))(raw).pipe(
    Effect.mapError((error) =>
      ParseError.make({
        message: `Failed to parse Ollama chat stream chunk: ${String(error)}`,
        raw
      })
    )
  )

export const makeOllamaProvider = (
  config: LlmConfig,
  httpClient: HttpClientShape
): ApiConnectorShape => {
  const generateStream = (prompt: string, format?: string): Stream.Stream<LlmChunk, LlmError> =>
    Stream.unwrap(
      Effect.map(baseUrlEffect(config), (baseUrl) => {
        const request = OllamaGenerateRequest.make({
          model: config.model,
          prompt,
          stream: true,
          options: options(config),
          ...(format === undefined ? {} : { format })
        })
        return httpClient
          .postJsonStream(
            `${baseUrl}/api/generate`,
            JSON.stringify(request),
            noHeaders,
            config.timeout
          )
          .pipe(
            Stream.filter((line) => line.trim().length > 0),
            Stream.mapEffect((line) => decodeGenerate(line, true)),
            Stream.flatMap((response) => {
              const usage = response.done ? generateUsage(response) : undefined
              return response.response.length > 0 || response.done
                ? Stream.succeed(
                    LlmChunk.make({
                      delta: response.response,
                      metadata: {
                        provider: "ollama",
                        model: response.model
                      },
                      ...(response.done ? { finishReason: "stop" } : {}),
                      ...(usage === undefined ? {} : { usage })
                    })
                  )
                : Stream.empty
            })
          )
      })
    )

  const chatStream = (messages: ReadonlyArray<OllamaMessage>): Stream.Stream<LlmChunk, LlmError> =>
    Stream.unwrap(
      Effect.map(baseUrlEffect(config), (baseUrl) => {
        const request = OllamaChatRequest.make({
          model: config.model,
          messages,
          stream: true,
          options: options(config)
        })
        return httpClient
          .postJsonStream(`${baseUrl}/api/chat`, JSON.stringify(request), noHeaders, config.timeout)
          .pipe(
            Stream.filter((line) => line.trim().length > 0),
            Stream.mapEffect(decodeChat),
            Stream.flatMap((response) => {
              const usage = response.done ? chatUsage(response) : undefined
              return response.message.content.length > 0 || response.done
                ? Stream.succeed(
                    LlmChunk.make({
                      delta: response.message.content,
                      metadata: {
                        provider: "ollama",
                        model: response.model
                      },
                      ...(response.done ? { finishReason: "stop" } : {}),
                      ...(usage === undefined ? {} : { usage })
                    })
                  )
                : Stream.empty
            })
          )
      })
    )

  const generate = (
    prompt: string,
    format?: string
  ): Effect.Effect<readonly [response: OllamaGenerateResponse, raw: string], LlmError> =>
    Effect.gen(function* () {
      const baseUrl = yield* baseUrlEffect(config)
      const request = OllamaGenerateRequest.make({
        model: config.model,
        prompt,
        stream: false,
        options: options(config),
        ...(format === undefined ? {} : { format })
      })
      const raw = yield* httpClient.postJson(
        `${baseUrl}/api/generate`,
        JSON.stringify(request),
        noHeaders,
        config.timeout
      )
      const response = yield* decodeGenerate(raw, false)
      return [response, raw]
    })

  const executeStructuredWithUsage = <A, E, RD, RE>(
    prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    jsonSchema: JsonSchema
  ): Effect.Effect<StructuredResult<A>, LlmError, RD> =>
    Effect.gen(function* () {
      const [response] = yield* generate(
        `${prompt}\n\nPlease respond with valid JSON matching the provided schema.`,
        "json"
      )
      const value = yield* parseFromText(response.response, schema, jsonSchema)
      const result: StructuredResult<A> = [value, undefined, undefined]
      return result
    })

  const isAvailable: Effect.Effect<boolean> =
    config.baseUrl === undefined
      ? Effect.succeed(false)
      : httpClient
          .get(`${config.baseUrl.replace(/\/+$/, "")}/api/tags`, noHeaders, config.timeout)
          .pipe(
            Effect.match({
              onFailure: () => false,
              onSuccess: () => true
            })
          )

  return {
    id: ConnectorIds.Ollama,
    kind: "Api",
    capabilities: apiConnectorCapabilities(),
    healthCheck: Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeNanos
      const available = yield* isAvailable
      const completedAt = yield* Clock.currentTimeNanos
      return HealthStatus.make({
        availability: available ? "Healthy" : "Unhealthy",
        authStatus: available ? "Valid" : "Invalid",
        latency: Duration.nanos(completedAt - startedAt)
      })
    }),
    executeStream: (prompt) => generateStream(prompt),
    executeStreamWithHistory: (messages) => chatStream(ollamaHistory(messages)),
    executeWithTools: () =>
      Effect.fail(
        InvalidRequestError.make({
          message: "Ollama provider does not support tool calling"
        })
      ),
    executeStructured: <A, E, RD, RE>(
      prompt: string,
      schema: Schema.ConstraintCodec<A, E, RD, RE>,
      jsonSchema: JsonSchema
    ): Effect.Effect<A, LlmError, RD> =>
      Effect.map(executeStructuredWithUsage(prompt, schema, jsonSchema), ([value]) => value),
    executeStructuredWithUsage,
    isAvailable
  }
}

export const ollamaProviderLayer = (
  config: LlmConfig
): Layer.Layer<LlmService, never, HttpClient> =>
  Layer.effect(
    LlmService,
    Effect.map(HttpClient, (httpClient) => makeOllamaProvider(config, httpClient))
  )
