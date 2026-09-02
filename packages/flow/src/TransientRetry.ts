import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import type { LlmError } from "@llm4ts/core/Errors"
import { LlmService, type LlmServiceShape } from "@llm4ts/core/LlmService"
import { isLoopDetectedMessage } from "@llm4ts/core/providers/CliSupport"
import type { LlmChunk } from "@llm4ts/core/Models"
import { FlowEvents, Info } from "./FlowEvents.ts"

const transientSignals: ReadonlyArray<string> = [
  "connection reset",
  "server_error",
  "internal error",
  "service unavailable",
  "unavailable",
  "overloaded",
  "temporarily",
  "timed out",
  "api error",
  "unknown error",
  "code=500",
  "code=502",
  "code=503",
  "code=504",
  " 500",
  " 502",
  " 503",
  " 504"
]

// An "empty response" is ambiguous: gemini returns one both for a random mid-stream
// flake and for a prompt too large to start on. This classifier sees only the message,
// so it deliberately treats both as flaky — a fresh process fixes the common (flake)
// case, and the oversized-prompt case is resolved a layer up by Context.withShrink.
// Do not route empty responses into isContextOverflow.
const flakyStreamSignals: ReadonlyArray<string> = [
  "empty response",
  "malformed tool call",
  "invalid stream"
]

// Deterministic client errors a retry can never fix. Gemini wraps every error in
// "[API Error: {...}]", including 400s, so the "api error" transient signal would
// otherwise swallow them.
const deterministic4xxSignals: ReadonlyArray<string> = [
  "invalid_argument",
  '"code": 400',
  '"code":400',
  "code=400",
  "exceeds the maximum number of tokens"
]

// The message signatures of a prompt-too-large failure, in one place: isContextOverflow
// matches them on a typed LlmError, and Context.withShrink matches them on a bare
// message string when no typed cause survived. Two copies of this list would drift.
const contextOverflowSignals: ReadonlyArray<string> = [
  "exceeds the maximum number of tokens",
  "input token count exceeds",
  "context length exceeded",
  "maximum context length",
  "prompt is too long",
  "request too large"
]

const includesSignal = (message: string, signals: ReadonlyArray<string>): boolean => {
  const normalized = message.toLowerCase()
  return signals.some((signal) => normalized.includes(signal))
}

// A coding agent's own loop breaker (Gemini CLI: "A potential loop was
// detected … The request has been halted") is flaky in the same sense: the
// turn is lost, the quota is not, and a fresh process with the same prompt
// ordinarily completes — so it takes the fresh-retry budget, not the
// transient one, and is never treated as deterministic.
export const isFlakyStream = (error: LlmError): boolean =>
  error._tag === "ProviderError" &&
  (includesSignal(error.message, flakyStreamSignals) || isLoopDetectedMessage(error.message))

const isDeterministic4xx = (message: string): boolean =>
  includesSignal(message, deterministic4xxSignals)

export const isContextOverflowMessage = (message: string): boolean =>
  includesSignal(message, contextOverflowSignals)

// The prompt was larger than the model's input window. Deterministic: the same prompt
// always fails, so it is not transient — it routes to Context.withShrink, which retries
// at a smaller budget.
export const isContextOverflow = (error: LlmError): boolean =>
  error._tag === "ProviderError" && isContextOverflowMessage(error.message)

export const isTransient = (error: LlmError): boolean => {
  switch (error._tag) {
    case "TimeoutError":
    case "RateLimitError":
      return true
    case "ProviderError":
      return (
        !isFlakyStream(error) &&
        !isDeterministic4xx(error.message) &&
        includesSignal(error.message, transientSignals)
      )
    default:
      return false
  }
}

const maxHonoredRetryAfter = Duration.minutes(2)

export const transientDelay = (error: LlmError, backoff: Duration.Duration): Duration.Duration => {
  if (error._tag !== "RateLimitError" || error.retryAfter === undefined) {
    return backoff
  }

  return Duration.max(backoff, Duration.min(error.retryAfter, maxHonoredRetryAfter))
}

export interface TransientRetryOptions {
  readonly maxRetries?: number
  readonly baseDelay?: Duration.Input
  readonly flakyRetries?: number
  readonly flakyDelay?: Duration.Input
}

interface ResolvedTransientRetryOptions {
  readonly maxRetries: number
  readonly baseDelay: Duration.Duration
  readonly flakyRetries: number
  readonly flakyDelay: Duration.Duration
}

const resolveOptions = (options: TransientRetryOptions): ResolvedTransientRetryOptions => ({
  maxRetries: options.maxRetries ?? 3,
  baseDelay: Duration.fromInputUnsafe(options.baseDelay ?? "1 second"),
  flakyRetries: options.flakyRetries ?? 6,
  flakyDelay: Duration.fromInputUnsafe(options.flakyDelay ?? "1 second")
})

const backoff = (baseDelay: Duration.Duration, attempt: number): Duration.Duration =>
  Duration.times(baseDelay, 2 ** attempt)

const retryNotice = (
  events: FlowEvents["Service"],
  what: string,
  attempt: number,
  maximum: number,
  error: LlmError
): Effect.Effect<void> =>
  events.publish(
    Info.make({
      message: `⟳ ${what} — retry ${attempt + 1}/${maximum}: ${error.message}`
    })
  )

const waitForRetry = (
  events: FlowEvents["Service"],
  what: string,
  attempt: number,
  maximum: number,
  error: LlmError,
  delay: Duration.Duration
): Effect.Effect<void> =>
  retryNotice(events, what, attempt, maximum, error).pipe(Effect.andThen(Effect.sleep(delay)))

const retryEffect = <A, R>(
  effect: Effect.Effect<A, LlmError, R>,
  what: string,
  options: ResolvedTransientRetryOptions,
  events: FlowEvents["Service"]
): Effect.Effect<A, LlmError, R> => {
  const loop = (transientAttempt: number, flakyAttempt: number): Effect.Effect<A, LlmError, R> =>
    Effect.catchIf(
      effect,
      () => true,
      (error) => {
        if (isFlakyStream(error) && flakyAttempt < options.flakyRetries) {
          return waitForRetry(
            events,
            `flaky ${what} (fresh retry)`,
            flakyAttempt,
            options.flakyRetries,
            error,
            options.flakyDelay
          ).pipe(Effect.andThen(Effect.suspend(() => loop(transientAttempt, flakyAttempt + 1))))
        }

        if (isTransient(error) && transientAttempt < options.maxRetries) {
          return waitForRetry(
            events,
            `transient error (${what})`,
            transientAttempt,
            options.maxRetries,
            error,
            transientDelay(error, backoff(options.baseDelay, transientAttempt))
          ).pipe(Effect.andThen(Effect.suspend(() => loop(transientAttempt + 1, flakyAttempt))))
        }

        return Effect.fail(error)
      }
    )

  return loop(0, 0)
}

const retryStream = <R>(
  stream: Stream.Stream<LlmChunk, LlmError, R>,
  what: string,
  options: ResolvedTransientRetryOptions,
  events: FlowEvents["Service"]
): Stream.Stream<LlmChunk, LlmError, R> => {
  const waitThenRetry = (
    notice: Effect.Effect<void>,
    next: () => Stream.Stream<LlmChunk, LlmError, R>
  ): Stream.Stream<LlmChunk, LlmError, R> =>
    Stream.concat(Stream.drain(Stream.fromEffect(notice)), Stream.suspend(next))

  const loop = (
    transientAttempt: number,
    flakyAttempt: number
  ): Stream.Stream<LlmChunk, LlmError, R> =>
    Stream.catchIf(
      stream,
      () => true,
      (error) => {
        if (isFlakyStream(error) && flakyAttempt < options.flakyRetries) {
          return waitThenRetry(
            waitForRetry(
              events,
              `flaky ${what} (fresh retry)`,
              flakyAttempt,
              options.flakyRetries,
              error,
              options.flakyDelay
            ),
            () => loop(transientAttempt, flakyAttempt + 1)
          )
        }

        if (isTransient(error) && transientAttempt < options.maxRetries) {
          return waitThenRetry(
            waitForRetry(
              events,
              `transient error (${what})`,
              transientAttempt,
              options.maxRetries,
              error,
              transientDelay(error, backoff(options.baseDelay, transientAttempt))
            ),
            () => loop(transientAttempt + 1, flakyAttempt)
          )
        }

        return Stream.fail(error)
      }
    )

  return loop(0, 0)
}

export const makeTransientRetry = Effect.fn("@llm4ts/flow/TransientRetry.make")(function* (
  underlying: LlmServiceShape,
  retryOptions: TransientRetryOptions = {}
): Effect.fn.Return<LlmServiceShape, never, FlowEvents> {
  const events = yield* FlowEvents
  const options = resolveOptions(retryOptions)

  return LlmService.of({
    executeStream: (prompt) =>
      retryStream(underlying.executeStream(prompt), "stream", options, events),
    executeStreamWithHistory: (messages) =>
      retryStream(underlying.executeStreamWithHistory(messages), "stream", options, events),
    executeWithTools: (prompt, tools) =>
      retryEffect(underlying.executeWithTools(prompt, tools), "tools", options, events),
    executeStructured: (prompt, schema, jsonSchema) =>
      retryEffect(
        underlying.executeStructured(prompt, schema, jsonSchema),
        "structured",
        options,
        events
      ),
    executeStructuredWithUsage: (prompt, schema, jsonSchema) =>
      retryEffect(
        underlying.executeStructuredWithUsage(prompt, schema, jsonSchema),
        "structured",
        options,
        events
      ),
    isAvailable: underlying.isAvailable
  })
})
