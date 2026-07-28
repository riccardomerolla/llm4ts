import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { FlowError } from "./FlowError.ts"

export interface InteractionShape {
  readonly ask: (question: string) => Effect.Effect<string, FlowError>
}

export class ApprovalAllowed extends Schema.TaggedClass<ApprovalAllowed>()("Allow", {}) {}

export class ApprovalDenied extends Schema.TaggedClass<ApprovalDenied>()("Deny", {
  reason: Schema.String
}) {}

export const ApprovalDecision = Schema.Union([ApprovalAllowed, ApprovalDenied])
export type ApprovalDecision = typeof ApprovalDecision.Type

export interface ApprovalPolicy {
  readonly decide: (
    toolName: string,
    input: Schema.Json
  ) => Effect.Effect<ApprovalDecision, FlowError>
}
