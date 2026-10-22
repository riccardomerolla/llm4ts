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
import { summarizeTree } from "@llm4ts/runner/RunSummary"

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
