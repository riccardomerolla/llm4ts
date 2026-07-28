import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import { LlmConfig, Message, type JsonSchema } from "@llm4ts/core/Models"
import { makeMockProvider, mockResponse } from "@llm4ts/core/providers/MockProvider"
import { collect } from "@llm4ts/core/Streaming"

const provider = makeMockProvider(
  LlmConfig.make({
    provider: "Mock",
    model: "mock-model"
  })
)

const resultSchema = Schema.Struct({
  result: Schema.String
})

const resultJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    result: {
      type: "string"
    }
  }
}

const issueBatchSchema = Schema.Struct({
  summary: Schema.String,
  issues: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      priority: Schema.String,
      title: Schema.String
    })
  )
})

const issueBatchJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    issues: {
      type: "array"
    }
  },
  required: ["summary", "issues"]
}

describe("MockProvider", () => {
  it.effect("streams deterministic words with final usage", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(collect(provider.executeStream("ignored")))
      yield* TestClock.adjust("10 seconds")
      const response = yield* Fiber.join(fiber)

      assert.strictEqual(response.content, mockResponse())
      assert.strictEqual(response.usage?.completion, mockResponse().split(" ").length)
      assert.strictEqual(response.metadata.provider, "mock")
    })
  )

  it.effect("uses the last user turn and remains deterministic", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(
          provider.executeStreamWithHistory([
            Message.make({ role: "User", content: "first" }),
            Message.make({ role: "Assistant", content: "answer" }),
            Message.make({ role: "User", content: "last" })
          ])
        )
      )
      yield* TestClock.adjust("10 seconds")
      const chunks = yield* Fiber.join(fiber)

      assert.isTrue(chunks.length > 1)
      assert.strictEqual(chunks.at(-1)?.finishReason, "stop")
    })
  )

  it.effect("returns deterministic tool-free and structured responses", () =>
    Effect.gen(function* () {
      const tools = yield* provider.executeWithTools("test", [])
      const structured = yield* provider.executeStructured("test", resultSchema, resultJsonSchema)

      assert.strictEqual(tools.content, mockResponse())
      assert.deepStrictEqual(tools.toolCalls, [])
      assert.deepStrictEqual(structured, {
        result: "mock structured response"
      })
    })
  )

  it.effect("generates bounded issue-batch fixtures and reports healthy", () =>
    Effect.gen(function* () {
      const batch = yield* provider.executeStructured(
        "Generate 3 issues",
        issueBatchSchema,
        issueBatchJsonSchema
      )
      const available = yield* provider.isAvailable
      const health = yield* provider.healthCheck

      assert.strictEqual(batch.issues.length, 3)
      assert.strictEqual(batch.issues[0]?.id, "demo-issue-1")
      assert.strictEqual(batch.issues[0]?.title, "Set up Spring Boot project scaffold")
      assert.strictEqual(
        batch.summary,
        "Generated 3 issue drafts for Spring Boot microservice demo."
      )
      assert.isTrue(available)
      assert.strictEqual(health.availability, "Healthy")
    })
  )
})
