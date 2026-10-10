import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { ProviderError, type LlmError } from "../Errors.ts"
import { LlmChunk, TokenUsage, type Effort } from "../Models.ts"
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

/**
 * The harness's word for an llm4ts effort (ADR 0029): the same four words,
 * except `max` on a harness whose top level is `xhigh`.
 */
export const effortWord = (effort: Effort, top: "max" | "xhigh" = "max"): string =>
  effort === "max" ? top : effort

export const toolEventChunk = (
  name: string,
  input: JsonValue | undefined,
  id?: string,
  options: {
    /** The tool call this one runs inside, when a harness delegated it to a sub-agent (ADR 0033). */
    readonly parent?: string
  } = {}
): LlmChunk =>
  LlmChunk.make({
    delta: "",
    metadata: {
      event: "tool_use",
      tool_name: name,
      tool_input: input === undefined ? "{}" : jsonText(input),
      ...(id === undefined || id.length === 0 ? {} : { tool_id: id }),
      ...(options.parent === undefined || options.parent.length === 0
        ? {}
        : { parent: options.parent })
    }
  })

/**
 * A tool result's text: a plain string, or the text parts of a content list
 * (`[{type:"text",text}]`, as Claude and pi send it).
 */
export const toolResultText = (value: JsonValue | undefined): string | undefined => {
  if (typeof value === "string") {
    return value
  }
  if (Array.isArray(value)) {
    const parts = value.flatMap((part) => {
      const text = jsonStringField(part, "text")
      return text === undefined ? [] : [text]
    })
    return parts.length === 0 ? undefined : parts.join("\n")
  }
  return undefined
}

/**
 * The end of a tool call: `id` pairs it with its `toolEventChunk`;
 * without one, the oldest open call is meant. `tool` and `input` are for a
 * harness that only reports a tool once it is done, so it still shows.
 */
export const toolResultChunk = (
  id: string | undefined,
  options: {
    readonly failed?: boolean
    readonly tool?: string
    readonly input?: JsonValue
    /** What the tool returned, for an opt-in transcript; never in the trace. */
    readonly output?: string
    /** The tool call this one ran inside (ADR 0033). */
    readonly parent?: string
    /** How long the harness says the tool ran, when it reports that itself. */
    readonly durationMs?: number
  } = {}
): LlmChunk =>
  LlmChunk.make({
    delta: "",
    metadata: {
      event: "tool_result",
      ...(id === undefined || id.length === 0 ? {} : { tool_id: id }),
      ...(options.failed === true ? { tool_failed: "true" } : {}),
      ...(options.parent === undefined || options.parent.length === 0
        ? {}
        : { parent: options.parent }),
      ...(options.durationMs === undefined || !Number.isFinite(options.durationMs)
        ? {}
        : { tool_duration_ms: String(Math.max(0, Math.round(options.durationMs))) }),
      ...(options.tool === undefined ? {} : { tool_name: options.tool }),
      ...(options.input === undefined ? {} : { tool_input: jsonText(options.input) }),
      ...(options.output === undefined ? {} : { tool_content: options.output })
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

/** The first `x.y.z` in a CLI's `--version` answer, if it holds one. */
export const versionTriple = (text: string): ReadonlyArray<number> | undefined => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return match === null ? undefined : match.slice(1, 4).map(Number)
}

/** Whether `version` is `floor` or newer, component by component. */
export const atLeastVersion = (
  version: ReadonlyArray<number>,
  floor: ReadonlyArray<number>
): boolean => {
  for (let index = 0; index < floor.length; index += 1) {
    const have = version[index] ?? 0
    const want = floor[index] ?? 0
    if (have !== want) {
      return have > want
    }
  }
  return true
}
