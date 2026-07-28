import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { ProviderError } from "@llm4ts/core/Errors"
import { makeHttpClient, makeRecordingHttpClient, type HttpRequest } from "@llm4ts/core/HttpClient"
import { LlmConfig, Message, ToolDefinition, type JsonSchema } from "@llm4ts/core/Models"
import {
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionRequestWithTools
} from "@llm4ts/core/providers/OpenAIModels"
import { makeOpenAIProvider, openAIHistoryMessages } from "@llm4ts/core/providers/OpenAIProvider"
import { collect } from "@llm4ts/core/Streaming"

const config = (
  overrides: {
    readonly baseUrl?: string
    readonly apiKey?: Redacted.Redacted<string>
  } = {}
): LlmConfig =>
  LlmConfig.make({
    provider: "OpenAI",
    model: "gpt-4o",
    baseUrl: overrides.baseUrl ?? "https://api.openai.test/v1/",
    apiKey: overrides.apiKey ?? Redacted.make("test-api-key")
  })

const withoutApiKey = (): LlmConfig =>
  LlmConfig.make({
    provider: "OpenAI",
    model: "gpt-4o",
    baseUrl: "https://api.openai.test/v1"
  })

const withoutBaseUrl = (): LlmConfig =>
  LlmConfig.make({
    provider: "OpenAI",
    model: "gpt-4o",
    apiKey: Redacted.make("test-api-key")
  })

const streamChunk = (content: string | null, finishReason: string | null): string =>
  JSON.stringify({
    id: "chatcmpl-123",
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        delta: {
          content
        },
        finish_reason: finishReason
      }
    ]
  })

const completionResponse = (content: string): string =>
  JSON.stringify({
    id: "chatcmpl-structured",
    model: "gpt-4o-2026-01-01",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content
        },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14
    }
  })

const decodeChatRequest = (
  request: HttpRequest
): Effect.Effect<OpenAIChatCompletionRequest, unknown> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OpenAIChatCompletionRequest))(request.body ?? "")

const decodeToolRequest = (
  request: HttpRequest
): Effect.Effect<OpenAIChatCompletionRequestWithTools, unknown> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OpenAIChatCompletionRequestWithTools))(
    request.body ?? ""
  )

const responseSchema = Schema.Struct({
  answer: Schema.Int
})

const responseJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    answer: {
      type: "integer"
    }
  },
  required: ["answer"]
}

describe("OpenAIProvider", () => {
  it.effect("streams chat completions with normalized URL and bearer auth", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(
        () => Effect.succeed("{}"),
        () =>
          Stream.make(
            `data: ${streamChunk("Test ", null)}`,
            `data: ${streamChunk("response", "stop")}`
          )
      )
      const provider = makeOpenAIProvider(config(), recording.client)

      const response = yield* collect(provider.executeStream("test prompt"))
      const requests = yield* recording.recorded
      const request = requests[0]

      assert.strictEqual(response.content, "Test response")
      assert.strictEqual(response.metadata.provider, "openai")
      assert.strictEqual(requests.length, 1)
      assert.strictEqual(request?.url, "https://api.openai.test/v1/chat/completions")
      assert.strictEqual(request?.headers.Authorization, "Bearer test-api-key")

      if (request !== undefined) {
        const body = yield* decodeChatRequest(request)
        assert.strictEqual(body.model, "gpt-4o")
        assert.isTrue(body.stream)
        assert.strictEqual(body.temperature, 0.7)
        assert.deepStrictEqual(
          body.messages.map(({ role, content }) => ({ role, content })),
          [
            {
              role: "user",
              content: "test prompt"
            }
          ]
        )
      }
    })
  )

  it.effect("maps all conversation roles to OpenAI history messages", () =>
    Effect.gen(function* () {
      const mapped = openAIHistoryMessages([
        Message.make({ role: "System", content: "system" }),
        Message.make({ role: "User", content: "question" }),
        Message.make({ role: "Assistant", content: "answer" }),
        Message.make({ role: "Tool", content: "result" })
      ])

      assert.deepStrictEqual(
        mapped.map(({ role, content }) => ({ role, content })),
        [
          { role: "system", content: "system" },
          { role: "user", content: "question" },
          { role: "assistant", content: "answer" },
          { role: "tool", content: "result" }
        ]
      )
    })
  )

  it.effect("fails lazily with typed errors for missing required configuration", () =>
    Effect.gen(function* () {
      const httpClient = makeHttpClient({
        postJson: () => Effect.succeed("{}")
      })
      const missingKey = makeOpenAIProvider(withoutApiKey(), httpClient)
      const missingUrl = makeOpenAIProvider(withoutBaseUrl(), httpClient)

      const keyError = yield* Effect.flip(Stream.runCollect(missingKey.executeStream("test")))
      const urlError = yield* Effect.flip(Stream.runCollect(missingUrl.executeStream("test")))

      assert.strictEqual(keyError._tag, "AuthenticationError")
      assert.match(keyError.message, /Missing API key/)
      assert.strictEqual(urlError._tag, "ConfigError")
      assert.match(urlError.message, /Missing baseUrl/)
    })
  )

  it.effect("preserves the source health-check availability semantics", () =>
    Effect.gen(function* () {
      const failingHttp = makeHttpClient({
        postJson: () => Effect.succeed("{}"),
        get: () =>
          Effect.fail(
            ProviderError.make({
              message: "offline"
            })
          )
      })
      const configured = makeOpenAIProvider(config(), failingHttp)
      const unconfigured = makeOpenAIProvider(withoutBaseUrl(), failingHttp)

      const configuredHealth = yield* configured.healthCheck
      const unconfiguredHealth = yield* unconfigured.healthCheck

      assert.strictEqual(configuredHealth.availability, "Healthy")
      assert.strictEqual(configuredHealth.authStatus, "Valid")
      assert.strictEqual(unconfiguredHealth.availability, "Unhealthy")
      assert.strictEqual(unconfiguredHealth.authStatus, "Invalid")
    })
  )

  it.effect("decodes schema-constrained structured output", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() =>
        Effect.succeed(completionResponse('{"answer":42}'))
      )
      const provider = makeOpenAIProvider(config(), recording.client)

      const result = yield* provider.executeStructured(
        "answer the question",
        responseSchema,
        responseJsonSchema
      )
      const requests = yield* recording.recorded
      const request = requests[0]

      assert.deepStrictEqual(result, { answer: 42 })
      if (request !== undefined) {
        const body = yield* decodeChatRequest(request)
        assert.strictEqual(body.stream, false)
        assert.strictEqual(body.response_format?.type, "json_schema")
        assert.strictEqual(body.response_format?.json_schema?.name, "response")
        assert.deepStrictEqual(body.response_format?.json_schema?.schema, responseJsonSchema)
      }
    })
  )

  it.effect("maps OpenAI function calls to the neutral tool response", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() =>
        Effect.succeed(
          JSON.stringify({
            id: "test-id",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "get_time",
                        arguments: "{}"
                      }
                    }
                  ]
                },
                finish_reason: "tool_calls"
              }
            ],
            model: "gpt-4o"
          })
        )
      )
      const provider = makeOpenAIProvider(config(), recording.client)
      const tool = ToolDefinition.make({
        name: "get_time",
        description: "Returns the current time",
        parameters: {
          type: "object",
          properties: {},
          required: []
        }
      })

      const response = yield* provider.executeWithTools("what time is it?", [tool])
      const requests = yield* recording.recorded
      const request = requests[0]

      assert.strictEqual(response.toolCalls.length, 1)
      assert.strictEqual(response.toolCalls[0]?.id, "call_1")
      assert.strictEqual(response.toolCalls[0]?.name, "get_time")
      assert.strictEqual(response.finishReason, "tool_calls")
      if (request !== undefined) {
        const body = yield* decodeToolRequest(request)
        assert.strictEqual(body.tools[0]?.type, "function")
        assert.strictEqual(body.tools[0]?.function.name, "get_time")
      }
    })
  )

  it.effect("reports malformed stream events as typed parse errors", () =>
    Effect.gen(function* () {
      const httpClient = makeHttpClient({
        postJson: () => Effect.succeed("{}"),
        postJsonStream: () => Stream.make("data: not-json")
      })
      const provider = makeOpenAIProvider(config(), httpClient)

      const error = yield* Effect.flip(Stream.runCollect(provider.executeStream("test")))

      assert.strictEqual(error._tag, "ParseError")
      if (error._tag === "ParseError") {
        assert.strictEqual(error.raw, "not-json")
      }
    })
  )

  it.effect("rejects a successful response with no assistant content", () =>
    Effect.gen(function* () {
      const httpClient = makeHttpClient({
        postJson: () =>
          Effect.succeed(
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "   "
                  }
                }
              ]
            })
          )
      })
      const provider = makeOpenAIProvider(config(), httpClient)

      const error = yield* Effect.flip(
        provider.executeStructured("answer", responseSchema, responseJsonSchema)
      )

      assert.strictEqual(error._tag, "ParseError")
      assert.match(error.message, /missing choices/)
    })
  )
})
