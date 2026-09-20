import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { makeApiConnector } from "@llm4ts/core/Connector"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import {
  normalizeLabelProbabilities,
  unsupportedScoreLabels,
  verbalizedLabelsJsonSchema,
  verbalizedScoreLabels
} from "@llm4ts/core/LabelScoring"
import type { StructuredResult } from "@llm4ts/core/LlmService"
import { ConnectorIds, TokenUsage, type JsonSchema } from "@llm4ts/core/Models"

const unused = InvalidRequestError.make({ message: "unused" })

const structuredReplying =
  (reply: unknown, usage?: TokenUsage) =>
  <A, E, RD, RE>(
    _prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    _jsonSchema: JsonSchema
  ): Effect.Effect<StructuredResult<A>, never, RD> =>
    Schema.decodeUnknownEffect(schema)(reply).pipe(
      Effect.orDie,
      Effect.map((value) => [value, usage, "fake-model"] as const)
    )

describe("LabelScoring", () => {
  it.effect("normalizes over the offered labels only and clamps negatives", () =>
    Effect.gen(function* () {
      const distribution = yield* normalizeLabelProbabilities(
        ["A", "B"],
        { A: 3, B: 1, C: 100, D: -5 },
        "logprobs"
      )
      assert.deepStrictEqual(distribution.probabilities, { A: 0.75, B: 0.25 })
      assert.strictEqual(distribution.method, "logprobs")
      // Support is capped at 1: these numbers were not a probability distribution.
      assert.strictEqual(distribution.support, 1)
      const sliver = yield* normalizeLabelProbabilities(
        ["A", "B"],
        { A: 0.04, B: 0.01, The: 0.95 },
        "logprobs"
      )
      assert.closeTo(sliver.probabilities["A"] ?? 0, 0.8, 1e-9)
      assert.closeTo(sliver.probabilities["B"] ?? 0, 0.2, 1e-9)
      assert.closeTo(sliver.support, 0.05, 1e-9)
    })
  )

  it.effect("fails typed when no offered label carries mass", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        normalizeLabelProbabilities(["A", "B"], { C: 1 }, "logprobs")
      )
      assert.strictEqual(error._tag, "ParseError")
      assert.match(error.message, /none of the offered labels/)
    })
  )

  it("builds a JSON schema that names every label", () => {
    const schema = verbalizedLabelsJsonSchema(["yes", "no"])
    assert.deepStrictEqual(schema.required, ["label", "probabilities"])
    const properties = schema.properties
    assert.isObject(properties)
  })

  it.effect("derives verbalized scoring from a structured reply and carries usage", () =>
    Effect.gen(function* () {
      const usage = TokenUsage.make({ prompt: 12, completion: 8, total: 20 })
      const score = verbalizedScoreLabels(
        structuredReplying({ label: "B", probabilities: { A: 0.2, B: 0.8 } }, usage)
      )
      const distribution = yield* score("which?", ["A", "B"])
      assert.deepStrictEqual(distribution.probabilities, { A: 0.2, B: 0.8 })
      assert.strictEqual(distribution.method, "verbalized")
      assert.strictEqual(distribution.support, 1)
      assert.deepStrictEqual(distribution.usage, usage)
      assert.strictEqual(distribution.model, "fake-model")
    })
  )

  it.effect(
    "fails typed when the model names a label it gave no mass, instead of inventing it",
    () =>
      Effect.gen(function* () {
        const score = verbalizedScoreLabels(
          structuredReplying({ label: "A", probabilities: { A: 0, B: 0 } })
        )
        const error = yield* Effect.flip(score("which?", ["A", "B"]))
        assert.strictEqual(error._tag, "ParseError")
        assert.match(error.message, /gave it no probability/)
      })
  )

  it.effect("makeApiConnector derives scoreLabels when the provider offers none", () =>
    Effect.gen(function* () {
      const connector = makeApiConnector({
        id: ConnectorIds.Mock,
        executeStream: () => Stream.empty,
        executeStreamWithHistory: () => Stream.empty,
        executeWithTools: () => Effect.fail(unused),
        executeStructuredWithUsage: structuredReplying({
          label: "no",
          probabilities: { yes: 0.1, no: 0.9 }
        }),
        isAvailable: Effect.succeed(true)
      })
      const distribution = yield* connector.scoreLabels("is it?", ["yes", "no"])
      assert.deepStrictEqual(distribution.probabilities, { yes: 0.1, no: 0.9 })
      assert.strictEqual(connector.capabilities.labelProbabilities, "verbalized")
    })
  )

  it.effect("makeApiConnector keeps a native scoreLabels when the provider has one", () =>
    Effect.gen(function* () {
      const connector = makeApiConnector({
        id: ConnectorIds.Mock,
        executeStream: () => Stream.empty,
        executeStreamWithHistory: () => Stream.empty,
        executeWithTools: () => Effect.fail(unused),
        executeStructuredWithUsage: () => Effect.fail(unused),
        scoreLabels: (_prompt, labels) =>
          normalizeLabelProbabilities(labels, { [labels[0] ?? ""]: 1 }, "logprobs"),
        isAvailable: Effect.succeed(true)
      })
      const distribution = yield* connector.scoreLabels("is it?", ["yes", "no"])
      assert.strictEqual(distribution.method, "logprobs")
      assert.deepStrictEqual(distribution.probabilities, { yes: 1, no: 0 })
    })
  )

  it.effect("unsupportedScoreLabels fails typed", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(unsupportedScoreLabels("p", ["a"]))
      assert.strictEqual(error._tag, "InvalidRequestError")
    })
  )
})
