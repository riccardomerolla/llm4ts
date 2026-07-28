import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export const PromptRole = Schema.Literals(["System", "User", "Assistant", "Tool"])
export type PromptRole = typeof PromptRole.Type

const emptyMetadata: Readonly<Record<string, string>> = Object.freeze({})

export class ConversationMessage extends Schema.Class<ConversationMessage>("ConversationMessage")({
  id: Schema.String,
  role: PromptRole,
  content: Schema.String,
  timestamp: Schema.DateTimeUtc,
  tokens: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(0))),
  model: Schema.optionalKey(Schema.String),
  costUsd: Schema.optionalKey(Schema.Number),
  metadata: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyMetadata))
  ),
  important: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false)))
}) {}
