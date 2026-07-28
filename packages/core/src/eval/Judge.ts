import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
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
