import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { makeApiConnector, type ApiConnectorShape } from "../Connector.ts"
import { AuthenticationError, ConfigError, ParseError, type LlmError } from "../Errors.ts"
import type { HttpClientShape } from "../HttpClient.ts"
import type { StructuredResult } from "../LlmService.ts"
import {
  ConnectorCapabilities,
  ConnectorIds,
  LlmChunk,
  TokenUsage,
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
  AnthropicCacheControl,
  AnthropicMessage,
  AnthropicOutputConfig,
  AnthropicRequest,
  AnthropicRequestWithTools,
  AnthropicResponse,
  AnthropicResponseWithTools,
  AnthropicStreamChunk,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolInputSchema,
  AnthropicUsage
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

const ephemeral = AnthropicCacheControl.make({ type: "ephemeral" })

const cachedBlock = (text: string): AnthropicTextBlock =>
  AnthropicTextBlock.make({ type: "text", text, cache_control: ephemeral })

/**
 * Prompt-cache breakpoints (ADR 0029): one on the system block, one on the
 * last message. The API caches the prefix up to each marker and looks the
 * next request up at earlier markers too, so a chat whose history only
 * grows at the end reads every earlier turn from the cache.
 */
export const withCacheMarkers = (
  messages: ReadonlyArray<AnthropicMessage>,
  system: string | undefined
): {
  readonly messages: ReadonlyArray<AnthropicMessage>
  readonly system: string | ReadonlyArray<AnthropicTextBlock> | undefined
} => {
  const last = messages[messages.length - 1]
  const marked =
    last === undefined || typeof last.content !== "string"
      ? messages
      : [
          ...messages.slice(0, -1),
          AnthropicMessage.make({ role: last.role, content: [cachedBlock(last.content)] })
        ]
  return {
    messages: marked,
    system: system === undefined || system.length === 0 ? system : [cachedBlock(system)]
  }
}

export const buildAnthropicRequest = (
  config: LlmConfig,
  messages: ReadonlyArray<AnthropicMessage>,
  stream: boolean,
  system?: string
): AnthropicRequest => {
  const cached =
    config.promptCache === false ? { messages, system } : withCacheMarkers(messages, system)
  return AnthropicRequest.make({
    model: config.model,
    max_tokens: config.maxTokens ?? 4096,
    messages: cached.messages,
    stream,
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    ...(cached.system === undefined ? {} : { system: cached.system }),
    ...(config.effort === undefined
      ? {}
      : { output_config: AnthropicOutputConfig.make({ effort: config.effort }) })
  })
}

/**
 * The API's usage as llm4ts counts it: cache reads and writes are prompt
 * tokens the request paid for (at their own rates), `cached` is what was
 * read from the cache.
 */
export const anthropicTokenUsage = (usage: AnthropicUsage): TokenUsage => {
  const read = usage.cache_read_input_tokens ?? 0
  const written = usage.cache_creation_input_tokens ?? 0
  const prompt = (usage.input_tokens ?? 0) + read + written
  const completion = usage.output_tokens ?? 0
  return TokenUsage.make({
    prompt,
    completion,
    total: prompt + completion,
    ...(read > 0 ? { cached: read } : {})
  })
}

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
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    ...(config.effort === undefined
      ? {}
      : { output_config: AnthropicOutputConfig.make({ effort: config.effort }) })
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
        // Usage arrives in two events: `message_start` carries the input
        // (and cache) counts, `message_delta` the output so far. The final
        // chunk carries them together, so the seat is measured, not estimated.
        const usage = Stream.unwrap(
          Effect.map(Ref.make<AnthropicUsage | undefined>(undefined), (started) =>
            httpClient
              .postJsonStreamSSE(
                `${baseUrl}/messages`,
                JSON.stringify(request),
                authHeaders(apiKey),
                config.timeout
              )
              .pipe(
                Stream.mapEffect(decodeStreamChunk),
                Stream.mapEffect((chunk) =>
                  chunk.type === "message_start" && chunk.message?.usage !== undefined
                    ? Effect.as(Ref.set(started, chunk.message.usage), chunk)
                    : Effect.succeed(chunk)
                ),
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
                    chunk.type === "message_delta"
                      ? (chunk.delta?.stop_reason ?? undefined)
                      : undefined
                  if (finishReason === undefined) {
                    return Stream.empty
                  }
                  return Stream.fromEffect(
                    Effect.map(Ref.get(started), (input) => {
                      const combined =
                        input === undefined && chunk.usage === undefined
                          ? undefined
                          : anthropicTokenUsage(
                              AnthropicUsage.make({
                                ...(input ?? {}),
                                ...(chunk.usage?.output_tokens === undefined
                                  ? {}
                                  : { output_tokens: chunk.usage.output_tokens })
                              })
                            )
                      return LlmChunk.make({
                        delta: "",
                        finishReason,
                        ...(combined === undefined ? {} : { usage: combined }),
                        metadata: {
                          provider: "anthropic",
                          model: config.model
                        }
                      })
                    })
                  )
                })
              )
          )
        )
        return usage
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
    isAvailable,
    capabilities: ConnectorCapabilities.make({ readOnlyEnforcement: "enforced", effort: "mapped" })
  })
}
