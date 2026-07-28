import * as Effect from "effect/Effect"
import { allows, currentGrants, type Capability } from "@llm4ts/core/Capability"
import { FlowCapabilityDenied } from "./FlowError.ts"
import { CapabilityDeniedEvent, CapabilityUsedEvent, type FlowEventsShape } from "./FlowEvents.ts"

const capabilityName = (capability: Capability): string =>
  capability._tag === "Exec" ? `Exec(${capability.command})` : capability._tag

export const guarded = <A, E, R>(
  capability: Capability,
  operation: string,
  events: FlowEventsShape,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | FlowCapabilityDenied, R> =>
  Effect.flatMap(currentGrants, (grants): Effect.Effect<A, E | FlowCapabilityDenied, R> => {
    if (!allows(grants, capability)) {
      return events
        .publish(
          CapabilityDeniedEvent.make({
            capability: capabilityName(capability),
            operation
          })
        )
        .pipe(
          Effect.andThen(
            Effect.fail(
              FlowCapabilityDenied.make({
                capability,
                operation
              })
            )
          )
        )
    }
    return events
      .publish(
        CapabilityUsedEvent.make({
          capability: capabilityName(capability),
          operation
        })
      )
      .pipe(Effect.andThen(effect))
  })
