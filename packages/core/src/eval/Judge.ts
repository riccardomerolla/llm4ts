import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ProviderError } from "../Errors.ts"
import type { JudgmentShape } from "../judgment/Judgment.ts"
import { score, type ScoreQuestion, type State } from "../judgment/Schemas.ts"
import type { LlmServiceShape } from "../LlmService.ts"
import type { JsonSchema } from "../Models.ts"
import { DimensionScore, EvalResult } from "./Eval.ts"
import type { Dimension, Sample } from "./Eval.ts"
import { makeEvaluator, type Evaluator } from "./Evaluator.ts"

export class JudgeResponse extends Schema.Class<JudgeResponse>("JudgeResponse")({
  scores: Schema.Array(DimensionScore)
}) {}

export const defaultSystem =
  "You are an impartial evaluator. Score each dimension strictly on its rubric; when unsure, score lower. " +
  "Return ONLY valid JSON, no prose."

const judgeJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          score: { type: "integer" },
          reasoning: { type: "string" }
        },
        required: ["name", "score"]
      }
    }
  },
  required: ["scores"],
  additionalProperties: false
}

export const buildPrompt = (
  system: string,
  dimensions: ReadonlyArray<Dimension>,
  sample: Sample
): string => {
  const rubric = dimensions
    .map((dimension) => `- ${dimension.name} (0..${dimension.maxScore}): ${dimension.rubric}`)
    .join("\n")
  const user = [
    sample.query === undefined ? undefined : `Query: ${sample.query}`,
    sample.context === undefined ? undefined : `Context: ${sample.context}`,
    `Response: ${sample.response}`,
    sample.expected === undefined ? undefined : `Expected: ${sample.expected}`
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
  return `${system}

Score each dimension on its 0..max scale per the rubric:
${rubric}

Return ONLY this JSON: {"scores":[{"name":"<dimension>","score":<int>,"reasoning":"<one sentence>"}]}

${user}`
}

const toResult = (dimensions: ReadonlyArray<Dimension>, response: JudgeResponse): EvalResult => {
  const byName = new Map(response.scores.map((score) => [score.name, score]))
  return EvalResult.make({
    scores: dimensions.map((dimension) => {
      const score = byName.get(dimension.name)
      return score === undefined
        ? DimensionScore.make({
            name: dimension.name,
            score: 0,
            reasoning: "missing"
          })
        : DimensionScore.make({
            name: dimension.name,
            score: Math.max(0, Math.min(dimension.maxScore, score.score)),
            reasoning: score.reasoning
          })
    })
  })
}

export const judge = (
  llm: LlmServiceShape,
  dimensions: ReadonlyArray<Dimension>,
  system = defaultSystem
): Evaluator<Sample> =>
  makeEvaluator((sample) =>
    llm
      .executeStructured(buildPrompt(system, dimensions, sample), JudgeResponse, judgeJsonSchema)
      .pipe(Effect.map((response) => toResult(dimensions, response)))
  )

/**
 * A dimension as a Score question: one level per rubric point, so the
 * judgment returns a distribution over the scale instead of one integer.
 */
export const dimensionQuestion = (dimension: Dimension): ScoreQuestion =>
  score(
    `${dimension.name}: ${dimension.rubric}`,
    Array.from({ length: dimension.maxScore + 1 }, (_, level) => ({
      level,
      of: dimension.maxScore,
      meaning:
        level === 0
          ? "does not meet the rubric at all"
          : level === dimension.maxScore
            ? "fully meets the rubric"
            : `partially meets the rubric (${level} of ${dimension.maxScore})`
    }))
  )

export const sampleState = (sample: Sample): State => ({
  ...(sample.query === undefined ? {} : { query: sample.query }),
  ...(sample.context === undefined ? {} : { context: sample.context }),
  response: sample.response,
  ...(sample.expected === undefined ? {} : { expected: sample.expected })
})

/**
 * The rubric judge over the Judgment service (ADR 0017, consumer 1): every
 * dimension is an independent Score question over the same sample. A
 * dimension the backend could not answer scores 0 with the reason recorded,
 * matching the generative judge's treatment of a missing score.
 */
export const judgeWithJudgment = (
  judgment: JudgmentShape,
  dimensions: ReadonlyArray<Dimension>
): Evaluator<Sample> =>
  makeEvaluator((sample) =>
    judgment
      .judge({
        state: sampleState(sample),
        questions: Object.fromEntries(
          dimensions.map((dimension) => [dimension.name, dimensionQuestion(dimension)])
        )
      })
      .pipe(
        Effect.mapError((error) =>
          ProviderError.make({ message: `judgment backend failed: ${error.message}`, cause: error })
        ),
        Effect.map((result) =>
          EvalResult.make({
            scores: dimensions.map((dimension) => {
              const answer = result.answers[dimension.name]
              if (answer === undefined || answer.type !== "score") {
                const failure = result.failures.find((entry) => entry.key === dimension.name)
                return DimensionScore.make({
                  name: dimension.name,
                  score: 0,
                  reasoning: failure === undefined ? "missing" : `failed: ${failure.reason}`
                })
              }
              return DimensionScore.make({
                name: dimension.name,
                score: Math.max(0, Math.min(dimension.maxScore, Math.round(answer.score))),
                reasoning: `${answer.origin.method} judgment (${answer.origin.backend}), confidence ${answer.confidence.toFixed(2)}, support ${answer.support.toFixed(2)}, expected level ${answer.score.toFixed(2)}`
              })
            })
          })
        )
      )
  )
