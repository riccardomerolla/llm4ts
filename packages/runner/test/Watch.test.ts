import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { appendEpicRun, EpicRun } from "@llm4ts/flow/EpicRuns"
import { makeMemoryPlainFileStore, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { makeWatchProgram, type WatchDependencies } from "@llm4ts/runner/Watch"
import { TranscriptEntry } from "@llm4ts/flow/Transcript"
import * as Schema from "effect/Schema"

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")

const epicDir = "/repo/.llm4ts/epics/conto"
const ended = `${fixture("agent-tree.trace.jsonl")}${JSON.stringify({
  schemaVersion: 1,
  seq: 99,
  timestamp: 1_790_000_500_000,
  runId: "run-fixture",
  kind: "RunEnded",
  fields: { outcome: "completed" }
})}\n`

const transcriptLine = Schema.encodeSync(Schema.fromJsonString(TranscriptEntry))
const paymentsTranscript: ReadonlyArray<TranscriptEntry> = [
  {
    _tag: "Call",
    at: 1,
    call: "c1",
    role: "coder",
    executor: "pi-lmstudio",
    input: "Add the fake routes"
  },
  { _tag: "Reply", at: 2, call: "c1", text: "Writing " },
  { _tag: "Reply", at: 3, call: "c1", text: "payments.fake.ts" },
  { _tag: "Tool", at: 4, call: "c1", tool: "bash", args: '{"command":"pnpm test"}' },
  { _tag: "ToolResult", at: 9, call: "c1", output: "3 passed" },
  { _tag: "End", at: 10, call: "c1", ms: 9 }
]

const setup = (
  keys: ReadonlyArray<string> = [],
  interactive = false,
  transcript: Readonly<Record<string, string>> = {
    "/repo/.llm4ts/transcripts/run-fixture/payments.jsonl": `${paymentsTranscript
      .map((entry) => transcriptLine(entry))
      .join("\n")}\n`
  }
) =>
  Effect.gen(function* () {
    const memory = yield* makeMemoryPlainFileStore({
      "/repo/.llm4ts/trace-1790000000000.jsonl": ended,
      "/repo/.llm4ts/trace-1700000000000.jsonl": "",
      [`${epicDir}/board.json`]: fixture("agent-tree.board.json")
    })
    yield* appendEpicRun(
      memory.store,
      epicDir,
      EpicRun.make({
        runId: "run-fixture",
        tracePath: "/repo/.llm4ts/trace-1790000000000.jsonl",
        action: "RunPlan",
        startedAt: 1
      })
    )
    const written = yield* Ref.make("")
    const dependencies: WatchDependencies = {
      files: memory.store,
      listTraces: (directory) =>
        directory === "/repo/.llm4ts"
          ? ["/repo/.llm4ts/trace-1700000000000.jsonl", "/repo/.llm4ts/trace-1790000000000.jsonl"]
          : [],
      listEpics: (directory) => (directory === "/repo/.llm4ts/epics" ? ["conto", "other"] : []),
      output: {
        write: (text) => Ref.update(written, (all) => all + text),
        columns: () => 90,
        rows: () => 32,
        interactive,
        colour: false
      },
      keys: Stream.fromIterable(keys),
      transcripts: {
        read: (path) => Effect.succeed(transcript[path]),
        list: (directory) =>
          Object.keys(transcript)
            .filter((path) => path.startsWith(`${directory}/`))
            .map((path) => path.slice(directory.length + 1))
      }
    }
    return { files: memory.store satisfies PlainFileStoreShape, written, dependencies }
  })

describe("llm4ts watch", () => {
  it.effect("prints the last frame of a finished run, with its epic's board", () =>
    Effect.gen(function* () {
      const { written, dependencies } = yield* setup()
      yield* makeWatchProgram(
        { repo: "/repo", trace: "/repo/.llm4ts/trace-1790000000000.jsonl" },
        dependencies
      )
      const text = yield* Ref.get(written)
      assert.include(text, "LLM4TS AGENT TREE  ·  epic conto-bonifico")
      assert.include(text, "run plan")
      assert.include(text, "✓ accounts  ◐ payments  ✗ iban  ◐ overview  · movimenti")
      assert.include(text, "run [completed]")
      assert.notInclude(text, "\u001b[")
    })
  )

  it.effect("opens an epic's latest run, and the newest trace when given nothing", () =>
    Effect.gen(function* () {
      const byEpic = yield* setup()
      yield* makeWatchProgram({ repo: "/repo", epic: "conto" }, byEpic.dependencies)
      assert.include(yield* Ref.get(byEpic.written), "run [completed]")

      const newest = yield* setup()
      yield* makeWatchProgram({ repo: "/repo" }, newest.dependencies)
      // The newest trace belongs to the epic "conto": its board names the stories.
      assert.include(yield* Ref.get(newest.written), "· movimenti")

      const missing = yield* setup()
      const error = yield* Effect.flip(
        makeWatchProgram({ repo: "/repo", epic: "other" }, missing.dependencies)
      )
      assert.strictEqual(error._tag, "WatchTargetMissing")
      assert.include(error.message, "epic other has no recorded run")
    })
  )

  it.effect("in a terminal, draws full-screen and gives the screen back on q", () =>
    Effect.gen(function* () {
      const { written, dependencies } = yield* setup(["e", "q"], true)
      yield* makeWatchProgram(
        { repo: "/repo", trace: "/repo/.llm4ts/trace-1790000000000.jsonl" },
        dependencies
      )
      const text = yield* Ref.get(written)
      assert.isTrue(text.startsWith("\u001b[?1049h"))
      assert.isTrue(text.endsWith("\u001b[?1049l"))
      // `e` switched to the executor columns before `q`.
      assert.include(text, "│ no lease")
      // One clear, then only changed rows, never below the terminal's 32 rows.
      assert.strictEqual(text.split("\u001b[2J").length - 1, 1)
      const rows = text
        .split("\u001b[")
        .flatMap((sequence) => /^(\d+);1H/u.exec(sequence)?.[1] ?? [])
        .map(Number)
      assert.isAbove(rows.length, 0)
      assert.isAtMost(Math.max(...rows), 32)
      assert.include(text, "run [completed]")
    })
  )

  it.effect("tails a story's transcript, as it was said, and stops when the run has ended", () =>
    Effect.gen(function* () {
      const { written, dependencies } = yield* setup()
      yield* makeWatchProgram(
        { repo: "/repo", trace: "/repo/.llm4ts/trace-1790000000000.jsonl", tail: "payments" },
        dependencies
      )
      const text = yield* Ref.get(written)
      assert.include(text, "coder · pi-lmstudio")
      assert.include(text, "▶ Add the fake routes")
      assert.include(text, "◀ Writing payments.fake.ts")
      assert.include(text, "⚙ bash pnpm test")
      assert.include(text, "↳ ok: 3 passed")
    })
  )

  it.effect("tails an executor across stories, and says when the run kept no transcript", () =>
    Effect.gen(function* () {
      const byExecutor = yield* setup()
      yield* makeWatchProgram(
        { repo: "/repo", trace: "/repo/.llm4ts/trace-1790000000000.jsonl", tail: "pi-lmstudio" },
        byExecutor.dependencies
      )
      assert.include(yield* Ref.get(byExecutor.written), "◀ Writing payments.fake.ts")
      const other = yield* setup()
      yield* makeWatchProgram(
        { repo: "/repo", trace: "/repo/.llm4ts/trace-1790000000000.jsonl", tail: "claude" },
        other.dependencies
      )
      assert.notInclude(yield* Ref.get(other.written), "Writing")

      const none = yield* setup([], false, {})
      const error = yield* Effect.flip(
        makeWatchProgram(
          { repo: "/repo", trace: "/repo/.llm4ts/trace-1790000000000.jsonl", tail: "payments" },
          none.dependencies
        )
      )
      assert.include(error.message, "no transcript for this run")
    })
  )

  it.effect("opens the selected story's tail in the tree with t", () =>
    Effect.gen(function* () {
      const { written, dependencies } = yield* setup(["1", "t", "q"], true)
      yield* makeWatchProgram(
        { repo: "/repo", trace: "/repo/.llm4ts/trace-1790000000000.jsonl" },
        dependencies
      )
      const text = yield* Ref.get(written)
      assert.include(text, "tail · payments · all")
      assert.include(text, "◀ Writing payments.fake.ts")
    })
  )
})
