import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { TokenUsage, JsonSchema } from "@llm4ts/core/Models"
import { FlowLlmError } from "./FlowError.ts"
import { TokensUsed, type FlowEventsShape } from "./FlowEvents.ts"

/**
 * Token accounting for structured requests.
 *
 * `executeStructured` discards the usage its provider reported, so a flow
 * built from structured calls — every modernization phase, and every reviewer
 * lens — produced no `TokensUsed` events at all and summarised as "no usage
 * reported" however many tokens the backend actually counted. These helpers
 * keep cost accounting a property of the flow spine rather than of each
 * script. They live apart from `Flow.ts` so `Review.ts`, which `Flow.ts`
 * itself imports, can publish without an import cycle.
 */

/** Publishes a `TokensUsed` event when the provider reported usage. */
export const publishUsage = (
  events: FlowEventsShape,
  usage: TokenUsage | undefined,
  model: string | undefined,
  agent: string
): Effect.Effect<void> =>
  usage === undefined
    ? Effect.void
    : events.publish(
        TokensUsed.make({
          agent,
          usage,
          ...(model === undefined ? {} : { model })
        })
      )

/**
 * Runs a structured request, publishes its token usage, and returns the
 * decoded value — the structured counterpart of `completeAndPublish`.
 */
export const structuredAndPublish = <A, E, RD, RE>(
  service: LlmServiceShape,
  events: FlowEventsShape,
  prompt: string,
  schema: Schema.ConstraintCodec<A, E, RD, RE>,
  jsonSchema: JsonSchema,
  agent = "reasoning"
): Effect.Effect<A, FlowLlmError, RD> =>
  Effect.gen(function* () {
    const [value, usage, model] = yield* service
      .executeStructuredWithUsage(prompt, schema, jsonSchema)
      .pipe(Effect.mapError(FlowLlmError.from))
    yield* publishUsage(events, usage, model, agent)
    return value
  })
