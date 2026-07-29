import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Stream from "effect/Stream"
import type * as Schema from "effect/Schema"
import type { LlmError } from "./Errors.ts"
import type {
  JsonSchema,
  LlmChunk,
  Message,
  TokenUsage,
  ToolCallResponse,
  ToolDefinition
} from "./Models.ts"

export type StructuredResult<A> = readonly [
  value: A,
  usage: TokenUsage | undefined,
  model: string | undefined
]

export interface LlmServiceShape {
  readonly executeStream: (prompt: string) => Stream.Stream<LlmChunk, LlmError>
  readonly executeStreamWithHistory: (
    messages: ReadonlyArray<Message>
  ) => Stream.Stream<LlmChunk, LlmError>
  readonly executeWithTools: (
    prompt: string,
    tools: ReadonlyArray<ToolDefinition>
  ) => Effect.Effect<ToolCallResponse, LlmError>
  readonly executeStructured: <A, E, RD, RE>(
    prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    jsonSchema: JsonSchema
  ) => Effect.Effect<A, LlmError, RD>
  readonly executeStructuredWithUsage: <A, E, RD, RE>(
    prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    jsonSchema: JsonSchema
  ) => Effect.Effect<StructuredResult<A>, LlmError, RD>
  readonly isAvailable: Effect.Effect<boolean>
}

export class LlmService extends Context.Service<LlmService, LlmServiceShape>()(
  "@llm4ts/core/LlmService"
) {}
