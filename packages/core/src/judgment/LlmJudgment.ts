import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type { LlmError } from "../Errors.ts"
import { verbalizedScoreLabels } from "../LabelScoring.ts"
import type { LlmServiceShape } from "../LlmService.ts"
import { TokenUsage, type LabelDistribution } from "../Models.ts"
import { Judgment, type JudgmentInput, type JudgmentShape } from "./Judgment.ts"
import {
  averageProbabilities,
  choiceAnswer,
  JudgmentResult,
  QuestionFailure,
  renderState,
  scoreAnswer,
  truthAnswer,
  origins,
  type Answer,
  type AnswerOrigin,
  type Description,
  type Question,
  type ScoringMethod,
  type State
} from "./Schemas.ts"

/**
 * `LlmJudgment`: the Judgment service over any `LlmServiceShape`. One label
 * question per atomic question, answered through `scoreLabels`: a single
 * forward pass on connectors with log-probabilities, a short JSON reply on
 * the rest. Questions never see each other's answers.
 */

export class LlmJudgmentConfig extends Schema.Class<LlmJudgmentConfig>("LlmJudgmentConfig")({
  /** Questions in flight at once. 1 keeps a local server's prompt cache warm. */
  concurrency: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(1))),
  /** 2 also asks with the options reversed and averages, to blunt position bias. */
  permutations: Schema.Literals([1, 2]).pipe(
    Schema.withConstructorDefault(Effect.succeed<1 | 2>(1))
  ),
  /** Connector and model behind the seat, for `identity` and answer origins. */
  connector: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String)
}) {}

export interface LlmJudgmentHooks {
  /** Called once per request with the summed backend usage, when any was reported. */
  readonly onUsage?: (usage: TokenUsage, model: string | undefined) => Effect.Effect<void>
  /** Called when a question fell back from label scoring to the verbalized path. */
  readonly onFallback?: (key: string, reason: string) => Effect.Effect<void>
}

const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

const describe = (description: Description): string =>
  typeof description === "string" ? description : JSON.stringify(description)

interface LabelPlan {
  readonly prompt: string
  readonly labels: ReadonlyArray<string>
  /** Label to the option key or level index it stands for. */
  readonly keys: Readonly<Record<string, string>>
}

/**
 * The fixed label-scoring template: state first, then the question, then
 * one single-token label per option. Truth uses `yes`/`no`.
 */
export const labelPlan = (state: State, question: Question, reverse: boolean): LabelPlan => {
  const header = `State:\n${renderState(state)}\n\n`
  if (question.type === "truth") {
    const criteria =
      question.criteria === undefined
        ? ""
        : `\nYes means: ${describe(question.criteria.true)}\nNo means: ${describe(question.criteria.false)}`
    return {
      prompt: `${header}Statement: ${question.instructions}${criteria}\nAnswer with exactly one word: yes or no.`,
      labels: ["yes", "no"],
      keys: { yes: "yes", no: "no" }
    }
  }
  const entries: ReadonlyArray<readonly [key: string, description: Description]> =
    question.type === "choice"
      ? Object.entries(question.criteria)
      : question.criteria.map((level, index) => [String(index), level] as const)
  const ordered = reverse ? [...entries].reverse() : entries
  const labels = ordered.map((_, index) => LABELS[index] ?? `L${index}`)
  const lines = ordered
    .map(([key, description], index) =>
      question.type === "choice"
        ? `${labels[index]}. ${key}: ${describe(description)}`
        : `${labels[index]}. ${describe(description)}`
    )
    .join("\n")
  const ask = question.type === "choice" ? "Question" : "Rate on the levels below"
  return {
    prompt: `${header}${ask}: ${question.instructions}\nOptions:\n${lines}\nAnswer with exactly one letter.`,
    labels,
    keys: Object.fromEntries(ordered.map(([key], index) => [labels[index] ?? `L${index}`, key]))
  }
}

const byKey = (plan: LabelPlan, distribution: LabelDistribution): Record<string, number> =>
  Object.fromEntries(
    Object.entries(distribution.probabilities).map(([label, value]) => [
      plan.keys[label] ?? label,
      value
    ])
  )

const toAnswer = (
  question: Question,
  probabilities: Readonly<Record<string, number>>,
  origin: AnswerOrigin,
  support: number
): Answer =>
  question.type === "choice"
    ? choiceAnswer(probabilities, origin, support)
    : question.type === "score"
      ? scoreAnswer(question, probabilities, origin, support)
      : truthAnswer(probabilities["yes"] ?? 0, origin, support)

const sumUsage = (usages: ReadonlyArray<TokenUsage | undefined>): TokenUsage | undefined => {
  const present = usages.filter((usage): usage is TokenUsage => usage !== undefined)
  return present.length === 0
    ? undefined
    : TokenUsage.make({
        prompt: present.reduce((sum, usage) => sum + usage.prompt, 0),
        completion: present.reduce((sum, usage) => sum + usage.completion, 0),
        total: present.reduce((sum, usage) => sum + usage.total, 0)
      })
}

interface Scored {
  readonly answer: Answer
  readonly usage: TokenUsage | undefined
  readonly model: string | undefined
}

export const makeLlmJudgment = (
  llm: LlmServiceShape,
  config: LlmJudgmentConfig = LlmJudgmentConfig.make({}),
  hooks: LlmJudgmentHooks = {}
): JudgmentShape => {
  const fallback = verbalizedScoreLabels(llm.executeStructuredWithUsage)

  const scoreOnce = (plan: LabelPlan, key: string): Effect.Effect<LabelDistribution, LlmError> =>
    llm
      .scoreLabels(plan.prompt, plan.labels)
      .pipe(
        Effect.catchTag("ParseError", (error) =>
          (hooks.onFallback?.(key, error.message) ?? Effect.void).pipe(
            Effect.andThen(fallback(plan.prompt, plan.labels))
          )
        )
      )

  const scoreQuestion = (
    state: State,
    key: string,
    question: Question
  ): Effect.Effect<Scored, LlmError> =>
    Effect.gen(function* () {
      const plans =
        config.permutations === 2 && question.type !== "truth"
          ? [labelPlan(state, question, false), labelPlan(state, question, true)]
          : [labelPlan(state, question, false)]
      const distributions = yield* Effect.forEach(plans, (plan) =>
        Effect.map(scoreOnce(plan, key), (distribution) => [plan, distribution] as const)
      )
      // A mixed pair reports the weaker method; support is the weakest seen.
      const method: ScoringMethod = distributions.every(
        ([, distribution]) => distribution.method === "logprobs"
      )
        ? "logprobs"
        : distributions.some(([, distribution]) => distribution.method === "sampled")
          ? "sampled"
          : "verbalized"
      const support = Math.min(...distributions.map(([, distribution]) => distribution.support))
      const probabilities = averageProbabilities(
        distributions.map(([plan, distribution]) => byKey(plan, distribution))
      )
      const model =
        distributions.find(([, distribution]) => distribution.model !== undefined)?.[1].model ??
        config.model
      return {
        answer: toAnswer(question, probabilities, origins.llm(method, model), support),
        usage: sumUsage(distributions.map(([, distribution]) => distribution.usage)),
        model
      }
    })

  const judge = Effect.fn("@llm4ts/core/judgment/LlmJudgment.judge")(function* (
    input: JudgmentInput
  ): Effect.fn.Return<JudgmentResult> {
    const entries = Object.entries(input.questions)
    const outcomes = yield* Effect.forEach(
      entries,
      ([key, question]) =>
        Effect.map(
          Effect.result(scoreQuestion(input.state, key, question)),
          (outcome) => [key, outcome] as const
        ),
      { concurrency: config.concurrency }
    )
    const answers: Record<string, Answer> = {}
    const failures: Array<QuestionFailure> = []
    const usages: Array<TokenUsage | undefined> = []
    let model: string | undefined
    for (const [key, outcome] of outcomes) {
      if (Result.isFailure(outcome)) {
        failures.push(QuestionFailure.make({ key, reason: outcome.failure.message }))
      } else {
        answers[key] = outcome.success.answer
        usages.push(outcome.success.usage)
        model = model ?? outcome.success.model
      }
    }
    const usage = sumUsage(usages)
    if (usage !== undefined && hooks.onUsage !== undefined) {
      yield* hooks.onUsage(usage, model)
    }
    return JudgmentResult.make({
      answers,
      failures,
      backend: "llm",
      ...(usage === undefined ? {} : { usage }),
      ...(model === undefined ? {} : { model })
    })
  })

  return {
    backend: "llm",
    identity: `llm:${config.connector ?? "unknown"}:${config.model ?? "default"}`,
    judge
  }
}

export const LlmJudgmentLive = (
  llm: LlmServiceShape,
  config?: LlmJudgmentConfig,
  hooks?: LlmJudgmentHooks
): Layer.Layer<Judgment> => Layer.succeed(Judgment, makeLlmJudgment(llm, config, hooks))
