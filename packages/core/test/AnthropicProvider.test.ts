import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { ProviderError } from "@llm4ts/core/Errors"
import { makeHttpClient, makeRecordingHttpClient, type HttpRequest } from "@llm4ts/core/HttpClient"
import { LlmConfig, Message, ToolDefinition, type JsonSchema } from "@llm4ts/core/Models"
import { AnthropicRequest, AnthropicRequestWithTools } from "@llm4ts/core/providers/AnthropicModels"
import { anthropicHistory, makeAnthropicProvider } from "@llm4ts/core/providers/AnthropicProvider"
import { collect } from "@llm4ts/core/Streaming"

const providerConfig = (
  options: {
    readonly baseUrl?: string
    readonly withApiKey?: boolean
  } = {}
): LlmConfig =>
  LlmConfig.make({
    provider: "Anthropic",
    model: "claude-3-5-sonnet-20241022",
    baseUrl: options.baseUrl ?? "https://api.anthropic.test/v1/",
    ...(options.withApiKey === false ? {} : { apiKey: Redacted.make("test-anthropic-key") })
  })

const streamEvent = (type: string, delta: Readonly<Record<string, string>>): string =>
  `data: ${JSON.stringify({
    type,
    delta
  })}`

/** The text of a message or system field, whether plain or in cache-marked blocks. */
const textOf = (content: string | ReadonlyArray<{ readonly text: string }> | undefined): string =>
  content === undefined
    ? ""
    : typeof content === "string"
      ? content
      : content.map((block) => block.text).join("")

const decodeRequest = (request: HttpRequest): Effect.Effect<AnthropicRequest, unknown> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AnthropicRequest))(request.body ?? "")

const decodeToolRequest = (
  request: HttpRequest
): Effect.Effect<AnthropicRequestWithTools, unknown> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AnthropicRequestWithTools))(request.body ?? "")

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

describe("AnthropicProvider", () => {
  it.effect("streams text and stop events through the native messages API", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(
        () => Effect.succeed("{}"),
        () =>
          Stream.make(
            streamEvent("content_block_delta", {
              type: "text_delta",
              text: "Test response"
            }),
            streamEvent("message_delta", {
              type: "message_delta",
              stop_reason: "end_turn"
            })
          )
      )
      const provider = makeAnthropicProvider(providerConfig(), recording.client)

      const response = yield* collect(provider.executeStream("test prompt"))
      const requests = yield* recording.recorded
      const request = requests[0]

      assert.strictEqual(response.content, "Test response")
      assert.strictEqual(request?.url, "https://api.anthropic.test/v1/messages")
      assert.strictEqual(request?.headers["x-api-key"], "test-anthropic-key")
      assert.strictEqual(request?.headers["anthropic-version"], "2023-06-01")
      if (request !== undefined) {
        const body = yield* decodeRequest(request)
        assert.strictEqual(body.max_tokens, 4096)
        assert.isTrue(body.stream)
        assert.strictEqual(body.messages[0]?.role, "user")
      }
    })
  )

  it.effect("extracts the first system message and maps tool turns to user", () =>
    Effect.gen(function* () {
      const history = anthropicHistory([
        Message.make({ role: "System", content: "first system" }),
        Message.make({ role: "System", content: "ignored system" }),
        Message.make({ role: "User", content: "question" }),
        Message.make({ role: "Assistant", content: "answer" }),
        Message.make({ role: "Tool", content: "tool result" })
      ])

      assert.strictEqual(history.system, "first system")
      assert.deepStrictEqual(
        history.messages.map(({ role, content }) => ({ role, content })),
        [
          { role: "user", content: "question" },
          { role: "assistant", content: "answer" },
          { role: "user", content: "tool result" }
        ]
      )
    })
  )

  it.effect("fails with typed configuration and authentication errors", () =>
    Effect.gen(function* () {
      const client = makeHttpClient({
        postJson: () => Effect.succeed("{}")
      })
      const missingKey = makeAnthropicProvider(providerConfig({ withApiKey: false }), client)
      const missingBaseUrl = makeAnthropicProvider(
        LlmConfig.make({
          provider: "Anthropic",
          model: "claude",
          apiKey: Redacted.make("key")
        }),
        client
      )

      const keyError = yield* Effect.flip(Stream.runCollect(missingKey.executeStream("test")))
      const urlError = yield* Effect.flip(Stream.runCollect(missingBaseUrl.executeStream("test")))

      assert.strictEqual(keyError._tag, "AuthenticationError")
      assert.strictEqual(urlError._tag, "ConfigError")
    })
  )

  it.effect("uses prompt-guided JSON for structured output", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() =>
        Effect.succeed(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: '{"answer":42}'
              }
            ]
          })
        )
      )
      const provider = makeAnthropicProvider(providerConfig(), recording.client)

      const result = yield* provider.executeStructured("answer", answerSchema, answerJsonSchema)
      const requests = yield* recording.recorded
      const request = requests[0]

      assert.deepStrictEqual(result, { answer: 42 })
      if (request !== undefined) {
        const body = yield* decodeRequest(request)
        assert.match(textOf(body.messages[0]?.content), /valid JSON/)
        assert.isFalse(body.stream)
      }
    })
  )

  it.effect("maps tool_use blocks to neutral tool calls", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() =>
        Effect.succeed(
          JSON.stringify({
            id: "msg_1",
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "get_weather",
                input: {
                  location: "Rome"
                }
              }
            ],
            stop_reason: "tool_use"
          })
        )
      )
      const provider = makeAnthropicProvider(providerConfig(), recording.client)
      const tool = ToolDefinition.make({
        name: "get_weather",
        description: "Get weather for a location",
        parameters: {
          type: "object",
          properties: {
            location: {
              type: "string"
            }
          },
          required: ["location"]
        }
      })

      const response = yield* provider.executeWithTools("weather in Rome", [tool])
      const requests = yield* recording.recorded
      const request = requests[0]

      assert.strictEqual(response.toolCalls[0]?.id, "toolu_1")
      assert.strictEqual(response.toolCalls[0]?.name, "get_weather")
      assert.strictEqual(response.toolCalls[0]?.arguments, '{"location":"Rome"}')
      assert.strictEqual(response.finishReason, "tool_use")
      if (request !== undefined) {
        const body = yield* decodeToolRequest(request)
        assert.strictEqual(body.tools[0]?.input_schema.type, "object")
        assert.deepStrictEqual(body.tools[0]?.input_schema.properties, tool.parameters)
      }
    })
  )

  it.effect("reports unavailable when the health stream fails", () =>
    Effect.gen(function* () {
      const client = makeHttpClient({
        postJson: () => Effect.succeed("{}"),
        postJsonStream: () =>
          Stream.fail(
            ProviderError.make({
              message: "offline"
            })
          )
      })
      const provider = makeAnthropicProvider(providerConfig(), client)

      const available = yield* provider.isAvailable
      const health = yield* provider.healthCheck

      assert.isFalse(available)
      assert.strictEqual(health.availability, "Unhealthy")
      assert.strictEqual(health.authStatus, "Invalid")
    })
  )

  it.effect("reports malformed SSE payloads as typed parse errors", () =>
    Effect.gen(function* () {
      const client = makeHttpClient({
        postJson: () => Effect.succeed("{}"),
        postJsonStream: () => Stream.make("data: malformed")
      })
      const provider = makeAnthropicProvider(providerConfig(), client)

      const error = yield* Effect.flip(Stream.runCollect(provider.executeStream("test")))

      assert.strictEqual(error._tag, "ParseError")
      if (error._tag === "ParseError") {
        assert.strictEqual(error.raw, "malformed")
      }
    })
  )

  it.effect(
    "marks the system block and the last message for the prompt cache, and sends the effort (ADR 0029)",
    () =>
      Effect.gen(function* () {
        const recording = yield* makeRecordingHttpClient(
          () => Effect.succeed("{}"),
          () => Stream.make(streamEvent("message_delta", { stop_reason: "end_turn" }))
        )
        const provider = makeAnthropicProvider(
          LlmConfig.make({ ...providerConfig(), effort: "high" }),
          recording.client
        )
        yield* collect(
          provider.executeStreamWithHistory([
            Message.make({ role: "System", content: "stable rules" }),
            Message.make({ role: "User", content: "first" }),
            Message.make({ role: "Assistant", content: "reply" }),
            Message.make({ role: "User", content: "second" })
          ])
        )
        const request = (yield* recording.recorded)[0]
        assert.isDefined(request)
        if (request !== undefined) {
          const body: unknown = JSON.parse(request.body ?? "{}")
          assert.deepStrictEqual(body, {
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 4096,
            stream: true,
            system: [{ type: "text", text: "stable rules", cache_control: { type: "ephemeral" } }],
            // Earlier turns stay plain strings: the prefix is byte-stable.
            messages: [
              { role: "user", content: "first" },
              { role: "assistant", content: "reply" },
              {
                role: "user",
                content: [{ type: "text", text: "second", cache_control: { type: "ephemeral" } }]
              }
            ],
            output_config: { effort: "high" }
          })
        }
        assert.strictEqual(provider.capabilities.effort, "mapped")
      })
  )

  it.effect(
    "sends plain strings and no output_config when caching is off and no effort is asked",
    () =>
      Effect.gen(function* () {
        const recording = yield* makeRecordingHttpClient(
          () => Effect.succeed("{}"),
          () => Stream.make(streamEvent("message_delta", { stop_reason: "end_turn" }))
        )
        const provider = makeAnthropicProvider(
          LlmConfig.make({ ...providerConfig(), promptCache: false }),
          recording.client
        )
        yield* collect(
          provider.executeStreamWithHistory([
            Message.make({ role: "System", content: "rules" }),
            Message.make({ role: "User", content: "hi" })
          ])
        )
        const request = (yield* recording.recorded)[0]
        if (request !== undefined) {
          const body = yield* decodeRequest(request)
          assert.strictEqual(body.system, "rules")
          assert.strictEqual(body.messages[0]?.content, "hi")
          assert.isUndefined(body.output_config)
        }
      })
  )

  it.effect(
    "reports usage from message_start and message_delta, cache reads as cached tokens",
    () =>
      Effect.gen(function* () {
        const recording = yield* makeRecordingHttpClient(
          () => Effect.succeed("{}"),
          () =>
            Stream.make(
              `data: ${JSON.stringify({
                type: "message_start",
                message: {
                  model: "claude-sonnet-5-5",
                  usage: {
                    input_tokens: 10,
                    cache_read_input_tokens: 900,
                    cache_creation_input_tokens: 90,
                    output_tokens: 1
                  }
                }
              })}`,
              streamEvent("content_block_delta", { type: "text_delta", text: "ok" }),
              `data: ${JSON.stringify({
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 25 }
              })}`
            )
        )
        const provider = makeAnthropicProvider(providerConfig(), recording.client)
        const response = yield* collect(provider.executeStream("hello"))
        assert.strictEqual(response.content, "ok")
        assert.deepStrictEqual(
          response.usage === undefined
            ? undefined
            : {
                prompt: response.usage.prompt,
                completion: response.usage.completion,
                total: response.usage.total,
                cached: response.usage.cached
              },
          { prompt: 1000, completion: 25, total: 1025, cached: 900 }
        )
      })
  )
})
