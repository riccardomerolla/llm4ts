import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { TokenUsage } from "@llm4ts/core/Models"
import {
  CostBudget,
  CostCell,
  appendCostRecord,
  checkCostBudget,
  loadCostLedger,
  makeCostRecord,
  mergeCostCells
} from "@llm4ts/flow/CostLedger"
import { makeCostTracker } from "@llm4ts/flow/CostTracker"
import { Info, StageCompleted, StageStarted, TokensUsed } from "@llm4ts/flow/FlowEvents"
import { estimateCostUsd } from "@llm4ts/flow/PriceList"
import { memoryFiles } from "./MemoryFiles.ts"

describe("pricing and cost tracking", () => {
  it("matches pinned prefix rates including cached input", () => {
    assert.strictEqual(
      estimateCostUsd(
        "gpt-5.5-codex",
        TokenUsage.make({
          prompt: 1_000_000,
          completion: 100_000,
          total: 1_100_000,
          cached: 1_000_000
        })
      ),
      8.5
    )
    assert.strictEqual(
      estimateCostUsd("unknown", TokenUsage.make({ prompt: 1, completion: 1, total: 2 })),
      undefined
    )
  })

  it.effect("attributes usage to the innermost stage and renders an estimated summary", () =>
    Effect.gen(function* () {
      const tracker = yield* makeCostTracker()
      yield* tracker.record(Info.make({ message: "ignored" }))
      yield* tracker.record(StageStarted.make({ stage: "Extract" }))
      yield* tracker.record(
        TokensUsed.make({
          agent: "coder",
          model: "gemini-2.5-pro",
          usage: TokenUsage.make({
            prompt: 1_000_000,
            completion: 100_000,
            total: 1_100_000,
            cached: 100
          })
        })
      )
      yield* tracker.record(StageStarted.make({ stage: "Task" }))
      yield* tracker.record(
        TokensUsed.make({
          agent: "coder",
          usage: TokenUsage.make({ prompt: 5, completion: 1, total: 6 })
        })
      )
      yield* tracker.record(StageCompleted.make({ stage: "Task" }))
      const cells = yield* tracker.cells
      const summary = yield* tracker.summary

      assert.strictEqual(cells.find(({ stage }) => stage === "Extract")?.prompt, 1_000_000)
      assert.strictEqual(cells.find(({ stage }) => stage === "Task")?.prompt, 5)
      assert.match(summary, /By agent:/)
      assert.match(summary, /100 cached/)
      assert.match(summary, /estimated from the pricing table/)
    })
  )
})

describe("cost ledger and budgets", () => {
  const record = makeCostRecord({
    runId: "run-1",
    at: "2026-07-28T00:00:00Z",
    repo: "repo",
    prompt: "A prompt\nwith whitespace",
    cells: [
      CostCell.make({
        stage: "Build",
        agent: "coder",
        model: "gpt-5.5",
        prompt: 100,
        completion: 10,
        total: 110,
        costUsd: 0.01
      })
    ]
  })

  it.effect("round-trips append-only records and merges cells deterministically", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make<Readonly<Record<string, string>>>({})
      const files = memoryFiles(state)
      yield* appendCostRecord(files, "costs.jsonl", record)
      yield* appendCostRecord(
        files,
        "costs.jsonl",
        makeCostRecord({
          runId: "run-2",
          at: record.at,
          repo: record.repo,
          prompt: "same",
          cells: record.cells
        })
      )
      const loaded = yield* loadCostLedger(files, "costs.jsonl")
      const merged = mergeCostCells(loaded)

      assert.deepStrictEqual(
        loaded.map(({ runId }) => runId),
        ["run-1", "run-2"]
      )
      assert.strictEqual(merged[0]?.prompt, 200)
      assert.strictEqual(record.promptHead, "A prompt with whitespace")
      assert.strictEqual(
        record.promptHash,
        makeCostRecord({
          runId: "other",
          at: record.at,
          repo: record.repo,
          prompt: "A prompt\nwith whitespace",
          cells: []
        }).promptHash
      )
    })
  )

  it.effect("rejects token and cost overruns as typed budget failures", () =>
    Effect.gen(function* () {
      const tokenFailure = yield* Effect.flip(
        checkCostBudget(record, CostBudget.make({ maximumTokens: 100 }))
      )
      const costFailure = yield* Effect.flip(
        checkCostBudget(record, CostBudget.make({ maximumCostUsd: 0.001 }))
      )

      assert.strictEqual(tokenFailure.metric, "tokens")
      assert.strictEqual(costFailure.metric, "costUsd")
    })
  )
})
