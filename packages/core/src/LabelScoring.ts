import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { InvalidRequestError, ParseError, type LlmError } from "./Errors.ts"
import type { LlmServiceShape } from "./LlmService.ts"
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
