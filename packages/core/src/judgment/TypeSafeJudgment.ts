import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import type { HttpClientShape } from "../HttpClient.ts"
import { TokenUsage } from "../Models.ts"
import {
  Judgment,
  JudgmentBackendError,
  type JudgmentInput,
  type JudgmentShape
} from "./Judgment.ts"
import {
  ChoiceAnswer,
  confidenceOf,
  Description,
  JudgmentResult,
  origins,
  QuestionFailure,
  ScoreAnswer,
  State,
  TruthAnswer,
  TruthCriteria,
  type Answer,
  type Question
} from "./Schemas.ts"

/**
 * `TypeSafeJudgment`: the Judgment service over TypeSafe's hosted Jev
 * (`POST /v1/systemone`). One request carries every question; the model
 * answers them independently and its probabilities are calibrated. The only
 * translation is `truth` ↔ `noul`. The key travels in a header and nowhere
 * else: never in a log, an error, or a persisted result.
 */

/** Published input price on 2026-09-19: $42 per billion tokens; output is free. */
export const typeSafeInputUsdPer1k = 0.000042

export interface TypeSafeJudgmentConfig {
  readonly apiKey: Redacted.Redacted<string>
  readonly baseUrl?: string
  readonly model?: string
  readonly timeout?: Duration.Duration
  readonly onUsage?: (usage: TokenUsage, model: string | undefined) => Effect.Effect<void>
}

export const defaultTypeSafeBaseUrl = "https://api.typesafe.ai"
export const defaultTypeSafeModel = "jev-latest"

// Wire schemas, kept private: the public shape is `Schemas.ts`.
class WireNoulCriteria extends Schema.Class<WireNoulCriteria>("WireNoulCriteria")({
  true: Description,
  false: Description
}) {}

class WireQuestion extends Schema.Class<WireQuestion>("WireQuestion")({
  type: Schema.Literals(["choice", "score", "noul"]),
  instructions: Schema.String,
  criteria: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Description),
      Schema.Array(Description),
      WireNoulCriteria
    ])
  )
}) {}

class WireRequest extends Schema.Class<WireRequest>("WireRequest")({
  model: Schema.String,
  state: State,
  questions: Schema.Record(Schema.String, WireQuestion)
}) {}

class WireChoice extends Schema.Class<WireChoice>("WireChoice")({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  probabilities: Schema.Record(Schema.String, Schema.Number),
  confidence: Schema.Number
}) {}

class WireScore extends Schema.Class<WireScore>("WireScore")({
  type: Schema.Literal("score"),
  score: Schema.Number,
  legend: Schema.Record(Schema.String, Description),
  probabilities: Schema.Record(Schema.String, Schema.Number),
  confidence: Schema.Number
}) {}

class WireNoul extends Schema.Class<WireNoul>("WireNoul")({
  type: Schema.Literal("noul"),
  noul: Schema.Number
}) {}

class WireError extends Schema.Class<WireError>("WireError")({
  type: Schema.Literal("error"),
  message: Schema.optionalKey(Schema.String)
}) {}

class WireUsage extends Schema.Class<WireUsage>("WireUsage")({
  input_tokens: Schema.optionalKey(Schema.Int),
  output_tokens: Schema.optionalKey(Schema.Int)
}) {}

class WireResponse extends Schema.Class<WireResponse>("WireResponse")({
  model: Schema.optionalKey(Schema.String),
  answers: Schema.Record(Schema.String, Schema.Union([WireChoice, WireScore, WireNoul, WireError])),
  usage: Schema.optionalKey(WireUsage)
}) {}

export const toWireQuestion = (question: Question): WireQuestion =>
  question.type === "truth"
    ? WireQuestion.make({
        type: "noul",
        instructions: question.instructions,
        ...(question.criteria === undefined
          ? {}
          : {
              criteria: WireNoulCriteria.make({
                true: question.criteria.true,
                false: question.criteria.false
              })
            })
      })
    : WireQuestion.make({
        type: question.type,
        instructions: question.instructions,
        criteria: question.criteria
      })

// `confidence` is recomputed as the maximum probability so the field means
// the same thing whichever backend answered; TypeSafe's own statistic is
// kept beside it as `reportedConfidence`.
const fromWireAnswer = (
  answer: WireChoice | WireScore | WireNoul,
  model: string | undefined
): Answer =>
  answer instanceof WireChoice
    ? ChoiceAnswer.make({
        type: "choice",
        choice: answer.choice,
        probabilities: answer.probabilities,
        confidence: confidenceOf(answer.probabilities),
        reportedConfidence: answer.confidence,
        origin: origins.hosted(model)
      })
    : answer instanceof WireScore
      ? ScoreAnswer.make({
          type: "score",
          score: answer.score,
          legend: answer.legend,
          probabilities: answer.probabilities,
          confidence: confidenceOf(answer.probabilities),
          reportedConfidence: answer.confidence,
          origin: origins.hosted(model)
        })
      : TruthAnswer.make({ type: "truth", truth: answer.noul, origin: origins.hosted(model) })

const toUsage = (usage: WireUsage | undefined): TokenUsage | undefined => {
  if (usage === undefined) {
    return undefined
  }
  const prompt = usage.input_tokens ?? 0
  const completion = usage.output_tokens ?? 0
  return TokenUsage.make({
    prompt,
    completion,
    total: prompt + completion,
    costUsd: (prompt / 1_000) * typeSafeInputUsdPer1k
  })
}

export const makeTypeSafeJudgment = (
  config: TypeSafeJudgmentConfig,
  httpClient: HttpClientShape
): JudgmentShape => {
  const baseUrl = (config.baseUrl ?? defaultTypeSafeBaseUrl).replace(/\/+$/, "")
  const model = config.model ?? defaultTypeSafeModel
  const timeout = config.timeout ?? Duration.seconds(60)

  const judge = Effect.fn("@llm4ts/core/judgment/TypeSafeJudgment.judge")(function* (
    input: JudgmentInput
  ): Effect.fn.Return<JudgmentResult, JudgmentBackendError> {
    const request = WireRequest.make({
      model,
      state: input.state,
      questions: Object.fromEntries(
        Object.entries(input.questions).map(([key, question]) => [key, toWireQuestion(question)])
      )
    })
    const raw = yield* httpClient
      .postJson(
        `${baseUrl}/v1/systemone`,
        JSON.stringify(request),
        { Authorization: `Bearer ${Redacted.value(config.apiKey)}` },
        timeout
      )
      .pipe(
        Effect.mapError((error) =>
          JudgmentBackendError.make({
            backend: "typesafe",
            message: `TypeSafe request failed: ${error._tag}`,
            cause: error
          })
        )
      )
    const response = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WireResponse))(
      raw
    ).pipe(
      Effect.mapError((error) =>
        JudgmentBackendError.make({
          backend: "typesafe",
          message: `TypeSafe response did not decode: ${String(error)}`
        })
      )
    )
    const answers: Record<string, Answer> = {}
    const failures: Array<QuestionFailure> = []
    for (const [key, answer] of Object.entries(response.answers)) {
      if (answer instanceof WireError) {
        failures.push(QuestionFailure.make({ key, reason: answer.message ?? "backend error" }))
      } else {
        answers[key] = fromWireAnswer(answer, response.model ?? model)
      }
    }
    for (const key of Object.keys(input.questions)) {
      if (answers[key] === undefined && !failures.some((failure) => failure.key === key)) {
        failures.push(QuestionFailure.make({ key, reason: "no answer returned" }))
      }
    }
    const usage = toUsage(response.usage)
    if (usage !== undefined && config.onUsage !== undefined) {
      yield* config.onUsage(usage, response.model)
    }
    return JudgmentResult.make({
      answers,
      failures,
      backend: "typesafe",
      ...(usage === undefined ? {} : { usage }),
      ...(response.model === undefined ? {} : { model: response.model })
    })
  })

  return { backend: "typesafe", identity: `typesafe:${model}`, judge }
}

export const TypeSafeJudgmentLive = (
  config: TypeSafeJudgmentConfig,
  httpClient: HttpClientShape
): Layer.Layer<Judgment> => Layer.succeed(Judgment, makeTypeSafeJudgment(config, httpClient))

/** `TruthCriteria` is re-exported so callers can build the wire form themselves. */
export { TruthCriteria }
