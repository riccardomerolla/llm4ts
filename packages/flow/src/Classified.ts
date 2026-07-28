import * as Effect from "effect/Effect"
import { Capabilities, type Capability, allows, currentGrants } from "@llm4ts/core/Capability"
import { FlowCapabilityDenied } from "./FlowError.ts"
import { FlowEvents, FlowEventsValues, type FlowEventsShape } from "./FlowEvents.ts"

const capabilityName = (capability: Capability): string =>
  capability._tag === "Exec" ? `Exec(${capability.command})` : capability._tag

const shouldAuditUse = (capability: Capability): boolean => {
  switch (capability._tag) {
    case "GitPush":
    case "GhWrite":
    case "AdoWrite":
    case "Exec":
      return true
    default:
      return false
  }
}

export const guarded = <A, E, R>(
  capability: Capability,
  operation: string,
  body: Effect.Effect<A, E, R>
): Effect.Effect<A, E | FlowCapabilityDenied, R | FlowEvents> =>
  Effect.gen(function* () {
    const events: FlowEventsShape = yield* FlowEvents
    const grants = yield* currentGrants
    const name = capabilityName(capability)

    if (!allows(grants, capability)) {
      yield* events.publish(FlowEventsValues.CapabilityDenied(name, operation))
      return yield* new FlowCapabilityDenied({ capability, operation })
    }

    if (shouldAuditUse(capability)) {
      yield* events.publish(FlowEventsValues.CapabilityUsed(name, operation))
    }

    return yield* body
  })

export class Classified<A> {
  private constructor(private readonly value: A) {}

  static of<A>(value: A): Classified<A> {
    return new Classified(value)
  }

  map<B>(transform: (value: A) => B): Classified<B> {
    return new Classified(transform(this.value))
  }

  declassify(label: string): Effect.Effect<A, FlowCapabilityDenied, FlowEvents> {
    return guarded(
      Capabilities.Declassify,
      `declassify ${label}`,
      Effect.flatMap(FlowEvents, (events) =>
        Effect.as(events.publish(FlowEventsValues.Declassified(label)), this.value)
      )
    )
  }

  toString(): string {
    return "Classified(…)"
  }
}
