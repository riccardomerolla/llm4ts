import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { lengthBetween, matches, noPii, validJson } from "@llm4ts/core/eval/Checks"
import { DimensionScore, EvalResult, Sample, repeat } from "@llm4ts/core/eval/Eval"
import { all, contramap, makeEvaluator, type Evaluator } from "@llm4ts/core/eval/Evaluator"
import { run } from "@llm4ts/core/eval/EvalSuite"

const one = (name: string, score: number): EvalResult =>
  EvalResult.make({
    scores: [DimensionScore.make({ name, score })]
  })

const sequenceEvaluator = (results: ReadonlyArray<EvalResult>): Effect.Effect<Evaluator<void>> =>
  Ref.make(results).pipe(
    Effect.map((state) =>
      makeEvaluator(() =>
        Ref.modify(state, (remaining) => [
          remaining[0] ?? EvalResult.make({ scores: [] }),
          remaining.slice(1)
        ])
      )
    )
  )

describe("Eval values and deterministic checks", () => {
  it("looks up, totals, and gates scores", () => {
    const result = EvalResult.make({
      scores: [
        DimensionScore.make({ name: "correctness", score: 2 }),
        DimensionScore.make({ name: "safety", score: 1 })
      ]
    })

    assert.strictEqual(result.score("correctness"), 2)
    assert.strictEqual(result.score("missing"), undefined)
    assert.strictEqual(result.total, 3)
    assert.isTrue(result.meets(1))
    assert.isFalse(result.meets(2))
    assert.isTrue(EvalResult.make({ scores: [] }).meets(2))
  })

  it.effect("detects PII, JSON, whole-string regexes, and inclusive lengths", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* noPii().evaluate("clean")).score("no-pii"), 2)
      assert.strictEqual((yield* noPii().evaluate("jane@example.com")).score("no-pii"), 0)
      assert.strictEqual((yield* validJson().evaluate('{"a":1}')).score("valid-json"), 2)
      assert.strictEqual((yield* validJson().evaluate("no")).score("valid-json"), 0)
      assert.strictEqual((yield* matches("[a-z]+", "lower").evaluate("abc123")).score("lower"), 0)
      assert.strictEqual((yield* lengthBetween(2, 4).evaluate("abcd")).score("length"), 2)
    })
  )

  it.effect("combines evaluators and contramaps richer inputs", () =>
    Effect.gen(function* () {
      const combined = all(
        makeEvaluator<string>(() => Effect.succeed(one("a", 2))),
        makeEvaluator<string>(() =>
          Effect.succeed(
            EvalResult.make({
              scores: [DimensionScore.make({ name: "b", score: 1 })],
              summary: "only"
            })
          )
        )
      )
      const result = yield* combined.evaluate("x")
      const sampleEvaluator = contramap(lengthBetween(4, 4), (sample: Sample) => sample.response)

      assert.deepStrictEqual(
        result.scores.map((score) => score.name),
        ["a", "b"]
      )
      assert.strictEqual(result.summary, "only")
      assert.strictEqual(
        (yield* sampleEvaluator.evaluate(Sample.make({ response: "abcd" }))).score("length"),
        2
      )
    })
  )
})

describe("repeat-N variance and evaluation suites", () => {
  it.effect("aggregates lower-middle median/min/max and flags spread", () =>
    Effect.gen(function* () {
      const evaluator = yield* sequenceEvaluator([
        one("correctness", 2),
        one("correctness", 0),
        one("correctness", 1)
      ])
      const repeated = yield* repeat(evaluator, undefined, 3, 1)
      const stat = repeated.stats[0]

      assert.strictEqual(stat?.median, 1)
      assert.strictEqual(stat?.min, 0)
      assert.strictEqual(stat?.max, 2)
      assert.strictEqual(stat?.spread, 2)
      assert.isTrue(repeated.isFlaky)
      assert.deepStrictEqual(repeated.flakyDimensions, ["correctness"])
      assert.strictEqual(repeated.aggregate.score("correctness"), 1)
      assert.strictEqual(repeated.aggregate.summary, "aggregate of 3 runs")
    })
  )

  it.effect("fails a suite case when its median passes but variance is flaky", () =>
    Effect.gen(function* () {
      const evaluator = yield* sequenceEvaluator([one("q", 2), one("q", 0), one("q", 2)])
      const report = yield* run(
        evaluator,
        [{ name: "flaky", input: undefined, minPerDimension: 1 }],
        3,
        1
      )

      assert.isFalse(report.passed)
      assert.strictEqual(report.failures[0]?.name, "flaky")
      assert.strictEqual(report.cases[0]?.result.score("q"), 2)
      assert.isTrue(report.cases[0]?.repeated?.isFlaky)
    })
  )
})
