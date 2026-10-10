import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import type { LlmError } from "@llm4ts/core/Errors"
import { LlmChunk } from "@llm4ts/core/Models"
import { Began, Timed, ToolUse, UsageProgress, type FlowEventsShape } from "./FlowEvents.ts"

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
  const parent = chunk.metadata.parent
  return ToolUse.make({
    tool,
    args: summariseToolArgs(chunk.metadata.tool_input ?? chunk.metadata.toolInput ?? ""),
    ...(parent === undefined || parent.length === 0 ? {} : { parent })
  })
}

let calls = 0
/** A process-unique id for one streaming call's progress. */
const nextCall: Effect.Effect<string> = Effect.sync(() => {
  calls += 1
  return `call-${calls}`
})

/**
 * Republishes the stream unchanged, publishing a `ToolUse` event for every
 * tool call it carries. Wrap a connector stream with this before `collect` so
 * the run reports what the agent is doing while it is doing it.
 */
interface OpenTool {
  readonly id: string | undefined
  readonly tool: string
  readonly category: ToolCategory
  readonly at: number
}

export type ToolCategory =
  | "explore"
  | "edit"
  | "test"
  | "build"
  | "install"
  | "git"
  | "delegate"
  | "other"

/**
 * A harness handing work to a sub-agent of its own: Claude's Agent (Task
 * before 2.1.63), Codex's collab tools, Gemini's built-in agents (ADR 0033).
 */
export const delegateTools =
  /^(agent|task|spawn_agent|send_input|wait_agent|wait|resume_agent|close_agent|codebase_investigator|generalist|cli_help|browser_agent)$/iu

const exploreTools =
  /^(read|read_file|read_many_files|glob|grep|search|search_file_content|list|ls|list_directory|find|view|web_fetch|google_web_search)$/iu
const editTools = /^(edit|write|write_file|replace|multiedit|apply_patch|create|str_replace)$/iu
const shellTools = /^(bash|shell|run_shell_command|exec|command_execution)$/iu

/**
 * What kind of work a coder's tool call is, for "where does the time go":
 * reading the code, editing it, or a shell command sorted by what it runs.
 * Only this name is kept — never the command.
 */
export const toolCategory = (tool: string, args: string): ToolCategory => {
  if (delegateTools.test(tool)) {
    return "delegate"
  }
  if (editTools.test(tool)) {
    return "edit"
  }
  if (!shellTools.test(tool)) {
    return exploreTools.test(tool) ? "explore" : "other"
  }
  // `cd <worktree> && …`: the command is what follows.
  const command = args.replace(/^\s*cd\s+\S+\s*&&\s*/u, "").trim()
  if (/\b(test|vitest|jest|pytest|mocha|playwright)\b/u.test(command)) {
    return "test"
  }
  if (/\b(typecheck|tsc|lint|eslint|build|compile|prettier|format)\b/u.test(command)) {
    return "build"
  }
  if (
    /\b(install|ci|add)\b/u.test(command) &&
    /^(pnpm|npm|yarn|bun|pip|poetry|mvn|gradle)\b/u.test(command)
  ) {
    return "install"
  }
  if (/^git\b/u.test(command)) {
    return "git"
  }
  if (
    /^(ls|find|grep|rg|cat|head|tail|sed|awk|wc|tree|pwd|echo|stat|file|less|more|du)\b/u.test(
      command
    )
  ) {
    return "explore"
  }
  return "other"
}

const toolIdOf = (chunk: LlmChunk): string | undefined => {
  const id = chunk.metadata.tool_id ?? chunk.metadata.toolId
  return id === undefined || id.length === 0 ? undefined : id
}

/**
 * The `Timed{kind:"tool"}` a tool's end closes: the open call with
 * the same id, or the oldest open one when the harness sends no ids. A
 * harness that reports a tool only at its end (an older codex) gets its
 * `ToolUse` published then, untimed, as before.
 */
const toolEnded = (
  events: FlowEventsShape,
  open: Ref.Ref<ReadonlyArray<OpenTool>>,
  chunk: LlmChunk
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const id = toolIdOf(chunk)
    const started = yield* Ref.modify(open, (calls) => {
      const index = id === undefined ? 0 : calls.findIndex((call) => call.id === id)
      const found = index < 0 ? undefined : calls[index]
      return [
        found,
        found === undefined ? calls : [...calls.slice(0, index), ...calls.slice(index + 1)]
      ] as const
    })
    if (started === undefined) {
      const late = toolUseFrom(
        LlmChunk.make({ delta: "", metadata: { ...chunk.metadata, event: "tool_use" } })
      )
      return late === undefined ? undefined : yield* events.publish(late)
    }
    const now = yield* Clock.currentTimeMillis
    const failed = chunk.metadata.tool_failed === "true" || chunk.metadata.tool_status === "error"
    // The harness's own figure when it reports one (pi), else the wall clock.
    const reported = Number(chunk.metadata.tool_duration_ms)
    const ms =
      chunk.metadata.tool_duration_ms !== undefined && Number.isFinite(reported) && reported >= 0
        ? reported
        : now - started.at
    yield* events.publish(
      Timed.make({
        kind: "tool",
        label: started.tool,
        category: started.category,
        ms,
        ...(failed ? { failed: true } : {})
      })
    )
  })

/** A harness pause (`statusChunk`) as a wait on the lane: `Began` at its start, `Timed` at its end. */
const pauseLabels: Readonly<Record<string, string>> = {
  retrying: "pi retry",
  compacting: "pi compaction"
}

const statusChanged = (
  events: FlowEventsShape,
  pauses: Ref.Ref<ReadonlyArray<{ readonly label: string; readonly at: number }>>,
  chunk: LlmChunk
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const label = pauseLabels[chunk.metadata.status ?? ""]
    if (label === undefined) {
      return
    }
    const now = yield* Clock.currentTimeMillis
    if (chunk.metadata.phase === "start") {
      yield* Ref.update(pauses, (open) => [...open, { label, at: now }])
      return yield* events.publish(Began.make({ kind: "wait", label }))
    }
    const started = yield* Ref.modify(pauses, (open) => {
      const index = open.findIndex((pause) => pause.label === label)
      return [
        index < 0 ? undefined : open[index],
        index < 0 ? open : [...open.slice(0, index), ...open.slice(index + 1)]
      ] as const
    })
    if (started !== undefined) {
      yield* events.publish(Timed.make({ kind: "wait", label, ms: now - started.at }))
    }
  })

/**
 * Republishes the stream unchanged, publishing a `ToolUse` event for every
 * tool call it carries, and a `Timed` one when the call ends. Wrap a
 * connector stream with this before `collect` so the run reports what the
 * agent is doing while it is doing it.
 */
export const withToolActivity = <R>(
  events: FlowEventsShape,
  stream: Stream.Stream<LlmChunk, LlmError, R>
): Stream.Stream<LlmChunk, LlmError, R> =>
  // Usage a harness reports mid-turn (pi per model message) is published as
  // display-only progress, so a long agent turn shows its tokens growing; a
  // call that reported any closes with `done` so the display drops it.
  Stream.unwrap(
    Effect.map(
      Effect.all([
        nextCall,
        Ref.make(false),
        Ref.make<ReadonlyArray<OpenTool>>([]),
        Ref.make<ReadonlyArray<{ readonly label: string; readonly at: number }>>([])
      ]),
      ([call, reported, open, pauses]) =>
        Stream.tap(stream, (chunk) => {
          const event = toolUseFrom(chunk)
          const tool =
            event === undefined
              ? chunk.metadata.event === "tool_result"
                ? toolEnded(events, open, chunk)
                : chunk.metadata.event === "status"
                  ? statusChanged(events, pauses, chunk)
                  : Effect.void
              : Effect.andThen(
                  events.publish(event),
                  Effect.flatMap(Clock.currentTimeMillis, (at) =>
                    Ref.update(open, (calls) => [
                      ...calls,
                      {
                        id: toolIdOf(chunk),
                        tool: event.tool,
                        category: toolCategory(event.tool, event.args),
                        at
                      }
                    ])
                  )
                )
          return chunk.usage === undefined
            ? tool
            : tool.pipe(
                Effect.andThen(events.publish(UsageProgress.make({ call, usage: chunk.usage }))),
                Effect.andThen(Ref.set(reported, true))
              )
        }).pipe(
          Stream.ensuring(
            Effect.flatMap(Ref.get(reported), (any) =>
              any ? events.publish(UsageProgress.make({ call, done: true })) : Effect.void
            )
          )
        )
    )
  )
