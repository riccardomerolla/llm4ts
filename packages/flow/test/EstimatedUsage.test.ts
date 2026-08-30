import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError, ProviderError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { LlmChunk, Message, TokenUsage } from "@llm4ts/core/Models"
import { collect } from "@llm4ts/core/Streaming"
import {
  estimateUsage,
  estimatedModelLabel,
  estimatedUsageOptionsFromEnv,
  isEstimatedModel,
  makeEstimatedUsageMeter
} from "@llm4ts/flow/EstimatedUsage"

const unused = InvalidRequestError.make({ message: "unused" })

const options = { referenceModel: "claude-sonnet-4" }

const serviceOf = (overrides: Partial<LlmServiceShape>): LlmServiceShape => ({
  executeStream: (_prompt) => Stream.empty,
  executeStreamWithHistory: (_messages) => Stream.empty,
  executeWithTools: (_prompt, _tools) => Effect.fail(unused),
  executeStructured: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  isAvailable: Effect.succeed(true),
  ...overrides
})

describe("EstimatedUsage", () => {
  it("estimates tokens from characters and prices via the reference model", () => {
    const usage = estimateUsage(400, 100, options)

    assert.strictEqual(usage.prompt, 100)
    assert.strictEqual(usage.completion, 25)
    assert.strictEqual(usage.total, 125)
    // claude-sonnet-4 rates exist in the PriceList, so a cost is attached.
    assert.isDefined(usage.costUsd)
    assert.strictEqual(estimateUsage(8, 8, { ...options, charsPerToken: 8 }).total, 2)
    assert.isTrue(isEstimatedModel(estimatedModelLabel("claude-sonnet-4")))
    assert.isFalse(isEstimatedModel("claude-sonnet-4"))
  })

  it("reads reference model and chars-per-token from the environment", () => {
    const fromEnv = estimatedUsageOptionsFromEnv({
      LLM4TS_ESTIMATE_MODEL: "claude-haiku-4",
      LLM4TS_ESTIMATE_CHARS_PER_TOKEN: "5"
    })
    const defaults = estimatedUsageOptionsFromEnv({})

    assert.strictEqual(fromEnv.referenceModel, "claude-haiku-4")
    assert.strictEqual(fromEnv.charsPerToken, 5)
    assert.strictEqual(defaults.referenceModel, "claude-sonnet-4")
    assert.isUndefined(defaults.charsPerToken)
  })

  it.effect("appends a labelled synthetic usage chunk when the backend reports none", () =>
    Effect.gen(function* () {
      const service = serviceOf({
        executeStreamWithHistory: (_messages) =>
          Stream.fromIterable([
            LlmChunk.make({ delta: "hello " }),
            LlmChunk.make({ delta: "world", finishReason: "stop" })
          ])
      })
      const meter = yield* makeEstimatedUsageMeter(service, options)
      const messages = [Message.make({ role: "User", content: "x".repeat(40) })]
      const response = yield* collect(meter.service.executeStreamWithHistory(messages))
      const totals = yield* meter.totals

      assert.strictEqual(response.content, "hello world")
      assert.strictEqual(response.metadata.model, "estimated:claude-sonnet-4")
      assert.strictEqual(response.usage?.prompt, 10)
      assert.strictEqual(response.usage?.completion, 3)
      assert.isDefined(response.usage?.costUsd)
      assert.strictEqual(totals?.total, 13)
    })
  )

  it.effect("never double-counts a backend that reported real usage", () =>
    Effect.gen(function* () {
      const real = TokenUsage.make({ prompt: 7, completion: 2, total: 9 })
      const service = serviceOf({
        executeStreamWithHistory: (_messages) =>
          Stream.fromIterable([LlmChunk.make({ delta: "ok", usage: real })])
      })
      const meter = yield* makeEstimatedUsageMeter(service, options)
      const response = yield* collect(
        meter.service.executeStreamWithHistory([Message.make({ role: "User", content: "hi" })])
      )
      const totals = yield* meter.totals

      assert.deepStrictEqual(response.usage, real)
      assert.notInclude(response.metadata.model ?? "", "estimated")
      assert.strictEqual(totals?.total, 9)
    })
  )

  it.effect("estimates nothing for a failed stream", () =>
    Effect.gen(function* () {
      const service = serviceOf({
        executeStreamWithHistory: (_messages) =>
          Stream.concat(
            Stream.succeed(LlmChunk.make({ delta: "partial" })),
            Stream.fail(ProviderError.make({ message: "boom" }))
          )
      })
      const meter = yield* makeEstimatedUsageMeter(service, options)
      const result = yield* Effect.result(
        collect(
          meter.service.executeStreamWithHistory([Message.make({ role: "User", content: "hi" })])
        )
      )
      const totals = yield* meter.totals

      assert.strictEqual(result._tag, "Failure")
      assert.isUndefined(totals)
    })
  )

  it.effect("fills in structured-call usage and labels it estimated", () =>
    Effect.gen(function* () {
      const value = { answer: "yes" }
      const service = serviceOf({
        executeStructuredWithUsage: (_prompt, schema, _jsonSchema) =>
          Schema.decodeUnknownEffect(schema)(value).pipe(
            Effect.mapError(() => unused),
            Effect.map((decoded) => [decoded, undefined, undefined] as const)
          )
      })
      const meter = yield* makeEstimatedUsageMeter(service, options)
      const [decoded, usage, model] = yield* meter.service.executeStructuredWithUsage(
        "p".repeat(20),
        Schema.Unknown,
        { type: "object" }
      )
      const totals = yield* meter.totals

      assert.deepStrictEqual(decoded, value)
      assert.strictEqual(usage?.prompt, 5)
      assert.strictEqual(model, "estimated:claude-sonnet-4")
      assert.strictEqual(totals?.prompt, 5)
    })
  )
})
