import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import {
  ConfigError,
  InvalidRequestError,
  ParseError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  UsageLimitError,
  type LlmError
} from "@llm4ts/core/Errors"
import { LlmService, type LlmServiceShape } from "@llm4ts/core/LlmService"
import { LlmChunk } from "@llm4ts/core/Models"
import { FlowEvents, makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import {
  isContextOverflow,
  isContextOverflowMessage,
  isFlakyStream,
  isTransient,
  makeTransientRetry,
  transientDelay
} from "@llm4ts/flow/TransientRetry"

interface CountingService {
  readonly service: LlmServiceShape
  readonly attempts: Ref.Ref<number>
}

const makeCountingService = (
  failTimes: number,
  failure: LlmError
): Effect.Effect<CountingService> =>
  Effect.map(Ref.make(0), (attempts) => ({
    attempts,
    service: LlmService.of({
      executeStream: (_prompt) =>
        Stream.unwrap(
          Ref.updateAndGet(attempts, (count) => count + 1).pipe(
            Effect.map((count) =>
              count <= failTimes
                ? Stream.fail(failure)
                : Stream.make(LlmChunk.make({ delta: "ok" }))
            )
          )
        ),
      executeStreamWithHistory: (_messages) =>
        Stream.unwrap(
          Ref.updateAndGet(attempts, (count) => count + 1).pipe(
            Effect.map((count) =>
              count <= failTimes
                ? Stream.fail(failure)
                : Stream.make(LlmChunk.make({ delta: "ok" }))
            )
          )
        ),
      executeWithTools: (_prompt, _tools) =>
        Effect.fail(InvalidRequestError.make({ message: "not used" })),
      executeStructured: (_prompt, _schema, _jsonSchema) =>
        Effect.fail(InvalidRequestError.make({ message: "not used" })),
      executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) =>
        Effect.fail(InvalidRequestError.make({ message: "not used" })),
      isAvailable: Effect.succeed(true)
    })
  }))

describe("TransientRetry", () => {
  it("classifies only transient provider failures", () => {
    assert.isTrue(isTransient(TimeoutError.make({ duration: Duration.seconds(1) })))
    assert.isTrue(isTransient(RateLimitError.make({})))
    assert.isTrue(isTransient(ProviderError.make({ message: "connection reset by peer" })))
    assert.isTrue(
      isTransient(
        ProviderError.make({
          message: "Gemini CLI returned an error: [API Error: An unknown error occurred.]"
        })
      )
    )

    assert.isFalse(isTransient(InvalidRequestError.make({ message: "bad" })))
    assert.isFalse(isTransient(ParseError.make({ message: "nope", raw: "raw" })))
    assert.isFalse(isTransient(ConfigError.make({ message: "missing key" })))
    assert.isFalse(
      isTransient(
        UsageLimitError.make({
          provider: "gemini",
          message: "capacity exhausted"
        })
      )
    )
    assert.isFalse(
      isTransient(ProviderError.make({ message: "you asked for a nonexistent model" }))
    )
  })

  it("never retries deterministic 4xx failures, even wrapped as API errors", () => {
    assert.isFalse(
      isTransient(
        ProviderError.make({
          message:
            'Gemini CLI returned an error: [API Error: {"error":{"code": 400,"status":"INVALID_ARGUMENT"}}]'
        })
      )
    )
    assert.isFalse(isTransient(ProviderError.make({ message: "request failed: code=400" })))
    assert.isFalse(
      isTransient(
        ProviderError.make({
          message:
            "[API Error: The input token count exceeds the maximum number of tokens allowed (1048576).]"
        })
      )
    )
  })

  it("classifies context overflow as deterministic, not transient", () => {
    const phrasings = [
      "input exceeds the maximum number of tokens allowed",
      "input token count exceeds the limit",
      "context length exceeded",
      "this model's maximum context length is 200000 tokens",
      "prompt is too long: 250000 tokens",
      "request too large for model"
    ]
    for (const message of phrasings) {
      assert.isTrue(isContextOverflowMessage(message), message)
      assert.isTrue(isContextOverflow(ProviderError.make({ message })), message)
      assert.isFalse(isTransient(ProviderError.make({ message })), message)
    }

    assert.isFalse(isContextOverflowMessage("connection reset by peer"))
    assert.isFalse(isContextOverflow(TimeoutError.make({ duration: Duration.seconds(1) })))
    // Empty responses stay flaky-stream: gemini returns one for a mid-stream flake too,
    // and a fresh process fixes that common case. Context.withShrink handles the rest.
    assert.isFalse(isContextOverflowMessage("Invalid stream: empty response"))
  })

  it("keeps flaky stream failures on an independent retry budget", () => {
    const flaky = ProviderError.make({
      message: "Gemini CLI stream error: Invalid stream: empty response"
    })

    assert.isTrue(isFlakyStream(flaky))
    assert.isFalse(isTransient(flaky))
    assert.isFalse(isFlakyStream(ProviderError.make({ message: "connection reset by peer" })))
    assert.isFalse(isFlakyStream(ParseError.make({ message: "wrong shape", raw: '{"a":1}' })))
  })

  it("honors bounded provider retry-after durations", () => {
    assert.strictEqual(
      Duration.toMillis(
        transientDelay(
          RateLimitError.make({ retryAfter: Duration.seconds(45) }),
          Duration.seconds(1)
        )
      ),
      45_000
    )
    assert.strictEqual(
      Duration.toMillis(
        transientDelay(
          RateLimitError.make({ retryAfter: Duration.seconds(1) }),
          Duration.seconds(4)
        )
      ),
      4_000
    )
    assert.strictEqual(
      Duration.toMillis(
        transientDelay(RateLimitError.make({ retryAfter: Duration.hours(21) }), Duration.seconds(1))
      ),
      120_000
    )
  })

  it.effect("retries transient stream failures and publishes each retry", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const counted = yield* makeCountingService(
        2,
        ProviderError.make({ message: "connection reset" })
      )
      const retrying = yield* makeTransientRetry(counted.service, {
        maxRetries: 2,
        baseDelay: Duration.zero
      }).pipe(Effect.provideService(FlowEvents, events))

      const result = yield* Stream.runCollect(retrying.executeStream("hello"))
      const attempts = yield* Ref.get(counted.attempts)
      const recorded = yield* events.recorded

      assert.deepStrictEqual(
        result.map((chunk) => chunk.delta),
        ["ok"]
      )
      assert.strictEqual(attempts, 3)
      assert.strictEqual(
        recorded.filter(
          (event) => event._tag === "Info" && event.message.includes("transient error")
        ).length,
        2
      )
    })
  )

  it.effect("fails fast when the transient retry budget is zero", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const counted = yield* makeCountingService(
        99,
        ProviderError.make({ message: "connection reset" })
      )
      const retrying = yield* makeTransientRetry(counted.service, {
        maxRetries: 0,
        baseDelay: Duration.zero
      }).pipe(Effect.provideService(FlowEvents, events))

      const exit = yield* Effect.exit(Stream.runCollect(retrying.executeStream("hello")))
      const attempts = yield* Ref.get(counted.attempts)
      const recorded = yield* events.recorded

      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(attempts, 1)
      assert.strictEqual(recorded.length, 0)
    })
  )

  it.effect("does not consume retries for usage limits or non-transient errors", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const counted = yield* makeCountingService(
        99,
        UsageLimitError.make({
          provider: "gemini",
          message: "capacity exhausted"
        })
      )
      const retrying = yield* makeTransientRetry(counted.service, {
        maxRetries: 3,
        flakyRetries: 3,
        baseDelay: Duration.zero,
        flakyDelay: Duration.zero
      }).pipe(Effect.provideService(FlowEvents, events))

      const exit = yield* Effect.exit(Stream.runCollect(retrying.executeStream("hello")))
      const attempts = yield* Ref.get(counted.attempts)
      const recorded = yield* events.recorded

      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(attempts, 1)
      assert.strictEqual(recorded.length, 0)
    })
  )

  it.effect("retries flaky streams independently of the transient budget", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const counted = yield* makeCountingService(
        2,
        ProviderError.make({ message: "Invalid stream: empty response" })
      )
      const retrying = yield* makeTransientRetry(counted.service, {
        maxRetries: 0,
        flakyRetries: 2,
        flakyDelay: Duration.zero
      }).pipe(Effect.provideService(FlowEvents, events))

      const result = yield* Stream.runCollect(retrying.executeStream("hello"))
      const attempts = yield* Ref.get(counted.attempts)

      assert.strictEqual(result[0]?.delta, "ok")
      assert.strictEqual(attempts, 3)
    })
  )
})
