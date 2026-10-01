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
import { RunResult } from "@llm4ts/core/blackboard/Run"
import { Answer, AnswerOrigin, Question, State } from "@llm4ts/core/judgment/Schemas"
import { Decision, JudgmentMode } from "./JudgmentTypes.ts"

export const JudgmentOutcome = Schema.Union([
  Schema.TaggedStruct("ReviewPrescreen", {
    lens: Schema.String,
    issues: Schema.Struct({ Critical: Schema.Int, Warning: Schema.Int, Info: Schema.Int })
  }),
  Schema.TaggedStruct("SatisfiedProbe", { literalMatch: Schema.Boolean }),
  Schema.TaggedStruct("ProgramJudge", { score: Schema.Number }),
  Schema.TaggedStruct("StoryBoard", {
    dimension: Schema.String,
    score: Schema.Number,
    mergeable: Schema.Boolean
  })
])
export type JudgmentOutcome = typeof JudgmentOutcome.Type

export class JudgmentObserved extends Schema.TaggedClass<JudgmentObserved>()("JudgmentObserved", {
  consumer: Schema.Literals([
    "review-prescreen",
    "satisfied-probe",
    "program-judge",
    "story-board"
  ]),
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
  stage: Schema.String,
  /** The concurrent unit (a story) this event belongs to; absent for run-wide events. */
  lane: Schema.optionalKey(Schema.String),
  /** The roster executor working that lane, when there is one (ADR 0019). */
  executor: Schema.optionalKey(Schema.String)
}) {}

export class StageCompleted extends Schema.TaggedClass<StageCompleted>()("StageCompleted", {
  stage: Schema.String,
  /** The concurrent unit (a story) this event belongs to; absent for run-wide events. */
  lane: Schema.optionalKey(Schema.String),
  /** The roster executor working that lane, when there is one (ADR 0019). */
  executor: Schema.optionalKey(Schema.String)
}) {}

export class StageFailed extends Schema.TaggedClass<StageFailed>()("StageFailed", {
  stage: Schema.String,
  message: Schema.String,
  /** The concurrent unit (a story) this event belongs to; absent for run-wide events. */
  lane: Schema.optionalKey(Schema.String),
  /** The roster executor working that lane, when there is one (ADR 0019). */
  executor: Schema.optionalKey(Schema.String)
}) {}

export class Aborted extends Schema.TaggedClass<Aborted>()("Aborted", {
  message: Schema.String
}) {}

export class Info extends Schema.TaggedClass<Info>()("Info", {
  message: Schema.String,
  /** The concurrent unit (a story) this event belongs to; absent for run-wide events. */
  lane: Schema.optionalKey(Schema.String),
  /** The roster executor working that lane, when there is one (ADR 0019). */
  executor: Schema.optionalKey(Schema.String)
}) {}

export class ToolUse extends Schema.TaggedClass<ToolUse>()("ToolUse", {
  tool: Schema.String,
  args: Schema.String,
  /** The concurrent unit (a story) this event belongs to; absent for run-wide events. */
  lane: Schema.optionalKey(Schema.String),
  /** The roster executor working that lane, when there is one (ADR 0019). */
  executor: Schema.optionalKey(Schema.String)
}) {}

export class AssistantMessage extends Schema.TaggedClass<AssistantMessage>()("AssistantMessage", {
  text: Schema.String,
  /** The concurrent unit (a story) this event belongs to; absent for run-wide events. */
  lane: Schema.optionalKey(Schema.String),
  /** The roster executor working that lane, when there is one (ADR 0019). */
  executor: Schema.optionalKey(Schema.String)
}) {}

export class TokensUsed extends Schema.TaggedClass<TokensUsed>()("TokensUsed", {
  agent: Schema.String,
  model: Schema.optionalKey(Schema.String),
  usage: TokenUsage,
  /** The concurrent unit (a story) this event belongs to; absent for run-wide events. */
  lane: Schema.optionalKey(Schema.String),
  /** The roster executor working that lane, when there is one (ADR 0019). */
  executor: Schema.optionalKey(Schema.String)
}) {}

/** One issue a review round found, as the operator sees it. */
export class ReviewFinding extends Schema.Class<ReviewFinding>("ReviewFinding")({
  severity: Schema.Literals(["Critical", "Warning", "Info"]),
  title: Schema.String,
  file: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Int)
}) {}

/**
 * What a review round found: the issues the coder is now asked to fix, or,
 * `settled`, what is left when the review stops. A bare count said the round
 * took long without saying why.
 */
export class ReviewFindings extends Schema.TaggedClass<ReviewFindings>()("ReviewFindings", {
  round: Schema.Int,
  settled: Schema.Boolean,
  issues: Schema.Array(ReviewFinding),
  lane: Schema.optionalKey(Schema.String),
  executor: Schema.optionalKey(Schema.String)
}) {}

/**
 * Display only: a model call's running usage while it is still streaming
 * (a harness that reports usage per model message, such as pi), and `done`
 * when the call's stream ends. The call's final `TokensUsed` is what costs,
 * ledgers and budgets count; the trace does not record progress.
 */
export class UsageProgress extends Schema.TaggedClass<UsageProgress>()("UsageProgress", {
  /** One streaming call: progress of the same call replaces, never adds. */
  call: Schema.String,
  usage: Schema.optionalKey(TokenUsage),
  done: Schema.optionalKey(Schema.Boolean),
  lane: Schema.optionalKey(Schema.String),
  executor: Schema.optionalKey(Schema.String)
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

/** A blackboard ruleset ran (ADR 0020): its board, trace and failures, for the trace file. */
export class BlackboardRun extends Schema.TaggedClass<BlackboardRun>()("BlackboardRun", {
  ruleset: Schema.String,
  result: RunResult
}) {}

/**
 * How long something took (ADR 0023), published when it ends: a model call,
 * a coder's tool, a gate command, git or a merge, a wait, a process start.
 * `llm4ts profile` and the agent tree add these up; nothing else depends on
 * them, and none carries content — only names, numbers and an exit code.
 */
export const TimedKind = Schema.Literals(["model", "tool", "gate", "git", "merge", "wait", "spawn"])
export type TimedKind = typeof TimedKind.Type

export class Timed extends Schema.TaggedClass<Timed>()("Timed", {
  kind: TimedKind,
  /** What was timed: the seat's role, the tool, the gate command as configured, the wait. */
  label: Schema.String,
  ms: Schema.Number,
  /** A model call: when its first output came. */
  firstMs: Schema.optionalKey(Schema.Number),
  /** As the backend itself reported them (Gemini's stats): model API time and tool time. */
  apiMs: Schema.optionalKey(Schema.Number),
  toolMs: Schema.optionalKey(Schema.Number),
  exitCode: Schema.optionalKey(Schema.Int),
  /** It ended in a failure (the time was still spent). */
  failed: Schema.optionalKey(Schema.Boolean),
  lane: Schema.optionalKey(Schema.String),
  executor: Schema.optionalKey(Schema.String)
}) {}

/** One rubric dimension of a story verdict: its score out of `max`. */
export const JudgedDimension = Schema.Struct({
  id: Schema.String,
  score: Schema.Number,
  max: Schema.Number
})
export type JudgedDimension = typeof JudgedDimension.Type

/** The story judge ruled on a story's branch (ADR 0022): one event per judge round. */
export class StoryJudged extends Schema.TaggedClass<StoryJudged>()("StoryJudged", {
  lane: Schema.String,
  round: Schema.Int,
  cleared: Schema.Boolean,
  /** Issues the coder gets back when it is not cleared. */
  issues: Schema.Int,
  /** The rubric's scores, when the judge reports them. */
  dimensions: Schema.Array(JudgedDimension)
}) {}

/**
 * The executor roster's events (ADR 0019, 0022). `label` names who holds the
 * lease — a story's id, or "the run" — so a view can put an executor on its lane.
 */
export class ExecutorLeased extends Schema.TaggedClass<ExecutorLeased>()("ExecutorLeased", {
  executor: Schema.String,
  role: Schema.String,
  label: Schema.optionalKey(Schema.String),
  /** Took the role on its own context's coder slot: nobody independent could. */
  borrowed: Schema.optionalKey(Schema.Boolean)
}) {}

export class ExecutorReleased extends Schema.TaggedClass<ExecutorReleased>()("ExecutorReleased", {
  executor: Schema.String,
  role: Schema.String,
  label: Schema.optionalKey(Schema.String)
}) {}

export class ExecutorExcluded extends Schema.TaggedClass<ExecutorExcluded>()("ExecutorExcluded", {
  executor: Schema.String,
  /** How long and why, as the roster describes it ("for this run: not logged in"). */
  reason: Schema.String
}) {}

export class ExecutorResumed extends Schema.TaggedClass<ExecutorResumed>()("ExecutorResumed", {
  executor: Schema.String,
  /** `expired`: its exclusion ran out; `health`: its engine answers again; `resumed`: by hand. */
  why: Schema.Literals(["expired", "health", "resumed"])
}) {}

export class ExecutorHandedOver extends Schema.TaggedClass<ExecutorHandedOver>()(
  "ExecutorHandedOver",
  {
    from: Schema.String,
    role: Schema.String,
    label: Schema.optionalKey(Schema.String),
    reason: Schema.String,
    /** `call`: one call moves to another executor; `coder`: a context's coder changes hands. */
    scope: Schema.Literals(["call", "coder"])
  }
) {}

export type RosterEvent =
  | ExecutorLeased
  | ExecutorReleased
  | ExecutorExcluded
  | ExecutorResumed
  | ExecutorHandedOver

const resumedWords: Readonly<Record<ExecutorResumed["why"], string>> = {
  expired: "back in the round",
  health: "answers its health check again; back in the round",
  resumed: "resumed"
}

/**
 * The line the classic terminal shows for a roster event — the same words
 * the roster used to publish as `Info` — or `undefined` for one it does not
 * show (a release) and for any other event.
 */
export const rosterEventMessage = (event: FlowEvent): string | undefined => {
  const forLabel = (label: string | undefined): string =>
    label === undefined ? "" : ` for ${label}`
  switch (event._tag) {
    case "ExecutorLeased":
      return event.borrowed === true
        ? `roster: ${event.executor} takes ${event.role}${forLabel(event.label)} on its own coder's slot — not independent (no other executor can take ${event.role})`
        : `roster: ${event.executor} takes ${event.role}${forLabel(event.label)}`
    case "ExecutorExcluded":
      return `roster: ${event.executor} out of the round ${event.reason}`
    case "ExecutorResumed":
      return `roster: ${event.executor} ${resumedWords[event.why]}`
    case "ExecutorHandedOver":
      return event.scope === "coder"
        ? `roster: ${event.label ?? "the run"}: handing the coder over from ${event.from} (${event.reason})`
        : `roster: ${event.role}${forLabel(event.label)} moves off ${event.from} (${event.reason})`
    default:
      return undefined
  }
}

export const FlowEvent = Schema.Union([
  JudgmentObserved,
  BlackboardRun,
  StageStarted,
  StageCompleted,
  StageFailed,
  Aborted,
  Info,
  ToolUse,
  AssistantMessage,
  TokensUsed,
  UsageProgress,
  ReviewFindings,
  CapabilityUsedEvent,
  CapabilityDeniedEvent,
  CapabilityUnenforceable,
  Declassified,
  ExecutorLeased,
  ExecutorReleased,
  ExecutorExcluded,
  ExecutorResumed,
  ExecutorHandedOver,
  StoryJudged,
  Timed
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

/** A concurrent unit of work whose events should say so (a story, ADR 0013/0019). */
export interface Lane {
  /** Stable key: the story id. */
  readonly lane: string
  /** The executor working it now; read at every publish, so a handover shows. */
  readonly executor?: Effect.Effect<string | undefined>
  /** The lane's working directory, dropped from tool arguments (the lane already names it). */
  readonly workDir?: string
}

/** Tool arguments without the lane's own directory: `cd <dir> && x` → `x`, `<dir>/src/a` → `src/a`. */
export const shortenLaneArgs = (args: string, workDir: string | undefined): string => {
  if (workDir === undefined || workDir.length === 0) {
    return args
  }
  const root = workDir.replace(/\/+$/, "")
  return args.split(`cd ${root} && `).join("").split(`${root}/`).join("")
}

const stamped = (
  event: FlowEvent,
  lane: string,
  executor: string | undefined,
  workDir: string | undefined
): FlowEvent => {
  const tags = { lane, ...(executor === undefined ? {} : { executor }) }
  switch (event._tag) {
    case "StageStarted":
      return event.lane !== undefined ? event : StageStarted.make({ stage: event.stage, ...tags })
    case "StageCompleted":
      return event.lane !== undefined ? event : StageCompleted.make({ stage: event.stage, ...tags })
    case "StageFailed":
      return event.lane !== undefined
        ? event
        : StageFailed.make({ stage: event.stage, message: event.message, ...tags })
    case "Info":
      return event.lane !== undefined ? event : Info.make({ message: event.message, ...tags })
    case "ToolUse":
      return event.lane !== undefined
        ? event
        : ToolUse.make({
            tool: event.tool,
            args: shortenLaneArgs(event.args, workDir),
            ...tags
          })
    case "AssistantMessage":
      return event.lane !== undefined ? event : AssistantMessage.make({ text: event.text, ...tags })
    case "ReviewFindings":
      return event.lane !== undefined
        ? event
        : ReviewFindings.make({
            round: event.round,
            settled: event.settled,
            issues: event.issues,
            ...tags
          })
    case "UsageProgress":
      return event.lane !== undefined
        ? event
        : UsageProgress.make({
            call: event.call,
            ...(event.usage === undefined ? {} : { usage: event.usage }),
            ...(event.done === undefined ? {} : { done: event.done }),
            ...tags
          })
    case "TokensUsed":
      return event.lane !== undefined
        ? event
        : TokensUsed.make({
            agent: event.agent,
            usage: event.usage,
            ...(event.model === undefined ? {} : { model: event.model }),
            ...tags
          })
    case "Timed":
      return event.lane !== undefined ? event : Timed.make({ ...event, ...tags })
    default:
      return event
  }
}

/**
 * The same events, stamped with a lane: every stage, message, tool call and
 * token report says which story it belongs to and which executor works it.
 * An event already stamped (a nested context) keeps its own lane.
 */
export const withLane = (events: FlowEventsShape, lane: Lane): FlowEventsShape => ({
  publish: (event) =>
    Effect.flatMap(lane.executor ?? Effect.succeed(undefined), (executor) =>
      events.publish(stamped(event, lane.lane, executor, lane.workDir))
    )
})

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
