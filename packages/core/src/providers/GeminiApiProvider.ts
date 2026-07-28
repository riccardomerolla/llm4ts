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
import {
  GeminiContent,
  GeminiFunctionDeclaration,
  GeminiGenerateContentRequest,
  GeminiGenerateContentRequestWithTools,
  GeminiGenerateContentResponse,
  GeminiGenerateContentResponseFull,
  GeminiGenerationConfig,
  GeminiPart,
  GeminiToolDef
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

export const buildGeminiToolRequest = (
  prompt: string,
  tools: ReadonlyArray<ToolDefinition>
): GeminiGenerateContentRequestWithTools =>
  GeminiGenerateContentRequestWithTools.make({
    contents: promptContents(prompt),
    tools: [
      GeminiToolDef.make({
        functionDeclarations: tools.map((tool) =>
          GeminiFunctionDeclaration.make({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          })
        )
      })
    ]
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

const decodeToolResponse = (
  raw: string
): Effect.Effect<GeminiGenerateContentResponseFull, ParseError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(GeminiGenerateContentResponseFull))(raw).pipe(
    Effect.mapError((error) =>
      ParseError.make({
        message: `Failed to decode Gemini tool response: ${String(error)}`,
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
              message: "Missing API key for Gemini API provider"
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
      const { apiKey, baseUrl } = yield* requiredConfig
      const raw = yield* httpClient.postJson(
        endpoint(baseUrl, "generateContent"),
        JSON.stringify(buildGeminiToolRequest(prompt, tools)),
        headers(apiKey),
        config.timeout
      )
      const response = yield* decodeToolResponse(raw)
      const candidate = response.candidates[0]
      if (candidate === undefined) {
        return yield* Effect.fail(
          ParseError.make({
            message: "Gemini tool response has no candidates",
            raw
          })
        )
      }
      const calls = candidate.content.parts.flatMap((part) =>
        part.functionCall === undefined ? [] : [part.functionCall]
      )
      const text = candidate.content.parts
        .map((part) => part.text)
        .find((part) => part !== undefined && part !== null)

      return ToolCallResponse.make({
        toolCalls: calls.map((call, index) =>
          ToolCall.make({
            id: `gemini_call_${index}`,
            name: call.name,
            arguments: JSON.stringify(call.args) ?? "{}"
          })
        ),
        finishReason: candidate.finishReason ?? "STOP",
        ...(text === undefined || text === null ? {} : { content: text })
      })
    })

  const executeStream = (prompt: string): Stream.Stream<LlmChunk, LlmError> =>
    executeStreamWithContents(promptContents(prompt))

  const isAvailable: Effect.Effect<boolean> = collect(executeStream("health check")).pipe(
    Effect.match({
      onFailure: () => false,
      onSuccess: () => true
    })
  )

  return {
    id: ConnectorIds.GeminiApi,
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
    executeStream,
    executeStreamWithHistory: (messages) => executeStreamWithContents(geminiContents(messages)),
    executeWithTools,
    executeStructured,
    executeStructuredWithUsage,
    isAvailable
  }
}

export const geminiApiProviderLayer = (
  config: LlmConfig
): Layer.Layer<LlmService, never, HttpClient> =>
  Layer.effect(
    LlmService,
    Effect.map(HttpClient, (httpClient) => makeGeminiApiProvider(config, httpClient))
  )
