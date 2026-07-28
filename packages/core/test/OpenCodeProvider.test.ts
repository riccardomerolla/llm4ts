import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { makeHttpClient, makeRecordingHttpClient, type HttpRequest } from "@llm4ts/core/HttpClient"
import { LlmConfig, Message, type JsonSchema } from "@llm4ts/core/Models"
import { OpenCodeCompletionRequest } from "@llm4ts/core/providers/OpenCodeModels"
import { makeOpenCodeProvider, parseOpenCodeSseBody } from "@llm4ts/core/providers/OpenCodeProvider"
import { collect } from "@llm4ts/core/Streaming"

const config = (withApiKey = true): LlmConfig =>
  LlmConfig.make({
    provider: "OpenCode",
    model: "opencode-default",
    baseUrl: "http://opencode.test/",
    ...(withApiKey ? { apiKey: Redacted.make("test-key") } : {})
  })

const response = (content: string): string =>
  JSON.stringify({
    id: "chatcmpl-123",
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
      completion_tokens: 5,
      total_tokens: 15
    },
    model: "opencode-default"
  })

const streamResponse = [
  `data: ${JSON.stringify({
    choices: [
      {
        index: 0,
        delta: {
          content: "Hello"
        }
      }
    ],
    model: "opencode-default"
  })}`,
  "",
  `data: ${JSON.stringify({
    choices: [
      {
        index: 0,
        delta: {
          content: " world"
        },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: 8,
      completion_tokens: 3,
      total_tokens: 11
    },
    model: "opencode-default"
  })}`,
  "data: [DONE]"
].join("\n")

const decodeRequest = (request: HttpRequest): Effect.Effect<OpenCodeCompletionRequest, unknown> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OpenCodeCompletionRequest))(request.body ?? "")

const personSchema = Schema.Struct({
  name: Schema.String,
  age: Schema.Int
})
const personJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "integer" }
  }
}

describe("OpenCodeProvider", () => {
  it.effect("parses the provider's buffered SSE response", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() => Effect.succeed(streamResponse))
      const provider = makeOpenCodeProvider(config(), recording.client)

      const result = yield* collect(provider.executeStream("test prompt"))
      const requests = yield* recording.recorded
      const request = requests[0]

      assert.strictEqual(result.content, "Hello world")
      assert.strictEqual(result.usage?.total, 11)
      assert.strictEqual(result.metadata.provider, "opencode")
      assert.strictEqual(request?.url, "http://opencode.test/chat/completions")
      assert.strictEqual(request?.headers.Authorization, "Bearer test-key")
      if (request !== undefined) {
        const body = yield* decodeRequest(request)
        assert.isTrue(body.stream)
        assert.strictEqual(body.messages[0]?.content, "test prompt")
      }
    })
  )

  it.effect("preserves all history roles in OpenAI-compatible messages", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() => Effect.succeed(streamResponse))
      const provider = makeOpenCodeProvider(config(), recording.client)

      yield* collect(
        provider.executeStreamWithHistory([
          Message.make({ role: "System", content: "s" }),
          Message.make({ role: "User", content: "u" }),
          Message.make({ role: "Assistant", content: "a" }),
          Message.make({ role: "Tool", content: "t" })
        ])
      )
      const requests = yield* recording.recorded
      const request = requests[0]

      if (request !== undefined) {
        const body = yield* decodeRequest(request)
        assert.deepStrictEqual(
          body.messages.map(({ role }) => role),
          ["system", "user", "assistant", "tool"]
        )
      }
    })
  )

  it.effect("sends native JSON-schema response format", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() =>
        Effect.succeed(response('{"name":"Alice","age":30}'))
      )
      const provider = makeOpenCodeProvider(config(), recording.client)

      const person = yield* provider.executeStructured(
        "Give person",
        personSchema,
        personJsonSchema
      )
      const requests = yield* recording.recorded
      const request = requests[0]

      assert.deepStrictEqual(person, { name: "Alice", age: 30 })
      if (request !== undefined) {
        const body = yield* decodeRequest(request)
        assert.strictEqual(body.response_format?.type, "json_schema")
        assert.deepStrictEqual(body.response_format?.json_schema?.schema, personJsonSchema)
      }
    })
  )

  it.effect("requires both base URL and API key", () =>
    Effect.gen(function* () {
      const client = makeHttpClient({
        postJson: () => Effect.succeed(streamResponse)
      })
      const missingKey = makeOpenCodeProvider(config(false), client)
      const missingUrl = makeOpenCodeProvider(
        LlmConfig.make({
          provider: "OpenCode",
          model: "model",
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

  it.effect("checks models with authentication before reporting available", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() => Effect.succeed("{}"))
      const provider = makeOpenCodeProvider(config(), recording.client)
      const withoutKey = makeOpenCodeProvider(config(false), recording.client)

      assert.isTrue(yield* provider.isAvailable)
      assert.isFalse(yield* withoutKey.isAvailable)
      const requests = yield* recording.recorded
      assert.strictEqual(requests[0]?.url, "http://opencode.test/models")
    })
  )

  it.effect("rejects malformed and empty buffered SSE responses", () =>
    Effect.gen(function* () {
      const malformed = yield* Effect.flip(parseOpenCodeSseBody(config(), "data: {not-json}"))
      const empty = yield* Effect.flip(
        parseOpenCodeSseBody(config(), "event: ping\n\ndata: [DONE]")
      )

      assert.strictEqual(malformed._tag, "ParseError")
      assert.strictEqual(empty._tag, "ParseError")
      assert.match(empty.message, /No stream chunks/)
    })
  )

  it.effect("keeps tool calling explicitly unsupported", () =>
    Effect.gen(function* () {
      const provider = makeOpenCodeProvider(
        config(),
        makeHttpClient({
          postJson: () => Effect.succeed(response("ok"))
        })
      )

      const error = yield* Effect.flip(provider.executeWithTools("test", []))

      assert.strictEqual(error._tag, "InvalidRequestError")
    })
  )
})
