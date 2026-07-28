import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { makeHttpClient, makeRecordingHttpClient, type HttpRequest } from "@llm4ts/core/HttpClient"
import { LlmConfig, Message, ToolDefinition, type JsonSchema } from "@llm4ts/core/Models"
import {
  GeminiGenerateContentRequest,
  GeminiGenerateContentRequestWithTools
} from "@llm4ts/core/providers/GeminiModels"
import { geminiContents, makeGeminiApiProvider } from "@llm4ts/core/providers/GeminiApiProvider"
import { collect } from "@llm4ts/core/Streaming"

const config = (
  options: {
    readonly baseUrl?: string
    readonly apiKey?: Redacted.Redacted<string>
  } = {}
): LlmConfig =>
  LlmConfig.make({
    provider: "GeminiApi",
    model: "gemini-2.0-flash-exp",
    baseUrl: options.baseUrl ?? "https://generativelanguage.googleapis.test/",
    apiKey: options.apiKey ?? Redacted.make("test-gemini-key")
  })

const decodeRequest = (
  request: HttpRequest
): Effect.Effect<GeminiGenerateContentRequest, unknown> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(GeminiGenerateContentRequest))(
    request.body ?? ""
  )

const decodeToolRequest = (
  request: HttpRequest
): Effect.Effect<GeminiGenerateContentRequestWithTools, unknown> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(GeminiGenerateContentRequestWithTools))(
    request.body ?? ""
  )

const answerSchema = Schema.Struct({
  name: Schema.String
})

const answerJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    name: {
      type: "string"
    }
  },
  required: ["name"]
}

describe("GeminiApiProvider", () => {
  it.effect("parses native NDJSON streaming with usage and finish metadata", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(
        () => Effect.succeed("{}"),
        () =>
          Stream.make(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: "Hel" }]
                  }
                }
              ]
            }),
            `data: ${JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: "lo" }]
                  },
                  finishReason: "STOP"
                }
              ],
              usageMetadata: {
                promptTokenCount: 1,
                candidatesTokenCount: 1,
                totalTokenCount: 2
              }
            })}`
          )
      )
      const provider = makeGeminiApiProvider(config(), recording.client)

      const response = yield* collect(provider.executeStream("test prompt"))
      const requests = yield* recording.recorded
      const request = requests[0]

      assert.strictEqual(response.content, "Hello")
      assert.strictEqual(response.usage?.total, 2)
      assert.strictEqual(response.metadata.provider, "gemini-api")
      assert.strictEqual(
        request?.url,
        "https://generativelanguage.googleapis.test/v1beta/models/" +
          "gemini-2.0-flash-exp:streamGenerateContent"
      )
      assert.strictEqual(request?.headers["x-goog-api-key"], "test-gemini-key")
      if (request !== undefined) {
        const body = yield* decodeRequest(request)
        assert.strictEqual(body.contents[0]?.parts[0]?.text, "test prompt")
      }
    })
  )

  it.effect("preserves history content without inventing unsupported roles", () =>
    Effect.gen(function* () {
      const contents = geminiContents([
        Message.make({ role: "System", content: "system" }),
        Message.make({ role: "User", content: "user" }),
        Message.make({ role: "Assistant", content: "assistant" })
      ])

      assert.deepStrictEqual(
        contents.map((content) => content.parts[0]?.text),
        ["system", "user", "assistant"]
      )
    })
  )

  it.effect("fails lazily when API key or base URL is absent", () =>
    Effect.gen(function* () {
      const client = makeHttpClient({
        postJson: () => Effect.succeed("{}")
      })
      const missingKey = makeGeminiApiProvider(
        LlmConfig.make({
          provider: "GeminiApi",
          model: "gemini",
          baseUrl: "https://gemini.test"
        }),
        client
      )
      const missingUrl = makeGeminiApiProvider(
        LlmConfig.make({
          provider: "GeminiApi",
          model: "gemini",
          apiKey: Redacted.make("key")
        }),
        client
      )

      const keyError = yield* Effect.flip(Stream.runCollect(missingKey.executeStream("test")))
      const urlError = yield* Effect.flip(Stream.runCollect(missingUrl.executeStream("test")))

      assert.strictEqual(keyError._tag, "AuthenticationError")
      assert.strictEqual(urlError._tag, "ConfigError")
    })
  )

  it.effect("uses Gemini generation configuration for structured output", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() =>
        Effect.succeed(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: '{"name":"Test"}' }]
                }
              }
            ]
          })
        )
      )
      const provider = makeGeminiApiProvider(config(), recording.client)

      const result = yield* provider.executeStructured("test", answerSchema, answerJsonSchema)
      const requests = yield* recording.recorded
      const request = requests[0]

      assert.deepStrictEqual(result, { name: "Test" })
      if (request !== undefined) {
        const body = yield* decodeRequest(request)
        assert.strictEqual(body.generationConfig?.responseMimeType, "application/json")
        assert.deepStrictEqual(body.generationConfig?.responseSchema, answerJsonSchema)
      }
    })
  )

  it.effect("maps Gemini function calls to stable neutral IDs", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() =>
        Effect.succeed(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        name: "search",
                        args: {
                          query: "Scala"
                        }
                      }
                    }
                  ]
                },
                finishReason: "STOP"
              }
            ]
          })
        )
      )
      const provider = makeGeminiApiProvider(config(), recording.client)
      const tool = ToolDefinition.make({
        name: "search",
        description: "Web search",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string"
            }
          },
          required: ["query"]
        }
      })

      const response = yield* provider.executeWithTools("search", [tool])
      const requests = yield* recording.recorded
      const request = requests[0]

      assert.strictEqual(response.toolCalls[0]?.id, "gemini_call_0")
      assert.strictEqual(response.toolCalls[0]?.name, "search")
      assert.match(response.toolCalls[0]?.arguments ?? "", /Scala/)
      if (request !== undefined) {
        const body = yield* decodeToolRequest(request)
        assert.strictEqual(body.tools[0]?.functionDeclarations[0]?.name, "search")
      }
    })
  )

  it.effect("treats a safety-filtered stream response as an empty chunk stream", () =>
    Effect.gen(function* () {
      const client = makeHttpClient({
        postJson: () => Effect.succeed("{}"),
        postJsonStream: () =>
          Stream.make(
            JSON.stringify({
              promptFeedback: {
                blockReason: "SAFETY"
              }
            })
          )
      })
      const provider = makeGeminiApiProvider(config(), client)

      const response = yield* collect(provider.executeStream("blocked prompt"))

      assert.strictEqual(response.content, "")
    })
  )

  it.effect("fails tool calls when Gemini returns no candidate", () =>
    Effect.gen(function* () {
      const client = makeHttpClient({
        postJson: () => Effect.succeed("{}")
      })
      const provider = makeGeminiApiProvider(config(), client)

      const error = yield* Effect.flip(provider.executeWithTools("test", []))

      assert.strictEqual(error._tag, "ParseError")
      assert.match(error.message, /no candidates/)
    })
  )
})
