import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ProviderError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { JsonSchema } from "@llm4ts/core/Models"
import type {
  JudgmentBackendError,
  JudgmentInput,
  JudgmentShape
} from "@llm4ts/core/judgment/Judgment"
import { makeLlmJudgment } from "@llm4ts/core/judgment/LlmJudgment"
import {
  ChoiceAnswer,
  JudgmentResult,
  ScoreAnswer,
  TruthAnswer,
  confidenceOf,
  expectedScore,
  origins,
  renderState,
  type Answer,
  type AnswerOrigin,
  type JudgmentBackend,
  type Question
} from "@llm4ts/core/judgment/Schemas"
import { ParseError } from "@llm4ts/core/Errors"
import type { FlowContextShape } from "./FlowContext.ts"
import { FlowLlmError, PersistenceError, type FlowError } from "./FlowError.ts"
import { Info, type FlowEventsShape } from "./FlowEvents.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"

/**
 * Judgment policy (ADR 0017): core answers questions and reports their
 * origin; this module decides what a flow does with the number. Thresholds
 * are keyed first by calibration evidence (`measured`, then `claimed`) and
 * otherwise by extraction method, because a model that writes its own
 * probabilities (`verbalized`) is held to a higher bar than one whose
 * log-probabilities were read (`logprobs`), and a reasoning model's typed
 * reply (`reasoning`) sits between. An answer whose `support` (mass the
 * backend actually placed on the offered options) is below `minSupport` is
 * held whatever its confidence. Jev's advice, kept: questions and
 * thresholds in one place.
 */

export class CertaintyBands extends Schema.Class<CertaintyBands>("CertaintyBands")({
  /** At or above: act automatically. */
  act: Schema.Number,
  /** Below: do not act; escalate or hold. Between the two: proceed with caution. */
  hold: Schema.Number
}) {}

const thresholds = (act: number, hold: number) =>
  CertaintyBands.pipe(
    Schema.withConstructorDefault(Effect.succeed(CertaintyBands.make({ act, hold })))
  )

export class JudgmentPolicy extends Schema.Class<JudgmentPolicy>("JudgmentPolicy")({
  /** Calibration evidence produced in this project: trusted most. */
  measured: thresholds(0.8, 0.5),
  /** The provider claims calibration (TypeSafe). */
  claimed: thresholds(0.85, 0.5),
  /** No evidence; keyed by how the numbers were extracted. */
  logprobs: thresholds(0.9, 0.6),
  sampled: thresholds(0.9, 0.6),
  reasoning: thresholds(0.9, 0.6),
  verbalized: thresholds(0.95, 0.7),
  /** Below this share of mass on the offered options, hold regardless. */
  minSupport: Schema.Number.pipe(Schema.withConstructorDefault(Effect.succeed(0.5)))
}) {
  thresholds(origin: AnswerOrigin): CertaintyBands {
    switch (origin.calibration) {
      case "measured":
        return this.measured
      case "claimed":
        return this.claimed
      case "none":
        return origin.method === "hosted" ? this.claimed : this[origin.method]
    }
  }
}

export const defaultJudgmentPolicy = JudgmentPolicy.make({})

export const Decision = Schema.Literals(["act", "caution", "hold"])
export type Decision = typeof Decision.Type

/**
 * How sure an answer is, whatever its kind. A Choice or Score carries its
 * confidence (the peak probability). A Truth's certainty is its distance
 * from even, scaled so 0.5 is 0 and either extreme is 1: `|2·truth − 1|`.
 */
export const certaintyOf = (answer: Answer): number =>
  answer.type === "truth" ? Math.abs(2 * answer.truth - 1) : answer.confidence

/**
 * The three bands Jev documents: act, proceed with caution, or hold. An
 * answer rebuilt from too little mass on the offered options is always held.
 */
export const decide = (
  answer: Answer,
  policy: JudgmentPolicy = defaultJudgmentPolicy
): Decision => {
  if (answer.support < policy.minSupport) {
    return "hold"
  }
  const certainty = certaintyOf(answer)
  const bands = policy.thresholds(answer.origin)
  return certainty >= bands.act ? "act" : certainty < bands.hold ? "hold" : "caution"
}

/** The context's judgment service, or one derived from its reasoning seat. */
export const judgmentOf = (context: FlowContextShape): JudgmentShape =>
  context.judgment ?? makeLlmJudgment(context.reasoning)

const backendFailure = (error: JudgmentBackendError): FlowError =>
  FlowLlmError.from(ProviderError.make({ message: error.message, cause: error }))

// Escalation asks a reasoning model the same question in its own words and
// decodes a typed reply, so the schema per kind mirrors the answer shape.
class EscalatedChoice extends Schema.Class<EscalatedChoice>("EscalatedChoice")({
  choice: Schema.String,
  probabilities: Schema.Record(Schema.String, Schema.Number)
}) {}
class EscalatedScore extends Schema.Class<EscalatedScore>("EscalatedScore")({
  probabilities: Schema.Record(Schema.String, Schema.Number)
}) {}
class EscalatedTruth extends Schema.Class<EscalatedTruth>("EscalatedTruth")({
  truth: Schema.Number
}) {}

const numberMap = (keys: ReadonlyArray<string>): JsonSchema => ({
  type: "object",
  properties: Object.fromEntries(keys.map((key) => [key, { type: "number" }])),
  required: [...keys],
  additionalProperties: false
})

const escalationPrompt = (state: JudgmentInput["state"], question: Question): string => {
  const header = `State:\n${renderState(state)}\n\nThink carefully, then answer with JSON only.\n`
  switch (question.type) {
    case "choice":
      return (
        `${header}Question: ${question.instructions}\nOptions:\n` +
        Object.entries(question.criteria)
          .map(([key, description]) => `- ${key}: ${JSON.stringify(description)}`)
          .join("\n") +
        '\nReply: {"choice": <option key>, "probabilities": {<a probability per option, summing to 1>}}'
      )
    case "score":
      return (
        `${header}Rate: ${question.instructions}\nLevels:\n` +
        question.criteria.map((level, index) => `- ${index}: ${JSON.stringify(level)}`).join("\n") +
        '\nReply: {"probabilities": {<a probability per level index, summing to 1>}}'
      )
    case "truth":
      return (
        `${header}Statement: ${question.instructions}\n` +
        (question.criteria === undefined
          ? ""
          : `True means: ${JSON.stringify(question.criteria.true)}\nFalse means: ${JSON.stringify(question.criteria.false)}\n`) +
        'Reply: {"truth": <probability between 0 and 1 that the statement holds>}'
      )
  }
}

/** Renormalize over the offered keys; fails typed when nothing was placed on them. */
const normalized = (
  keys: ReadonlyArray<string>,
  raw: Readonly<Record<string, number>>
): Effect.Effect<Record<string, number>, ParseError> => {
  const kept = keys.map((key) => [key, Math.max(0, raw[key] ?? 0)] as const)
  const total = kept.reduce((sum, [, value]) => sum + value, 0)
  return total > 0
    ? Effect.succeed(Object.fromEntries(kept.map(([key, value]) => [key, value / total])))
    : Effect.fail(
        ParseError.make({
          message: "the reasoning seat placed no probability on any offered option",
          raw: JSON.stringify(raw)
        })
      )
}

const escalate = (
  reasoning: LlmServiceShape,
  backend: JudgmentBackend,
  state: JudgmentInput["state"],
  question: Question
): Effect.Effect<Answer, FlowError> => {
  const prompt = escalationPrompt(state, question)
  const origin = origins.escalated(backend)
  switch (question.type) {
    case "choice": {
      const keys = Object.keys(question.criteria)
      return reasoning
        .executeStructured(prompt, EscalatedChoice, {
          type: "object",
          properties: {
            choice: { type: "string", enum: [...keys] },
            probabilities: numberMap(keys)
          },
          required: ["choice", "probabilities"]
        })
        .pipe(
          Effect.flatMap((reply) =>
            // A choice the model gave no mass contradicts itself: fail rather
            // than invent certainty, and the caller keeps its earlier answer.
            keys.includes(reply.choice) && !((reply.probabilities[reply.choice] ?? 0) > 0)
              ? Effect.fail(
                  ParseError.make({
                    message: `the reasoning seat chose "${reply.choice}" but gave it no probability`,
                    raw: JSON.stringify(reply.probabilities)
                  })
                )
              : Effect.map(normalized(keys, reply.probabilities), (probabilities) =>
                  ChoiceAnswer.make({
                    type: "choice",
                    choice: keys.includes(reply.choice) ? reply.choice : (keys[0] ?? ""),
                    probabilities,
                    confidence: confidenceOf(probabilities),
                    origin
                  })
                )
          ),
          Effect.mapError(FlowLlmError.from)
        )
    }
    case "score": {
      const keys = question.criteria.map((_, index) => String(index))
      return reasoning
        .executeStructured(prompt, EscalatedScore, {
          type: "object",
          properties: { probabilities: numberMap(keys) },
          required: ["probabilities"]
        })
        .pipe(
          Effect.flatMap((reply) =>
            Effect.map(normalized(keys, reply.probabilities), (probabilities) =>
              ScoreAnswer.make({
                type: "score",
                score: expectedScore(probabilities),
                legend: Object.fromEntries(
                  question.criteria.map((level, index) => [String(index), level])
                ),
                probabilities,
                confidence: confidenceOf(probabilities),
                origin
              })
            )
          ),
          Effect.mapError(FlowLlmError.from)
        )
    }
    case "truth":
      return reasoning
        .executeStructured(prompt, EscalatedTruth, {
          type: "object",
          properties: { truth: { type: "number" } },
          required: ["truth"]
        })
        .pipe(
          Effect.map((reply) =>
            TruthAnswer.make({
              type: "truth",
              truth: Math.max(0, Math.min(1, reply.truth)),
              origin
            })
          ),
          Effect.mapError(FlowLlmError.from)
        )
  }
}

export interface JudgeOrEscalateOptions {
  readonly judgment: JudgmentShape
  readonly reasoning: LlmServiceShape
  readonly events: FlowEventsShape
  readonly request: JudgmentInput
  readonly policy?: JudgmentPolicy
}

/**
 * Run the judgment; every answer the policy would `hold`, and every question
 * that failed, is asked again of the reasoning seat and replaced with an
 * `escalated` answer. An escalation that fails keeps what it had, so the
 * caller always sees the most informed answer available.
 */
export const judgeOrEscalate = Effect.fn("@llm4ts/flow/Judgment.judgeOrEscalate")(function* (
  options: JudgeOrEscalateOptions
): Effect.fn.Return<JudgmentResult, FlowError> {
  const policy = options.policy ?? defaultJudgmentPolicy
  const result = yield* options.judgment
    .judge(options.request)
    .pipe(Effect.mapError(backendFailure))
  const answers: Record<string, Answer> = { ...result.answers }
  const failures = [...result.failures]
  for (const [key, question] of Object.entries(options.request.questions)) {
    const current = answers[key]
    const reason =
      current === undefined
        ? (failures.find((failure) => failure.key === key)?.reason ?? "no answer")
        : decide(current, policy) === "hold"
          ? current.support < policy.minSupport
            ? `${current.origin.method} support ${current.support.toFixed(2)} below ${policy.minSupport}`
            : `${current.origin.method} certainty ${certaintyOf(current).toFixed(2)} below hold`
          : undefined
    if (reason === undefined) {
      continue
    }
    yield* options.events.publish(
      Info.make({ message: `judgment '${key}' escalated to the reasoning seat: ${reason}` })
    )
    const escalated = yield* escalate(
      options.reasoning,
      result.backend,
      options.request.state,
      question
    ).pipe(
      Effect.map((answer): Answer | undefined => answer),
      Effect.catch((error) =>
        options.events
          .publish(
            Info.make({
              message: `judgment '${key}' escalation failed (${error._tag}); keeping the original answer`
            })
          )
          .pipe(Effect.as<Answer | undefined>(undefined))
      )
    )
    if (escalated !== undefined) {
      answers[key] = escalated
      const index = failures.findIndex((failure) => failure.key === key)
      if (index >= 0) {
        failures.splice(index, 1)
      }
    }
  }
  return JudgmentResult.make({
    answers,
    failures,
    backend: result.backend,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(result.model === undefined ? {} : { model: result.model })
  })
})

class JudgmentCacheEntry extends Schema.Class<JudgmentCacheEntry>("JudgmentCacheEntry")({
  fingerprint: Schema.String,
  result: JudgmentResult
}) {}

const hexDigest = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")

/**
 * A stable digest of state, questions and the judgment's identity (backend
 * plus checkpoint): the cache key for one request. A retrained or swapped
 * local model therefore never reuses its predecessor's answers.
 */
export const judgmentFingerprint = (
  request: JudgmentInput,
  identity: string
): Effect.Effect<string, PersistenceError> =>
  Effect.tryPromise({
    try: async () =>
      hexDigest(
        await globalThis.crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify({ identity, state: request.state, questions: request.questions })
          )
        )
      ),
    catch: (error) =>
      PersistenceError.make({
        message: `failed to fingerprint judgment: ${error instanceof Error ? error.message : String(error)}`,
        cause: error
      })
  })

/**
 * Answers persisted like `cachedReview`: a re-run re-judges only what
 * changed (state, questions, or backend). A cached result carries the
 * origin it was answered with, so policy still applies as before.
 */
export const cachedJudgment = Effect.fn("@llm4ts/flow/Judgment.cached")(function* (
  files: PlainFileStoreShape,
  path: string,
  judgment: JudgmentShape,
  request: JudgmentInput
): Effect.fn.Return<JudgmentResult, FlowError> {
  const fingerprint = yield* judgmentFingerprint(request, judgment.identity)
  const contents = yield* files.read(path).pipe(Effect.catch(() => Effect.succeed(undefined)))
  const entry =
    contents === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JudgmentCacheEntry))(contents).pipe(
          Effect.option,
          Effect.map((option) => (option._tag === "Some" ? option.value : undefined))
        )
  if (entry?.fingerprint === fingerprint) {
    return entry.result
  }
  const result = yield* judgment.judge(request).pipe(Effect.mapError(backendFailure))
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(JudgmentCacheEntry))(
    JudgmentCacheEntry.make({ fingerprint, result })
  ).pipe(
    Effect.mapError((error) =>
      PersistenceError.make({
        message: `failed to encode judgment cache: ${String(error)}`,
        cause: error
      })
    )
  )
  yield* files.writeAtomic(path, encoded)
  return result
})
