import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type * as Stream from "effect/Stream"
import type * as Schema from "effect/Schema"
import type * as Result from "effect/Result"
import type { LlmError, ParseError } from "./Errors.ts"
import type {
  JsonSchema,
  LabelDistribution,
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
  /**
   * One atomic classification: the probability of each offered label given
   * the prompt. Connectors with token log-probabilities answer in one forward
   * pass; the rest derive it from `executeStructured` (see `LabelScoring`).
   * Fails with `ParseError` when no offered label could be observed.
   */
  readonly scoreLabels: (
    prompt: string,
    labels: ReadonlyArray<string>
  ) => Effect.Effect<LabelDistribution, LlmError>
  /**
   * Several label questions answered in one call over a shared prompt
   * prefix (the judgment layer's `shared-prefix` batching): the reply is one
   * label per question in order, and each position is read as its own
   * distribution. Optional, unlike `scoreLabels`: it is a cost optimization
   * that only backends with token log-probabilities implement natively, and
   * the judgment layer derives a verbalized version from structured output
   * when it is absent, so no fake or decorator has to carry it.
   */
  readonly scoreLabelSequence?: (
    prompt: string,
    labelSets: ReadonlyArray<ReadonlyArray<string>>
  ) => Effect.Effect<LabelSequence, LlmError>
  readonly isAvailable: Effect.Effect<boolean>
}

/**
 * The reply to `scoreLabelSequence`: one outcome per question in order (a
 * position that could not be read fails on its own, so the caller can fall
 * back for that question only), plus the call's usage and model once.
 */
export interface LabelSequence {
  readonly entries: ReadonlyArray<Result.Result<LabelDistribution, ParseError>>
  readonly usage?: TokenUsage
  readonly model?: string
}

export class LlmService extends Context.Service<LlmService, LlmServiceShape>()(
  "@llm4ts/core/LlmService"
) {}
