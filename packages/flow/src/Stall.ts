// Stopping conditions the model does not control (ADR 0027 decision 11).
// Pure helpers over a chat's chunk stream; `Chat` applies them when asked.
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import type { LlmError } from "@llm4ts/core/Errors"
import type { LlmChunk } from "@llm4ts/core/Models"
import { Stalled } from "./FlowError.ts"

export interface StallOptions {
  /** The same tool call with the same arguments this many times in a row ends the turn. Default 5. */
  readonly repeats?: number
  /** No chunk for this long ends the turn; absent means never (a slow seat looks like silence). */
  readonly silence?: Duration.Duration
}

export const defaultStallRepeats = 5

/** The identity of a tool call chunk: name and arguments; `undefined` for anything else. */
export const toolCallKey = (chunk: LlmChunk): string | undefined =>
  chunk.metadata.event === "tool_use"
    ? `${chunk.metadata.tool_name ?? chunk.metadata.toolName ?? ""}|${chunk.metadata.tool_input ?? chunk.metadata.toolInput ?? ""}`
    : undefined

export interface RepeatState {
  readonly key: string | undefined
  readonly count: number
}

export const noRepeats: RepeatState = { key: undefined, count: 0 }

/** The repeat state after one chunk: a different call resets, the same one counts. */
export const nextRepeat = (state: RepeatState, chunk: LlmChunk): RepeatState => {
  const key = toolCallKey(chunk)
  if (key === undefined) {
    return state
  }
  return key === state.key ? { key, count: state.count + 1 } : { key, count: 1 }
}

/**
 * The stream, ended with `Stalled` when one tool call repeats `repeats`
 * times in a row (the state is shared across a chat's turns through `state`)
 * or when no chunk arrives within `silence`.
 */
export const stallGuard = <R>(
  stream: Stream.Stream<LlmChunk, LlmError, R>,
  options: StallOptions,
  state: Ref.Ref<RepeatState>
): Stream.Stream<LlmChunk, LlmError | Stalled, R> => {
  const limit = Math.max(2, options.repeats ?? defaultStallRepeats)
  const counted = Stream.mapEffect(stream, (chunk) =>
    Effect.flatMap(
      Ref.modify(state, (current) => {
        const next = nextRepeat(current, chunk)
        return [next, next] as const
      }),
      (next) =>
        next.count >= limit
          ? Effect.fail(
              Stalled.make({
                signal: "repeated-tool-call",
                detail: `the same tool call ${next.count} times in a row: ${(next.key ?? "").slice(0, 200)}`
              })
            )
          : Effect.succeed(chunk)
    )
  )
  const silence = options.silence
  return silence === undefined
    ? counted
    : counted.pipe(
        Stream.timeoutOrElse({
          duration: silence,
          orElse: () =>
            Stream.fail(
              Stalled.make({
                signal: "silence",
                detail: `no output for ${Duration.format(silence)} (LLM4TS_STALL_MINUTES)`
              })
            )
        })
      )
}
