import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { JsonSchema } from "@llm4ts/core/Models"
import { collect } from "@llm4ts/core/Streaming"
import { FlowLlmError } from "./FlowError.ts"
import { Plan } from "./Plan.ts"

export class Proceed extends Schema.Class<Proceed>("Proceed")({
  kind: Schema.Literal("Proceed"),
  value: Plan
}) {}

export class Blocked extends Schema.Class<Blocked>("Blocked")({
  kind: Schema.Literal("Blocked"),
  reason: Schema.String
}) {}

export const Verdict = Schema.Union([Proceed, Blocked])
export type Verdict = typeof Verdict.Type

export const planJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    epicId: { type: "string" },
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          completed: { type: "boolean" }
        },
        required: ["title", "description", "completed"]
      }
    },
    brief: { type: "string" }
  },
  required: ["epicId", "tasks"]
}

const verdictJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["Proceed", "Blocked"] },
    value: planJsonSchema,
    reason: { type: "string" }
  },
  required: ["kind"]
}

export const defaultPlanInstructions = [
  "You are a planning assistant. Break the user's request into an ordered list of small,",
  "independently implementable tasks. Each task must be a thin vertical slice with an observable",
  "outcome, described in terms of behavior rather than mechanism. Choose a short kebab-case epicId.",
  'Respond only with JSON: {"epicId":"kebab-case-id","tasks":',
  '[{"title":"...","description":"...","completed":false}]}'
].join("\n")

export const planFrom = Effect.fn("@llm4ts/flow/Planner.from")(function* (
  reasoning: LlmServiceShape,
  prompt: string,
  instructions = defaultPlanInstructions
): Effect.fn.Return<Plan, FlowLlmError> {
  return yield* reasoning
    .executeStructured(`${instructions}\n\nRequest:\n${prompt}`, Plan, planJsonSchema)
    .pipe(Effect.mapError(FlowLlmError.from))
})

export const reviewPlanInstructions = [
  "Review the draft implementation plan for correctness, completeness, simplicity, and concision.",
  "Keep the same epicId unless it is clearly wrong. Return the complete improved plan, not a patch.",
  'Respond only with JSON: {"epicId":"kebab-case-id","tasks":',
  '[{"title":"...","description":"...","completed":false}]}'
].join("\n")

export const reviewPlan = Effect.fn("@llm4ts/flow/Planner.review")(function* (
  reasoning: LlmServiceShape,
  plan: Plan,
  instructions = reviewPlanInstructions
): Effect.fn.Return<Plan, FlowLlmError> {
  const improved = yield* reasoning
    .executeStructured(`${instructions}\n\nDraft plan:\n${plan.render}`, Plan, planJsonSchema)
    .pipe(Effect.mapError(FlowLlmError.from))
  return Plan.make({
    ...improved,
    ...(plan.brief === undefined ? {} : { brief: plan.brief })
  })
})

export const briefInstructions = [
  "Write a concise codebase brief for an engineer about to implement this change:",
  "relevant modules and file paths, important APIs and types, conventions, and build/test commands.",
  "Explore the repository as needed. Do not restate the task list. Return plain prose."
].join("\n")

export const writeBrief = Effect.fn("@llm4ts/flow/Planner.brief")(function* (
  reasoning: LlmServiceShape,
  prompt: string,
  instructions = briefInstructions
): Effect.fn.Return<string, FlowLlmError> {
  const response = yield* collect(
    reasoning.executeStream(`${instructions}\n\nChange request:\n${prompt}`)
  ).pipe(Effect.mapError(FlowLlmError.from))
  return response.content.trim()
})

export const briefPlan = Effect.fn("@llm4ts/flow/Planner.briefPlan")(function* (
  reasoning: LlmServiceShape,
  plan: Plan,
  prompt: string,
  instructions = briefInstructions
): Effect.fn.Return<Plan, FlowLlmError> {
  const brief = yield* writeBrief(reasoning, prompt, instructions)
  return Plan.make({ ...plan, brief })
})

export const assessThenPlanInstructions = [
  "First decide whether this request is ready to implement.",
  'Respond only with JSON using exactly one form: {"kind":"Blocked","reason":"why it cannot proceed"}',
  'or {"kind":"Proceed","value":{"epicId":"kebab-id","tasks":',
  '[{"title":"...","description":"...","completed":false}]}}.'
].join("\n")

export const assessThenPlan = Effect.fn("@llm4ts/flow/Planner.assessThenPlan")(function* (
  reasoning: LlmServiceShape,
  prompt: string,
  instructions = assessThenPlanInstructions
): Effect.fn.Return<Verdict, FlowLlmError> {
  return yield* reasoning
    .executeStructured(`${instructions}\n\nRequest:\n${prompt}`, Verdict, verdictJsonSchema)
    .pipe(Effect.mapError(FlowLlmError.from))
})
