import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { InvalidRequestError, ParseError, type LlmError } from "./Errors.ts"
import * as Result from "effect/Result"
import type { LabelSequence, LlmServiceShape } from "./LlmService.ts"
import { LabelDistribution, type JsonSchema, type LabelMethod } from "./Models.ts"

/**
 * Label scoring: the one classification primitive every connector offers.
 *
 * A caller hands over a prompt and a closed set of labels and gets a
 * probability per label back. Connectors that expose token log-probabilities
 * implement it natively in one forward pass; everything else derives it here
 * from `executeStructured`, asking the model to write the numbers down
 * (method `verbalized`, which callers should hold to a higher bar).
 */

const raw = (text: string): string => (text.length > 200 ? `${text.slice(0, 200)}…` : text)

/**
 * Keep only the offered labels, clamp negatives to zero and renormalize.
 * `support` records how much mass the offered labels held before
 * renormalization: for log-probabilities that is their absolute share of
 * the vocabulary distribution (so one label found with 5% of the mass
 * yields probability 1 but support 0.05); a backend whose numbers were
 * declared over the labels alone passes `support: 1`. Fails typed when
 * none of the offered labels carries any mass, so a caller never branches
 * on a silent uniform distribution.
 */
export const normalizeLabelProbabilities = (
  labels: ReadonlyArray<string>,
  observed: Readonly<Record<string, number>>,
  method: LabelMethod,
  extra: {
    readonly usage?: LabelDistribution["usage"]
    readonly model?: string
    readonly support?: number
  } = {}
): Effect.Effect<LabelDistribution, ParseError> => {
  const kept = labels.map((label) => [label, Math.max(0, observed[label] ?? 0)] as const)
  const total = kept.reduce((sum, [, value]) => sum + value, 0)
  if (!(total > 0)) {
    return Effect.fail(
      ParseError.make({
        message: `none of the offered labels was observed: ${labels.join(", ")}`,
        raw: raw(JSON.stringify(observed))
      })
    )
  }
  return Effect.succeed(
    LabelDistribution.make({
      probabilities: Object.fromEntries(kept.map(([label, value]) => [label, value / total])),
      method,
      support: Math.max(0, Math.min(1, extra.support ?? total)),
      ...(extra.usage === undefined ? {} : { usage: extra.usage }),
      ...(extra.model === undefined ? {} : { model: extra.model })
    })
  )
}

export class VerbalizedLabels extends Schema.Class<VerbalizedLabels>("VerbalizedLabels")({
  label: Schema.String,
  probabilities: Schema.Record(Schema.String, Schema.Number)
}) {}

export const verbalizedLabelsJsonSchema = (labels: ReadonlyArray<string>): JsonSchema => ({
  type: "object",
  properties: {
    label: { type: "string", enum: [...labels] },
    probabilities: {
      type: "object",
      properties: Object.fromEntries(labels.map((label) => [label, { type: "number" }])),
      required: [...labels],
      additionalProperties: false
    }
  },
  required: ["label", "probabilities"],
  additionalProperties: false
})

export const verbalizedLabelsPrompt = (prompt: string, labels: ReadonlyArray<string>): string =>
  `${prompt}\n\nReply with JSON only: {"label": <the one label you choose>, "probabilities": {<a probability for every label, summing to 1>}}. Labels: ${labels.join(", ")}.`

/**
 * The default `scoreLabels` for a connector without log-probabilities: one
 * schema-constrained JSON reply, renormalized over the offered labels.
 */
export const verbalizedScoreLabels =
  (executeStructuredWithUsage: LlmServiceShape["executeStructuredWithUsage"]) =>
  (prompt: string, labels: ReadonlyArray<string>): Effect.Effect<LabelDistribution, LlmError> =>
    executeStructuredWithUsage(
      verbalizedLabelsPrompt(prompt, labels),
      VerbalizedLabels,
      verbalizedLabelsJsonSchema(labels)
    ).pipe(
      Effect.flatMap(([reply, usage, model]) =>
        // A reply that names a label but gives it no mass contradicts itself;
        // failing here is what lets the judgment layer retry or hold, instead
        // of a manufactured 1.0 that could wave a review through.
        labels.includes(reply.label) && !((reply.probabilities[reply.label] ?? 0) > 0)
          ? Effect.fail(
              ParseError.make({
                message: `the model chose "${reply.label}" but gave it no probability`,
                raw: raw(JSON.stringify(reply.probabilities))
              })
            )
          : normalizeLabelProbabilities(labels, reply.probabilities, "verbalized", {
              // Declared over the labels alone: support is by construction.
              support: 1,
              ...(usage === undefined ? {} : { usage }),
              ...(model === undefined ? {} : { model })
            })
      )
    )

/** For fakes and adapters that cannot classify: fails typed instead of guessing. */
export const unsupportedScoreLabels: LlmServiceShape["scoreLabels"] = (_prompt, _labels) =>
  Effect.fail(InvalidRequestError.make({ message: "label scoring is not supported here" }))

export class VerbalizedLabelSequence extends Schema.Class<VerbalizedLabelSequence>(
  "VerbalizedLabelSequence"
)({
  answers: Schema.Array(VerbalizedLabels)
}) {}

export const verbalizedLabelSequenceJsonSchema = (
  labelSets: ReadonlyArray<ReadonlyArray<string>>
): JsonSchema => ({
  type: "object",
  properties: {
    answers: {
      type: "array",
      minItems: labelSets.length,
      maxItems: labelSets.length,
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          probabilities: { type: "object", additionalProperties: { type: "number" } }
        },
        required: ["label", "probabilities"]
      }
    }
  },
  required: ["answers"],
  additionalProperties: false
})

export const verbalizedLabelSequencePrompt = (
  prompt: string,
  labelSets: ReadonlyArray<ReadonlyArray<string>>
): string =>
  `${prompt}\n\nReply with JSON only: {"answers": [<one entry per question, in order>]}, each entry {"label": <the one label you choose>, "probabilities": {<a probability for every label of that question, summing to 1>}}. Labels per question: ${labelSets
    .map((labels, index) => `${index + 1}: ${labels.join(", ")}`)
    .join("; ")}.`

/**
 * The derived `scoreLabelSequence`: one schema-constrained JSON reply with
 * an answer per question. A missing position, or a chosen label with no
 * mass, fails that position only.
 */
export const verbalizedScoreLabelSequence =
  (executeStructuredWithUsage: LlmServiceShape["executeStructuredWithUsage"]) =>
  (
    prompt: string,
    labelSets: ReadonlyArray<ReadonlyArray<string>>
  ): Effect.Effect<LabelSequence, LlmError> =>
    executeStructuredWithUsage(
      verbalizedLabelSequencePrompt(prompt, labelSets),
      VerbalizedLabelSequence,
      verbalizedLabelSequenceJsonSchema(labelSets)
    ).pipe(
      Effect.flatMap(([reply, usage, model]) =>
        Effect.forEach(labelSets, (labels, index) => {
          const answer = reply.answers[index]
          const entry: Effect.Effect<LabelDistribution, ParseError> =
            answer === undefined
              ? Effect.fail(
                  ParseError.make({
                    message: `no answer for question ${index + 1} of ${labelSets.length}`,
                    raw: raw(JSON.stringify(reply.answers))
                  })
                )
              : labels.includes(answer.label) && !((answer.probabilities[answer.label] ?? 0) > 0)
                ? Effect.fail(
                    ParseError.make({
                      message: `question ${index + 1}: the model chose "${answer.label}" but gave it no probability`,
                      raw: raw(JSON.stringify(answer.probabilities))
                    })
                  )
                : normalizeLabelProbabilities(labels, answer.probabilities, "verbalized", {
                    support: 1
                  })
          return Effect.result(entry)
        }).pipe(
          Effect.map(
            (entries): LabelSequence => ({
              entries,
              ...(usage === undefined ? {} : { usage }),
              ...(model === undefined ? {} : { model })
            })
          )
        )
      )
    )

/** Convenience for callers that want the sequence's successes only. */
export const sequenceSuccesses = (
  sequence: LabelSequence
): ReadonlyArray<LabelDistribution | undefined> =>
  sequence.entries.map((entry) => (Result.isSuccess(entry) ? entry.success : undefined))
