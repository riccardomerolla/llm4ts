import * as Effect from "effect/Effect"
import type { LlmError } from "../Errors.ts"
import { repeat } from "./Eval.ts"
import type { EvalResult, RepeatedEval } from "./Eval.ts"
import type { Evaluator } from "./Evaluator.ts"

export interface EvalCase<In> {
  readonly name: string
  readonly input: In
  readonly minPerDimension?: number
}

export interface CaseReport {
  readonly name: string
  readonly result: EvalResult
  readonly repeated: RepeatedEval | undefined
  readonly passed: boolean
}

export interface SuiteReport {
  readonly cases: ReadonlyArray<CaseReport>
  readonly passed: boolean
  readonly failures: ReadonlyArray<CaseReport>
}

export const run = Effect.fn("@llm4ts/core/eval/EvalSuite.run")(function* <In>(
  evaluator: Evaluator<In>,
  cases: ReadonlyArray<EvalCase<In>>,
  repeats = 1,
  spreadThreshold = 1
): Effect.fn.Return<SuiteReport, LlmError> {
  const reports = yield* Effect.forEach(cases, (testCase) => {
    const minimum = testCase.minPerDimension ?? 1
    if (repeats <= 1) {
      return evaluator.evaluate(testCase.input).pipe(
        Effect.map(
          (result): CaseReport => ({
            name: testCase.name,
            result,
            repeated: undefined,
            passed: result.meets(minimum)
          })
        )
      )
    }
    return repeat(evaluator, testCase.input, repeats, spreadThreshold).pipe(
      Effect.map((repeated): CaseReport => {
        const result = repeated.aggregate
        return {
          name: testCase.name,
          result,
          repeated,
          passed: result.meets(minimum) && !repeated.isFlaky
        }
      })
    )
  })
  return {
    cases: reports,
    passed: reports.every((report) => report.passed),
    failures: reports.filter((report) => !report.passed)
  }
})
