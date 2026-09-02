import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
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
  isStructuredParseFailure,
  isTransient,
  makeTransientRetry,
  repairPrompt,
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

  it("treats a coding agent's loop breaker as a fresh-retry flake, never deterministic", () => {
    // Gemini CLI halts a repetitive turn; the process exits, the quota is
    // untouched, and the same prompt in a fresh process ordinarily completes.
    for (const message of [
      "Gemini CLI returned an error: A potential loop was detected. This can happen due to repetitive tool calls or other model behavior. The request has been halted.",
      "Gemini CLI halted the turn: Loop detected: repetitive tool calls",
      "Gemini CLI stream error (type=loop): LOOP DETECTED"
    ]) {
      const error = ProviderError.make({ message })
      assert.isTrue(isFlakyStream(error), message)
      assert.isFalse(isTransient(error), message)
      assert.isFalse(isContextOverflow(error), message)
    }
    assert.isFalse(isFlakyStream(ProviderError.make({ message: "for loop syntax error" })))
  })

  it.effect("retries a loop-detected turn on the flaky budget until it completes", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const counted = yield* makeCountingService(
        2,
        ProviderError.make({
          message:
            "Gemini CLI returned an error: A potential loop was detected. The request has been halted."
        })
      )
      const retrying = yield* makeTransientRetry(counted.service, {
        maxRetries: 0,
        flakyRetries: 2,
        flakyDelay: Duration.zero
      }).pipe(Effect.provideService(FlowEvents, events))

      const result = yield* Stream.runCollect(retrying.executeStream("hello"))
      assert.strictEqual(result[0]?.delta, "ok")
      assert.strictEqual(yield* Ref.get(counted.attempts), 3)
      const notices = (yield* events.recorded).flatMap((event) =>
        event._tag === "Info" ? [event.message] : []
      )
      assert.isTrue(
        notices.some((message) => message.includes("fresh retry") && message.includes("loop")),
        `retry notice should name the loop: ${notices.join(" | ")}`
      )
    })
  )

  it("quotes the parse failure back to the model in the repair prompt", () => {
    const error = ParseError.make({
      message:
        'Failed to parse response as structured output: Expected number, actual "12 EUR" at ["amount"] (tried 2 candidate(s); last: {"amount":"12 EUR"})',
      raw: '{"amount":"12 EUR"}'
    })
    const repaired = repairPrompt("Extract the fee.", error)
    assert.isTrue(repaired.startsWith("Extract the fee."))
    assert.include(repaired, "could not be parsed")
    assert.include(repaired, 'Expected number, actual "12 EUR"')
    assert.include(repaired, "ONLY the JSON object")
    // A very long reason is cut so the re-ask does not double the prompt.
    const long = repairPrompt("p", ParseError.make({ message: "x".repeat(2_000), raw: "" }))
    assert.isBelow(long.length, 700)

    assert.isTrue(isStructuredParseFailure(error))
    assert.isFalse(isStructuredParseFailure(ProviderError.make({ message: "Failed to parse" })))
    assert.isFalse(isFlakyStream(error))
    assert.isFalse(isTransient(error))
  })

  const makeStructuredService = (
    failTimes: number,
    failure: LlmError
  ): Effect.Effect<{
    readonly service: LlmServiceShape
    readonly prompts: Ref.Ref<ReadonlyArray<string>>
  }> =>
    Effect.map(Ref.make<ReadonlyArray<string>>([]), (prompts) => {
      // Succeeds with 42 decoded through the caller's schema, so the fake is
      // honest about the service's generic return type without an assertion.
      const attempt = <A, E, RD, RE>(
        prompt: string,
        schema: Schema.ConstraintCodec<A, E, RD, RE>
      ): Effect.Effect<A, LlmError, RD> =>
        Ref.updateAndGet(prompts, (seen) => [...seen, prompt]).pipe(
          Effect.flatMap((seen) =>
            seen.length <= failTimes
              ? Effect.fail(failure)
              : Schema.decodeUnknownEffect(schema)(42).pipe(
                  Effect.mapError((error) => ParseError.make({ message: String(error), raw: "42" }))
                )
          )
        )
      return {
        prompts,
        service: LlmService.of({
          executeStream: (_prompt) => Stream.fail(InvalidRequestError.make({ message: "unused" })),
          executeStreamWithHistory: (_messages) =>
            Stream.fail(InvalidRequestError.make({ message: "unused" })),
          executeWithTools: (_prompt, _tools) =>
            Effect.fail(InvalidRequestError.make({ message: "unused" })),
          executeStructured: (prompt, schema, _jsonSchema) => attempt(prompt, schema),
          executeStructuredWithUsage: (prompt, schema, _jsonSchema) =>
            attempt(prompt, schema).pipe(Effect.map((value) => [value, undefined, undefined])),
          isAvailable: Effect.succeed(true)
        })
      }
    })

  const parseFailure = ParseError.make({
    message: 'Failed to parse response as structured output: missing field "waves"',
    raw: "{}"
  })

  it.effect("re-asks a structured call with the repair prompt until it parses", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const structured = yield* makeStructuredService(2, parseFailure)
      const retrying = yield* makeTransientRetry(structured.service, {
        maxRetries: 0,
        flakyRetries: 0,
        flakyDelay: Duration.zero,
        parseRetries: 2
      }).pipe(Effect.provideService(FlowEvents, events))

      const [value] = yield* retrying.executeStructuredWithUsage(
        "Plan the waves.",
        Schema.Number,
        {}
      )
      assert.strictEqual(value, 42)
      const prompts = yield* Ref.get(structured.prompts)
      assert.strictEqual(prompts.length, 3)
      assert.strictEqual(prompts[0], "Plan the waves.")
      // Every re-ask is the ORIGINAL prompt plus the latest failure — not a
      // repair of a repair, which would grow with each attempt.
      for (const prompt of prompts.slice(1)) {
        assert.isTrue(prompt.startsWith("Plan the waves."))
        assert.include(prompt, 'missing field "waves"')
        assert.strictEqual(prompt.split("could not be parsed").length, 2)
      }
      const notices = (yield* events.recorded).flatMap((event) =>
        event._tag === "Info" ? [event.message] : []
      )
      assert.strictEqual(notices.filter((line) => line.includes("repair retry")).length, 2)
    })
  )

  it.effect("surfaces the parse failure once the repair budget is spent", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const structured = yield* makeStructuredService(5, parseFailure)
      const retrying = yield* makeTransientRetry(structured.service, {
        maxRetries: 0,
        flakyRetries: 0,
        flakyDelay: Duration.zero,
        parseRetries: 2
      }).pipe(Effect.provideService(FlowEvents, events))

      const error = yield* Effect.flip(retrying.executeStructured("Plan.", Schema.Number, {}))
      assert.strictEqual(error._tag, "ParseError")
      assert.strictEqual((yield* Ref.get(structured.prompts)).length, 3)
    })
  )

  it.effect("keeps the repair budget separate from transient and flaky retries", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      // A transient failure inside a structured call still takes the
      // transient budget and re-sends the SAME prompt, not a repair.
      const structured = yield* makeStructuredService(
        1,
        ProviderError.make({ message: "connection reset by peer" })
      )
      const retrying = yield* makeTransientRetry(structured.service, {
        maxRetries: 1,
        baseDelay: Duration.zero,
        parseRetries: 0
      }).pipe(Effect.provideService(FlowEvents, events))

      yield* retrying.executeStructured("Plan.", Schema.Number, {})
      assert.deepStrictEqual(yield* Ref.get(structured.prompts), ["Plan.", "Plan."])
    })
  )

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
