import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { EpicRun, appendEpicRun, epicRunsPath, readEpicRuns } from "@llm4ts/flow/EpicRuns"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"

describe("EpicRuns", () => {
  it.effect("remembers every run of an epic with its trace, and skips a torn line", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const stateDir = "/repo/.llm4ts/epics/conto"
      assert.deepStrictEqual(yield* readEpicRuns(memory.store, stateDir), [])
      const first = EpicRun.make({
        runId: "run-1",
        tracePath: "/repo/.llm4ts/trace-1.jsonl",
        action: "RunPlan",
        startedAt: 1
      })
      const second = EpicRun.make({
        runId: "run-2",
        tracePath: "/repo/.llm4ts/trace-2.jsonl",
        action: "RunRound",
        round: 1,
        startedAt: 2
      })
      yield* appendEpicRun(memory.store, stateDir, first)
      yield* memory.store.append(epicRunsPath(stateDir), '{"runId":"run-torn"\n')
      yield* appendEpicRun(memory.store, stateDir, second)
      assert.strictEqual(epicRunsPath(stateDir), "/repo/.llm4ts/epics/conto/runs.jsonl")
      assert.deepStrictEqual(yield* readEpicRuns(memory.store, stateDir), [first, second])
    })
  )
})
