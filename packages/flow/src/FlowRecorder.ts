import * as Clock from "effect/Clock"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type { StreamRecorder } from "@llm4ts/core/observability/StreamRecorder"
import type { JsonValue } from "@llm4ts/core/providers/CliSupport"
import { awaitConsumed, type FlowEvent, type FlowEventHub } from "./FlowEvents.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"

export class TraceLine extends Schema.Class<TraceLine>("TraceLine")({
  schemaVersion: Schema.optionalKey(Schema.Int),
  seq: Schema.Int,
  timestamp: Schema.Number,
  runId: Schema.String,
  kind: Schema.String,
  fields: Schema.Record(Schema.String, Schema.Json)
}) {}

/** How a run ended, as its trace's last line says (ADR 0022). */
export const RunOutcome = Schema.Literals(["completed", "failed", "interrupted"])
export type RunOutcome = typeof RunOutcome.Type

/** Lines the recorder could not write: the trace is short by this much, from the first failure on. */
export interface TraceShortfall {
  readonly lines: number
  /** The first write failure, as the file store described it. */
  readonly reason: string
}

export interface FlowRecorderShape extends StreamRecorder {
  readonly runId: string
  readonly tracePath: string
  /** What the trace is missing, once a write failed; `undefined` while every line landed. */
  readonly shortfall: Effect.Effect<TraceShortfall | undefined>
  readonly record: (event: FlowEvent) => Effect.Effect<void>
  readonly consume: (hub: FlowEventHub) => Effect.Effect<void, never, Scope.Scope>
  /** Appends the `RunEnded` line: a reader knows the run is over, not stalled. */
  readonly end: (outcome: RunOutcome) => Effect.Effect<void>
  /** Waits for this recorder to catch up; `false` means it gave up first. */
  readonly awaitDrained: (hub: FlowEventHub, timeout?: Duration.Input) => Effect.Effect<boolean>
}

const encode = (line: TraceLine): string =>
  JSON.stringify({
    schemaVersion: line.schemaVersion,
    seq: line.seq,
    timestamp: line.timestamp,
    runId: line.runId,
    kind: line.kind,
    fields: line.fields
  })

export const makeFlowRecorder = Effect.fn("@llm4ts/flow/FlowRecorder.make")(function* (
  files: PlainFileStoreShape,
  tracePath: string,
  runId: string
): Effect.fn.Return<FlowRecorderShape> {
  const sequence = yield* Ref.make(0)
  const consumed = yield* Ref.make(0)
  const lock = yield* Semaphore.make(1)
  // Set by the first failed write and never cleared: a disk that refused one
  // line is not asked again, but every line it then loses is counted, so
  // the run can say how short its trace is (`llm4ts costs` reads the
  // ledger for the rest).
  const degraded = yield* Ref.make<TraceShortfall | undefined>(undefined)

  const append = (kind: string, fields: Readonly<Record<string, JsonValue>>): Effect.Effect<void> =>
    lock.withPermit(
      Effect.gen(function* () {
        const shortfall = yield* Ref.get(degraded)
        if (shortfall !== undefined) {
          yield* Ref.set(degraded, { ...shortfall, lines: shortfall.lines + 1 })
          return
        }
        const seq = yield* Ref.getAndUpdate(sequence, (current) => current + 1)
        const timestamp = yield* Clock.currentTimeMillis
        const line = TraceLine.make({
          schemaVersion: 1,
          seq,
          timestamp,
          runId,
          kind,
          fields
        })
        yield* files
          .append(tracePath, `${encode(line)}\n`)
          .pipe(Effect.catch((error) => Ref.set(degraded, { lines: 1, reason: error.message })))
      })
    )

  const record = (event: FlowEvent): Effect.Effect<void> =>
    append(event._tag, { event: JSON.stringify(event) })

  const recorder: FlowRecorderShape = {
    runId,
    tracePath,
    shortfall: Ref.get(degraded),
    record,
    rawLine: (provider, model, line) =>
      append("RawLine", {
        provider,
        ...(model === undefined ? {} : { model }),
        line
      }),
    streamError: (provider, model, message) =>
      append("StreamError", {
        provider,
        ...(model === undefined ? {} : { model }),
        message
      }),
    consume: (hub) =>
      Effect.gen(function* () {
        const subscription = yield* hub.subscribe
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((event) =>
            // Progress is for the screen; the call's TokensUsed is the record.
            (event._tag === "UsageProgress" ? Effect.void : record(event)).pipe(
              Effect.andThen(Ref.update(consumed, (count) => count + 1))
            )
          ),
          Effect.forkScoped,
          Effect.asVoid
        )
      }),
    end: (outcome) => append("RunEnded", { outcome }),
    awaitDrained: (hub, timeout) => awaitConsumed(hub, consumed, timeout)
  }
  return recorder
})
