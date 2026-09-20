import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { Dimension, DimensionScore, Sample } from "@llm4ts/core/eval/Eval"
import { dimensionQuestion, judge, judgeWithJudgment } from "@llm4ts/core/eval/Judge"
import { makeFakeJudgment } from "@llm4ts/core/judgment/FakeJudgment"
import { origins, scoreAnswer } from "@llm4ts/core/judgment/Schemas"
import { unsupportedScoreLabels } from "@llm4ts/core/LabelScoring"

const unused = InvalidRequestError.make({ message: "unused" })

const stub = (
  response: ReadonlyArray<DimensionScore>,
  prompt: Ref.Ref<string>
): LlmServiceShape => ({
  executeStream: (_prompt) => Stream.empty,
  executeStreamWithHistory: (_messages) => Stream.empty,
  executeWithTools: (_prompt, _tools) => Effect.fail(unused),
  executeStructured: (text, schema, _jsonSchema) =>
    Ref.set(prompt, text).pipe(
      Effect.andThen(
        Schema.decodeUnknownEffect(schema)({
          scores: response
        }).pipe(Effect.orDie)
      )
    ),
  executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  scoreLabels: unsupportedScoreLabels,
  isAvailable: Effect.succeed(true)
})

const dimensions = [
  Dimension.make({
    name: "correctness",
    rubric: "Does the response match the expected outcome?"
  }),
  Dimension.make({
    name: "safety",
    rubric: "Does the response avoid PII leakage?"
  })
]

describe("LLM judge", () => {
  it.effect("maps, clamps, and fills model scores", () =>
    Effect.gen(function* () {
      const prompt = yield* Ref.make("")
      const result = yield* judge(
        stub(
          [
            DimensionScore.make({
              name: "correctness",
              score: 3,
              reasoning: "too high"
            })
          ],
          prompt
        ),
        dimensions
      ).evaluate(Sample.make({ response: "answer", query: "question" }))

      assert.strictEqual(result.score("correctness"), 2)
      assert.strictEqual(result.score("safety"), 0)
      assert.strictEqual(
        result.scores.find((score) => score.name === "safety")?.reasoning,
        "missing"
      )
    })
  )

  it.effect("places rubrics, scales, and sample material in the prompt", () =>
    Effect.gen(function* () {
      const prompt = yield* Ref.make("")
      yield* judge(stub([], prompt), dimensions).evaluate(
        Sample.make({
          response: "answer",
          query: "question",
          context: "facts",
          expected: "expected answer"
        })
      )
      const text = yield* Ref.get(prompt)

      assert.match(text, /Does the response match the expected outcome/)
      assert.match(text, /Does the response avoid PII leakage/)
      assert.match(text, /0\.\.2/)
      assert.match(text, /Query: question/)
      assert.match(text, /Context: facts/)
      assert.match(text, /Expected: expected answer/)
    })
  )
})

describe("judgeWithJudgment", () => {
  it("turns a dimension into a Score question with one level per rubric point", () => {
    const question = dimensionQuestion(
      Dimension.make({ name: "safety", rubric: "No PII", maxScore: 2 })
    )
    assert.strictEqual(question.type, "score")
    assert.strictEqual(question.criteria.length, 3)
    assert.match(question.instructions, /^safety: No PII$/)
  })

  it.effect("scores every dimension from its distribution and records failures as 0", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeJudgment({
        answers: {
          correctness: scoreAnswer(
            dimensionQuestion(dimensions[0] ?? Dimension.make({ name: "x", rubric: "y" })),
            { "0": 0.1, "1": 0.2, "2": 0.7 },
            origins.llm("logprobs")
          )
        },
        failures: { safety: "no label observed" }
      })
      const result = yield* judgeWithJudgment(fake.judgment, dimensions).evaluate(
        Sample.make({ response: "fine", expected: "fine" })
      )
      assert.strictEqual(result.score("correctness"), 2)
      assert.match(result.scores[0]?.reasoning ?? "", /logprobs judgment \(llm\), confidence 0\.70/)
      assert.strictEqual(result.score("safety"), 0)
      assert.match(result.scores[1]?.reasoning ?? "", /failed: no label observed/)
      const [request] = yield* fake.recorded
      assert.deepStrictEqual(request?.state, { response: "fine", expected: "fine" })
      assert.deepStrictEqual(Object.keys(request?.questions ?? {}), ["correctness", "safety"])
    })
  )
})
