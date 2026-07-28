import * as Effect from "effect/Effect"
import type { LlmError } from "../Errors.ts"
import { EvalResult } from "./Eval.ts"

export interface Evaluator<in In> {
  readonly evaluate: (input: In) => Effect.Effect<EvalResult, LlmError>
}

export const makeEvaluator = <In>(evaluate: Evaluator<In>["evaluate"]): Evaluator<In> => ({
  evaluate
})

export const contramap = <In, In2>(
  evaluator: Evaluator<In>,
  project: (input: In2) => In
): Evaluator<In2> => makeEvaluator((input) => evaluator.evaluate(project(input)))

export const all = <In>(...evaluators: ReadonlyArray<Evaluator<In>>): Evaluator<In> =>
  makeEvaluator((input) =>
    Effect.forEach(evaluators, (evaluator) => evaluator.evaluate(input)).pipe(
      Effect.map((results) =>
        EvalResult.make({
          scores: results.flatMap((result) => result.scores),
          summary: results
            .map((result) => result.summary)
            .filter((summary) => summary.length > 0)
            .join("; ")
        })
      )
    )
  )
