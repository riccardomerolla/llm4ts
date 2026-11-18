import { assert, describe, it } from "@effect/vitest"
import { TokenUsage } from "@llm4ts/core/Models"
import {
  ExecutorLeased,
  StageStarted,
  StoryStatusChanged,
  TokensUsed,
  type FlowEvent
} from "@llm4ts/flow/FlowEvents"
import { emptyTree, reduceTree, type TreeInput, type TreeState } from "@llm4ts/runner/AgentTree"
import { plainProgressLine, summarizeTree, type PlainProgress } from "@llm4ts/runner/RunSummary"

const t0 = 1_790_000_000_000

const at = (minutes: number, event: FlowEvent): TreeInput => ({
  _tag: "Event",
  at: t0 + minutes * 60_000,
  event
})

const fold = (inputs: ReadonlyArray<TreeInput>): TreeState =>
  inputs.reduce(reduceTree, emptyTree({ title: "epic-stories" }))

const status = (minutes: number, id: string, to: StoryStatusChanged["status"]): TreeInput =>
  at(minutes, StoryStatusChanged.make({ id, status: to }))

describe("summarizeTree", () => {
  it("renders done, active and failed stories with executor, stage and cost", () => {
    const state = fold([
      status(0, "a", "done"),
      status(0, "b", "done"),
      status(0, "c", "done"),
      status(1, "payments", "active"),
      status(1, "notifications", "failed"),
      at(2, StageStarted.make({ stage: "story payments", lane: "payments", executor: "codex" })),
      at(3, ExecutorLeased.make({ executor: "codex", role: "coder", label: "payments" })),
      at(4, StageStarted.make({ stage: "review", lane: "payments" })),
      at(
        42,
        TokensUsed.make({
          agent: "coder",
          usage: TokenUsage.make({ prompt: 1, completion: 1, total: 2, costUsd: 12.4 })
        })
      )
    ])
    assert.strictEqual(
      summarizeTree(state, "epic-stories"),
      "epic-stories, 42 min: 3 stories done, 1 active (payments, codex, review), 1 failed (notifications: failed), $12.40"
    )
  })

  it("renders an ended run and an empty one", () => {
    const empty = emptyTree({ title: "epic-stories" })
    assert.strictEqual(
      summarizeTree(empty, "epic-stories"),
      "epic-stories, 0 min: no stories yet, $0.00"
    )
    const ended = reduceTree(
      fold([status(0, "a", "done"), at(75, StageStarted.make({ stage: "story b", lane: "b" }))]),
      { _tag: "RunEnded", at: t0 + 75 * 60_000, outcome: "succeeded" }
    )
    assert.strictEqual(
      summarizeTree(ended, undefined),
      "succeeded, epic-stories, 1 h 15 min: 1 stories done, 0 active, 0 failed, $0.00"
    )
  })
})

describe("plainProgressLine", () => {
  const id = "op-1-ab12"
  const at = (tasksDone: number, tasksTotal = 4): PlainProgress => ({ tasksTotal, tasksDone })
  const withoutBranch = { outcome: "completed", minutes: 11, costUsd: 1.37 }
  const ended = { ...withoutBranch, branch: "llm4ts/csv-export", commits: 4 }

  it("announces the plan once, then each task that finishes", () => {
    assert.strictEqual(plainProgressLine(id, undefined, at(0)), "op-1-ab12: plan written, 4 tasks")
    assert.strictEqual(plainProgressLine(id, at(1), at(2)), "op-1-ab12: task 2 of 4 done")
  })

  it("says nothing when nothing changed or there is no plan", () => {
    assert.isUndefined(plainProgressLine(id, at(2), at(2)))
    assert.isUndefined(plainProgressLine(id, undefined, at(0, 0)))
  })

  it("closes with outcome, time, cost, branch and commits", () => {
    assert.strictEqual(
      plainProgressLine(id, at(3), { ...at(4), ended }),
      "op-1-ab12 finished completed in 11 min, $1.37. Branch llm4ts/csv-export, 4 commits."
    )
    assert.strictEqual(
      plainProgressLine(id, at(3), { ...at(3), ended: withoutBranch }),
      "op-1-ab12 finished completed in 11 min, $1.37."
    )
  })
})
