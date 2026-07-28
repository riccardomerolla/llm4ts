import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import {
  ConnectorIds,
  LlmChunk,
  LlmConfig,
  LlmProvider,
  LlmResponse,
  Message,
  TokenUsage,
  defaultBaseUrl,
  providerConnectorId
} from "@llm4ts/core/Models"

describe("core models", () => {
  it.effect("preserves the source provider wire names", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(LlmProvider)("OpenAI")
      assert.strictEqual(JSON.stringify(encoded), '"OpenAI"')
    })
  )

  it.effect("round-trips messages through their JSON codec", () =>
    Effect.gen(function* () {
      const codec = Schema.toCodecJson(Message)
      const message = new Message({ role: "User", content: "Hello" })
      const encoded = yield* Schema.encodeEffect(codec)(message)
      const decoded = yield* Schema.decodeUnknownEffect(codec)(encoded)

      assert.deepStrictEqual(decoded, message)
    })
  )

  it.effect("round-trips responses and streaming chunks", () =>
    Effect.gen(function* () {
      const usage = new TokenUsage({ prompt: 10, completion: 5, total: 15 })
      const response = new LlmResponse({
        content: "Hello world",
        usage,
        metadata: { model: "gpt-4" }
      })
      const chunk = new LlmChunk({ delta: "Hello", finishReason: "stop" })

      const encodedResponse = yield* Schema.encodeEffect(Schema.toCodecJson(LlmResponse))(response)
      const decodedResponse = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(LlmResponse))(
        encodedResponse
      )
      const encodedChunk = yield* Schema.encodeEffect(Schema.toCodecJson(LlmChunk))(chunk)
      const decodedChunk = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(LlmChunk))(
        encodedChunk
      )

      assert.deepStrictEqual(decodedResponse, response)
      assert.deepStrictEqual(decodedChunk, chunk)
    })
  )

  it("applies source-compatible configuration defaults", () => {
    const config = new LlmConfig({
      provider: "GeminiCli",
      model: "gemini-2.5-flash"
    })

    assert.strictEqual(Duration.toMillis(config.timeout), 300_000)
    assert.strictEqual(config.maxRetries, 3)
    assert.strictEqual(config.requestsPerMinute, 60)
    assert.strictEqual(config.burstSize, 10)
    assert.strictEqual(Duration.toMillis(config.acquireTimeout), 30_000)
    assert.strictEqual(config.temperature, undefined)
    assert.strictEqual(config.maxTokens, undefined)
    assert.strictEqual(config.baseUrl, undefined)
  })

  it("maps providers to defaults and stable connector identifiers", () => {
    assert.strictEqual(defaultBaseUrl("OpenAI"), "https://api.openai.com/v1")
    assert.strictEqual(defaultBaseUrl("GeminiCli"), undefined)
    assert.deepStrictEqual(providerConnectorId("OpenCode"), ConnectorIds.OpenCode)
    assert.strictEqual(ConnectorIds.Cursor.value, "cursor")
  })

  it.effect("refuses to serialize API keys", () =>
    Effect.gen(function* () {
      const config = new LlmConfig({
        provider: "OpenAI",
        model: "gpt-4",
        apiKey: Redacted.make("secret")
      })
      const error = yield* Effect.flip(Schema.encodeEffect(Schema.toCodecJson(LlmConfig))(config))

      assert.match(String(error), /Cannot serialize Redacted/)
    })
  )
})
