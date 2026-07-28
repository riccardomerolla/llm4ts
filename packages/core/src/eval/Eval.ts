import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { LlmError } from "../Errors.ts"
import type { Evaluator } from "./Evaluator.ts"

export class Dimension extends Schema.Class<Dimension>("Dimension")({
  name: Schema.String,
  rubric: Schema.String,
  maxScore: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(2)))
}) {}

export class DimensionScore extends Schema.Class<DimensionScore>("DimensionScore")({
  name: Schema.String,
  score: Schema.Int,
  reasoning: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("")))
}) {}

export class EvalResult extends Schema.Class<EvalResult>("EvalResult")({
  scores: Schema.Array(DimensionScore),
  summary: Schema.String.pipe(Schema.withConstructorDefault(Effect.succeed("")))
}) {
  score(name: string): number | undefined {
    return this.scores.find((item) => item.name === name)?.score
  }

  get total(): number {
    return this.scores.reduce((sum, item) => sum + item.score, 0)
  }

  meets(minPerDimension: number): boolean {
    return this.scores.every((item) => item.score >= minPerDimension)
  }
}

export class Sample extends Schema.Class<Sample>("Sample")({
  response: Schema.String,
  query: Schema.optionalKey(Schema.String),
  context: Schema.optionalKey(Schema.String),
  expected: Schema.optionalKey(Schema.String)
}) {}

export class DimensionStats extends Schema.Class<DimensionStats>("DimensionStats")({
  name: Schema.String,
  median: Schema.Int,
  min: Schema.Int,
  max: Schema.Int
}) {
  get spread(): number {
    return this.max - this.min
  }

  isFlaky(threshold: number): boolean {
    return this.spread > threshold
  }
}

export class RepeatedEval extends Schema.Class<RepeatedEval>("RepeatedEval")({
  runs: Schema.Array(EvalResult),
  stats: Schema.Array(DimensionStats),
  spreadThreshold: Schema.Int
}) {
  get flakyDimensions(): ReadonlyArray<string> {
    return this.stats.filter((stat) => stat.isFlaky(this.spreadThreshold)).map((stat) => stat.name)
  }

  get isFlaky(): boolean {
    return this.flakyDimensions.length > 0
  }

  get aggregate(): EvalResult {
    return EvalResult.make({
      scores: this.stats.map((stat) =>
        DimensionScore.make({
          name: stat.name,
          score: stat.median,
          reasoning: `median of ${this.runs.length} runs`
        })
      ),
      summary: `aggregate of ${this.runs.length} runs`
    })
  }
}

const median = (sorted: ReadonlyArray<number>): number =>
  sorted.length === 0 ? 0 : (sorted[Math.floor((sorted.length - 1) / 2)] ?? 0)

export const repeat = Effect.fn("@llm4ts/core/eval/Eval.repeat")(function* <In>(
  evaluator: Evaluator<In>,
  input: In,
  n = 3,
  spreadThreshold = 1
): Effect.fn.Return<RepeatedEval, LlmError> {
  const runs = yield* Effect.forEach(Array.from({ length: Math.max(0, n) }), () =>
    evaluator.evaluate(input)
  )
  const names = [...new Set(runs.flatMap((run) => run.scores.map((score) => score.name)))]
  const stats = names.map((name) => {
    const values = runs
      .flatMap((run) => {
        const score = run.score(name)
        return score === undefined ? [] : [score]
      })
      .sort((left, right) => left - right)
    return DimensionStats.make({
      name,
      median: median(values),
      min: values.at(0) ?? 0,
      max: values.at(-1) ?? 0
    })
  })
  return RepeatedEval.make({ runs, stats, spreadThreshold })
})
