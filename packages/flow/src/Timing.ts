import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import type { JudgmentShape } from "@llm4ts/core/judgment/Judgment"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { LlmChunk } from "@llm4ts/core/Models"
import { Timed, type FlowEventsShape } from "./FlowEvents.ts"

/**
 * Where a run's time goes. `timedSeat` decorates a seat so every
 * call publishes a `Timed{kind:"model"}` when it ends — its wall time, when
 * its first output came, and the API and tool time the backend reported, if
 * it did. The events carry the seat's role, never the prompt or the reply.
 */

/**
 * The role a call is made for, when it is not the seat's own: one seat
 * serves the reviewer, the story judge and the BLOCKED_ON verifier when no
 * roster splits them, and the report should still tell them apart.
 */
const TimedRole = Context.Reference<string | undefined>("@llm4ts/flow/Timing/TimedRole", {
  defaultValue: () => undefined
})

/** Times the seat calls `effect` makes under `role` instead of the seat's own label. */
export const withTimedRole = <A, E, R>(role: string, effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, TimedRole, role)

const reportedMs = (chunk: LlmChunk, key: string): number | undefined => {
  const raw = chunk.metadata[key]
  const value = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** Times `effect`, publishing what `timed` makes of its duration whether it succeeds or fails. */
export const timeEffect = <A, E, R>(
  events: FlowEventsShape,
  effect: Effect.Effect<A, E, R>,
  timed: (ms: number, failed: boolean, role: string | undefined) => Timed
): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.all([Clock.currentTimeMillis, TimedRole]), ([start, role]) =>
    Effect.onExit(effect, (exit) =>
      Effect.flatMap(Clock.currentTimeMillis, (end) =>
        events.publish(timed(end - start, Exit.isFailure(exit), role))
      )
    )
  )

const timedStream = <E>(
  events: FlowEventsShape,
  label: string,
  stream: Stream.Stream<LlmChunk, E>
): Stream.Stream<LlmChunk, E> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis
      const role = yield* TimedRole
      const first = yield* Ref.make<number | undefined>(undefined)
      const reported = yield* Ref.make<{ apiMs?: number; toolMs?: number }>({})
      const failed = yield* Ref.make(false)
      return stream.pipe(
        Stream.tap((chunk) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            yield* Ref.update(first, (at) => at ?? now - start)
            const apiMs = reportedMs(chunk, "api_ms")
            const toolMs = reportedMs(chunk, "tools_ms")
            if (apiMs !== undefined || toolMs !== undefined) {
              yield* Ref.update(reported, (current) => ({
                ...current,
                ...(apiMs === undefined ? {} : { apiMs }),
                ...(toolMs === undefined ? {} : { toolMs })
              }))
            }
          })
        ),
        Stream.tapError(() => Ref.set(failed, true)),
        Stream.ensuring(
          Effect.gen(function* () {
            const end = yield* Clock.currentTimeMillis
            const firstMs = yield* Ref.get(first)
            yield* events.publish(
              Timed.make({
                kind: "model",
                label: role ?? label,
                ms: end - start,
                ...(firstMs === undefined ? {} : { firstMs }),
                ...(yield* Ref.get(reported)),
                ...((yield* Ref.get(failed)) ? { failed: true } : {})
              })
            )
          })
        )
      )
    })
  )

export const timedSeat = (
  service: LlmServiceShape,
  events: FlowEventsShape,
  label: string
): LlmServiceShape => {
  const model = (ms: number, failed: boolean, role: string | undefined): Timed =>
    Timed.make({ kind: "model", label: role ?? label, ms, ...(failed ? { failed: true } : {}) })
  const batched = service.scoreLabelSequence
  return {
    executeStream: (prompt) => timedStream(events, label, service.executeStream(prompt)),
    executeStreamWithHistory: (messages) =>
      timedStream(events, label, service.executeStreamWithHistory(messages)),
    executeWithTools: (prompt, tools) =>
      timeEffect(events, service.executeWithTools(prompt, tools), model),
    executeStructured: (prompt, schema, jsonSchema) =>
      timeEffect(events, service.executeStructured(prompt, schema, jsonSchema), model),
    executeStructuredWithUsage: (prompt, schema, jsonSchema) =>
      timeEffect(events, service.executeStructuredWithUsage(prompt, schema, jsonSchema), model),
    scoreLabels: (prompt, labels) => timeEffect(events, service.scoreLabels(prompt, labels), model),
    ...(batched === undefined
      ? {}
      : {
          scoreLabelSequence: (prompt: string, labelSets: ReadonlyArray<ReadonlyArray<string>>) =>
            timeEffect(events, batched(prompt, labelSets), model)
        }),
    isAvailable: service.isAvailable
  }
}

/** Typed judgments (ADR 0017) timed as `judgment` calls, under the caller's role if it named one. */
export const timedJudgment = (judgment: JudgmentShape, events: FlowEventsShape): JudgmentShape => ({
  ...judgment,
  judge: (input) =>
    timeEffect(events, judgment.judge(input), (ms, failed, role) =>
      Timed.make({
        kind: "model",
        label: role ?? "judgment",
        ms,
        ...(failed ? { failed: true } : {})
      })
    )
})
