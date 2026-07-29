import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { JsonSchema } from "@llm4ts/core/Models"
import { FlowLlmError } from "./FlowError.ts"

export class PrSummary extends Schema.Class<PrSummary>("PrSummary")({
  title: Schema.String,
  body: Schema.String
}) {}

export const prSummaryJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string" }
  },
  required: ["title", "body"]
}

export const summarisePr = Effect.fn("@llm4ts/flow/PrSummary.summarise")(function* (
  reasoning: LlmServiceShape,
  diff: string,
  context?: string
): Effect.fn.Return<PrSummary, FlowLlmError> {
  const contextBlock =
    context === undefined || context.length === 0 ? "" : `\nContext:\n${context}\n`
  const prompt = [
    'Summarise this change as a pull request. Respond only with JSON: {"title":"...","body":"..."}.',
    contextBlock,
    "Diff:",
    diff
  ].join("\n")
  return yield* reasoning
    .executeStructured(prompt, PrSummary, prSummaryJsonSchema)
    .pipe(Effect.mapError(FlowLlmError.from))
})
