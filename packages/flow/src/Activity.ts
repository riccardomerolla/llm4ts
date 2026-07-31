import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import type { LlmError } from "@llm4ts/core/Errors"
import type { LlmChunk } from "@llm4ts/core/Models"
import { ToolUse, type FlowEventsShape } from "./FlowEvents.ts"

/**
 * Live agent activity.
 *
 * CLI connectors emit a zero-delta chunk per tool call, tagged
 * `metadata.event = "tool_use"` with `tool_name` and `tool_input` (see
 * `toolEventChunk` in `@llm4ts/core/providers/CliSupport`). `collect` folds a
 * stream into its final response and drops those chunks, so a coding agent
 * working for minutes rendered as a bare spinner with no sign of progress.
 * Tapping the stream turns each of them into a `ToolUse` event the terminal
 * already knows how to draw.
 */

const ArgsLimit = 120

/** Keys worth showing alone, in the order a tool call is usually recognised by. */
const salientKeys: ReadonlyArray<string> = [
  "command",
  "file_path",
  "filePath",
  "path",
  "pattern",
  "query",
  "url",
  "topic",
  "title",
  "description",
  "prompt"
]

const compact = (text: string): string => {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length <= ArgsLimit ? collapsed : `${collapsed.slice(0, ArgsLimit - 1)}…`
}

const scalar = (value: unknown): string | undefined => {
  switch (typeof value) {
    case "string":
      return value
    case "number":
    case "boolean":
      return String(value)
    default:
      return undefined
  }
}

/**
 * The readable gist of a tool's arguments: the salient value on its own
 * (`ls -R docs/modernization` rather than `{"command":"ls -R …"}`), a compact
 * `key=value` list when no single field stands out, and the raw text when the
 * input is not a JSON object. Always collapsed to one line and truncated.
 */
export const summariseToolArgs = (raw: string): string => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return ""
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return compact(trimmed)
  }
  const direct = scalar(parsed)
  if (direct !== undefined) {
    return compact(direct)
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return compact(trimmed)
  }
  const entries = Object.entries(parsed)
  if (entries.length === 0) {
    return ""
  }
  for (const key of salientKeys) {
    const found = entries.find(([name]) => name === key)
    const value = found === undefined ? undefined : scalar(found[1])
    if (value !== undefined && value.trim().length > 0) {
      return compact(value)
    }
  }
  const single = entries.length === 1 ? scalar(entries[0]?.[1]) : undefined
  if (single !== undefined) {
    return compact(single)
  }
  return compact(
    entries.map(([name, value]) => `${name}=${scalar(value) ?? JSON.stringify(value)}`).join(", ")
  )
}

/** The `ToolUse` event a chunk represents, or undefined when it is not a tool call. */
export const toolUseFrom = (chunk: LlmChunk): ToolUse | undefined => {
  if (chunk.metadata.event !== "tool_use") {
    return undefined
  }
  const tool = (chunk.metadata.tool_name ?? chunk.metadata.toolName ?? "").trim()
  if (tool.length === 0) {
    return undefined
  }
  return ToolUse.make({
    tool,
    args: summariseToolArgs(chunk.metadata.tool_input ?? chunk.metadata.toolInput ?? "")
  })
}

/**
 * Republishes the stream unchanged, publishing a `ToolUse` event for every
 * tool call it carries. Wrap a connector stream with this before `collect` so
 * the run reports what the agent is doing while it is doing it.
 */
export const withToolActivity = <R>(
  events: FlowEventsShape,
  stream: Stream.Stream<LlmChunk, LlmError, R>
): Stream.Stream<LlmChunk, LlmError, R> =>
  Stream.tap(stream, (chunk) => {
    const event = toolUseFrom(chunk)
    return event === undefined ? Effect.void : events.publish(event)
  })
