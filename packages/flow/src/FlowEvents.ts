import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PubSub from "effect/PubSub"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { TokenUsage } from "@llm4ts/core/Models"

export class StageStarted extends Schema.TaggedClass<StageStarted>()("StageStarted", {
  stage: Schema.String
}) {}

export class StageCompleted extends Schema.TaggedClass<StageCompleted>()("StageCompleted", {
  stage: Schema.String
}) {}

export class StageFailed extends Schema.TaggedClass<StageFailed>()("StageFailed", {
  stage: Schema.String,
  message: Schema.String
}) {}

export class Aborted extends Schema.TaggedClass<Aborted>()("Aborted", {
  message: Schema.String
}) {}

export class Info extends Schema.TaggedClass<Info>()("Info", {
  message: Schema.String
}) {}

export class ToolUse extends Schema.TaggedClass<ToolUse>()("ToolUse", {
  tool: Schema.String,
  args: Schema.String
}) {}

export class AssistantMessage extends Schema.TaggedClass<AssistantMessage>()("AssistantMessage", {
  text: Schema.String
}) {}

export class TokensUsed extends Schema.TaggedClass<TokensUsed>()("TokensUsed", {
  agent: Schema.String,
  model: Schema.optionalKey(Schema.String),
  usage: TokenUsage
}) {}

export class CapabilityUsedEvent extends Schema.TaggedClass<CapabilityUsedEvent>()(
  "CapabilityUsed",
  {
    capability: Schema.String,
    operation: Schema.String
  }
) {}

export class CapabilityDeniedEvent extends Schema.TaggedClass<CapabilityDeniedEvent>()(
  "CapabilityDenied",
  {
    capability: Schema.String,
    operation: Schema.String
  }
) {}

export class CapabilityUnenforceable extends Schema.TaggedClass<CapabilityUnenforceable>()(
  "CapabilityUnenforceable",
  {
    detail: Schema.String
  }
) {}

export class Declassified extends Schema.TaggedClass<Declassified>()("Declassified", {
  label: Schema.String
}) {}

export const FlowEvent = Schema.Union([
  StageStarted,
  StageCompleted,
  StageFailed,
  Aborted,
  Info,
  ToolUse,
  AssistantMessage,
  TokensUsed,
  CapabilityUsedEvent,
  CapabilityDeniedEvent,
  CapabilityUnenforceable,
  Declassified
])
export type FlowEvent = typeof FlowEvent.Type

export const FlowEventsValues = Object.freeze({
  CapabilityUsed: (capability: string, operation: string): CapabilityUsedEvent =>
    new CapabilityUsedEvent({ capability, operation }),
  CapabilityDenied: (capability: string, operation: string): CapabilityDeniedEvent =>
    new CapabilityDeniedEvent({ capability, operation }),
  CapabilityUnenforceable: (detail: string): CapabilityUnenforceable =>
    new CapabilityUnenforceable({ detail }),
  Declassified: (label: string): Declassified => new Declassified({ label })
})

export interface FlowEventsShape {
  readonly publish: (event: FlowEvent) => Effect.Effect<void>
}

export class FlowEvents extends Context.Service<FlowEvents, FlowEventsShape>()(
  "@llm4ts/flow/FlowEvents"
) {}

const noopFlowEvents = FlowEvents.of({
  publish: (_event) => Effect.void
})

export const FlowEventsNoop = Layer.succeed(FlowEvents)(noopFlowEvents)

export interface CollectingFlowEvents extends FlowEventsShape {
  readonly recorded: Effect.Effect<ReadonlyArray<FlowEvent>>
}

export const makeCollectingFlowEvents: Effect.Effect<CollectingFlowEvents> = Effect.map(
  Ref.make<ReadonlyArray<FlowEvent>>([]),
  (events) => ({
    publish: (event) => Ref.update(events, (recorded) => [...recorded, event]),
    recorded: Ref.get(events)
  })
)

export interface FlowEventHub extends FlowEventsShape {
  readonly subscribe: Effect.Effect<PubSub.Subscription<FlowEvent>, never, Scope.Scope>
  readonly stream: Stream.Stream<FlowEvent>
  readonly publishedCount: Effect.Effect<number>
}

export const makeFlowEventHub = Effect.fn("@llm4ts/flow/FlowEvents.makeHub")(function* (
  capacity = 64
): Effect.fn.Return<FlowEventHub> {
  const events = yield* PubSub.bounded<FlowEvent>(capacity)
  const published = yield* Ref.make(0)
  return {
    publish: (event) =>
      Ref.update(published, (count) => count + 1).pipe(
        Effect.andThen(PubSub.publish(events, event)),
        Effect.asVoid
      ),
    subscribe: PubSub.subscribe(events),
    stream: Stream.fromPubSub(events),
    publishedCount: Ref.get(published)
  }
})
