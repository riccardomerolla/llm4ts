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
  type JsonSchema,
  type LlmConfig,
  type Message,
  type MessageRole
} from "../Models.ts"
import { parseFromText } from "../StructuredOutput.ts"
import { LmStudioChatRequest, LmStudioChatResponse, LmStudioMessage } from "./LmStudioModels.ts"
import { OpenAIChatChunk, OpenAIChatCompletionRequest, OpenAIChatMessage } from "./OpenAIModels.ts"

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

const decodeNativeResponse = (raw: string): Effect.Effect<LmStudioChatResponse, ParseError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(LmStudioChatResponse))(raw).pipe(
    Effect.mapError((error) =>
      ParseError.make({
        message: `Failed to decode LmStudio native API response: ${String(error)}`,
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

const nativeContent = (
  response: LmStudioChatResponse,
  raw: string
): Effect.Effect<string, ParseError> => {
  const content = response.output
    .find(
      (item) =>
        item.type === "message" &&
        item.content !== undefined &&
        item.content !== null &&
        item.content.trim().length > 0
    )
    ?.content?.trim()

  return content === undefined || content === null
    ? Effect.fail(
        ParseError.make({
          message: "LmStudio response missing choices[0].message.content",
          raw
        })
      )
    : Effect.succeed(content)
}

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

  const nativeRequest = (
    messages: ReadonlyArray<LmStudioMessage>
  ): Effect.Effect<readonly [response: LmStudioChatResponse, raw: string], LlmError> =>
    Effect.gen(function* () {
      const normalized = yield* baseUrl
      const rendered = renderLmStudioNativeInput(messages)
      const request = LmStudioChatRequest.make({
        model: config.model,
        input: rendered.input,
        temperature: config.temperature ?? 0.7,
        stream: false,
        ...(rendered.systemPrompt === undefined ? {} : { system_prompt: rendered.systemPrompt }),
        ...(config.maxTokens === undefined ? {} : { max_output_tokens: config.maxTokens })
      })
      const raw = yield* httpClient.postJson(
        `${normalized}/api/v1/chat`,
        JSON.stringify(request),
        authHeaders(),
        config.timeout
      )
      const response = yield* decodeNativeResponse(raw)
      return [response, raw]
    })

  const executeStructuredWithUsage = <A, E, RD, RE>(
    prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    jsonSchema: JsonSchema
  ): Effect.Effect<StructuredResult<A>, LlmError, RD> =>
    Effect.gen(function* () {
      const [response, raw] = yield* nativeRequest([
        LmStudioMessage.make({
          role: "user",
          content:
            `${prompt}\n\n` +
            "Please respond with valid JSON only, no additional text or markdown formatting."
        })
      ])
      const content = yield* nativeContent(response, raw)
      const value = yield* parseFromText(content, schema, jsonSchema)
      const result: StructuredResult<A> = [value, undefined, undefined]
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
