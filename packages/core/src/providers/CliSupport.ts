import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { ProviderError, type LlmError } from "../Errors.ts"
import { LlmChunk, TokenUsage } from "../Models.ts"
import { classifyUsageLimit } from "../UsageLimits.ts"

export type JsonValue = typeof Schema.Json.Type
export type JsonRecord = Readonly<Record<string, JsonValue>>

export const isJsonRecord = (value: JsonValue): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)

export const parseJsonLine = (line: string): JsonValue | undefined => {
  const trimmed = line.trim()
  if (trimmed.length === 0 || !trimmed.startsWith("{")) {
    return undefined
  }
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(trimmed)
  )
}

export const jsonField = (value: JsonValue | undefined, name: string): JsonValue | undefined =>
  value !== undefined && isJsonRecord(value) ? value[name] : undefined

export const jsonStringField = (value: JsonValue | undefined, name: string): string | undefined => {
  const field = jsonField(value, name)
  return typeof field === "string" ? field : undefined
}

export const jsonIntField = (value: JsonValue | undefined, name: string): number | undefined => {
  const field = jsonField(value, name)
  return typeof field === "number" && Number.isFinite(field) ? Math.trunc(field) : undefined
}

export const jsonNumberField = (value: JsonValue | undefined, name: string): number | undefined => {
  const field = jsonField(value, name)
  return typeof field === "number" && Number.isFinite(field) ? field : undefined
}

export const jsonBooleanField = (
  value: JsonValue | undefined,
  name: string
): boolean | undefined => {
  const field = jsonField(value, name)
  return typeof field === "boolean" ? field : undefined
}

export const jsonArray = (value: JsonValue | undefined): ReadonlyArray<JsonValue> =>
  Array.isArray(value) ? value : []

export const jsonObjectEntries = (
  value: JsonValue | undefined
): ReadonlyArray<readonly [string, JsonValue]> =>
  value !== undefined && isJsonRecord(value) ? Object.entries(value) : []

export const jsonText = (value: JsonValue): string => JSON.stringify(value) ?? "{}"

export const sortedFlagArgs = (flags: Readonly<Record<string, string>>): ReadonlyArray<string> =>
  Object.entries(flags)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => (value.length === 0 ? [`--${key}`] : [`--${key}`, value]))

export const optionalModelArgs = (model: string | undefined): ReadonlyArray<string> =>
  model === undefined ? [] : ["--model", model]

export const toolEventChunk = (name: string, input: JsonValue | undefined): LlmChunk =>
  LlmChunk.make({
    delta: "",
    metadata: {
      event: "tool_use",
      tool_name: name,
      tool_input: input === undefined ? "{}" : jsonText(input)
    }
  })

/** Two usage reports as one: counts add up, and so do cache reads and costs when either has them. */
export const addTokenUsage = (sum: TokenUsage | undefined, next: TokenUsage): TokenUsage => {
  if (sum === undefined) {
    return next
  }
  const cached =
    sum.cached === undefined && next.cached === undefined
      ? undefined
      : (sum.cached ?? 0) + (next.cached ?? 0)
  const costUsd =
    sum.costUsd === undefined && next.costUsd === undefined
      ? undefined
      : (sum.costUsd ?? 0) + (next.costUsd ?? 0)
  return TokenUsage.make({
    prompt: sum.prompt + next.prompt,
    completion: sum.completion + next.completion,
    total: sum.total + next.total,
    ...(cached === undefined ? {} : { cached }),
    ...(costUsd === undefined ? {} : { costUsd })
  })
}

/**
 * For a harness that reports usage per model message or step (pi's
 * `message_end`, opencode's `step_finish`): every usage chunk carries the
 * running total instead of its own share. A reply is read as its last usage
 * chunk, so without this an agent turn of thirty model calls counted as one.
 */
export const cumulativeUsage = <E, R>(
  stream: Stream.Stream<LlmChunk, E, R>
): Stream.Stream<LlmChunk, E, R> =>
  Stream.unwrap(
    Effect.map(Ref.make<TokenUsage | undefined>(undefined), (total) =>
      stream.pipe(
        Stream.mapEffect((chunk) => {
          const usage = chunk.usage
          return usage === undefined
            ? Effect.succeed(chunk)
            : Effect.map(
                Ref.updateAndGet(total, (sum) => addTokenUsage(sum, usage)),
                (sum) => (sum === undefined ? chunk : LlmChunk.make({ ...chunk, usage: sum }))
              )
        })
      )
    )
  )

export const usageEventChunk = (model: string | undefined, usage: TokenUsage): LlmChunk =>
  LlmChunk.make({
    delta: "",
    finishReason: "stop",
    usage,
    metadata:
      model === undefined
        ? {}
        : {
            model
          }
  })

/**
 * The message signatures of a coding agent's own loop breaker. Gemini CLI
 * halts a turn whose tool calls or model output repeat ("A potential loop
 * was detected … The request has been halted"); the turn is lost, not the
 * quota, and a fresh process with the same prompt ordinarily completes. So
 * this is a flaky-stream failure for the retry decorator, never a
 * deterministic one — one list here, matched by the provider on stderr and
 * by `@llm4ts/flow/TransientRetry` on the resulting error message.
 */
export const loopDetectionSignals: ReadonlyArray<string> = ["loop detected", "potential loop"]

export const isLoopDetectedMessage = (message: string): boolean => {
  const normalized = message.toLowerCase()
  return loopDetectionSignals.some((signal) => normalized.includes(signal))
}

export const failClassifiedCliError = Effect.fn(
  "@llm4ts/core/providers/CliSupport.failClassifiedCliError"
)(function* (
  provider: string,
  fallbackPrefix: string,
  raw: string
): Effect.fn.Return<never, LlmError> {
  const now = yield* DateTime.now
  const timeZone = yield* Effect.sync(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  return yield* classifyUsageLimit(provider, raw, now, timeZone) ??
    ProviderError.make({
      message: `${fallbackPrefix}: ${raw}`
    })
})
