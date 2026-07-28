import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as Stream from "effect/Stream"
import type { LlmError } from "./Errors.ts"
import { TokenUsage } from "./Models.ts"

export class SessionTextDelta extends Schema.TaggedClass<SessionTextDelta>()("TextDelta", {
  text: Schema.String
}) {}

export class SessionToolUse extends Schema.TaggedClass<SessionToolUse>()("ToolUse", {
  tool: Schema.String,
  rawInput: Schema.String,
  id: Schema.String
}) {}

export class SessionToolResult extends Schema.TaggedClass<SessionToolResult>()("ToolResult", {
  id: Schema.String,
  status: Schema.String,
  content: Schema.String
}) {}

export class SessionAskUser extends Schema.TaggedClass<SessionAskUser>()("AskUser", {
  question: Schema.String
}) {}

export class SessionApprovalRequest extends Schema.TaggedClass<SessionApprovalRequest>()(
  "ApprovalRequest",
  {
    tool: Schema.String,
    rawInput: Schema.String,
    id: Schema.String
  }
) {}

export class SessionUsage extends Schema.TaggedClass<SessionUsage>()("Usage", {
  usage: TokenUsage,
  model: Schema.optionalKey(Schema.String)
}) {}

export class SessionDone extends Schema.TaggedClass<SessionDone>()("Done", {
  result: Schema.String
}) {}

export const SessionEvent = Schema.Union([
  SessionTextDelta,
  SessionToolUse,
  SessionToolResult,
  SessionAskUser,
  SessionApprovalRequest,
  SessionUsage,
  SessionDone
])
export type SessionEvent = typeof SessionEvent.Type

export class SessionResult extends Schema.Class<SessionResult>("SessionResult")({
  text: Schema.String,
  usage: Schema.optionalKey(TokenUsage),
  model: Schema.optionalKey(Schema.String)
}) {}

export interface AgentSessionShape {
  readonly events: Stream.Stream<SessionEvent, LlmError>
  readonly sendUserMessage: (text: string) => Effect.Effect<void, LlmError>
  readonly respondToAsk: (answer: string) => Effect.Effect<void, LlmError>
  readonly respondToApproval: (id: string, approved: boolean) => Effect.Effect<void, LlmError>
  readonly awaitResult: Effect.Effect<SessionResult, LlmError>
  readonly cancel: Effect.Effect<void>
}
