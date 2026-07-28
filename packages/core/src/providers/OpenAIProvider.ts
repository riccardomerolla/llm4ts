import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { apiConnectorCapabilities, type ApiConnectorShape } from "../Connector.ts"
import { AuthenticationError, ConfigError, ParseError, type LlmError } from "../Errors.ts"
import { HttpClient, type HttpClientShape } from "../HttpClient.ts"
import { LlmService, type StructuredResult } from "../LlmService.ts"
import {
  ConnectorIds,
  HealthStatus,
  LlmChunk,
  ToolCall,
  ToolCallResponse,
  type JsonSchema,
  type LlmConfig,
  type Message,
  type MessageRole,
  type ToolDefinition
} from "../Models.ts"
import { parseFromText } from "../StructuredOutput.ts"
import {
  OpenAIChatChunk,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionRequestWithTools,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionResponseWithTools,
  OpenAIChatMessage,
  OpenAIFunction,
  OpenAIJsonSchemaSpec,
  OpenAIResponseFormat,
  OpenAITool
} from "./OpenAIModels.ts"

const emptyHeaders: Readonly<Record<string, string>> = Object.freeze({})

interface RequiredConfig {
  readonly baseUrl: string
}

const normalizedBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, "")

const roleName = (role: MessageRole): string => {
  switch (role) {
    case "System":
      return "system"
    case "User":
      return "user"
    case "Assistant":
      return "assistant"
    case "Tool":
      return "tool"
  }
}

export const openAIHistoryMessages = (
  messages: ReadonlyArray<Message>
): ReadonlyArray<OpenAIChatMessage> =>
  messages.map((message) =>
    OpenAIChatMessage.make({
      role: roleName(message.role),
      content: message.content
    })
  )

export const buildOpenAIChatRequest = (
  config: LlmConfig,
  messages: ReadonlyArray<OpenAIChatMessage>,
  stream: boolean,
  responseFormat?: OpenAIResponseFormat
): OpenAIChatCompletionRequest =>
  OpenAIChatCompletionRequest.make({
    model: config.model,
    messages,
    temperature: config.temperature ?? 0.7,
    stream,
    ...(config.maxTokens === undefined ? {} : { max_tokens: config.maxTokens }),
    ...(responseFormat === undefined ? {} : { response_format: responseFormat })
  })

export const buildOpenAIToolRequest = (
  config: LlmConfig,
  prompt: string,
  tools: ReadonlyArray<ToolDefinition>
): OpenAIChatCompletionRequestWithTools =>
  OpenAIChatCompletionRequestWithTools.make({
    model: config.model,
    messages: [
      OpenAIChatMessage.make({
        role: "user",
        content: prompt
      })
    ],
    tools: tools.map((tool) =>
      OpenAITool.make({
        function: OpenAIFunction.make({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        })
      })
    ),
    temperature: config.temperature ?? 0.7,
    stream: false,
    ...(config.maxTokens === undefined ? {} : { max_tokens: config.maxTokens })
  })

const decodeCompletionResponse = (
  raw: string
): Effect.Effect<OpenAIChatCompletionResponse, ParseError> =>
  schemaDecode.completion(raw).pipe(
    Effect.mapError((error) =>
      ParseError.make({
        message: `Failed to decode OpenAI response: ${String(error)}`,
        raw
      })
    )
  )

const decodeToolResponse = (
  raw: string
): Effect.Effect<OpenAIChatCompletionResponseWithTools, ParseError> =>
  schemaDecode.tools(raw).pipe(
    Effect.mapError((error) =>
      ParseError.make({
        message: `Failed to decode OpenAI tool response: ${String(error)}`,
        raw
      })
    )
  )

const decodeStreamChunk = (raw: string): Effect.Effect<OpenAIChatChunk, ParseError> =>
  schemaDecode.chunk(raw).pipe(
    Effect.mapError((error) =>
      ParseError.make({
        message: `Failed to parse OpenAI stream chunk: ${String(error)}`,
        raw
      })
    )
  )

const schemaDecode = {
  completion: Schema.decodeUnknownEffect(Schema.fromJsonString(OpenAIChatCompletionResponse)),
  tools: Schema.decodeUnknownEffect(Schema.fromJsonString(OpenAIChatCompletionResponseWithTools)),
  chunk: Schema.decodeUnknownEffect(Schema.fromJsonString(OpenAIChatChunk))
}

const extractContent = (
  response: OpenAIChatCompletionResponse,
  raw: string
): Effect.Effect<string, ParseError> => {
  const content = response.choices[0]?.message?.content?.trim()
  return content === undefined || content === null || content.length === 0
    ? Effect.fail(
        ParseError.make({
          message: "OpenAI response missing choices[0].message.content",
          raw
        })
      )
    : Effect.succeed(content)
}

export const makeOpenAIProvider = (
  config: LlmConfig,
  httpClient: HttpClientShape
): ApiConnectorShape => {
  const authHeaders = (): Readonly<Record<string, string>> =>
    config.apiKey === undefined
      ? emptyHeaders
      : { Authorization: `Bearer ${Redacted.value(config.apiKey)}` }

  const requiredConfig: Effect.Effect<RequiredConfig, LlmError> =
    config.baseUrl === undefined
      ? Effect.fail(
          ConfigError.make({
            message: "Missing baseUrl for OpenAI provider"
          })
        )
      : config.apiKey === undefined
        ? Effect.fail(
            AuthenticationError.make({
              message: "Missing API key for OpenAI provider"
            })
          )
        : Effect.succeed({
            baseUrl: normalizedBaseUrl(config.baseUrl)
          })

  const executeRequest = (
    messages: ReadonlyArray<OpenAIChatMessage>,
    responseFormat?: OpenAIResponseFormat
  ): Effect.Effect<readonly [response: OpenAIChatCompletionResponse, raw: string], LlmError> =>
    Effect.gen(function* () {
      const { baseUrl } = yield* requiredConfig
      const request = buildOpenAIChatRequest(config, messages, false, responseFormat)
      const raw = yield* httpClient.postJson(
        `${baseUrl}/chat/completions`,
        JSON.stringify(request),
        authHeaders(),
        config.timeout
      )
      const response = yield* decodeCompletionResponse(raw)
      return [response, raw]
    })

  const executeStreamRequest = (
    messages: ReadonlyArray<OpenAIChatMessage>
  ): Stream.Stream<LlmChunk, LlmError> =>
    Stream.unwrap(
      Effect.map(requiredConfig, ({ baseUrl }) => {
        const request = buildOpenAIChatRequest(config, messages, true)
        return httpClient
          .postJsonStreamSSE(
            `${baseUrl}/chat/completions`,
            JSON.stringify(request),
            authHeaders(),
            config.timeout
          )
          .pipe(
            Stream.mapEffect(decodeStreamChunk),
            Stream.flatMap((chunk) => {
              const choice = chunk.choices[0]
              const delta = choice?.delta?.content ?? ""
              const finishReason = choice?.finish_reason ?? undefined
              return delta.length > 0 || finishReason !== undefined
                ? Stream.succeed(
                    LlmChunk.make({
                      delta,
                      metadata: {
                        provider: "openai",
                        model: config.model
                      },
                      ...(finishReason === undefined ? {} : { finishReason })
                    })
                  )
                : Stream.empty
            })
          )
      })
    )

  const executeStructuredWithUsage = <A, E, RD, RE>(
    prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    jsonSchema: JsonSchema
  ): Effect.Effect<StructuredResult<A>, LlmError, RD> =>
    Effect.gen(function* () {
      const responseFormat = OpenAIResponseFormat.make({
        type: "json_schema",
        json_schema: OpenAIJsonSchemaSpec.make({
          name: "response",
          schema: jsonSchema
        })
      })
      const [response, raw] = yield* executeRequest(
        [
          OpenAIChatMessage.make({
            role: "user",
            content: prompt
          })
        ],
        responseFormat
      )
      const content = yield* extractContent(response, raw)
      const value = yield* parseFromText(content, schema, jsonSchema)
      const result: StructuredResult<A> = [value, undefined, undefined]
      return result
    })

  const executeStructured = <A, E, RD, RE>(
    prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    jsonSchema: JsonSchema
  ): Effect.Effect<A, LlmError, RD> =>
    Effect.map(executeStructuredWithUsage(prompt, schema, jsonSchema), ([value]) => value)

  const executeWithTools = (
    prompt: string,
    tools: ReadonlyArray<ToolDefinition>
  ): Effect.Effect<ToolCallResponse, LlmError> =>
    Effect.gen(function* () {
      const { baseUrl } = yield* requiredConfig
      const request = buildOpenAIToolRequest(config, prompt, tools)
      const raw = yield* httpClient.postJson(
        `${baseUrl}/chat/completions`,
        JSON.stringify(request),
        authHeaders(),
        config.timeout
      )
      const response = yield* decodeToolResponse(raw)
      const choice = response.choices[0]
      const toolCalls =
        choice?.message?.tool_calls.map((toolCall) =>
          ToolCall.make({
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments
          })
        ) ?? []
      const content = choice?.message?.content ?? undefined
      const finishReason = choice?.finish_reason ?? "stop"

      return ToolCallResponse.make({
        toolCalls,
        finishReason,
        ...(content === undefined || content === null ? {} : { content })
      })
    })

  const isAvailable: Effect.Effect<boolean> =
    config.baseUrl === undefined
      ? Effect.succeed(false)
      : httpClient
          .get(`${normalizedBaseUrl(config.baseUrl)}/models`, authHeaders(), config.timeout)
          .pipe(
            Effect.match({
              onFailure: () => true,
              onSuccess: () => true
            })
          )

  const healthCheck: Effect.Effect<HealthStatus, LlmError> = Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeNanos
    const available = yield* isAvailable
    const completedAt = yield* Clock.currentTimeNanos

    return HealthStatus.make({
      availability: available ? "Healthy" : "Unhealthy",
      authStatus: available ? "Valid" : "Invalid",
      latency: Duration.nanos(completedAt - startedAt)
    })
  })

  return {
    id: ConnectorIds.OpenAI,
    kind: "Api",
    capabilities: apiConnectorCapabilities(),
    healthCheck,
    executeStream: (prompt) =>
      executeStreamRequest([
        OpenAIChatMessage.make({
          role: "user",
          content: prompt
        })
      ]),
    executeStreamWithHistory: (messages) => executeStreamRequest(openAIHistoryMessages(messages)),
    executeWithTools,
    executeStructured,
    executeStructuredWithUsage,
    isAvailable
  }
}

export const openAIProviderLayer = (
  config: LlmConfig
): Layer.Layer<LlmService, never, HttpClient> =>
  Layer.effect(
    LlmService,
    Effect.map(HttpClient, (httpClient) => makeOpenAIProvider(config, httpClient))
  )
