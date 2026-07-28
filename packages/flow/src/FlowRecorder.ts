import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type { StreamRecorder } from "@llm4ts/core/observability/StreamRecorder"
import type { JsonValue } from "@llm4ts/core/providers/CliSupport"
import type { FlowEvent, FlowEventHub } from "./FlowEvents.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"

export class TraceLine extends Schema.Class<TraceLine>("TraceLine")({
  schemaVersion: Schema.optionalKey(Schema.Int),
  seq: Schema.Int,
  timestamp: Schema.Number,
  runId: Schema.String,
  kind: Schema.String,
  fields: Schema.Record(Schema.String, Schema.Json)
}) {}

export interface FlowRecorderShape extends StreamRecorder {
  readonly runId: string
  readonly tracePath: string
  readonly record: (event: FlowEvent) => Effect.Effect<void>
  readonly consume: (hub: FlowEventHub) => Effect.Effect<void, never, Scope.Scope>
  readonly awaitDrained: (hub: FlowEventHub) => Effect.Effect<void>
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
  const degraded = yield* Ref.make(false)

  const append = (kind: string, fields: Readonly<Record<string, JsonValue>>): Effect.Effect<void> =>
    lock.withPermit(
      Effect.gen(function* () {
        if (yield* Ref.get(degraded)) {
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
          .pipe(Effect.catch(() => Ref.set(degraded, true)))
      })
    )

  const record = (event: FlowEvent): Effect.Effect<void> =>
    append(event._tag, { event: JSON.stringify(event) })

  const recorder: FlowRecorderShape = {
    runId,
    tracePath,
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
            record(event).pipe(Effect.andThen(Ref.update(consumed, (count) => count + 1)))
          ),
          Effect.forkScoped,
          Effect.asVoid
        )
      }),
    awaitDrained: (hub) =>
      Effect.gen(function* () {
        const target = yield* hub.publishedCount
        const drain: Effect.Effect<void> = Effect.suspend(() =>
          Ref.get(consumed).pipe(
            Effect.flatMap((count) =>
              count >= target ? Effect.void : Effect.yieldNow.pipe(Effect.andThen(drain))
            )
          )
        )
        yield* drain
      })
  }
  return recorder
})
