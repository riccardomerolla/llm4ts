import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { UnknownStory } from "@llm4ts/flow/OperatorSchemas"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { isSafeStoryId, storyDetailOf, storyDiagnosisOf } from "@llm4ts/runner/StoryReaders"
import { seeded, stateDir, trace } from "./support/retroFixture.ts"

const tracePath = "/repo/.llm4ts/runs/run-1/trace.jsonl"

const recording = Effect.gen(function* () {
  const files = yield* seeded
  yield* files.writeAtomic(tracePath, trace.map((line) => JSON.stringify(line)).join("\n") + "\n")
  yield* files.writeAtomic(`${stateDir}/stories/a/gates/test.log`, "FAIL route\nexit 1\n")
  const reads: Array<string> = []
  const store: PlainFileStoreShape = {
    ...files,
    read: (path) => {
      reads.push(path)
      return files.read(path)
    }
  }
  return {
    reads,
    sources: {
      files: store,
      listFiles: (directory: string) =>
        directory === `${stateDir}/stories/a/gates` ? ["test.log"] : []
    }
  }
})

describe("story readers", () => {
  it("accepts plain ids and refuses paths", () => {
    assert.isTrue(isSafeStoryId("a"))
    assert.isTrue(isSafeStoryId("story-1.x_y"))
    assert.isFalse(isSafeStoryId("../a"))
    assert.isFalse(isSafeStoryId("a/b"))
    assert.isFalse(isSafeStoryId(""))
  })

  it.effect("storyDetailOf reads state, board, tasks and findings for a story", () =>
    Effect.gen(function* () {
      const { sources } = yield* recording
      const detail = yield* storyDetailOf(sources, stateDir, "a")
      assert.strictEqual(detail.id, "a")
      assert.strictEqual(detail.state?.status, "failed")
      assert.strictEqual(detail.board?.status, "failed")
      assert.deepStrictEqual(
        detail.tasks.map((task) => task.completed),
        [true, false]
      )
      assert.include(detail.findings ?? "", "judge round 1")
      assert.deepStrictEqual(detail.gateLogs, [`${stateDir}/stories/a/gates/test.log`])
    })
  )

  it.effect("storyDetailOf refuses a story id with a path", () =>
    Effect.gen(function* () {
      const { sources, reads } = yield* recording
      for (const id of ["../a", "a/b", "nope"]) {
        const error = yield* Effect.flip(storyDetailOf(sources, stateDir, id))
        assert.instanceOf(error, UnknownStory)
      }
      assert.isFalse(reads.some((path) => path.includes("..")))
    })
  )

  it.effect("storyDiagnosisOf returns the story's digest and the board reason", () =>
    Effect.gen(function* () {
      const { sources } = yield* recording
      const diagnosis = yield* storyDiagnosisOf(sources, {
        stateDir,
        storyId: "a",
        runId: "run-1",
        tracePath,
        transcriptsDir: undefined,
        budget: 8_000
      })
      assert.strictEqual(diagnosis.story, "a")
      assert.include(diagnosis.digest, "Story a")
      assert.include(diagnosis.digest, "no test for the route")
      assert.strictEqual(diagnosis.failure?.message, "judge not cleared after 1 revision")
      assert.strictEqual(diagnosis.gateLogTails[0]?.tail, "FAIL route\nexit 1")
    })
  )
})
