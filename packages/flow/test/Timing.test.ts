import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import { unsupportedScoreLabels } from "@llm4ts/core/LabelScoring"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { LlmChunk } from "@llm4ts/core/Models"
import { collect } from "@llm4ts/core/Streaming"
import { makeCollectingFlowEvents, type FlowEvent } from "@llm4ts/flow/FlowEvents"
import { timedSeat } from "@llm4ts/flow/Timing"

const unused = InvalidRequestError.make({ message: "unused" })

const chunk = (delta: string, metadata: Record<string, string> = {}) =>
  LlmChunk.make({ delta, metadata })

const serviceOf = (overrides: Partial<LlmServiceShape>): LlmServiceShape => ({
  executeStream: (_prompt) => Stream.empty,
  executeStreamWithHistory: (_messages) => Stream.empty,
  executeWithTools: (_prompt, _tools) => Effect.fail(unused),
  executeStructured: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  scoreLabels: unsupportedScoreLabels,
  isAvailable: Effect.succeed(true),
  ...overrides
})

const timings = (recorded: ReadonlyArray<FlowEvent>) =>
  recorded.flatMap((event) => (event._tag === "Timed" ? [event] : []))

describe("timedSeat", () => {
  it.effect("times a streamed call from its start to its end, and to its first output", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const slow = serviceOf({
        executeStream: (_prompt) =>
          Stream.fromEffect(Effect.as(Effect.sleep("3 seconds"), chunk("Hel"))).pipe(
            Stream.concat(
              Stream.fromEffect(
                Effect.as(
                  Effect.sleep("7 seconds"),
                  chunk("lo", { api_ms: "6000", tools_ms: "2500" })
                )
              )
            )
          )
      })
      const seat = timedSeat(slow, events, "coder")
      const fiber = yield* Effect.forkChild(collect(seat.executeStream("hi")))
      yield* TestClock.adjust("10 seconds")
      const reply = yield* Fiber.join(fiber)
      assert.strictEqual(reply.content, "Hello")
      const [timed] = timings(yield* events.recorded)
      assert.deepStrictEqual(
        [timed?.kind, timed?.label, timed?.ms, timed?.firstMs, timed?.apiMs, timed?.toolMs],
        ["model", "coder", 10_000, 3_000, 6_000, 2_500]
      )
    })
  )

  it.effect("times a call that fails too, and every non-streaming method", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const seat = timedSeat(
        serviceOf({
          executeStructured: (_prompt, _schema, _jsonSchema) =>
            Effect.andThen(Effect.sleep("4 seconds"), Effect.fail(unused))
        }),
        events,
        "reviewer"
      )
      const fiber = yield* Effect.forkChild(
        Effect.flip(seat.executeStructured("judge", Schema.String, {}))
      )
      yield* TestClock.adjust("4 seconds")
      assert.strictEqual((yield* Fiber.join(fiber))._tag, "InvalidRequestError")
      const [timed] = timings(yield* events.recorded)
      assert.deepStrictEqual([timed?.label, timed?.ms, timed?.failed], ["reviewer", 4_000, true])
    })
  )
})
