import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { JudgmentObserved, type FlowEvent, type FlowEventHub } from "./FlowEvents.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"

export class JudgmentObservation extends Schema.Class<JudgmentObservation>("JudgmentObservation")({
  runId: Schema.String,
  /** Epoch milliseconds, matching FlowRecorder's timestamp. */
  at: Schema.Number,
  consumer: JudgmentObserved.fields.consumer,
  key: JudgmentObserved.fields.key,
  state: JudgmentObserved.fields.state,
  question: JudgmentObserved.fields.question,
  answer: JudgmentObserved.fields.answer,
  outcome: JudgmentObserved.fields.outcome,
  decision: JudgmentObserved.fields.decision,
  mode: JudgmentObserved.fields.mode,
  judgmentIdentity: JudgmentObserved.fields.judgmentIdentity
}) {}

export const judgmentLogPath = (root: string, consumer: JudgmentObservation["consumer"]): string =>
  `${root.replace(/[\\/]+$/, "")}/.llm4ts/judgments/${consumer}.jsonl`

export interface JudgmentLogShape {
  readonly record: (event: FlowEvent) => Effect.Effect<void>
  readonly consume: (hub: FlowEventHub) => Effect.Effect<void, never, Scope.Scope>
  readonly awaitDrained: (hub: FlowEventHub) => Effect.Effect<void>
}

const codec = Schema.fromJsonString(JudgmentObservation)

/** A best-effort subscriber, with the same permanent degradation policy as FlowRecorder. */
export const makeJudgmentLog = Effect.fn("@llm4ts/flow/JudgmentLog.make")(function* (options: {
  readonly files: PlainFileStoreShape
  readonly root: string
  readonly runId: string
}): Effect.fn.Return<JudgmentLogShape> {
  const consumed = yield* Ref.make(0)
  const degraded = yield* Ref.make(false)
  const lock = yield* Semaphore.make(1)
  const record = (event: FlowEvent): Effect.Effect<void> =>
    event._tag !== "JudgmentObserved"
      ? Effect.void
      : lock.withPermit(
          Effect.gen(function* () {
            if (yield* Ref.get(degraded)) return
            const at = yield* Clock.currentTimeMillis
            // Classified remains sealed until an explicit, audited declassify.
            // Text uses its toString; JSON uses its toJSON. Serialize before
            // schema traversal so even nested sealed values use that redaction,
            // never their private payload. Already declassified plain text has
            // no taint metadata; callers must retain the wrapper for secrets.
            const observation = yield* Schema.decodeUnknownEffect(codec)(
              JSON.stringify({ ...event, runId: options.runId, at })
            )
            const line = yield* Schema.encodeEffect(codec)(observation)
            yield* options.files.append(judgmentLogPath(options.root, event.consumer), `${line}\n`)
          }).pipe(Effect.catch(() => Ref.set(degraded, true)))
        )

  const awaitDrained = (hub: FlowEventHub): Effect.Effect<void> =>
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

  return {
    record,
    awaitDrained,
    consume: (hub) =>
      Effect.gen(function* () {
        yield* Ref.set(consumed, yield* hub.publishedCount)
        const subscription = yield* hub.subscribe
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((event) =>
            record(event).pipe(Effect.andThen(Ref.update(consumed, (count) => count + 1)))
          ),
          Effect.forkScoped
        )
        // Registered after the consumer fiber: drain before scope interrupts it.
        yield* Effect.addFinalizer(() => awaitDrained(hub))
      })
  }
})
