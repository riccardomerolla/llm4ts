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
  TokenUsage,
  type JsonSchema,
  type LlmConfig,
  type Message
} from "../Models.ts"
import { collect } from "../Streaming.ts"
import { parseFromText } from "../StructuredOutput.ts"
import {
  GeminiContent,
  GeminiGenerateContentRequest,
  GeminiGenerateContentResponse,
  GeminiGenerationConfig,
  GeminiPart
} from "./GeminiModels.ts"

interface GeminiRequiredConfig {
  readonly baseUrl: string
  readonly apiKey: string
}

const normalizeBaseUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, "")

export const geminiContents = (messages: ReadonlyArray<Message>): ReadonlyArray<GeminiContent> =>
  messages.map((message) =>
    GeminiContent.make({
      parts: [
        GeminiPart.make({
          text: message.content
        })
      ]
    })
  )

const promptContents = (prompt: string): ReadonlyArray<GeminiContent> => [
  GeminiContent.make({
    parts: [
      GeminiPart.make({
        text: prompt
      })
    ]
  })
]

export const buildGeminiRequest = (
  contents: ReadonlyArray<GeminiContent>,
  jsonSchema?: JsonSchema
): GeminiGenerateContentRequest =>
  GeminiGenerateContentRequest.make({
    contents,
    ...(jsonSchema === undefined
      ? {}
      : {
          generationConfig: GeminiGenerationConfig.make({
            responseMimeType: "application/json",
            responseSchema: jsonSchema
          })
        })
  })

const decodeResponse = (
  raw: string,
  context: string
): Effect.Effect<GeminiGenerateContentResponse, ParseError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(GeminiGenerateContentResponse))(raw).pipe(
    Effect.mapError((error) =>
      ParseError.make({
        message: `${context}: ${String(error)}`,
        raw
      })
    )
  )

const usageFromResponse = (response: GeminiGenerateContentResponse): TokenUsage | undefined => {
  const usage = response.usageMetadata
  return usage === undefined
    ? undefined
    : TokenUsage.make({
        prompt: usage.promptTokenCount ?? 0,
        completion: usage.candidatesTokenCount ?? 0,
        total: usage.totalTokenCount ?? 0
      })
}

const metadataFromResponse = (
  config: LlmConfig,
  response: GeminiGenerateContentResponse
): Readonly<Record<string, string>> => {
  const usage = response.usageMetadata
  return {
    provider: "gemini-api",
    model: config.model,
    ...(usage?.promptTokenCount === undefined
      ? {}
      : { promptTokenCount: String(usage.promptTokenCount) }),
    ...(usage?.candidatesTokenCount === undefined
      ? {}
      : { candidatesTokenCount: String(usage.candidatesTokenCount) }),
    ...(usage?.totalTokenCount === undefined
      ? {}
      : { totalTokenCount: String(usage.totalTokenCount) })
  }
}

const responseText = (
  response: GeminiGenerateContentResponse,
  raw: string
): Effect.Effect<string, ParseError> => {
  const text = response.candidates[0]?.content.parts
    .map((part) => part.text?.trim())
    .find((part) => part !== undefined && part !== null && part.length > 0)
  return text === undefined || text === null
    ? Effect.fail(
        ParseError.make({
          message:
            "Gemini API response has no text content in candidates. " +
            "The response may be safety-filtered or malformed.",
          raw
        })
      )
    : Effect.succeed(text)
}

export const makeGeminiApiProvider = (
  config: LlmConfig,
  httpClient: HttpClientShape
): ApiConnectorShape => {
  const requiredConfig: Effect.Effect<GeminiRequiredConfig, LlmError> =
    config.baseUrl === undefined
      ? Effect.fail(
          ConfigError.make({
            message: "Missing baseUrl for Gemini API provider"
          })
        )
      : config.apiKey === undefined
        ? Effect.fail(
            AuthenticationError.make({
              message:
                "Missing API key for Gemini API provider (set GEMINI_API_KEY or GOOGLE_API_KEY, or pass apiKey in the connector config)"
            })
          )
        : Effect.succeed({
            baseUrl: normalizeBaseUrl(config.baseUrl),
            apiKey: Redacted.value(config.apiKey)
          })

  const endpoint = (
    baseUrl: string,
    operation: "generateContent" | "streamGenerateContent"
  ): string => `${baseUrl}/v1beta/models/${config.model}:${operation}`

  const headers = (apiKey: string): Readonly<Record<string, string>> => ({
    "x-goog-api-key": apiKey
  })

  const executeRequest = (
    prompt: string,
    jsonSchema?: JsonSchema
  ): Effect.Effect<readonly [response: GeminiGenerateContentResponse, raw: string], LlmError> =>
    Effect.gen(function* () {
      const { apiKey, baseUrl } = yield* requiredConfig
      const raw = yield* httpClient.postJson(
        endpoint(baseUrl, "generateContent"),
        JSON.stringify(buildGeminiRequest(promptContents(prompt), jsonSchema)),
        headers(apiKey),
        config.timeout
      )
      const response = yield* decodeResponse(raw, "Failed to decode Gemini API response")
      return [response, raw]
    })

  const executeStreamWithContents = (
    contents: ReadonlyArray<GeminiContent>
  ): Stream.Stream<LlmChunk, LlmError> =>
    Stream.unwrap(
      Effect.map(requiredConfig, ({ apiKey, baseUrl }) =>
        httpClient
          .postJsonStream(
            endpoint(baseUrl, "streamGenerateContent"),
            JSON.stringify(buildGeminiRequest(contents)),
            headers(apiKey),
            config.timeout
          )
          .pipe(
            Stream.map((line) => line.trim()),
            Stream.filter((line) => line.length > 0),
            Stream.map((line) =>
              line.startsWith("data:") ? line.slice("data:".length).trim() : line
            ),
            Stream.filter((payload) => payload.length > 0 && payload !== "[DONE]"),
            Stream.mapEffect((payload) =>
              decodeResponse(payload, "Failed to decode Gemini stream chunk")
            ),
            Stream.map((response) => {
              const delta =
                response.candidates[0]?.content.parts.map((part) => part.text ?? "").join("") ?? ""
              const finishReason = response.candidates[0]?.finishReason?.toLowerCase()
              const usage = usageFromResponse(response)
              return LlmChunk.make({
                delta,
                metadata: metadataFromResponse(config, response),
                ...(finishReason === undefined || finishReason === null ? {} : { finishReason }),
                ...(usage === undefined ? {} : { usage })
              })
            }),
            Stream.filter(
              (chunk) =>
                chunk.delta.length > 0 ||
                chunk.finishReason !== undefined ||
                chunk.usage !== undefined
            )
          )
      )
    )

  const executeStructuredWithUsage = <A, E, RD, RE>(
    prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    jsonSchema: JsonSchema
  ): Effect.Effect<StructuredResult<A>, LlmError, RD> =>
    Effect.gen(function* () {
      const [response, raw] = yield* executeRequest(prompt, jsonSchema)
      const content = yield* responseText(response, raw)
      const value = yield* parseFromText(content, schema, jsonSchema)
      const result: StructuredResult<A> = [value, undefined, undefined]
      return result
    })

  const executeStream = (prompt: string): Stream.Stream<LlmChunk, LlmError> =>
    executeStreamWithContents(promptContents(prompt))

  const isAvailable: Effect.Effect<boolean> = collect(executeStream("health check")).pipe(
    Effect.match({
      onFailure: () => false,
      onSuccess: () => true
    })
  )

  return makeApiConnector({
    id: ConnectorIds.GeminiApi,
    executeStream,
    executeStreamWithHistory: (messages) => executeStreamWithContents(geminiContents(messages)),
    executeStructuredWithUsage,
    isAvailable
  })
}
