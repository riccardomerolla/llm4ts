import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError, ParseError, ProviderError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { LabelDistribution, LlmChunk, Message, TokenUsage } from "@llm4ts/core/Models"
import { collect } from "@llm4ts/core/Streaming"
import {
  estimateUsage,
  estimatedModelLabel,
  estimatedUsageOptionsFromEnv,
  isEstimatedModel,
  makeEstimatedUsageMeter
} from "@llm4ts/flow/EstimatedUsage"
import { unsupportedScoreLabels } from "@llm4ts/core/LabelScoring"

const unused = InvalidRequestError.make({ message: "unused" })

const options = { referenceModel: "claude-sonnet-4" }

const serviceOf = (overrides: Partial<LlmServiceShape>): LlmServiceShape => ({
  executeStream: (_prompt) => Stream.empty,
  executeStreamWithHistory: (_messages) => Stream.empty,
  executeWithTools: (_prompt, _tools) => Effect.fail(unused),
  executeStructured: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  scoreLabels: unsupportedScoreLabels,
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

  // The judgment layer reads usage off the distribution and reports it through
  // its own hook, so recording the estimate in the meter's totals alone left
  // every judgment call on a non-reporting seat invisible to `TokensUsed`.
  it.effect("fills in label-scoring usage and labels it estimated", () =>
    Effect.gen(function* () {
      const service = serviceOf({
        scoreLabels: (_prompt, _labels) =>
          Effect.succeed(
            LabelDistribution.make({
              probabilities: { yes: 0.75, no: 0.25 },
              method: "verbalized",
              support: 1
            })
          )
      })
      const meter = yield* makeEstimatedUsageMeter(service, options)
      const distribution = yield* meter.service.scoreLabels("p".repeat(40), ["yes", "no"])
      const totals = yield* meter.totals

      assert.strictEqual(distribution.usage?.prompt, 10)
      assert.strictEqual(distribution.model, "estimated:claude-sonnet-4")
      assert.deepStrictEqual(distribution.probabilities, { yes: 0.75, no: 0.25 })
      assert.strictEqual(totals?.prompt, 10)
    })
  )

  it.effect("leaves a reported label-scoring usage untouched", () =>
    Effect.gen(function* () {
      const reported = TokenUsage.make({ prompt: 7, completion: 3, total: 10 })
      const service = serviceOf({
        scoreLabels: (_prompt, _labels) =>
          Effect.succeed(
            LabelDistribution.make({
              probabilities: { yes: 1 },
              method: "logprobs",
              support: 1,
              usage: reported,
              model: "mlx-community/model"
            })
          )
      })
      const meter = yield* makeEstimatedUsageMeter(service, options)
      const distribution = yield* meter.service.scoreLabels("p".repeat(400), ["yes"])
      const totals = yield* meter.totals

      assert.deepStrictEqual(distribution.usage, reported)
      assert.strictEqual(distribution.model, "mlx-community/model")
      assert.strictEqual(totals?.total, 10)
    })
  )

  // The judgment layer reads the absence of `scoreLabelSequence` as "this
  // backend cannot batch", so the decorator must neither invent it nor hide it.
  it.effect("forwards batched label scoring only when the seat has it", () =>
    Effect.gen(function* () {
      const without = yield* makeEstimatedUsageMeter(serviceOf({}), options)
      const withBatching = yield* makeEstimatedUsageMeter(
        serviceOf({
          scoreLabelSequence: (_prompt, labelSets) =>
            Effect.succeed({
              entries: labelSets.map((labels) =>
                Result.succeed(
                  LabelDistribution.make({
                    probabilities: Object.fromEntries(
                      labels.map((label) => [label, 1 / labels.length])
                    ),
                    method: "verbalized",
                    support: 1
                  })
                )
              )
            })
        }),
        options
      )

      assert.isUndefined(without.service.scoreLabelSequence)
      assert.isDefined(withBatching.service.scoreLabelSequence)
    })
  )

  it.effect("estimates a batched call once, for the whole sequence", () =>
    Effect.gen(function* () {
      const service = serviceOf({
        scoreLabelSequence: (_prompt, labelSets) =>
          Effect.succeed({
            entries: [
              ...labelSets.slice(1).map((labels) =>
                Result.succeed(
                  LabelDistribution.make({
                    probabilities: Object.fromEntries(
                      labels.map((label) => [label, 1 / labels.length])
                    ),
                    method: "verbalized",
                    support: 1
                  })
                )
              ),
              Result.fail(ParseError.make({ message: "unreadable position", raw: "" }))
            ]
          })
      })
      const meter = yield* makeEstimatedUsageMeter(service, options)
      const batched = meter.service.scoreLabelSequence
      assert.isDefined(batched)
      const sequence = yield* batched("p".repeat(80), [
        ["yes", "no"],
        ["red", "blue"]
      ])
      const totals = yield* meter.totals

      assert.strictEqual(sequence.usage?.prompt, 20)
      assert.strictEqual(sequence.model, "estimated:claude-sonnet-4")
      // One call, one estimate: the entries themselves stay usage-free, which is
      // what keeps `LlmJudgment` from counting a batch twice.
      assert.isTrue(
        sequence.entries.every(
          (entry) => !Result.isSuccess(entry) || entry.success.usage === undefined
        )
      )
      assert.strictEqual(totals?.prompt, 20)
    })
  )
})
