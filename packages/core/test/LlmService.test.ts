import { assert, describe, it, layer } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import {
  LlmService,
  executeStream,
  executeStreamWithHistory,
  executeWithTools,
  isAvailable
} from "@llm4ts/core/LlmService"
import { LlmChunk, Message, ToolCallResponse, type JsonSchema } from "@llm4ts/core/Models"
import { collect } from "@llm4ts/core/Streaming"

const mockService = LlmService.of({
  executeStream: (_prompt) =>
    Stream.make(
      new LlmChunk({ delta: "Hello" }),
      new LlmChunk({ delta: " world", finishReason: "stop" })
    ),
  executeStreamWithHistory: (_messages) =>
    Stream.make(new LlmChunk({ delta: "Stream response", finishReason: "stop" })),
  executeWithTools: (_prompt, _tools) =>
    Effect.succeed(
      new ToolCallResponse({
        content: "No tools needed",
        toolCalls: [],
        finishReason: "stop"
      })
    ),
  executeStructured: <A, E, RD, RE>(
    _prompt: string,
    _schema: Schema.ConstraintCodec<A, E, RD, RE>,
    _jsonSchema: JsonSchema
  ) => Effect.fail(new InvalidRequestError({ message: "Not implemented in mock" })),
  executeStructuredWithUsage: <A, E, RD, RE>(
    _prompt: string,
    _schema: Schema.ConstraintCodec<A, E, RD, RE>,
    _jsonSchema: JsonSchema
  ) => Effect.fail(new InvalidRequestError({ message: "Not implemented in mock" })),
  isAvailable: Effect.succeed(true)
})

const MockLlmService = Layer.succeed(LlmService)(mockService)

describe("LlmService direct implementation", () => {
  it.effect("collects streamed content into a response", () =>
    Effect.gen(function* () {
      const response = yield* collect(mockService.executeStream("test prompt"))
      assert.strictEqual(response.content, "Hello world")
    })
  )

  it.effect("exposes individual chunks", () =>
    Effect.gen(function* () {
      const chunks = yield* Stream.runCollect(mockService.executeStream("test"))

      assert.strictEqual(chunks.length, 2)
      assert.strictEqual(chunks[0]?.delta, "Hello")
      assert.strictEqual(chunks[1]?.finishReason, "stop")
    })
  )
})

layer(MockLlmService)("LlmService accessors", (it) => {
  it.effect("streams through the service context", () =>
    Effect.gen(function* () {
      const response = yield* collect(executeStream("test"))
      assert.strictEqual(response.content, "Hello world")
    })
  )

  it.effect("supports conversation history", () =>
    Effect.gen(function* () {
      const response = yield* collect(
        executeStreamWithHistory([
          new Message({ role: "User", content: "Hello" }),
          new Message({ role: "Assistant", content: "Hi there" })
        ])
      )
      assert.match(response.content, /Stream response/)
    })
  )

  it.effect("supports tools and availability", () =>
    Effect.gen(function* () {
      const response = yield* executeWithTools("test", [])
      const available = yield* isAvailable

      assert.strictEqual(response.content, "No tools needed")
      assert.isTrue(available)
    })
  )
})
