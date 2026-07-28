import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { Dimension, DimensionScore, Sample } from "@llm4ts/core/eval/Eval"
import { judge } from "@llm4ts/core/eval/Judge"

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
