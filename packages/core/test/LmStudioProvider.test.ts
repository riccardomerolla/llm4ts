import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { makeHttpClient, makeRecordingHttpClient, type HttpRequest } from "@llm4ts/core/HttpClient"
import { LlmConfig, Message, TokenUsage, type JsonSchema } from "@llm4ts/core/Models"
import { LmStudioMessage } from "@llm4ts/core/providers/LmStudioModels"
import {
  makeLmStudioProvider,
  normalizeLmStudioBaseUrl,
  renderLmStudioNativeInput
} from "@llm4ts/core/providers/LmStudioProvider"
import { OpenAIChatCompletionRequest } from "@llm4ts/core/providers/OpenAIModels"
import { collect } from "@llm4ts/core/Streaming"

const config = (apiKey?: Redacted.Redacted<string>): LlmConfig =>
  LlmConfig.make({
    provider: "LmStudio",
    model: "llama-2-7b",
    baseUrl: " http://lmstudio.test/v1/ ",
    ...(apiKey === undefined ? {} : { apiKey })
  })

const streamLine = (content: string): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-123",
    model: "llama-2-7b",
    choices: [
      {
        index: 0,
        delta: {
          content
        },
        finish_reason: "stop"
      }
    ]
  })}`

const decodeStreamRequest = (
  request: HttpRequest
): Effect.Effect<OpenAIChatCompletionRequest, unknown> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OpenAIChatCompletionRequest))(request.body ?? "")

const personSchema = Schema.Struct({
  name: Schema.String,
  age: Schema.Int
})
const personJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "integer" }
  },
  required: ["name", "age"]
}

describe("LmStudioProvider", () => {
  it.effect("normalizes root and OpenAI-compatible base URLs", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        normalizeLmStudioBaseUrl(" http://localhost:1234/v1/ "),
        "http://localhost:1234"
      )
      assert.strictEqual(
        normalizeLmStudioBaseUrl("http://localhost:1234/"),
        "http://localhost:1234"
      )
    })
  )

  it.effect("streams through the OpenAI-compatible endpoint", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(
        () => Effect.succeed("{}"),
        () => Stream.make(streamLine("LM Studio response"))
      )
      const provider = makeLmStudioProvider(config(Redacted.make("optional-key")), recording.client)

      const response = yield* collect(provider.executeStream("test prompt"))
      const requests = yield* recording.recorded
      const request = requests[0]

      assert.strictEqual(response.content, "LM Studio response")
      assert.strictEqual(response.metadata.provider, "lmstudio")
      assert.strictEqual(request?.url, "http://lmstudio.test/v1/chat/completions")
      assert.strictEqual(request?.headers.Authorization, "Bearer optional-key")
      if (request !== undefined) {
        const body = yield* decodeStreamRequest(request)
        assert.isTrue(body.stream)
        assert.strictEqual(body.messages[0]?.content, "test prompt")
      }
    })
  )

  it.effect("works without an API key and maps history roles", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(
        () => Effect.succeed("{}"),
        () => Stream.make(streamLine("history"))
      )
      const provider = makeLmStudioProvider(config(), recording.client)

      yield* collect(
        provider.executeStreamWithHistory([
          Message.make({ role: "System", content: "system" }),
          Message.make({ role: "Tool", content: "result" })
        ])
      )
      const requests = yield* recording.recorded
      const request = requests[0]

      assert.deepStrictEqual(request?.headers, {})
      if (request !== undefined) {
        const body = yield* decodeStreamRequest(request)
        assert.deepStrictEqual(
          body.messages.map(({ role }) => role),
          ["system", "tool"]
        )
      }
    })
  )

  it.effect("renders native input and separates system prompts", () =>
    Effect.gen(function* () {
      const rendered = renderLmStudioNativeInput([
        LmStudioMessage.make({ role: "system", content: " first " }),
        LmStudioMessage.make({ role: "system", content: "second" }),
        LmStudioMessage.make({ role: "user", content: "hello" }),
        LmStudioMessage.make({
          role: "assistant",
          content: "hi"
        })
      ])

      assert.strictEqual(rendered.systemPrompt, "first\nsecond")
      assert.strictEqual(rendered.input, "user: hello\nassistant: hi")
    })
  )

  const completionBody = (message: Record<string, unknown>): string =>
    JSON.stringify({
      id: "chatcmpl-1",
      model: "llama-2-7b",
      choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    })

  it.effect("uses schema-constrained JSON on the OpenAI-compatible endpoint", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() =>
        Effect.succeed(completionBody({ content: '{"name":"Alice","age":25}' }))
      )
      const provider = makeLmStudioProvider(config(), recording.client)

      const [person, usage] = yield* provider.executeStructuredWithUsage(
        "Generate a person",
        personSchema,
        personJsonSchema
      )
      const requests = yield* recording.recorded
      const request = requests[0]

      assert.deepStrictEqual(person, { name: "Alice", age: 25 })
      assert.deepStrictEqual(usage, TokenUsage.make({ prompt: 10, completion: 5, total: 15 }))
      assert.strictEqual(request?.url, "http://lmstudio.test/v1/chat/completions")
      if (request !== undefined) {
        const body = yield* decodeStreamRequest(request)
        assert.isFalse(body.stream)
        assert.strictEqual(body.response_format?.type, "json_schema")
        assert.strictEqual(body.response_format?.json_schema?.strict, true)
        assert.deepStrictEqual(body.response_format?.json_schema?.schema, personJsonSchema)
        assert.strictEqual(body.chat_template_kwargs?.enable_thinking, false)
        assert.strictEqual(body.messages[0]?.content, "Generate a person")
      }
    })
  )

  it.effect("falls back to reasoning_content when a thinking model leaves content empty", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() =>
        Effect.succeed(
          completionBody({ content: "", reasoning_content: '{"name":"Bob","age":41}' })
        )
      )
      const provider = makeLmStudioProvider(config(), recording.client)

      const person = yield* provider.executeStructured(
        "Generate a person",
        personSchema,
        personJsonSchema
      )

      assert.deepStrictEqual(person, { name: "Bob", age: 41 })
    })
  )

  it.effect("fails typed when the constrained reply is not the requested JSON", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() =>
        Effect.succeed(completionBody({ content: "not json at all" }))
      )
      const provider = makeLmStudioProvider(config(), recording.client)

      const error = yield* Effect.flip(
        provider.executeStructured("Generate a person", personSchema, personJsonSchema)
      )

      assert.strictEqual(error._tag, "ParseError")
    })
  )

  it.effect("checks the native models endpoint", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() => Effect.succeed('{"models":[]}'))
      const provider = makeLmStudioProvider(config(), recording.client)

      const available = yield* provider.isAvailable
      const requests = yield* recording.recorded

      assert.isTrue(available)
      assert.strictEqual(requests[0]?.url, "http://lmstudio.test/api/v1/models")
    })
  )

  it.effect("rejects missing base URL and unsupported tools", () =>
    Effect.gen(function* () {
      const provider = makeLmStudioProvider(
        LlmConfig.make({
          provider: "LmStudio",
          model: "local"
        }),
        makeHttpClient({
          postJson: () => Effect.succeed("{}")
        })
      )

      const configError = yield* Effect.flip(Stream.runCollect(provider.executeStream("test")))
      const toolsError = yield* Effect.flip(provider.executeWithTools("test", []))

      assert.strictEqual(configError._tag, "ConfigError")
      assert.strictEqual(toolsError._tag, "InvalidRequestError")
    })
  )
})
