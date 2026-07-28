import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { makeHttpClient, makeRecordingHttpClient, type HttpRequest } from "@llm4ts/core/HttpClient"
import { LlmConfig, Message, type JsonSchema } from "@llm4ts/core/Models"
import { OllamaChatRequest, OllamaGenerateRequest } from "@llm4ts/core/providers/OllamaModels"
import { makeOllamaProvider, ollamaHistory } from "@llm4ts/core/providers/OllamaProvider"
import { collect } from "@llm4ts/core/Streaming"

const config = LlmConfig.make({
  provider: "Ollama",
  model: "llama3.2",
  baseUrl: "http://ollama.test/",
  temperature: 0.2,
  maxTokens: 128
})

const decodeGenerate = (request: HttpRequest): Effect.Effect<OllamaGenerateRequest, unknown> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OllamaGenerateRequest))(request.body ?? "")

const decodeChat = (request: HttpRequest): Effect.Effect<OllamaChatRequest, unknown> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OllamaChatRequest))(request.body ?? "")

const answerSchema = Schema.Struct({
  answer: Schema.Int
})
const answerJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    answer: {
      type: "integer"
    }
  },
  required: ["answer"]
}

describe("OllamaProvider", () => {
  it.effect("streams generate output and exposes final usage", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(
        () => Effect.succeed("{}"),
        () =>
          Stream.make(
            JSON.stringify({
              model: "llama3.2",
              response: "Hel",
              done: false
            }),
            JSON.stringify({
              model: "llama3.2",
              response: "lo",
              done: true,
              prompt_eval_count: 3,
              eval_count: 2
            })
          )
      )
      const provider = makeOllamaProvider(config, recording.client)

      const response = yield* collect(provider.executeStream("test"))
      const requests = yield* recording.recorded
      const request = requests[0]

      assert.strictEqual(response.content, "Hello")
      assert.strictEqual(response.usage?.total, 5)
      assert.strictEqual(request?.url, "http://ollama.test/api/generate")
      if (request !== undefined) {
        const body = yield* decodeGenerate(request)
        assert.isTrue(body.stream)
        assert.strictEqual(body.options?.temperature, 0.2)
        assert.strictEqual(body.options?.num_predict, 128)
      }
    })
  )

  it.effect("maps history to chat roles and uses the chat endpoint", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(
        () => Effect.succeed("{}"),
        () =>
          Stream.make(
            JSON.stringify({
              model: "llama3.2",
              message: {
                role: "assistant",
                content: "answer"
              },
              done: true
            })
          )
      )
      const provider = makeOllamaProvider(config, recording.client)
      const messages = [
        Message.make({ role: "System", content: "system" }),
        Message.make({ role: "Tool", content: "tool" })
      ]

      const response = yield* collect(provider.executeStreamWithHistory(messages))
      const requests = yield* recording.recorded
      const request = requests[0]

      assert.strictEqual(response.content, "answer")
      assert.deepStrictEqual(
        ollamaHistory(messages).map(({ role }) => role),
        ["system", "user"]
      )
      assert.strictEqual(request?.url, "http://ollama.test/api/chat")
      if (request !== undefined) {
        const body = yield* decodeChat(request)
        assert.strictEqual(body.messages[1]?.content, "tool")
      }
    })
  )

  it.effect("uses Ollama JSON mode for structured output", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() =>
        Effect.succeed(
          JSON.stringify({
            model: "llama3.2",
            response: '{"answer":42}',
            done: true
          })
        )
      )
      const provider = makeOllamaProvider(config, recording.client)

      const result = yield* provider.executeStructured("answer", answerSchema, answerJsonSchema)
      const requests = yield* recording.recorded
      const request = requests[0]

      assert.deepStrictEqual(result, { answer: 42 })
      if (request !== undefined) {
        const body = yield* decodeGenerate(request)
        assert.strictEqual(body.format, "json")
        assert.isFalse(body.stream)
        assert.match(body.prompt, /valid JSON/)
      }
    })
  )

  it.effect("rejects tool calling with a typed request error", () =>
    Effect.gen(function* () {
      const provider = makeOllamaProvider(
        config,
        makeHttpClient({
          postJson: () => Effect.succeed("{}")
        })
      )

      const error = yield* Effect.flip(provider.executeWithTools("test", []))

      assert.strictEqual(error._tag, "InvalidRequestError")
      assert.match(error.message, /does not support tool calling/)
    })
  )

  it.effect("checks the tags endpoint and reports transport failure", () =>
    Effect.gen(function* () {
      const available = makeOllamaProvider(
        config,
        makeHttpClient({
          postJson: () => Effect.succeed("{}"),
          get: () => Effect.succeed('{"models":[]}')
        })
      )
      const unavailable = makeOllamaProvider(
        config,
        makeHttpClient({
          postJson: () => Effect.succeed("{}")
        })
      )

      assert.isTrue(yield* available.isAvailable)
      assert.isFalse(yield* unavailable.isAvailable)
    })
  )

  it.effect("requires a configured base URL before starting a stream", () =>
    Effect.gen(function* () {
      const provider = makeOllamaProvider(
        LlmConfig.make({
          provider: "Ollama",
          model: "llama3.2"
        }),
        makeHttpClient({
          postJson: () => Effect.succeed("{}")
        })
      )

      const error = yield* Effect.flip(Stream.runCollect(provider.executeStream("test")))

      assert.strictEqual(error._tag, "ConfigError")
    })
  )
})
