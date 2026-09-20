import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type { LlmError } from "../Errors.ts"
import { verbalizedScoreLabelSequence, verbalizedScoreLabels } from "../LabelScoring.ts"
import type { LabelSequence, LlmServiceShape } from "../LlmService.ts"
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
 * the rest. Questions never see each other's answers in `independent`
 * batching; `shared-prefix` sends the state once with every question and
 * reads each answer as its own label distribution, trading that isolation
 * for one prompt prefix per request.
 */

export const Batching = Schema.Literals(["independent", "shared-prefix"])
export type Batching = typeof Batching.Type

export class LlmJudgmentConfig extends Schema.Class<LlmJudgmentConfig>("LlmJudgmentConfig")({
  /** Questions in flight at once. 1 keeps a local server's prompt cache warm. */
  concurrency: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(1))),
  /** 2 also asks with the options reversed and averages, to blunt position bias. */
  permutations: Schema.Literals([1, 2]).pipe(
    Schema.withConstructorDefault(Effect.succeed<1 | 2>(1))
  ),
  /**
   * `independent` (default): one call per question, Jev's answer
   * independence. `shared-prefix`: every question of a request in one call
   * whose state prefix is sent once; a question the batch could not read
   * falls back to its own independent call.
   */
  batching: Batching.pipe(Schema.withConstructorDefault(Effect.succeed<Batching>("independent"))),
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

/** A question's part of a prompt, without the state header. */
export interface QuestionBody {
  readonly body: string
  readonly labels: ReadonlyArray<string>
  readonly keys: Readonly<Record<string, string>>
}

export const questionBody = (question: Question, reverse: boolean): QuestionBody => {
  if (question.type === "truth") {
    const criteria =
      question.criteria === undefined
        ? ""
        : `\nYes means: ${describe(question.criteria.true)}\nNo means: ${describe(question.criteria.false)}`
    return {
      body: `Statement: ${question.instructions}${criteria}\nAnswer with exactly one word: yes or no.`,
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
    body: `${ask}: ${question.instructions}\nOptions:\n${lines}\nAnswer with exactly one letter.`,
    labels,
    keys: Object.fromEntries(ordered.map(([key], index) => [labels[index] ?? `L${index}`, key]))
  }
}

const stateHeader = (state: State): string => `State:\n${renderState(state)}\n\n`

/**
 * The fixed label-scoring template: state first, then the question, then
 * one single-token label per option. Truth uses `yes`/`no`.
 */
export const labelPlan = (state: State, question: Question, reverse: boolean): LabelPlan => {
  const part = questionBody(question, reverse)
  return { prompt: `${stateHeader(state)}${part.body}`, labels: part.labels, keys: part.keys }
}

/**
 * The shared-prefix template: the state once, then every question numbered,
 * and an answer format of one label per line so a backend can read each
 * position as its own distribution.
 */
export const sequencePlan = (
  state: State,
  questions: ReadonlyArray<Question>,
  reverse: boolean
): { readonly prompt: string; readonly parts: ReadonlyArray<QuestionBody> } => {
  const parts = questions.map((question) => questionBody(question, reverse))
  const numbered = parts.map((part, index) => `Question ${index + 1}.\n${part.body}`).join("\n\n")
  return {
    prompt:
      `${stateHeader(state)}Answer each numbered question below with exactly one label on its own line, ` +
      `formatted as "<number>: <label>", in order, and nothing else.\n\n${numbered}`,
    parts
  }
}

const byKey = (
  keys: Readonly<Record<string, string>>,
  distribution: LabelDistribution
): Record<string, number> =>
  Object.fromEntries(
    Object.entries(distribution.probabilities).map(([label, value]) => [
      keys[label] ?? label,
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

type Read = readonly [keys: Readonly<Record<string, string>>, distribution: LabelDistribution]

/** Combine one distribution per permutation into an answer; the weaker method and support win. */
const combine = (
  question: Question,
  reads: ReadonlyArray<Read>,
  fallbackModel: string | undefined
): Scored => {
  const method: ScoringMethod = reads.every(
    ([, distribution]) => distribution.method === "logprobs"
  )
    ? "logprobs"
    : reads.some(([, distribution]) => distribution.method === "sampled")
      ? "sampled"
      : "verbalized"
  const support = Math.min(...reads.map(([, distribution]) => distribution.support))
  const probabilities = averageProbabilities(
    reads.map(([keys, distribution]) => byKey(keys, distribution))
  )
  const model =
    reads.find(([, distribution]) => distribution.model !== undefined)?.[1].model ?? fallbackModel
  return {
    answer: toAnswer(question, probabilities, origins.llm(method, model), support),
    usage: sumUsage(reads.map(([, distribution]) => distribution.usage)),
    model
  }
}

type Outcome = readonly [key: string, outcome: Result.Result<Scored, LlmError>]

export const makeLlmJudgment = (
  llm: LlmServiceShape,
  config: LlmJudgmentConfig = LlmJudgmentConfig.make({}),
  hooks: LlmJudgmentHooks = {}
): JudgmentShape => {
  const fallback = verbalizedScoreLabels(llm.executeStructuredWithUsage)
  const sequence =
    llm.scoreLabelSequence ?? verbalizedScoreLabelSequence(llm.executeStructuredWithUsage)
  const permutations: ReadonlyArray<boolean> = config.permutations === 2 ? [false, true] : [false]
  const permutationsFor = (question: Question): ReadonlyArray<boolean> =>
    permutations.filter((reverse) => !reverse || question.type !== "truth")

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
      const plans = permutationsFor(question).map((reverse) => labelPlan(state, question, reverse))
      const reads = yield* Effect.forEach(plans, (plan) =>
        Effect.map(scoreOnce(plan, key), (distribution): Read => [plan.keys, distribution])
      )
      return combine(question, reads, config.model)
    })

  const independently = (
    input: JudgmentInput,
    entries: ReadonlyArray<readonly [string, Question]>
  ): Effect.Effect<ReadonlyArray<Outcome>> =>
    Effect.forEach(
      entries,
      ([key, question]) =>
        Effect.map(
          Effect.result(scoreQuestion(input.state, key, question)),
          (outcome): Outcome => [key, outcome]
        ),
      { concurrency: config.concurrency }
    )

  /**
   * One call per permutation for the whole request. A question whose
   * position could not be read in any permutation, or a call that failed
   * outright, goes back through the independent path for that question.
   */
  const sharedPrefix = (
    input: JudgmentInput,
    entries: ReadonlyArray<readonly [string, Question]>
  ): Effect.Effect<{
    readonly outcomes: ReadonlyArray<Outcome>
    readonly usage: TokenUsage | undefined
    readonly model: string | undefined
  }> =>
    Effect.gen(function* () {
      const questions = entries.map(([, question]) => question)
      const calls = yield* Effect.forEach(permutations, (reverse) => {
        const plan = sequencePlan(input.state, questions, reverse)
        return Effect.map(
          Effect.result(
            sequence(
              plan.prompt,
              plan.parts.map((part) => part.labels)
            )
          ),
          (outcome) => [plan, outcome] as const
        )
      })
      const successes = calls.flatMap(([, outcome]) =>
        Result.isSuccess(outcome) ? [outcome.success] : []
      )
      const batchModel = successes.find((call) => call.model !== undefined)?.model ?? config.model
      const answered: Array<Outcome> = []
      const retry: Array<readonly [string, Question]> = []
      for (const [index, [key, question]] of entries.entries()) {
        const reads: Array<Read> = []
        let reason: string | undefined
        for (const [callIndex, reverse] of permutations.entries()) {
          if (!permutationsFor(question).includes(reverse)) {
            continue
          }
          const call = calls[callIndex]
          const part = call?.[0].parts[index]
          const outcome = call?.[1]
          if (outcome === undefined || part === undefined) {
            reason = "no batched call covered this question"
            break
          }
          if (Result.isFailure(outcome)) {
            reason = outcome.failure.message
            break
          }
          const entry = outcome.success.entries[index]
          if (entry === undefined) {
            reason = "no entry for this question"
            break
          }
          if (Result.isFailure(entry)) {
            reason = entry.failure.message
            break
          }
          reads.push([part.keys, entry.success])
        }
        if (reason === undefined && reads.length > 0) {
          // Usage was reported once for the whole call; the per-question reads carry none.
          answered.push([key, Result.succeed(combine(question, reads, batchModel))])
        } else {
          yield* hooks.onFallback?.(key, `shared-prefix batch: ${reason ?? "unreadable"}`) ??
            Effect.void
          retry.push([key, question])
        }
      }
      const retried = retry.length === 0 ? [] : yield* independently(input, retry)
      const order = new Map(entries.map(([key], index) => [key, index] as const))
      const outcomes = [...answered, ...retried].sort(
        ([a], [b]) => (order.get(a) ?? 0) - (order.get(b) ?? 0)
      )
      return {
        outcomes,
        usage: sumUsage(successes.map((call) => call.usage)),
        model: successes.find((call) => call.model !== undefined)?.model
      }
    })

  const judge = Effect.fn("@llm4ts/core/judgment/LlmJudgment.judge")(function* (
    input: JudgmentInput
  ): Effect.fn.Return<JudgmentResult> {
    const entries = Object.entries(input.questions)
    const batched =
      config.batching === "shared-prefix" && entries.length > 1
        ? yield* sharedPrefix(input, entries)
        : { outcomes: yield* independently(input, entries), usage: undefined, model: undefined }
    const answers: Record<string, Answer> = {}
    const failures: Array<QuestionFailure> = []
    const usages: Array<TokenUsage | undefined> = [batched.usage]
    let model: string | undefined = batched.model
    for (const [key, outcome] of batched.outcomes) {
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

export type { LabelSequence }
