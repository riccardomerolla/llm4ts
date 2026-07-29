import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { makeApiConnector, type ApiConnectorShape } from "../Connector.ts"
import { AuthenticationError, ConfigError, ParseError, type LlmError } from "../Errors.ts"
import type { HttpClientShape } from "../HttpClient.ts"
import type { StructuredResult } from "../LlmService.ts"
import {
  ConnectorIds,
  LlmChunk,
  ToolCall,
  ToolCallResponse,
  type JsonSchema,
  type LlmConfig,
  type Message,
  type ToolDefinition
} from "../Models.ts"
import { collect } from "../Streaming.ts"
import { parseFromText } from "../StructuredOutput.ts"
import type { AnthropicContentBlockFull } from "./AnthropicModels.ts"
import {
  AnthropicMessage,
  AnthropicRequest,
  AnthropicRequestWithTools,
  AnthropicResponse,
  AnthropicResponseWithTools,
  AnthropicStreamChunk,
  AnthropicTool,
  AnthropicToolInputSchema
} from "./AnthropicModels.ts"

interface AnthropicRequiredConfig {
  readonly baseUrl: string
  readonly apiKey: string
}

const normalizedBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, "")

const decodeResponse = (raw: string): Effect.Effect<AnthropicResponse, ParseError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AnthropicResponse))(raw).pipe(
    Effect.mapError((error) =>
      ParseError.make({
        message: `Failed to decode Anthropic response: ${String(error)}`,
        raw
      })
    )
  )

const decodeToolResponse = (raw: string): Effect.Effect<AnthropicResponseWithTools, ParseError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AnthropicResponseWithTools))(raw).pipe(
    Effect.mapError((error) =>
      ParseError.make({
        message: `Failed to decode Anthropic tool response: ${String(error)}`,
        raw
      })
    )
  )

const decodeStreamChunk = (raw: string): Effect.Effect<AnthropicStreamChunk, ParseError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AnthropicStreamChunk))(raw).pipe(
    Effect.mapError((error) =>
      ParseError.make({
        message: `Failed to parse Anthropic stream chunk: ${String(error)}`,
        raw
      })
    )
  )

export interface AnthropicHistory {
  readonly messages: ReadonlyArray<AnthropicMessage>
  readonly system: string | undefined
}

export const anthropicHistory = (messages: ReadonlyArray<Message>): AnthropicHistory => ({
  system: messages.find((message) => message.role === "System")?.content,
  messages: messages
    .filter((message) => message.role !== "System")
    .map((message) =>
      AnthropicMessage.make({
        role: message.role === "Assistant" ? "assistant" : "user",
        content: message.content
      })
    )
})

export const buildAnthropicRequest = (
  config: LlmConfig,
  messages: ReadonlyArray<AnthropicMessage>,
  stream: boolean,
  system?: string
): AnthropicRequest =>
  AnthropicRequest.make({
    model: config.model,
    max_tokens: config.maxTokens ?? 4096,
    messages,
    stream,
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    ...(system === undefined ? {} : { system })
  })

export const buildAnthropicToolRequest = (
  config: LlmConfig,
  prompt: string,
  tools: ReadonlyArray<ToolDefinition>
): AnthropicRequestWithTools =>
  AnthropicRequestWithTools.make({
    model: config.model,
    max_tokens: config.maxTokens ?? 4096,
    messages: [
      AnthropicMessage.make({
        role: "user",
        content: prompt
      })
    ],
    tools: tools.map((tool) =>
      AnthropicTool.make({
        name: tool.name,
        description: tool.description,
        input_schema: AnthropicToolInputSchema.make({
          type: "object",
          properties: tool.parameters
        })
      })
    ),
    ...(config.temperature === undefined ? {} : { temperature: config.temperature })
  })

const contentFromResponse = (
  response: AnthropicResponse,
  raw: string
): Effect.Effect<string, ParseError> => {
  const content = response.content[0]?.text?.trim()
  return content === undefined || content === null || content.length === 0
    ? Effect.fail(
        ParseError.make({
          message: "Anthropic response missing content[0].text",
          raw
        })
      )
    : Effect.succeed(content)
}

const jsonString = (value: typeof Schema.Json.Type): string => JSON.stringify(value) ?? "{}"

export const makeAnthropicProvider = (
  config: LlmConfig,
  httpClient: HttpClientShape
): ApiConnectorShape => {
  const requiredConfig: Effect.Effect<AnthropicRequiredConfig, LlmError> =
    config.baseUrl === undefined
      ? Effect.fail(
          ConfigError.make({
            message: "Missing baseUrl for Anthropic provider"
          })
        )
      : config.apiKey === undefined
        ? Effect.fail(
            AuthenticationError.make({
              message:
                "Missing API key for Anthropic provider (set ANTHROPIC_API_KEY or pass apiKey in the connector config)"
            })
          )
        : Effect.succeed({
            baseUrl: normalizedBaseUrl(config.baseUrl),
            apiKey: Redacted.value(config.apiKey)
          })

  const authHeaders = (apiKey: string): Readonly<Record<string, string>> => ({
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01"
  })

  const executeRequest = (
    messages: ReadonlyArray<AnthropicMessage>,
    system?: string
  ): Effect.Effect<readonly [response: AnthropicResponse, raw: string], LlmError> =>
    Effect.gen(function* () {
      const { apiKey, baseUrl } = yield* requiredConfig
      const request = buildAnthropicRequest(config, messages, false, system)
      const raw = yield* httpClient.postJson(
        `${baseUrl}/messages`,
        JSON.stringify(request),
        authHeaders(apiKey),
        config.timeout
      )
      const response = yield* decodeResponse(raw)
      return [response, raw]
    })

  const executeStreamRequest = (
    messages: ReadonlyArray<AnthropicMessage>,
    system?: string
  ): Stream.Stream<LlmChunk, LlmError> =>
    Stream.unwrap(
      Effect.map(requiredConfig, ({ apiKey, baseUrl }) => {
        const request = buildAnthropicRequest(config, messages, true, system)
        return httpClient
          .postJsonStreamSSE(
            `${baseUrl}/messages`,
            JSON.stringify(request),
            authHeaders(apiKey),
            config.timeout
          )
          .pipe(
            Stream.mapEffect(decodeStreamChunk),
            Stream.flatMap((chunk) => {
              if (chunk.type === "content_block_delta") {
                const delta = chunk.delta?.text ?? ""
                return delta.length === 0
                  ? Stream.empty
                  : Stream.succeed(
                      LlmChunk.make({
                        delta,
                        metadata: {
                          provider: "anthropic",
                          model: config.model
                        }
                      })
                    )
              }
              const finishReason =
                chunk.type === "message_delta" ? (chunk.delta?.stop_reason ?? undefined) : undefined
              return finishReason === undefined
                ? Stream.empty
                : Stream.succeed(
                    LlmChunk.make({
                      delta: "",
                      finishReason,
                      metadata: {
                        provider: "anthropic",
                        model: config.model
                      }
                    })
                  )
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
      const [response, raw] = yield* executeRequest([
        AnthropicMessage.make({
          role: "user",
          content: `${prompt}\n\n` + "Please respond with valid JSON matching the provided schema."
        })
      ])
      const content = yield* contentFromResponse(response, raw)
      const value = yield* parseFromText(content, schema, jsonSchema)
      const result: StructuredResult<A> = [value, undefined, undefined]
      return result
    })

  const executeWithTools = (
    prompt: string,
    tools: ReadonlyArray<ToolDefinition>
  ): Effect.Effect<ToolCallResponse, LlmError> =>
    Effect.gen(function* () {
      const { apiKey, baseUrl } = yield* requiredConfig
      const request = buildAnthropicToolRequest(config, prompt, tools)
      const raw = yield* httpClient.postJson(
        `${baseUrl}/messages`,
        JSON.stringify(request),
        authHeaders(apiKey),
        config.timeout
      )
      const response = yield* decodeToolResponse(raw)
      const toolCalls = response.content
        .filter((block) => block.type === "tool_use")
        .map((block) =>
          ToolCall.make({
            id: block.id ?? "",
            name: block.name ?? "",
            arguments: block.input === undefined ? "{}" : jsonString(block.input)
          })
        )
      const content = response.content.find(
        (block): block is AnthropicContentBlockFull =>
          block.type === "text" && block.text !== undefined && block.text !== null
      )?.text

      return ToolCallResponse.make({
        toolCalls,
        finishReason: response.stop_reason ?? "stop",
        ...(content === undefined || content === null ? {} : { content })
      })
    })

  const executeStream = (prompt: string): Stream.Stream<LlmChunk, LlmError> =>
    executeStreamRequest([
      AnthropicMessage.make({
        role: "user",
        content: prompt
      })
    ])

  const isAvailable: Effect.Effect<boolean> = collect(executeStream("health check")).pipe(
    Effect.match({
      onFailure: () => false,
      onSuccess: () => true
    })
  )

  return makeApiConnector({
    id: ConnectorIds.Anthropic,
    executeStream,
    executeStreamWithHistory: (messages) => {
      const history = anthropicHistory(messages)
      return executeStreamRequest(history.messages, history.system)
    },
    executeWithTools,
    executeStructuredWithUsage,
    isAvailable
  })
}
