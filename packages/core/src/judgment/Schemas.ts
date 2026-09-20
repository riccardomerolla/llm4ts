import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { TokenUsage } from "../Models.ts"

/**
 * Typed judgments (ADR 0017): atomic questions evaluated against one State,
 * answered with probabilities instead of text. Wire names mirror TypeSafe's
 * Jev so its cookbooks port by search and replace, with two changes: `noul`
 * is `truth`, and every answer carries an `origin` (backend, checkpoint,
 * extraction method, calibration evidence, escalation) plus `support`, the
 * mass the backend actually placed on the offered options. Vocabulary:
 * CONTEXT.md.
 */

/** The content a judgment evaluates. Data, never instructions. */
export const State = Schema.Union([
  Schema.String,
  Schema.Record(Schema.String, Schema.Json),
  Schema.Array(Schema.String)
])
export type State = typeof State.Type

/** An option, level, or criterion: text or any JSON structure (Jev's `EntryType`). */
export const Description = Schema.Json
export type Description = typeof Description.Type

export class ChoiceQuestion extends Schema.Class<ChoiceQuestion>("ChoiceQuestion")({
  type: Schema.Literal("choice"),
  instructions: Schema.String,
  /** Option key to description. Include an "other" key when coverage is uncertain. */
  criteria: Schema.Record(Schema.String, Description)
}) {}

export class ScoreQuestion extends Schema.Class<ScoreQuestion>("ScoreQuestion")({
  type: Schema.Literal("score"),
  instructions: Schema.String,
  /** Ordered levels, index 0 first. */
  criteria: Schema.Array(Description)
}) {}

export class TruthCriteria extends Schema.Class<TruthCriteria>("TruthCriteria")({
  true: Description,
  false: Description
}) {}

export class TruthQuestion extends Schema.Class<TruthQuestion>("TruthQuestion")({
  type: Schema.Literal("truth"),
  instructions: Schema.String,
  criteria: Schema.optionalKey(TruthCriteria)
}) {}

export const Question = Schema.Union([ChoiceQuestion, ScoreQuestion, TruthQuestion])
export type Question = typeof Question.Type

export const choice = (
  instructions: string,
  criteria: Readonly<Record<string, Description>>
): ChoiceQuestion => ChoiceQuestion.make({ type: "choice", instructions, criteria })

export const score = (instructions: string, criteria: ReadonlyArray<Description>): ScoreQuestion =>
  ScoreQuestion.make({ type: "score", instructions, criteria })

export const truth = (
  instructions: string,
  criteria?: { readonly true: Description; readonly false: Description }
): TruthQuestion =>
  TruthQuestion.make({
    type: "truth",
    instructions,
    ...(criteria === undefined ? {} : { criteria: TruthCriteria.make(criteria) })
  })

export const JudgmentBackend = Schema.Literals(["typesafe", "llm", "fake"])
export type JudgmentBackend = typeof JudgmentBackend.Type

/** How the probabilities were extracted. */
export const ScoringMethod = Schema.Literals([
  "logprobs",
  "verbalized",
  "sampled",
  "reasoning",
  "hosted"
])
export type ScoringMethod = typeof ScoringMethod.Type

/**
 * What is known about the numbers' calibration: `none` (nothing), `claimed`
 * (the provider says so; TypeSafe), `measured` (an evaluation in this
 * project produced the evidence; see the judgment decision map).
 */
export const Calibration = Schema.Literals(["none", "claimed", "measured"])
export type Calibration = typeof Calibration.Type

/**
 * Where an answer came from, in four separate facts a policy may key on:
 * which backend and checkpoint produced it, how the probabilities were
 * extracted, what is known about their calibration, and whether the answer
 * replaced an earlier one through escalation.
 */
export class AnswerOrigin extends Schema.Class<AnswerOrigin>("AnswerOrigin")({
  backend: JudgmentBackend,
  model: Schema.optionalKey(Schema.String),
  method: ScoringMethod,
  calibration: Calibration.pipe(
    Schema.withConstructorDefault(Effect.succeed<Calibration>("none")),
    Schema.withDecodingDefaultKey(Effect.succeed<Calibration>("none"))
  ),
  escalated: Schema.Boolean.pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
    Schema.withDecodingDefaultKey(Effect.succeed(false))
  )
}) {}

/**
 * Probability mass the backend placed on the offered options before
 * renormalization (1 when declared over the options alone). Low support
 * means the distribution was rebuilt from a sliver and must not be acted on.
 */
const Support = Schema.Number.pipe(
  Schema.withConstructorDefault(Effect.succeed(1)),
  Schema.withDecodingDefaultKey(Effect.succeed(1))
)

export class ChoiceAnswer extends Schema.Class<ChoiceAnswer>("ChoiceAnswer")({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  probabilities: Schema.Record(Schema.String, Schema.Number),
  /** The maximum probability, everywhere: the same statistic whatever the backend. */
  confidence: Schema.Number,
  /** The backend's own confidence statistic when it reports one (TypeSafe), kept for comparison. */
  reportedConfidence: Schema.optionalKey(Schema.Number),
  support: Support,
  origin: AnswerOrigin
}) {}

export class ScoreAnswer extends Schema.Class<ScoreAnswer>("ScoreAnswer")({
  type: Schema.Literal("score"),
  /** Expected level index; may fall between two levels. */
  score: Schema.Number,
  /** Level index (as a string key) to its description, echoed from the question. */
  legend: Schema.Record(Schema.String, Description),
  probabilities: Schema.Record(Schema.String, Schema.Number),
  confidence: Schema.Number,
  reportedConfidence: Schema.optionalKey(Schema.Number),
  support: Support,
  origin: AnswerOrigin
}) {}

export class TruthAnswer extends Schema.Class<TruthAnswer>("TruthAnswer")({
  type: Schema.Literal("truth"),
  /** Probability that the statement holds. */
  truth: Schema.Number,
  support: Support,
  origin: AnswerOrigin
}) {}

export const Answer = Schema.Union([ChoiceAnswer, ScoreAnswer, TruthAnswer])
export type Answer = typeof Answer.Type

/** The answer type a question kind produces, for typed call sites. */
export type AnswerFor<Q extends Question> = Q extends ChoiceQuestion
  ? ChoiceAnswer
  : Q extends ScoreQuestion
    ? ScoreAnswer
    : TruthAnswer

/** A question that could not be answered; the others in the request still were. */
export class QuestionFailure extends Schema.Class<QuestionFailure>("QuestionFailure")({
  key: Schema.String,
  reason: Schema.String
}) {}

export class JudgmentRequest extends Schema.Class<JudgmentRequest>("JudgmentRequest")({
  state: State,
  questions: Schema.Record(Schema.String, Question)
}) {}

const noFailures: ReadonlyArray<QuestionFailure> = Object.freeze([])

export class JudgmentResult extends Schema.Class<JudgmentResult>("JudgmentResult")({
  answers: Schema.Record(Schema.String, Answer),
  failures: Schema.Array(QuestionFailure).pipe(
    Schema.withConstructorDefault(Effect.succeed(noFailures))
  ),
  usage: Schema.optionalKey(TokenUsage),
  model: Schema.optionalKey(Schema.String),
  backend: JudgmentBackend
}) {}

/** Confidence is the peak of the distribution: the maximum probability. */
export const confidenceOf = (probabilities: Readonly<Record<string, number>>): number =>
  Object.values(probabilities).reduce((max, value) => (value > max ? value : max), 0)

/** Score is the expected level index under the distribution. */
export const expectedScore = (probabilities: Readonly<Record<string, number>>): number =>
  Object.entries(probabilities).reduce((sum, [level, value]) => sum + Number(level) * value, 0)

export const argmax = (probabilities: Readonly<Record<string, number>>): string | undefined =>
  Object.entries(probabilities).reduce<readonly [string, number] | undefined>(
    (best, entry) => (best === undefined || entry[1] > best[1] ? entry : best),
    undefined
  )?.[0]

export const choiceAnswer = (
  probabilities: Readonly<Record<string, number>>,
  origin: AnswerOrigin,
  support = 1
): ChoiceAnswer =>
  ChoiceAnswer.make({
    type: "choice",
    choice: argmax(probabilities) ?? "",
    probabilities,
    confidence: confidenceOf(probabilities),
    support,
    origin
  })

export const scoreAnswer = (
  question: ScoreQuestion,
  probabilities: Readonly<Record<string, number>>,
  origin: AnswerOrigin,
  support = 1
): ScoreAnswer =>
  ScoreAnswer.make({
    type: "score",
    score: expectedScore(probabilities),
    legend: Object.fromEntries(question.criteria.map((level, index) => [String(index), level])),
    probabilities,
    confidence: confidenceOf(probabilities),
    support,
    origin
  })

export const truthAnswer = (probability: number, origin: AnswerOrigin, support = 1): TruthAnswer =>
  TruthAnswer.make({ type: "truth", truth: probability, support, origin })

/** Origins for the common cases, so call sites stay short. */
export const origins = Object.freeze({
  llm: (method: ScoringMethod, model?: string): AnswerOrigin =>
    AnswerOrigin.make({ backend: "llm", method, ...(model === undefined ? {} : { model }) }),
  hosted: (model?: string): AnswerOrigin =>
    AnswerOrigin.make({
      backend: "typesafe",
      method: "hosted",
      calibration: "claimed",
      ...(model === undefined ? {} : { model })
    }),
  fake: (method: ScoringMethod = "verbalized"): AnswerOrigin =>
    AnswerOrigin.make({ backend: "fake", method }),
  escalated: (backend: JudgmentBackend, model?: string): AnswerOrigin =>
    AnswerOrigin.make({
      backend,
      method: "reasoning",
      escalated: true,
      ...(model === undefined ? {} : { model })
    })
})

/** Average several distributions over the same keys (used for permutations). */
export const averageProbabilities = (
  distributions: ReadonlyArray<Readonly<Record<string, number>>>
): Record<string, number> => {
  const keys = new Set(distributions.flatMap((distribution) => Object.keys(distribution)))
  const count = Math.max(1, distributions.length)
  return Object.fromEntries(
    [...keys].map((key) => [
      key,
      distributions.reduce((sum, distribution) => sum + (distribution[key] ?? 0), 0) / count
    ])
  )
}

export const renderState = (state: State): string =>
  typeof state === "string"
    ? state
    : Array.isArray(state)
      ? state.join("\n")
      : JSON.stringify(state, null, 2)
