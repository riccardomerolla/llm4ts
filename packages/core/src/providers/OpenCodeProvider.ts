import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { makeApiConnector, type ApiConnectorShape } from "../Connector.ts"
import {
  AuthenticationError,
  ConfigError,
  InvalidRequestError,
  ParseError,
  type LlmError
} from "../Errors.ts"
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
import {
  OpenCodeCompletionRequest,
  OpenCodeCompletionResponse,
  OpenCodeJsonSchemaSpec,
  OpenCodeMessage,
  OpenCodeResponseFormat
} from "./OpenCodeModels.ts"

interface OpenCodeRequiredConfig {
  readonly baseUrl: string
  readonly apiKey: string
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

export const openCodeHistory = (messages: ReadonlyArray<Message>): ReadonlyArray<OpenCodeMessage> =>
  messages.map((message) =>
    OpenCodeMessage.make({
      role: roleName(message.role),
      content: message.content
    })
  )

const usage = (response: OpenCodeCompletionResponse): TokenUsage | undefined =>
  response.usage === undefined
    ? undefined
    : TokenUsage.make({
        prompt: response.usage.prompt_tokens ?? 0,
        completion: response.usage.completion_tokens ?? 0,
        total: response.usage.total_tokens ?? 0
      })

const metadata = (
  config: LlmConfig,
  response: OpenCodeCompletionResponse
): Readonly<Record<string, string>> => ({
  provider: "opencode",
  model: config.model,
  ...(response.id === undefined ? {} : { id: response.id }),
  ...(response.model === undefined ? {} : { response_model: response.model })
})

const decodeResponse = (
  raw: string,
  context: string
): Effect.Effect<OpenCodeCompletionResponse, ParseError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OpenCodeCompletionResponse))(raw).pipe(
    Effect.mapError((error) =>
      ParseError.make({
        message: `${context}: ${String(error)}`,
        raw
      })
    )
  )

const toChunk = (config: LlmConfig, response: OpenCodeCompletionResponse): LlmChunk => {
  const choice = response.choices[0]
  const delta = choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? ""
  const finishReason = choice?.finish_reason ?? undefined
  const tokenUsage = usage(response)
  return LlmChunk.make({
    delta,
    metadata: metadata(config, response),
    ...(finishReason === undefined || finishReason === null ? {} : { finishReason }),
    ...(tokenUsage === undefined ? {} : { usage: tokenUsage })
  })
}

export const parseOpenCodeSseBody = Effect.fn("@llm4ts/core/OpenCodeProvider.parseSseBody")(
  function* (config: LlmConfig, raw: string): Effect.fn.Return<ReadonlyArray<LlmChunk>, LlmError> {
    const payloads = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter((payload) => payload.length > 0 && payload !== "[DONE]")
    const chunks = yield* Effect.forEach(payloads, (payload) =>
      Effect.map(decodeResponse(payload, "Failed to parse OpenCode SSE payload"), (response) =>
        toChunk(config, response)
      )
    )
    return chunks.length === 0
      ? yield* Effect.fail(
          ParseError.make({
            message: "No stream chunks parsed from OpenCode SSE response",
            raw
          })
        )
      : chunks
  }
)

export const makeOpenCodeProvider = (
  config: LlmConfig,
  httpClient: HttpClientShape
): ApiConnectorShape => {
  const requiredConfig: Effect.Effect<OpenCodeRequiredConfig, LlmError> =
    config.baseUrl === undefined
      ? Effect.fail(
          ConfigError.make({
            message: "Missing baseUrl for OpenCode provider"
          })
        )
      : config.apiKey === undefined
        ? Effect.fail(
            AuthenticationError.make({
              message: "Missing API key for OpenCode provider (pass apiKey in the connector config)"
            })
          )
        : Effect.succeed({
            baseUrl: config.baseUrl.replace(/\/+$/, ""),
            apiKey: Redacted.value(config.apiKey)
          })

  const request = (
    messages: ReadonlyArray<OpenCodeMessage>,
    stream: boolean,
    responseFormat?: OpenCodeResponseFormat
  ): OpenCodeCompletionRequest =>
    OpenCodeCompletionRequest.make({
      model: config.model,
      messages,
      temperature: config.temperature ?? 0.7,
      stream,
      ...(config.maxTokens === undefined ? {} : { max_tokens: config.maxTokens }),
      ...(responseFormat === undefined ? {} : { response_format: responseFormat })
    })

  const post = (
    messages: ReadonlyArray<OpenCodeMessage>,
    stream: boolean,
    responseFormat?: OpenCodeResponseFormat
  ): Effect.Effect<string, LlmError> =>
    Effect.flatMap(requiredConfig, ({ apiKey, baseUrl }) =>
      httpClient.postJson(
        `${baseUrl}/chat/completions`,
        JSON.stringify(request(messages, stream, responseFormat)),
        {
          Authorization: `Bearer ${apiKey}`
        },
        config.timeout
      )
    )

  const executeResponse = (
    messages: ReadonlyArray<OpenCodeMessage>,
    responseFormat?: OpenCodeResponseFormat
  ): Effect.Effect<readonly [response: OpenCodeCompletionResponse, raw: string], LlmError> =>
    Effect.gen(function* () {
      const raw = yield* post(messages, false, responseFormat)
      const response = yield* decodeResponse(raw, "Failed to decode OpenCode response")
      return [response, raw]
    })

  const responseContent = (
    response: OpenCodeCompletionResponse,
    raw: string
  ): Effect.Effect<string, ParseError> => {
    const content = (response.choices[0]?.message?.content ?? response.choices[0]?.text)?.trim()
    return content === undefined || content === null || content.length === 0
      ? Effect.fail(
          ParseError.make({
            message: "OpenCode response missing choices[0].message.content",
            raw
          })
        )
      : Effect.succeed(content)
  }

  const executeStructuredWithUsage = <A, E, RD, RE>(
    prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    jsonSchema: JsonSchema
  ): Effect.Effect<StructuredResult<A>, LlmError, RD> =>
    Effect.gen(function* () {
      const responseFormat = OpenCodeResponseFormat.make({
        type: "json_schema",
        json_schema: OpenCodeJsonSchemaSpec.make({
          name: "response",
          schema: jsonSchema
        })
      })
      const [response, raw] = yield* executeResponse(
        [
          OpenCodeMessage.make({
            role: "user",
            content: prompt
          })
        ],
        responseFormat
      )
      const content = yield* responseContent(response, raw)
      const value = yield* parseFromText(content, schema, jsonSchema)
      const result: StructuredResult<A> = [value, undefined, undefined]
      return result
    })

  const stream = (messages: ReadonlyArray<OpenCodeMessage>): Stream.Stream<LlmChunk, LlmError> =>
    Stream.flatMap(
      Stream.fromEffect(
        Effect.flatMap(post(messages, true), (raw) => parseOpenCodeSseBody(config, raw))
      ),
      Stream.fromIterable
    )

  const isAvailable: Effect.Effect<boolean> =
    config.baseUrl === undefined || config.apiKey === undefined
      ? Effect.succeed(false)
      : httpClient
          .get(
            `${config.baseUrl.replace(/\/+$/, "")}/models`,
            {
              Authorization: `Bearer ${Redacted.value(config.apiKey)}`
            },
            config.timeout
          )
          .pipe(
            Effect.match({
              onFailure: () => false,
              onSuccess: () => true
            })
          )

  return makeApiConnector({
    id: ConnectorIds.OpenCode,
    executeStream: (prompt) =>
      stream([
        OpenCodeMessage.make({
          role: "user",
          content: prompt
        })
      ]),
    executeStreamWithHistory: (messages) => stream(openCodeHistory(messages)),
    executeWithTools: () =>
      Effect.fail(
        InvalidRequestError.make({
          message: "OpenCode provider does not yet support tool calling in this implementation"
        })
      ),
    executeStructuredWithUsage,
    isAvailable
  })
}
