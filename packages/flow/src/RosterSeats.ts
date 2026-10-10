// Seats over the executor roster (ADR 0019). A flow keeps calling an
// `LlmServiceShape`; behind it, a reasoning seat leases an executor for each
// call, and a coder seat holds one executor for its context and hands over
// to the next when that one is taken out of the round. The runner supplies
// `seatFor`, which turns an executor into a connector rooted in a directory.
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import { ConfigError, type LlmError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { Message, type ConnectorCapabilities, type LlmChunk } from "@llm4ts/core/Models"
import { describeFlowError, type FlowError } from "./FlowError.ts"
import { ExecutorHandedOver, type FlowEventsShape } from "./FlowEvents.ts"
import { callPurpose } from "./Timing.ts"
import {
  describeExclusion,
  hasRole,
  type ExecutorSpec,
  type Lease,
  type Role,
  type RosterShape
} from "./Roster.ts"

/** An executor's connector, as the runner resolved it for a role and a directory. */
export type RosterSeat = LlmServiceShape & { readonly capabilities: ConnectorCapabilities }

export interface SeatSource {
  readonly seatFor: (
    executor: ExecutorSpec,
    role: Role,
    workDir: string
  ) => Effect.Effect<RosterSeat, FlowError>
}

/** What a flow context knows about the roster behind its seats. */
export interface RosterView {
  /** A seat for `role`, leased per call (independent of this context's coder where possible). */
  readonly forRole: (role: Role) => LlmServiceShape
  /** Free slots for `role` right now. */
  readonly available: (role: Role) => Effect.Effect<number>
  /** Configured slots for `role`. */
  readonly slots: (role: Role) => number
  /** Slots for `role` on the executors in the round, held or not. */
  readonly capacity: (role: Role) => Effect.Effect<number>
  /** Waits until `capacity(role)` is no longer `from`; returns the new value. */
  readonly capacityChanged: (role: Role, from: number) => Effect.Effect<number>
  /** The executor holding this context's coder, once leased. */
  readonly executor: Effect.Effect<string | undefined>
  /** Every executor that held this context's coder, in order (handovers). */
  readonly history: Effect.Effect<ReadonlyArray<string>>
  /** The autonomy contract profile an executor's roster entry asks for (ADR 0027), when it does. */
  readonly contractOf?: (executor: string) => "full" | "minimal" | "off" | undefined
}

/** A roster failure seen through an `LlmServiceShape`, whose failures are `LlmError`s. */
const asLlmError = (error: FlowError): LlmError =>
  ConfigError.make({ message: describeFlowError(error) })

/** Shared plumbing: every service method as "run this on some seat". */
interface SeatRunner {
  readonly run: <A, R>(
    use: (seat: RosterSeat, note: string | undefined) => Effect.Effect<A, LlmError, R>
  ) => Effect.Effect<A, LlmError, R>
  readonly stream: (
    use: (seat: RosterSeat, note: string | undefined) => Stream.Stream<LlmChunk, LlmError>
  ) => Stream.Stream<LlmChunk, LlmError>
  readonly isAvailable: Effect.Effect<boolean>
}

const withNote = (note: string | undefined, prompt: string): string =>
  note === undefined ? prompt : `${note}\n\n${prompt}`

const withNoteOnLast = (
  note: string | undefined,
  messages: ReadonlyArray<Message>
): ReadonlyArray<Message> => {
  const last = messages.at(-1)
  if (note === undefined || last === undefined) {
    return messages
  }
  return [
    ...messages.slice(0, -1),
    Message.make({ ...last, content: withNote(note, last.content) })
  ]
}

const serviceOver = (runner: SeatRunner): LlmServiceShape => ({
  executeStream: (prompt) =>
    runner.stream((seat, note) => seat.executeStream(withNote(note, prompt))),
  executeStreamWithHistory: (messages) =>
    runner.stream((seat, note) => seat.executeStreamWithHistory(withNoteOnLast(note, messages))),
  executeWithTools: (prompt, tools) =>
    runner.run((seat, note) => seat.executeWithTools(withNote(note, prompt), tools)),
  executeStructured: (prompt, schema, jsonSchema) =>
    runner.run((seat, note) => seat.executeStructured(withNote(note, prompt), schema, jsonSchema)),
  executeStructuredWithUsage: (prompt, schema, jsonSchema) =>
    runner.run((seat, note) =>
      seat.executeStructuredWithUsage(withNote(note, prompt), schema, jsonSchema)
    ),
  scoreLabels: (prompt, labels) => runner.run((seat) => seat.scoreLabels(prompt, labels)),
  isAvailable: runner.isAvailable
})

// ---- Per-call seats ----------------------------------------------------------------

export interface RosterSeatOptions {
  readonly events: FlowEventsShape
  /** Executors this seat must not use: the context's coder, for independence. */
  readonly avoid?: Effect.Effect<ReadonlyArray<string>>
  /**
   * The context's coder executor, taken when independence cannot be had —
   * nobody outside `avoid` can ever serve the role, every executor that
   * could is held by a coder, or out of the round — on a free slot of its
   * own, or without one (`LeaseOptions.borrow`).
   */
  readonly borrow?: Effect.Effect<ExecutorSpec | undefined>
  /** Who is asking, for the events. */
  readonly label?: string
}

/**
 * A seat for `role` that leases an executor for each call and releases it
 * when the call (or its stream) ends. A failure is reported to the roster,
 * which excludes the executor when the failure says it is out of quota or
 * down; the call itself still fails — a per-call seat has nothing to hand
 * over, and the retry layer below has already had its turn.
 */
export const rosterSeat = (
  roster: RosterShape,
  source: SeatSource,
  role: Role,
  workDir: string,
  options: RosterSeatOptions
): LlmServiceShape => {
  const acquire = (
    alsoAvoid: ReadonlyArray<string>
  ): Effect.Effect<ExecutorSpec, LlmError, Scope.Scope> =>
    Effect.gen(function* () {
      const avoid = [...(options.avoid === undefined ? [] : yield* options.avoid), ...alsoAvoid]
      // The roster decides who serves: an independent executor, or, when
      // none can ever serve or every one is held by a coder, the context's own.
      const borrow = options.borrow === undefined ? undefined : yield* options.borrow
      const purpose = yield* callPurpose
      const lease = yield* roster
        .lease(role, {
          avoid,
          ...(options.label === undefined ? {} : { label: options.label }),
          ...(purpose === undefined ? {} : { purpose }),
          ...(borrow === undefined ? {} : { borrow })
        })
        .pipe(Effect.mapError(asLlmError))
      return lease.executor
    })

  const seatOf = (executor: ExecutorSpec): Effect.Effect<RosterSeat, LlmError> =>
    source.seatFor(executor, role, workDir).pipe(Effect.mapError(asLlmError))

  /**
   * After a failure that took `executor` out of the round, whether another
   * executor can still take the call — an independent one, or the context's
   * own: the call moves once, never twice — a second failure is the call's
   * own, not the executor's.
   */
  const retryElsewhere = (
    executor: ExecutorSpec,
    error: LlmError,
    tried: ReadonlyArray<string>
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const exclusion = yield* roster.report(executor.id, error)
      if (exclusion === undefined || tried.length > 0) {
        return false
      }
      const avoid = options.avoid === undefined ? [] : yield* options.avoid
      const borrow = options.borrow === undefined ? undefined : yield* options.borrow
      const own = borrow !== undefined && borrow.id !== executor.id && hasRole(borrow, role)
      const other = own || (yield* roster.canEverServe(role, [...avoid, executor.id]))
      if (other) {
        yield* options.events.publish(
          ExecutorHandedOver.make({
            from: executor.id,
            role,
            ...(options.label === undefined ? {} : { label: options.label }),
            reason: describeExclusion(exclusion),
            scope: "call"
          })
        )
      }
      return other
    })

  const runOn = <A, R>(
    use: (seat: RosterSeat, note: string | undefined) => Effect.Effect<A, LlmError, R>,
    tried: ReadonlyArray<string>
  ): Effect.Effect<A, LlmError, R> =>
    // The slot is held for the call and released before any retry.
    Effect.scoped(
      Effect.gen(function* () {
        const executor = yield* acquire(tried)
        const seat = yield* seatOf(executor)
        const outcome = yield* Effect.result(use(seat, undefined))
        return { executor, outcome }
      })
    ).pipe(
      Effect.flatMap(({ executor, outcome }) =>
        outcome._tag === "Success"
          ? Effect.succeed(outcome.success)
          : Effect.flatMap(retryElsewhere(executor, outcome.failure, tried), (again) =>
              again ? runOn(use, [...tried, executor.id]) : Effect.fail(outcome.failure)
            )
      )
    )

  const streamOn = (
    use: (seat: RosterSeat, note: string | undefined) => Stream.Stream<LlmChunk, LlmError>,
    tried: ReadonlyArray<string>
  ): Stream.Stream<LlmChunk, LlmError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const executor = yield* acquire(tried)
        const seat = yield* seatOf(executor)
        return use(seat, undefined).pipe(
          Stream.catchIf(
            () => true,
            (error) =>
              Stream.unwrap(
                Effect.map(retryElsewhere(executor, error, tried), (again) =>
                  again ? streamOn(use, [...tried, executor.id]) : Stream.fail(error)
                )
              )
          )
        )
      })
    )

  return serviceOver({
    run: (use) => runOn(use, []),
    stream: (use) => streamOn(use, []),
    isAvailable: roster.canEverServe(role)
  })
}

// ---- The held coder ------------------------------------------------------------------

export interface HeldCoderOptions {
  readonly events: FlowEventsShape
  /** Lease now (a story waiting for capacity), or on the first call (a flow's root coder). */
  readonly eager: boolean
  /** The executor this context held before, taken first while free. */
  readonly prefer?: string
  /** Handovers before a failure surfaces. Default 2. */
  readonly maxHandovers?: number
  readonly label?: string
}

export interface HeldCoder {
  readonly service: LlmServiceShape
  readonly executor: Effect.Effect<string | undefined>
  /** The held coder's clone number, when it holds a slot (ADR 0033). */
  readonly clone: Effect.Effect<number | undefined>
  readonly lease: Effect.Effect<ExecutorSpec | undefined>
  readonly history: Effect.Effect<ReadonlyArray<string>>
}

export const takeoverNote = (from: string, reason: string): string =>
  [
    `(You are taking over this work from another coding agent ('${from}'), which had to stop:`,
    `${reason}. Its changes so far are in the working tree: inspect them (git status, git diff)`,
    "before continuing, and carry on from there.)"
  ].join(" ")

interface Held {
  readonly lease: Lease
  readonly seat: RosterSeat
}

/**
 * The coder of one context (a story, or a flow's root): one executor held
 * for the context's lifetime. When a call fails in a way that takes that
 * executor out of the round (a usage limit, a dead serving engine), the
 * lease is released, the next coder leased, and the call repeated there
 * with a takeover note — the chat history the flow replays, the task
 * checkpoint and the working tree carry the work across.
 */
export const makeHeldCoder = Effect.fn("@llm4ts/flow/RosterSeats.heldCoder")(function* (
  roster: RosterShape,
  source: SeatSource,
  workDir: string,
  options: HeldCoderOptions
): Effect.fn.Return<HeldCoder, FlowError, Scope.Scope> {
  const scope = yield* Effect.scope
  const current = yield* Ref.make<Held | undefined>(undefined)
  const history = yield* Ref.make<ReadonlyArray<string>>([])
  const handovers = yield* Ref.make(0)
  const prefer = yield* Ref.make(options.prefer)
  const gate = yield* Semaphore.make(1)
  const maxHandovers = options.maxHandovers ?? 2

  const acquire: Effect.Effect<Held, FlowError> = gate.withPermit(
    Effect.gen(function* () {
      const held = yield* Ref.get(current)
      if (held !== undefined) {
        return held
      }
      const preferred = yield* Ref.get(prefer)
      const lease = yield* roster
        .lease("coder", {
          ...(preferred === undefined ? {} : { prefer: preferred }),
          ...(options.label === undefined ? {} : { label: options.label })
        })
        .pipe(Scope.provide(scope))
      const seat = yield* source.seatFor(lease.executor, "coder", workDir)
      const next = { lease, seat }
      yield* Ref.set(current, next)
      yield* Ref.update(history, (ids) =>
        ids.at(-1) === lease.executor.id ? ids : [...ids, lease.executor.id]
      )
      return next
    })
  )

  if (options.eager) {
    yield* acquire
  }

  /** Decides whether a failure hands over; returns the takeover note, or fails with the error. */
  const handover = (held: Held, error: LlmError): Effect.Effect<string, LlmError> =>
    Effect.gen(function* () {
      const exclusion = yield* roster.report(held.lease.executor.id, error)
      if (exclusion === undefined || (yield* Ref.get(handovers)) >= maxHandovers) {
        return yield* Effect.fail(error)
      }
      yield* Ref.update(handovers, (count) => count + 1)
      yield* Ref.set(prefer, undefined)
      yield* held.lease.release
      yield* Ref.set(current, undefined)
      yield* options.events.publish(
        ExecutorHandedOver.make({
          from: held.lease.executor.id,
          role: "coder",
          label: options.label ?? workDir,
          reason: describeExclusion(exclusion),
          scope: "coder"
        })
      )
      return takeoverNote(held.lease.executor.id, exclusion.reason)
    })

  const run = <A, R>(
    use: (seat: RosterSeat, note: string | undefined) => Effect.Effect<A, LlmError, R>,
    note?: string
  ): Effect.Effect<A, LlmError, R> =>
    Effect.gen(function* () {
      const held = yield* acquire.pipe(Effect.mapError(asLlmError))
      return yield* use(held.seat, note).pipe(
        Effect.catch((error) => Effect.flatMap(handover(held, error), (next) => run(use, next)))
      )
    })

  const stream = (
    use: (seat: RosterSeat, note: string | undefined) => Stream.Stream<LlmChunk, LlmError>,
    note?: string
  ): Stream.Stream<LlmChunk, LlmError> =>
    Stream.unwrap(
      Effect.map(acquire.pipe(Effect.mapError(asLlmError)), (held) =>
        use(held.seat, note).pipe(
          Stream.catchIf(
            () => true,
            (error) => Stream.unwrap(Effect.map(handover(held, error), (next) => stream(use, next)))
          )
        )
      )
    )

  return {
    service: serviceOver({ run, stream, isAvailable: roster.canEverServe("coder") }),
    executor: Effect.map(Ref.get(current), (held) => held?.lease.executor.id),
    clone: Effect.map(Ref.get(current), (held) => held?.lease.clone),
    lease: Effect.map(Ref.get(current), (held) => held?.lease.executor),
    history: Ref.get(history)
  }
})
