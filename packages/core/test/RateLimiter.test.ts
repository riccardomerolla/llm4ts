import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import { TestClock } from "effect/testing"
import { LlmConfig } from "@llm4ts/core/Models"
import {
  RateLimiterConfig,
  makeRateLimiter,
  rateLimiterConfigFromLlmConfig
} from "@llm4ts/core/RateLimiter"

describe("RateLimiter", () => {
  it("derives limiter configuration from the LLM configuration", () => {
    const llm = LlmConfig.make({
      provider: "OpenAI",
      model: "gpt-5",
      requestsPerMinute: 120,
      burstSize: 4,
      acquireTimeout: Duration.seconds(2)
    })
    const limiter = rateLimiterConfigFromLlmConfig(llm)

    assert.strictEqual(limiter.requestsPerMinute, 120)
    assert.strictEqual(limiter.burstSize, 4)
    assert.strictEqual(Duration.toMillis(limiter.acquireTimeout), 2_000)
  })

  it.effect("tryAcquire respects burst size and records metrics", () =>
    Effect.gen(function* () {
      const limiter = yield* makeRateLimiter(
        RateLimiterConfig.make({
          requestsPerMinute: 60,
          burstSize: 2,
          acquireTimeout: Duration.seconds(2)
        })
      )

      const first = yield* limiter.tryAcquire
      const second = yield* limiter.tryAcquire
      const third = yield* limiter.tryAcquire
      const metrics = yield* limiter.metrics

      assert.isTrue(first)
      assert.isTrue(second)
      assert.isFalse(third)
      assert.strictEqual(metrics.totalRequests, 3)
      assert.strictEqual(metrics.throttledRequests, 1)
      assert.strictEqual(metrics.currentTokens, 0)
    })
  )

  it.effect("acquire waits until a token is refilled", () =>
    Effect.gen(function* () {
      const limiter = yield* makeRateLimiter(
        RateLimiterConfig.make({
          requestsPerMinute: 60,
          burstSize: 1,
          acquireTimeout: Duration.seconds(5)
        })
      )

      yield* limiter.acquire
      const completed = yield* Ref.make(false)
      const fiber = yield* Effect.forkChild(
        limiter.acquire.pipe(Effect.tap(() => Ref.set(completed, true)))
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("900 millis")
      const beforeRefill = yield* Ref.get(completed)
      yield* TestClock.adjust("200 millis")
      yield* Fiber.join(fiber)

      assert.isFalse(beforeRefill)
    })
  )

  it.effect("acquire fails with a typed timeout when refill is too slow", () =>
    Effect.gen(function* () {
      const limiter = yield* makeRateLimiter(
        RateLimiterConfig.make({
          requestsPerMinute: 60,
          burstSize: 1,
          acquireTimeout: Duration.millis(500)
        })
      )

      yield* limiter.acquire
      const fiber = yield* Effect.forkChild(Effect.result(limiter.acquire))
      yield* Effect.yieldNow
      yield* TestClock.adjust("600 millis")
      const result = yield* Fiber.join(fiber)

      assert.strictEqual(result._tag, "Failure")
      if (result._tag === "Failure") {
        assert.strictEqual(result.failure._tag, "AcquireTimeout")
      }
    })
  )

  it.effect("metrics count one throttled request while acquire is waiting", () =>
    Effect.gen(function* () {
      const limiter = yield* makeRateLimiter(
        RateLimiterConfig.make({
          requestsPerMinute: 60,
          burstSize: 1,
          acquireTimeout: Duration.seconds(5)
        })
      )

      yield* limiter.acquire
      const fiber = yield* Effect.forkChild(limiter.acquire)
      yield* Effect.yieldNow
      yield* TestClock.adjust("1 milli")
      const metrics = yield* limiter.metrics
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(fiber)

      assert.strictEqual(metrics.totalRequests, 2)
      assert.strictEqual(metrics.throttledRequests, 1)
    })
  )

  it.effect("invalid configuration fails acquire and makes tryAcquire return false", () =>
    Effect.gen(function* () {
      const limiter = yield* makeRateLimiter(
        RateLimiterConfig.make({
          requestsPerMinute: 0,
          burstSize: 1,
          acquireTimeout: Duration.seconds(1)
        })
      )

      const acquire = yield* Effect.result(limiter.acquire)
      const opportunistic = yield* limiter.tryAcquire
      const metrics = yield* limiter.metrics

      assert.strictEqual(acquire._tag, "Failure")
      if (acquire._tag === "Failure") {
        assert.strictEqual(acquire.failure._tag, "InvalidConfig")
      }
      assert.isFalse(opportunistic)
      assert.strictEqual(metrics.totalRequests, 0)
    })
  )
})
