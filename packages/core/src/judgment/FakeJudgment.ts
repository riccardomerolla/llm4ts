import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import { Judgment, type JudgmentInput, type JudgmentShape } from "./Judgment.ts"
import {
  choiceAnswer,
  JudgmentRequest,
  JudgmentResult,
  origins,
  QuestionFailure,
  scoreAnswer,
  truthAnswer,
  type Answer,
  type Question
} from "./Schemas.ts"

/**
 * `FakeJudgment`: deterministic answers for tests. A plan maps question keys
 * to canned answers (or a failure reason); unplanned questions get a
 * predictable default so a consumer test can run without listing every key.
 */

export interface FakeJudgmentPlan {
  readonly answers?: Readonly<Record<string, Answer>>
  readonly failures?: Readonly<Record<string, string>>
  /** Truth probability for unplanned truth questions (default 1). */
  readonly defaultTruth?: number
}

export interface FakeJudgment {
  readonly judgment: JudgmentShape
  readonly recorded: Effect.Effect<ReadonlyArray<JudgmentRequest>>
}

const defaultAnswer = (question: Question, defaultTruth: number): Answer => {
  switch (question.type) {
    case "choice": {
      const keys = Object.keys(question.criteria)
      return choiceAnswer(
        Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 1 : 0])),
        origins.fake()
      )
    }
    case "score":
      return scoreAnswer(
        question,
        Object.fromEntries(
          question.criteria.map((_, index) => [String(index), index === 0 ? 1 : 0])
        ),
        origins.fake()
      )
    case "truth":
      return truthAnswer(defaultTruth, origins.fake())
  }
}

export const makeFakeJudgment = Effect.fn("@llm4ts/core/judgment/FakeJudgment.make")(function* (
  plan: FakeJudgmentPlan = {}
): Effect.fn.Return<FakeJudgment> {
  const requests = yield* Ref.make<ReadonlyArray<JudgmentRequest>>([])
  const judge = (input: JudgmentInput): Effect.Effect<JudgmentResult> =>
    Ref.update(requests, (all) => [
      ...all,
      JudgmentRequest.make({ state: input.state, questions: input.questions })
    ]).pipe(
      Effect.map(() => {
        const answers: Record<string, Answer> = {}
        const failures: Array<QuestionFailure> = []
        for (const [key, question] of Object.entries(input.questions)) {
          const failure = plan.failures?.[key]
          if (failure !== undefined) {
            failures.push(QuestionFailure.make({ key, reason: failure }))
            continue
          }
          answers[key] = plan.answers?.[key] ?? defaultAnswer(question, plan.defaultTruth ?? 1)
        }
        return JudgmentResult.make({ answers, failures, backend: "fake" })
      })
    )
  return {
    judgment: { backend: "fake", identity: "fake", judge },
    recorded: Ref.get(requests)
  }
})

export const FakeJudgmentLive = (plan?: FakeJudgmentPlan): Layer.Layer<Judgment> =>
  Layer.effect(
    Judgment,
    Effect.map(makeFakeJudgment(plan), (fake) => fake.judgment)
  )
