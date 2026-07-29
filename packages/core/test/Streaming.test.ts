import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import { TimeoutError } from "@llm4ts/core/Errors"
import { LlmChunk, TokenUsage, type StreamProgress } from "@llm4ts/core/Models"
import {
  cancellable,
  collect,
  fromSSE,
  parallelStream,
  parsePartialJson,
  toSSE,
  trackProgress,
  withHeartbeat,
  withSnapshots,
  withTimeout
} from "@llm4ts/core/Streaming"

describe("Streaming", () => {
  it.effect("collects chunks into a complete response", () =>
    Effect.gen(function* () {
      const usage = TokenUsage.make({ prompt: 10, completion: 5, total: 15 })
      const chunks = Stream.make(
        LlmChunk.make({ delta: "Hello ", metadata: { provider: "test" } }),
        LlmChunk.make({ delta: "world", usage }),
        LlmChunk.make({ delta: "!", finishReason: "stop" })
      )

      const response = yield* collect(chunks)

      assert.strictEqual(response.content, "Hello world!")
      assert.deepStrictEqual(response.usage, usage)
      assert.strictEqual(response.metadata.provider, "test")
    })
  )

  it.effect("collects an empty stream", () =>
    Effect.gen(function* () {
      const response = yield* collect(Stream.empty)

      assert.strictEqual(response.content, "")
      assert.strictEqual(response.usage, undefined)
    })
  )

  it.effect("tracks token count and throughput", () =>
    Effect.gen(function* () {
      const progress = yield* Ref.make<ReadonlyArray<StreamProgress>>([])
      const chunks = Stream.make(
        LlmChunk.make({ delta: "test " }),
        LlmChunk.make({ delta: "message " }),
        LlmChunk.make({ delta: "content" })
      )

      const result = yield* Stream.runCollect(
        trackProgress(chunks, (update) => Ref.update(progress, (updates) => [...updates, update]))
      )
      const updates = yield* Ref.get(progress)

      assert.strictEqual(result.length, 3)
      assert.strictEqual(updates.length, 3)
      assert.isTrue(updates.every((update) => update.tokensProcessed > 0))
    })
  )

  it.effect("passes through streams that complete within the timeout", () =>
    Effect.gen(function* () {
      const result = yield* Stream.runCollect(
        withTimeout(
          Stream.make(LlmChunk.make({ delta: "fast" }), LlmChunk.make({ delta: " response" })),
          "5 seconds"
        )
      )

      assert.strictEqual(result.length, 2)
    })
  )

  it.effect("fails when the next chunk exceeds the timeout", () =>
    Effect.gen(function* () {
      const slow = Stream.make(LlmChunk.make({ delta: "slow" })).pipe(
        Stream.concat(
          Stream.fromEffect(
            Effect.delay(Effect.succeed(LlmChunk.make({ delta: "late" })), "10 seconds")
          )
        )
      )
      const fiber = yield* Effect.forkChild(Stream.runCollect(withTimeout(slow, "100 millis")))

      yield* Effect.yieldNow
      yield* TestClock.adjust("100 millis")
      const exit = yield* Fiber.await(fiber)

      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        assert.match(String(exit.cause), /TimeoutError/)
      }
    })
  )

  it.effect("supports external cancellation", () =>
    Effect.gen(function* () {
      const infinite = Stream.fromEffectRepeat(
        Effect.delay(Effect.succeed(LlmChunk.make({ delta: "chunk" })), "10 millis")
      )
      const [stream, cancel] = yield* cancellable(infinite)
      const fiber = yield* Effect.forkChild(Stream.runCollect(stream))

      yield* Effect.yieldNow
      yield* TestClock.adjust("50 millis")
      yield* cancel
      const exit = yield* Fiber.await(fiber)

      assert.isTrue(Exit.isSuccess(exit))
    })
  )

  it.effect("emits cumulative snapshots", () =>
    Effect.gen(function* () {
      const chunks = Stream.make(
        LlmChunk.make({ delta: "Hello " }),
        LlmChunk.make({ delta: "world " }),
        LlmChunk.make({ delta: "from " }),
        LlmChunk.make({ delta: "streaming" })
      )
      const snapshots = yield* Stream.runCollect(withSnapshots(chunks, "100 millis"))

      assert.isAbove(snapshots.length, 0)
      assert.strictEqual(snapshots.at(-1), "Hello world from streaming")
    })
  )

  it.effect("round-trips chunks through SSE and filters the done marker", () =>
    Effect.gen(function* () {
      const chunks = Stream.make(
        LlmChunk.make({ delta: "Hello", metadata: { provider: "test" } }),
        LlmChunk.make({ delta: " world", finishReason: "stop" })
      )
      const sse = yield* Stream.runCollect(toSSE(chunks))
      const converted = yield* Stream.runCollect(
        fromSSE(Stream.fromIterable([...sse, "data: [DONE]"]))
      )

      assert.strictEqual(sse.length, 2)
      assert.isTrue(sse.every((event) => event.startsWith("data: ")))
      assert.strictEqual(converted.length, 2)
      assert.strictEqual(converted[0]?.delta, "Hello")
      assert.strictEqual(converted[1]?.delta, " world")
    })
  )

  it.effect("classifies malformed SSE payloads as parse failures", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Stream.runCollect(fromSSE(Stream.make("data: not-json"))))

      assert.strictEqual(error._tag, "ParseError")
      if (error._tag === "ParseError") {
        assert.strictEqual(error.raw, "not-json")
      }
    })
  )

  it.effect("processes inputs concurrently while preserving input order", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(
          parallelStream([1, 2, 3, 4, 5], 3, (input) =>
            Stream.fromEffect(
              Effect.delay(
                Effect.succeed(LlmChunk.make({ delta: `item-${input}` })),
                `${6 - input} millis`
              )
            )
          )
        )
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("20 millis")
      const result = yield* Fiber.join(fiber)

      assert.deepStrictEqual(
        result.map((chunk) => chunk.delta),
        ["item-1", "item-2", "item-3", "item-4", "item-5"]
      )
    })
  )

  it.effect("emits a decoded value once streamed JSON becomes complete", () =>
    Effect.gen(function* () {
      const TestData = Schema.Struct({ value: Schema.String })
      const result = yield* Stream.runCollect(
        parsePartialJson(Stream.make('{"val', 'ue":"', 'test"}'), TestData)
      )

      assert.deepStrictEqual(result, [{ value: "test" }])
    })
  )

  it.effect("applies heartbeat timeout semantics per pull", () =>
    Effect.gen(function* () {
      const stalled = Stream.fromEffect(
        Effect.delay(Effect.succeed(LlmChunk.make({ delta: "late" })), "10 seconds")
      )
      const fiber = yield* Effect.forkChild(Stream.runCollect(withHeartbeat(stalled, "100 millis")))

      yield* Effect.yieldNow
      yield* TestClock.adjust("100 millis")
      const error = yield* Effect.flip(Fiber.join(fiber))

      assert.isTrue(error instanceof TimeoutError)
    })
  )
})
