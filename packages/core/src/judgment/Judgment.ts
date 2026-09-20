import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  ChoiceAnswer,
  ScoreAnswer,
  TruthAnswer,
  type Answer,
  type JudgmentBackend,
  type JudgmentResult,
  type Question,
  type State
} from "./Schemas.ts"

/**
 * The Judgment service (ADR 0017): evaluate typed questions against one
 * State and return typed answers with probabilities and their origin. It
 * answers; it never decides. Policy (thresholds, escalation, caching) lives
 * in the flow package.
 */

export class JudgmentBackendError extends Schema.TaggedError<JudgmentBackendError>()(
  "JudgmentBackendError",
  {
    backend: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

/** Raised by the typed accessors when a key is missing or of another kind. */
export class AnswerMismatch extends Schema.TaggedError<AnswerMismatch>()("AnswerMismatch", {
  key: Schema.String,
  expected: Schema.String,
  actual: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String)
}) {
  get message(): string {
    return this.actual === undefined
      ? `no ${this.expected} answer for "${this.key}"${this.reason === undefined ? "" : `: ${this.reason}`}`
      : `answer "${this.key}" is a ${this.actual}, not a ${this.expected}`
  }
}

export const JudgmentError = Schema.Union([JudgmentBackendError, AnswerMismatch])
export type JudgmentError = typeof JudgmentError.Type

export interface JudgmentInput {
  readonly state: State
  readonly questions: Readonly<Record<string, Question>>
}

export interface JudgmentShape {
  readonly backend: JudgmentBackend
  /**
   * Backend plus checkpoint, e.g. `llm:mlx-lm:/models/qwen3-4b` or
   * `typesafe:jev-1.13.0`: what a cached answer is keyed on, so swapping a
   * local model never reuses its predecessor's answers.
   */
  readonly identity: string
  /**
   * Answer every question independently over the same state. A question the
   * backend could not answer lands in `failures`; the request as a whole
   * fails only when the backend itself is unreachable or rejects it.
   */
  readonly judge: (input: JudgmentInput) => Effect.Effect<JudgmentResult, JudgmentBackendError>
}

export class Judgment extends Context.Service<Judgment, JudgmentShape>()(
  "@llm4ts/core/judgment/Judgment"
) {}

const answerOf = (
  result: JudgmentResult,
  key: string,
  expected: Answer["type"]
): Effect.Effect<Answer, AnswerMismatch> => {
  const answer = result.answers[key]
  if (answer === undefined) {
    const failure = result.failures.find((entry) => entry.key === key)
    return Effect.fail(
      AnswerMismatch.make({
        key,
        expected,
        ...(failure === undefined ? {} : { reason: failure.reason })
      })
    )
  }
  return answer.type === expected
    ? Effect.succeed(answer)
    : Effect.fail(AnswerMismatch.make({ key, expected, actual: answer.type }))
}

/** Typed accessors: the honest way to read an answer by key. */
export const choiceOf = (
  result: JudgmentResult,
  key: string
): Effect.Effect<ChoiceAnswer, AnswerMismatch> =>
  Effect.flatMap(answerOf(result, key, "choice"), (answer) =>
    answer instanceof ChoiceAnswer
      ? Effect.succeed(answer)
      : Effect.fail(AnswerMismatch.make({ key, expected: "choice", actual: answer.type }))
  )

export const scoreOf = (
  result: JudgmentResult,
  key: string
): Effect.Effect<ScoreAnswer, AnswerMismatch> =>
  Effect.flatMap(answerOf(result, key, "score"), (answer) =>
    answer instanceof ScoreAnswer
      ? Effect.succeed(answer)
      : Effect.fail(AnswerMismatch.make({ key, expected: "score", actual: answer.type }))
  )

export const truthOf = (
  result: JudgmentResult,
  key: string
): Effect.Effect<TruthAnswer, AnswerMismatch> =>
  Effect.flatMap(answerOf(result, key, "truth"), (answer) =>
    answer instanceof TruthAnswer
      ? Effect.succeed(answer)
      : Effect.fail(AnswerMismatch.make({ key, expected: "truth", actual: answer.type }))
  )
