import * as Effect from "effect/Effect"
import { DimensionScore, EvalResult } from "./Eval.ts"
import { makeEvaluator, type Evaluator } from "./Evaluator.ts"

const piiPatterns: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["ssn", /\b\d{3}-\d{2}-\d{4}\b/],
  ["credit-card", /\b(?:\d[ -]?){13,16}\b/],
  ["phone", /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/],
  ["ipv4", /\b(?:\d{1,3}\.){3}\d{1,3}\b/]
]

const one = (name: string, ok: boolean, maxScore: number, why: string): EvalResult =>
  EvalResult.make({
    scores: [
      DimensionScore.make({
        name,
        score: ok ? maxScore : 0,
        reasoning: why
      })
    ]
  })

export const noPii = (maxScore = 2): Evaluator<string> =>
  makeEvaluator((input) => {
    const hits = piiPatterns.flatMap(([label, pattern]) => (pattern.test(input) ? [label] : []))
    return Effect.succeed(
      one(
        "no-pii",
        hits.length === 0,
        maxScore,
        hits.length === 0 ? "no PII detected" : `matched: ${hits.join(", ")}`
      )
    )
  })

export const validJson = (maxScore = 2): Evaluator<string> =>
  makeEvaluator((input) => {
    let valid = true
    try {
      JSON.parse(input)
    } catch {
      valid = false
    }
    return Effect.succeed(
      one("valid-json", valid, maxScore, valid ? "parses as JSON" : "not valid JSON")
    )
  })

export const matches = (regex: string, name = "format", maxScore = 2): Evaluator<string> =>
  makeEvaluator((input) => {
    const ok = new RegExp(`^(?:${regex})$`).test(input)
    return Effect.succeed(
      one(name, ok, maxScore, ok ? `matches /${regex}/` : `does not match /${regex}/`)
    )
  })

export const lengthBetween = (min: number, max: number, maxScore = 2): Evaluator<string> =>
  makeEvaluator((input) =>
    Effect.succeed(
      one(
        "length",
        input.length >= min && input.length <= max,
        maxScore,
        `length ${input.length}; bounds [${min}, ${max}]`
      )
    )
  )
