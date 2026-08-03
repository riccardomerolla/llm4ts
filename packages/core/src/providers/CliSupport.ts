import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { ProviderError, type LlmError } from "../Errors.ts"
import { LlmChunk, type TokenUsage } from "../Models.ts"
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
