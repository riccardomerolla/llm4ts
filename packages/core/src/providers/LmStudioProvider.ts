import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { makeApiConnector, type ApiConnectorShape } from "../Connector.ts"
import { ConfigError, InvalidRequestError, ParseError, type LlmError } from "../Errors.ts"
import type { HttpClientShape } from "../HttpClient.ts"
import type { StructuredResult } from "../LlmService.ts"
import {
  ConnectorIds,
  LlmChunk,
  TokenUsage,
  type JsonSchema,
  type LlmConfig,
  type Message,
  type MessageRole
} from "../Models.ts"
import { parseFromText } from "../StructuredOutput.ts"
import { LmStudioMessage } from "./LmStudioModels.ts"
import {
  OpenAIChatChunk,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  OpenAIChatMessage,
  OpenAIChatTemplateKwargs,
  OpenAIJsonSchemaSpec,
  OpenAIResponseFormat
} from "./OpenAIModels.ts"

const emptyHeaders: Readonly<Record<string, string>> = Object.freeze({})

export const normalizeLmStudioBaseUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, "")
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -"/v1".length) : trimmed
}

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

export const lmStudioHistory = (messages: ReadonlyArray<Message>): ReadonlyArray<LmStudioMessage> =>
  messages.map((message) =>
    LmStudioMessage.make({
      role: roleName(message.role),
      content: message.content
    })
  )

export interface LmStudioNativeInput {
  readonly input: string
  readonly systemPrompt: string | undefined
}

export const renderLmStudioNativeInput = (
  messages: ReadonlyArray<LmStudioMessage>
): LmStudioNativeInput => {
  const nonSystem = messages.filter((message) => message.role !== "system")
  const inputMessages = nonSystem.length > 0 ? nonSystem : messages
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0)

  return {
    input: inputMessages.map((message) => `${message.role}: ${message.content}`).join("\n"),
    systemPrompt: system.length === 0 ? undefined : system.join("\n")
  }
}

const decodeCompletionResponse = (
  raw: string
): Effect.Effect<OpenAIChatCompletionResponse, ParseError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OpenAIChatCompletionResponse))(raw).pipe(
    Effect.mapError((error) =>
      ParseError.make({
        message: `Failed to decode LmStudio chat completion: ${String(error)}`,
        raw
      })
    )
  )

const decodeStreamChunk = (raw: string): Effect.Effect<OpenAIChatChunk, ParseError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OpenAIChatChunk))(raw).pipe(
    Effect.mapError((error) =>
      ParseError.make({
        message: `Failed to parse LmStudio stream chunk: ${String(error)}`,
        raw
      })
    )
  )

/**
 * The visible reply, or the reasoning field when LM Studio's reasoning
 * parser filed a constrained JSON reply under `reasoning_content` and left
 * `content` empty (observed with Qwen 3.6 on 2026-09-19).
 */
const completionContent = (
  response: OpenAIChatCompletionResponse,
  raw: string
): Effect.Effect<string, ParseError> => {
  const message = response.choices[0]?.message
  const content = message?.content?.trim() ?? ""
  const reasoning = message?.reasoning_content?.trim() ?? ""
  const text = content.length > 0 ? content : reasoning
  return text.length === 0
    ? Effect.fail(
        ParseError.make({
          message: "LmStudio response missing choices[0].message.content",
          raw
        })
      )
    : Effect.succeed(text)
}

const completionUsage = (response: OpenAIChatCompletionResponse): TokenUsage | undefined =>
  response.usage === undefined
    ? undefined
    : TokenUsage.make({
        prompt: response.usage.prompt_tokens ?? 0,
        completion: response.usage.completion_tokens ?? 0,
        total:
          response.usage.total_tokens ??
          (response.usage.prompt_tokens ?? 0) + (response.usage.completion_tokens ?? 0)
      })

export const makeLmStudioProvider = (
  config: LlmConfig,
  httpClient: HttpClientShape
): ApiConnectorShape => {
  const baseUrl: Effect.Effect<string, ConfigError> =
    config.baseUrl === undefined
      ? Effect.fail(
          ConfigError.make({
            message: "Missing baseUrl for LmStudio provider"
          })
        )
      : Effect.succeed(normalizeLmStudioBaseUrl(config.baseUrl))

  const authHeaders = (): Readonly<Record<string, string>> =>
    config.apiKey === undefined
      ? emptyHeaders
      : {
          Authorization: `Bearer ${Redacted.value(config.apiKey)}`
        }

  const streamRequest = (
    messages: ReadonlyArray<LmStudioMessage>
  ): Stream.Stream<LlmChunk, LlmError> =>
    Stream.unwrap(
      Effect.map(baseUrl, (normalized) => {
        const request = OpenAIChatCompletionRequest.make({
          model: config.model,
          messages: messages.map((message) =>
            OpenAIChatMessage.make({
              role: message.role,
              content: message.content
            })
          ),
          temperature: config.temperature ?? 0.7,
          stream: true,
          ...(config.maxTokens === undefined ? {} : { max_tokens: config.maxTokens })
        })
        return httpClient
          .postJsonStreamSSE(
            `${normalized}/v1/chat/completions`,
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
                        provider: "lmstudio",
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
      const normalized = yield* baseUrl
      // Grammar-constrained sampling on the OpenAI-compatible endpoint: the
      // reply is guaranteed to match `jsonSchema`, so no "JSON only" nudge is
      // needed and `parseFromText` only has to decode it.
      const request = OpenAIChatCompletionRequest.make({
        model: config.model,
        messages: [OpenAIChatMessage.make({ role: "user", content: prompt })],
        temperature: config.temperature ?? 0.7,
        stream: false,
        response_format: OpenAIResponseFormat.make({
          type: "json_schema",
          json_schema: OpenAIJsonSchemaSpec.make({
            name: "response",
            schema: jsonSchema,
            strict: true
          })
        }),
        chat_template_kwargs: OpenAIChatTemplateKwargs.make({ enable_thinking: false }),
        ...(config.maxTokens === undefined ? {} : { max_tokens: config.maxTokens })
      })
      const raw = yield* httpClient.postJson(
        `${normalized}/v1/chat/completions`,
        JSON.stringify(request),
        authHeaders(),
        config.timeout
      )
      const response = yield* decodeCompletionResponse(raw)
      const content = yield* completionContent(response, raw)
      const value = yield* parseFromText(content, schema, jsonSchema)
      const result: StructuredResult<A> = [value, completionUsage(response), undefined]
      return result
    })

  const isAvailable: Effect.Effect<boolean> =
    config.baseUrl === undefined
      ? Effect.succeed(false)
      : httpClient
          .get(
            `${normalizeLmStudioBaseUrl(config.baseUrl)}/api/v1/models`,
            emptyHeaders,
            config.timeout
          )
          .pipe(
            Effect.match({
              onFailure: () => false,
              onSuccess: () => true
            })
          )

  return makeApiConnector({
    id: ConnectorIds.LmStudio,
    executeStream: (prompt) =>
      streamRequest([
        LmStudioMessage.make({
          role: "user",
          content: prompt
        })
      ]),
    executeStreamWithHistory: (messages) => streamRequest(lmStudioHistory(messages)),
    executeWithTools: () =>
      Effect.fail(
        InvalidRequestError.make({
          message: "LmStudio provider does not yet support tool calling in this implementation"
        })
      ),
    executeStructuredWithUsage,
    isAvailable
  })
}
