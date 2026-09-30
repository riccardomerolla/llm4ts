import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { appendEpicRun, EpicRun } from "@llm4ts/flow/EpicRuns"
import { makeMemoryPlainFileStore, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { makeWatchProgram, type WatchDependencies } from "@llm4ts/runner/Watch"

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

const setup = (keys: ReadonlyArray<string> = [], interactive = false) =>
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
      keys: Stream.fromIterable(keys)
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
      // Every frame fits the terminal's 32 rows and keeps its status lines.
      const frames = text.split("\u001b[H\u001b[2J").slice(1)
      assert.isAbove(frames.length, 1)
      for (const frame of frames) {
        const lines = frame.replace("\u001b[?25h\u001b[?1049l", "").split("\n")
        assert.isAtMost(lines.length, 32)
        assert.include(lines.at(-1) ?? "", "run [completed]")
      }
    })
  )
})
