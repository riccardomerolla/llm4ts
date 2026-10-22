import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import {
  ignoringRunState,
  runStateDeniedPaths,
  runStateIgnoreContents,
  runStateRootOf
} from "@llm4ts/flow/RunState"

describe("RunState", () => {
  it("finds the .llm4ts root of a path, the outermost one, on either separator", () => {
    assert.strictEqual(runStateRootOf("/repo/.llm4ts/trace-1.jsonl"), "/repo/.llm4ts")
    assert.strictEqual(runStateRootOf(".llm4ts/costs.jsonl"), ".llm4ts")
    assert.strictEqual(runStateRootOf(".llm4ts"), ".llm4ts")
    assert.strictEqual(
      runStateRootOf("/repo/.llm4ts/port/shards/1/.llm4ts/trace.jsonl"),
      "/repo/.llm4ts"
    )
    assert.strictEqual(runStateRootOf("C:\\repo\\.llm4ts\\plan.md"), "C:\\repo\\.llm4ts")
    assert.strictEqual(runStateRootOf("/repo/src/.llm4tsx/file"), undefined)
    assert.strictEqual(runStateRootOf("/repo/src/a.llm4ts"), undefined)
    assert.strictEqual(runStateRootOf("/repo/src/Main.ts"), undefined)
  })

  it.effect("the first write under .llm4ts leaves a .gitignore that ignores everything", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const store = ignoringRunState(memory.store)
      yield* store.append("/repo/.llm4ts/trace-1.jsonl", "{}\n")
      yield* store.writeAtomic("/repo/.llm4ts/plan-abc.md", "# plan\n")
      yield* store.writeAtomic("/repo/src/Main.ts", "export {}\n")
      const files = yield* memory.files
      assert.deepStrictEqual(Object.keys(files).sort(), [
        "/repo/.llm4ts/.gitignore",
        "/repo/.llm4ts/plan-abc.md",
        "/repo/.llm4ts/trace-1.jsonl",
        "/repo/src/Main.ts"
      ])
      assert.strictEqual(files["/repo/.llm4ts/.gitignore"], runStateIgnoreContents)
      assert.strictEqual(runStateIgnoreContents, "*\n")
      assert.deepStrictEqual(runStateDeniedPaths, [".llm4ts/**"])
    })
  )

  it.effect("an ignore file the repository already has is kept, and one per root", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore({
        "/repo/.llm4ts/.gitignore": "*\n!flows/\n"
      })
      const store = ignoringRunState(ignoringRunState(memory.store))
      yield* store.append("/repo/.llm4ts/trace-1.jsonl", "{}\n")
      yield* store.append("/repo/.llm4ts/trace-2.jsonl", "{}\n")
      yield* store.writeAtomic("/other/.llm4ts/costs.jsonl", "{}\n")
      const files = yield* memory.files
      assert.strictEqual(files["/repo/.llm4ts/.gitignore"], "*\n!flows/\n")
      assert.strictEqual(files["/other/.llm4ts/.gitignore"], "*\n")
    })
  )
})
