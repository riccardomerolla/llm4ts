import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Layer from "effect/Layer"
import * as PubSub from "effect/PubSub"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { TokenUsage } from "@llm4ts/core/Models"
import { Answer, AnswerOrigin, Question, State } from "@llm4ts/core/judgment/Schemas"
import { Decision, JudgmentMode } from "./JudgmentTypes.ts"

export const JudgmentOutcome = Schema.Union([
  Schema.TaggedStruct("ReviewPrescreen", {
    lens: Schema.String,
    issues: Schema.Struct({ Critical: Schema.Int, Warning: Schema.Int, Info: Schema.Int })
  }),
  Schema.TaggedStruct("SatisfiedProbe", { literalMatch: Schema.Boolean }),
  Schema.TaggedStruct("ProgramJudge", { score: Schema.Number })
])
export type JudgmentOutcome = typeof JudgmentOutcome.Type

export class JudgmentObserved extends Schema.TaggedClass<JudgmentObserved>()("JudgmentObserved", {
  consumer: Schema.Literals(["review-prescreen", "satisfied-probe", "program-judge"]),
  key: Schema.String,
  state: State,
  question: Question,
  answer: Answer,
  judgmentIdentity: Schema.String,
  decision: Decision,
  certainty: Schema.Number,
  support: Schema.Number,
  origin: AnswerOrigin,
  outcome: JudgmentOutcome,
  mode: JudgmentMode
}) {}

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
  JudgmentObserved,
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

/** Publish an observation, rendering the same decision and outcome in advise mode. */
export const publishJudgmentObserved = Effect.fn("@llm4ts/flow/FlowEvents.publishJudgmentObserved")(
  function* (events: FlowEventsShape, observation: JudgmentObserved): Effect.fn.Return<void> {
    yield* events.publish(observation)
    if (observation.mode === "advise") {
      yield* events.publish(
        Info.make({
          message: `judgment ${observation.consumer} '${observation.key}': ${observation.decision}; outcome ${JSON.stringify(observation.outcome)}`
        })
      )
    }
  }
)

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
    // Counted AFTER delivery, and only when the PubSub accepted the event.
    // Tallying first meant a publish interrupted while backpressured (a
    // bounded PubSub suspends when a subscriber is behind) left `published`
    // permanently above anything a consumer could ever reach, and every
    // drain waiting on it never finished.
    publish: (event) =>
      PubSub.publish(events, event).pipe(
        Effect.flatMap((accepted) =>
          accepted ? Ref.update(published, (count) => count + 1) : Effect.void
        ),
        Effect.asVoid
      ),
    subscribe: PubSub.subscribe(events),
    stream: Stream.fromPubSub(events),
    publishedCount: Ref.get(published)
  }
})

/** How long a consumer waits to catch up before the run moves on regardless. */
export const defaultDrainTimeout = "3 seconds"

/**
 * The shared drain: wait until `consumed` has caught up with everything the
 * hub published, and report whether it did.
 *
 * Bounded on purpose, and the single copy of this loop. A consumer can fall
 * permanently short of the count — a subscription torn down early, an
 * event the PubSub refused — and an unbounded wait then pegs a core forever.
 * In the runner that swallowed the end of a run: every stage printed and
 * ticked green, and no cost summary ever following, because the summary is
 * written only once every consumer reports drained.
 */
export const awaitConsumed = (
  hub: FlowEventHub,
  consumed: Ref.Ref<number>,
  timeout: Duration.Input = defaultDrainTimeout
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const target = yield* hub.publishedCount
    const drain: Effect.Effect<void> = Effect.suspend(() =>
      Ref.get(consumed).pipe(
        Effect.flatMap((count) =>
          count >= target ? Effect.void : Effect.yieldNow.pipe(Effect.andThen(drain))
        )
      )
    )
    return Option.isSome(yield* Effect.timeoutOption(drain, timeout))
  })
