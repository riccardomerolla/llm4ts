import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import { LlmChunk, TokenUsage, type StreamProgress } from "@llm4ts/core/Models"
import { collect, trackProgress, withTimeout } from "@llm4ts/core/Streaming"

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
})
