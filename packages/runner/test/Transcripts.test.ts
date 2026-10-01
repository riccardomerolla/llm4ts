import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  TranscriptEntry as TranscriptEntrySchema,
  type TranscriptEntry
} from "@llm4ts/flow/Transcript"
import {
  loadTranscript,
  renderTranscript,
  transcriptFileOf,
  transcriptsWanted
} from "@llm4ts/runner/Transcripts"

const t0 = 1_790_000_000_000
const entries: ReadonlyArray<TranscriptEntry> = [
  {
    _tag: "Call",
    at: t0,
    call: "c1",
    role: "coder",
    executor: "gemini",
    system: "You implement stories.",
    input: "Task 1: add the route"
  },
  { _tag: "Reply", at: t0 + 1_000, call: "c1", text: "Reading the " },
  { _tag: "Reply", at: t0 + 2_000, call: "c1", text: "routes first." },
  {
    _tag: "Tool",
    at: t0 + 3_000,
    call: "c1",
    tool: "run_shell_command",
    args: '{"command":"pnpm test"}'
  },
  {
    _tag: "ToolResult",
    at: t0 + 9_000,
    call: "c1",
    output: "FAIL a.test.ts\nexpected 1\nreceived 2\nmore\nlines",
    failed: true
  },
  { _tag: "End", at: t0 + 130_000, call: "c1", ms: 130_000 },
  {
    _tag: "Call",
    at: t0 + 140_000,
    call: "c2",
    role: "judge",
    input: "Judge this story",
    earlier: 0
  },
  { _tag: "Reply", at: t0 + 150_000, call: "c2", text: "cleared" },
  { _tag: "End", at: t0 + 151_000, call: "c2", ms: 11_000 }
]

describe("transcripts", () => {
  it("are wanted with LLM4TS_TRANSCRIPT, one file per story", () => {
    assert.isTrue(transcriptsWanted({ LLM4TS_TRANSCRIPT: "on" }))
    assert.isFalse(transcriptsWanted({}))
    assert.strictEqual(transcriptFileOf("home"), "home.jsonl")
    assert.strictEqual(transcriptFileOf(undefined), "run.jsonl")
    assert.strictEqual(transcriptFileOf("a/b"), "a_b.jsonl")
  })

  it("read as a conversation: who speaks, the input, the reply, the tools and their results", () => {
    const lines = renderTranscript(entries, { width: 60 })
    assert.deepStrictEqual(lines, [
      "── 00:00:00 coder · gemini ─────────────────────────────────",
      "▶ system: You implement stories.",
      "▶ Task 1: add the route",
      "◀ Reading the routes first.",
      "⚙ run_shell_command pnpm test",
      "  ↳ failed: FAIL a.test.ts · expected 1 · received 2 …",
      "  (2m10s)",
      "── 00:02:20 judge ──────────────────────────────────────────",
      "▶ Judge this story",
      "◀ cleared",
      "  (11s)"
    ])
  })

  it("filters by role and executor, wraps long text and keeps the last lines", () => {
    assert.deepStrictEqual(renderTranscript(entries, { width: 60, role: "judge" }).slice(0, 2), [
      "── 00:02:20 judge ──────────────────────────────────────────",
      "▶ Judge this story"
    ])
    assert.strictEqual(
      renderTranscript(entries, { width: 60, executor: "gemini" }).filter((line) =>
        line.startsWith("──")
      ).length,
      1
    )
    const long: TranscriptEntry = {
      _tag: "Call",
      at: t0,
      call: "c9",
      role: "coder",
      input: "word ".repeat(40)
    }
    const wrapped = renderTranscript([long], { width: 30 })
    assert.isTrue(wrapped.every((line) => [...line].length <= 30))
    assert.deepStrictEqual(renderTranscript(entries, { width: 60, last: 2 }), [
      "◀ cleared",
      "  (11s)"
    ])
  })

  it.effect(
    "loads a story's file, or every file for an executor, and knows when there is none",
    () =>
      Effect.gen(function* () {
        const line = Schema.encodeSync(Schema.fromJsonString(TranscriptEntrySchema))
        const lines = (picked: ReadonlyArray<TranscriptEntry>) =>
          picked.map((entry) => line(entry)).join("\n")
        const disk: Record<string, string> = {
          "/t/run-1/home.jsonl": `${lines(entries.slice(0, 1))}\n{"torn`,
          "/t/run-1/run.jsonl": `${lines(entries.slice(6, 7))}\n`
        }
        const files = {
          read: (path: string) => Effect.succeed(disk[path]),
          list: (directory: string) =>
            Object.keys(disk)
              .filter((path) => path.startsWith(`${directory}/`))
              .map((path) => path.slice(directory.length + 1))
        }
        const home = yield* loadTranscript(files, "/t/run-1", { lane: "home" })
        assert.deepStrictEqual(
          home?.map((entry) => entry.call),
          ["c1"]
        )
        const all = yield* loadTranscript(files, "/t/run-1", { executor: "gemini" })
        assert.deepStrictEqual(
          all?.map((entry) => entry.call),
          ["c1", "c2"]
        )
        assert.isUndefined(yield* loadTranscript(files, "/t/run-2", { lane: "home" }))
      })
  )
})
