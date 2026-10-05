import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { LlmChunk, Message } from "@llm4ts/core/Models"
import { redactText } from "@llm4ts/core/observability/Redaction"
import { roleOr } from "./Timing.ts"

/**
 * What the model was told and what it answered, per seat call — a record
 * (`llm4ts run --transcript`; on by default in epic-stories, where
 * `LLM4TS_TRANSCRIPT=off` turns it off) that `llm4ts watch` tails. It lives in
 * its own files, never in the trace, so the trace and `llm4ts profile` stay
 * content-free. Secrets are redacted and every field is capped.
 */

const Call = Schema.TaggedStruct("Call", {
  at: Schema.Number,
  call: Schema.String,
  role: Schema.String,
  executor: Schema.optionalKey(Schema.String),
  /** The system prompt, on a chat's first call only. */
  system: Schema.optionalKey(Schema.String),
  /** The input: a chat's newest message, or a one-shot prompt. */
  input: Schema.String,
  /** How many messages came before the input (a chat resends them all). */
  earlier: Schema.optionalKey(Schema.Int)
})

const Reply = Schema.TaggedStruct("Reply", {
  at: Schema.Number,
  call: Schema.String,
  text: Schema.String
})
const Tool = Schema.TaggedStruct("Tool", {
  at: Schema.Number,
  call: Schema.String,
  tool: Schema.String,
  args: Schema.String
})
const ToolResult = Schema.TaggedStruct("ToolResult", {
  at: Schema.Number,
  call: Schema.String,
  output: Schema.String,
  failed: Schema.optionalKey(Schema.Boolean)
})
const End = Schema.TaggedStruct("End", {
  at: Schema.Number,
  call: Schema.String,
  ms: Schema.Number,
  failed: Schema.optionalKey(Schema.Boolean)
})

export const TranscriptEntry = Schema.Union([Call, Reply, Tool, ToolResult, End])
export type TranscriptEntry = typeof TranscriptEntry.Type

/** Where entries go: one stream per story lane, and one for the run. */
export interface TranscriptSink {
  readonly write: (lane: string | undefined, entry: TranscriptEntry) => Effect.Effect<void>
}

export interface MemoryTranscriptSink {
  readonly sink: TranscriptSink
  readonly entries: Effect.Effect<
    ReadonlyArray<{ readonly lane: string | undefined; readonly entry: TranscriptEntry }>
  >
}

export const makeMemoryTranscriptSink: Effect.Effect<MemoryTranscriptSink> = Effect.map(
  Ref.make<ReadonlyArray<{ readonly lane: string | undefined; readonly entry: TranscriptEntry }>>(
    []
  ),
  (entries) => ({
    sink: { write: (lane, entry) => Ref.update(entries, (all) => [...all, { lane, entry }]) },
    entries: Ref.get(entries)
  })
)

const inputChars = 64_000
const partChars = 4_000

const clean = (text: string, limit: number): string => redactText(text, { maxLength: limit })

let calls = 0
const nextCall: Effect.Effect<string> = Effect.sync(() => {
  calls += 1
  return `call-${calls}`
})

export interface TranscriptSeatOptions {
  readonly lane?: string
  /** The seat's role; a caller's `withTimedRole` names the call instead. */
  readonly role: string
  /** Who serves the seat, read at each call (a roster hands the coder over). */
  readonly executor?: Effect.Effect<string | undefined>
}

/** A seat whose every call is written to `sink`, as it happens. */
export const transcriptSeat = (
  service: LlmServiceShape,
  sink: TranscriptSink,
  options: TranscriptSeatOptions
): LlmServiceShape => {
  const write = (entry: TranscriptEntry) => sink.write(options.lane, entry)

  const opened = (
    input: string,
    extra: { readonly system?: string; readonly earlier?: number }
  ): Effect.Effect<{ readonly call: string; readonly start: number }> =>
    Effect.gen(function* () {
      const call = yield* nextCall
      const start = yield* Clock.currentTimeMillis
      const role = yield* roleOr(options.role)
      const executor = options.executor === undefined ? undefined : yield* options.executor
      yield* write({
        _tag: "Call",
        at: start,
        call,
        role,
        ...(executor === undefined ? {} : { executor }),
        ...(extra.system === undefined ? {} : { system: clean(extra.system, inputChars) }),
        input: clean(input, inputChars),
        ...(extra.earlier === undefined ? {} : { earlier: extra.earlier })
      })
      return { call, start }
    })

  const closed = (call: string, start: number, failed: boolean): Effect.Effect<void> =>
    Effect.flatMap(Clock.currentTimeMillis, (at) =>
      write({ _tag: "End", at, call, ms: at - start, ...(failed ? { failed } : {}) })
    )

  const chunkEntry = (call: string, chunk: LlmChunk): Effect.Effect<void> =>
    Effect.flatMap(Clock.currentTimeMillis, (at) => {
      switch (chunk.metadata.event) {
        case "tool_use":
          return write({
            _tag: "Tool",
            at,
            call,
            tool: chunk.metadata.tool_name ?? chunk.metadata.toolName ?? "",
            args: clean(chunk.metadata.tool_input ?? chunk.metadata.toolInput ?? "", partChars)
          })
        case "tool_result": {
          const failed =
            chunk.metadata.tool_failed === "true" || chunk.metadata.tool_status === "error"
          return write({
            _tag: "ToolResult",
            at,
            call,
            output: clean(chunk.metadata.tool_content ?? "", partChars),
            ...(failed ? { failed } : {})
          })
        }
        default:
          return chunk.delta.length === 0
            ? Effect.void
            : write({
                _tag: "Reply",
                at,
                call,
                text: redactText(chunk.delta, { maxLength: inputChars })
              })
      }
    })

  const recorded = <E>(
    open: Effect.Effect<{ readonly call: string; readonly start: number }>,
    stream: Stream.Stream<LlmChunk, E>
  ): Stream.Stream<LlmChunk, E> =>
    Stream.unwrap(
      Effect.map(Effect.all([open, Ref.make(false)]), ([{ call, start }, failed]) =>
        stream.pipe(
          Stream.tap((chunk) => chunkEntry(call, chunk)),
          Stream.tapError(() => Ref.set(failed, true)),
          Stream.ensuring(Effect.flatMap(Ref.get(failed), (did) => closed(call, start, did)))
        )
      )
    )

  const once = <A, E, R>(input: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(opened(input, {}), ({ call, start }) =>
      Effect.onExit(effect, (exit) =>
        Effect.andThen(
          Exit.isSuccess(exit)
            ? Effect.flatMap(Clock.currentTimeMillis, (at) =>
                write({
                  _tag: "Reply",
                  at,
                  call,
                  text: clean(JSON.stringify(exit.value) ?? "", inputChars)
                })
              )
            : Effect.void,
          closed(call, start, Exit.isFailure(exit))
        )
      )
    )

  /** A chat's first call is told everything; a later one only what is new. */
  const chatInput = (messages: ReadonlyArray<Message>) => {
    const system = messages.filter((message) => message.role === "System")
    const rest = messages.filter((message) => message.role !== "System")
    const first = !rest.some((message) => message.role === "Assistant")
    const newest = rest.at(-1)?.content ?? ""
    return first
      ? {
          input: rest.map((message) => message.content).join("\n\n"),
          extra:
            system.length === 0
              ? {}
              : { system: system.map((message) => message.content).join("\n\n") }
        }
      : { input: newest, extra: { earlier: rest.length - 1 } }
  }

  const batched = service.scoreLabelSequence
  return {
    executeStream: (prompt) => recorded(opened(prompt, {}), service.executeStream(prompt)),
    executeStreamWithHistory: (messages) => {
      const { input, extra } = chatInput(messages)
      return recorded(opened(input, extra), service.executeStreamWithHistory(messages))
    },
    executeWithTools: (prompt, tools) => once(prompt, service.executeWithTools(prompt, tools)),
    executeStructured: (prompt, schema, jsonSchema) =>
      once(prompt, service.executeStructured(prompt, schema, jsonSchema)),
    executeStructuredWithUsage: (prompt, schema, jsonSchema) =>
      once(prompt, service.executeStructuredWithUsage(prompt, schema, jsonSchema)),
    scoreLabels: (prompt, labels) => once(prompt, service.scoreLabels(prompt, labels)),
    ...(batched === undefined
      ? {}
      : {
          scoreLabelSequence: (prompt: string, labelSets: ReadonlyArray<ReadonlyArray<string>>) =>
            once(prompt, batched(prompt, labelSets))
        }),
    isAvailable: service.isAvailable
  }
}
