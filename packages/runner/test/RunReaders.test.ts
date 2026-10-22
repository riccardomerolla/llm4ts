import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { TokenUsage } from "@llm4ts/core/Models"
import { CostRecord } from "@llm4ts/flow/CostLedger"
import {
  Aborted,
  Info,
  StageFailed,
  StageStarted,
  StoryStatusChanged,
  TokensUsed,
  type FlowEvent
} from "@llm4ts/flow/FlowEvents"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import {
  costsOfRun,
  foldTrace,
  meaningfulEventsAfter,
  runDiagnosisOf,
  runStatusOf,
  TraceUnreadable
} from "@llm4ts/runner/RunReaders"

const t0 = 1_790_000_000_000

const line = (seq: number, kind: string, fields: TraceLine["fields"], schemaVersion = 1) =>
  TraceLine.make({ schemaVersion, seq, timestamp: t0 + seq * 1_000, runId: "run-1", kind, fields })

const event = (seq: number, value: FlowEvent): TraceLine =>
  line(seq, value._tag, { event: JSON.stringify(value) })

const encode = (lines: ReadonlyArray<TraceLine>): string =>
  lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n"

const trace = [
  event(1, StoryStatusChanged.make({ id: "a", status: "active" })),
  event(2, StageStarted.make({ stage: "story a", lane: "a" })),
  event(3, StageStarted.make({ stage: "code", lane: "a" })),
  event(4, Info.make({ message: "gates: pnpm test" })),
  event(5, StageFailed.make({ stage: "gates", message: "tests red", lane: "a" })),
  event(6, StoryStatusChanged.make({ id: "a", status: "failed" })),
  line(7, "RunEnded", { outcome: "failed" })
]

const boardJson = JSON.stringify({
  schemaVersion: 1,
  value: {
    title: "Epic: conto",
    items: [
      { id: "a", title: "A", status: "planned" },
      { id: "b", title: "B", status: "planned" }
    ]
  }
})

const storeOf = (initial: Readonly<Record<string, string>>) =>
  Effect.map(makeMemoryPlainFileStore(initial), (memory) => memory.store)

describe("RunReaders", () => {
  it.effect("foldTrace seeds stories from the board and folds the trace", () =>
    Effect.gen(function* () {
      const files = yield* storeOf({
        "/t/trace.jsonl": encode(trace),
        "/e/board.json": boardJson
      })
      const fold = yield* foldTrace(files, "/t/trace.jsonl", "/e")
      assert.strictEqual(fold.seq, 7)
      assert.deepStrictEqual(
        fold.state.stories.map((story) => `${story.id}:${story.status}`),
        ["a:failed", "b:planned"]
      )
      assert.strictEqual(fold.state.ended, "failed")
      const status = runStatusOf(
        fold,
        { runId: "run-1", flow: "epic-stories", state: "exited" },
        t0 + 60_000
      )
      assert.strictEqual(status.ended, "failed")
      assert.strictEqual(status.seq, 7)
      assert.strictEqual(status.lanes[0]?.id, "a")
    })
  )

  it.effect("foldTrace reports a trace of a newer schema as TraceUnreadable", () =>
    Effect.gen(function* () {
      const files = yield* storeOf({
        "/t/trace.jsonl": encode([line(1, "Info", {}, 2)])
      })
      const exit = yield* Effect.exit(foldTrace(files, "/t/trace.jsonl"))
      assert.isTrue(Exit.isFailure(exit))
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        const error = failure?._tag === "Fail" ? failure.error : undefined
        assert.isTrue(error instanceof TraceUnreadable)
        assert.strictEqual(error instanceof TraceUnreadable ? error._tag : "", "TraceUnreadable")
        assert.strictEqual(error instanceof TraceUnreadable ? error.path : "", "/t/trace.jsonl")
      }
    })
  )

  it("meaningfulEventsAfter returns only meaningful kinds after the sequence", () => {
    const events = meaningfulEventsAfter(trace, 2)
    assert.deepStrictEqual(
      events.map((entry) => [entry.seq, entry.kind, entry.text]),
      [
        [5, "StageFailed", "gates failed: tests red"],
        [6, "StoryStatusChanged", "story a failed"],
        [7, "RunEnded", "run failed"]
      ]
    )
  })

  it.effect("runDiagnosisOf names the failing stage and the open tasks", () =>
    Effect.gen(function* () {
      const files = yield* storeOf({
        "/t/base.jsonl": encode(trace),
        "/t/trace.jsonl": encode([
          ...trace,
          event(8, Aborted.make({ message: "stalled (silence): 5m" }))
        ]),
        "/e/plan.md": "# Plan: conto\n\n## [x] One\nDone.\n\n## [ ] Two\nTodo.\n",
        "/g/gate.log": "one\ntwo\nthree\n"
      })
      const diagnosis = yield* runDiagnosisOf(
        { files, listFiles: (directory) => (directory === "/g" ? ["gate.log"] : []) },
        {
          runId: "run-1",
          tracePath: "/t/trace.jsonl",
          planPath: "/e/plan.md",
          transcriptsDir: undefined,
          gateLogDir: "/g",
          budget: 4_000
        }
      )
      assert.strictEqual(diagnosis.failure?.message, "stalled (silence): 5m")
      assert.include(diagnosis.digest, "- [x] One")
      assert.include(diagnosis.digest, "- [ ] Two")
      assert.include(diagnosis.digest, "gates failed: tests red")
      assert.strictEqual(diagnosis.gateLogTails[0]?.tail, "one\ntwo\nthree")

      const staged = yield* runDiagnosisOf(
        { files, listFiles: () => [] },
        {
          runId: "run-1",
          tracePath: "/t/base.jsonl",
          planPath: undefined,
          transcriptsDir: undefined,
          gateLogDir: undefined,
          budget: 4_000
        }
      )
      assert.strictEqual(staged.failure?.stage, "gates")
      assert.strictEqual(staged.failure?.lane, "a")
    })
  )

  it.effect("costsOfRun flags a ledger that disagrees", () =>
    Effect.gen(function* () {
      const used = TokensUsed.make({
        agent: "coder",
        model: "m",
        usage: TokenUsage.make({ prompt: 10, completion: 5, total: 15, costUsd: 1.5 })
      })
      const record = CostRecord.make({
        schemaVersion: 1,
        runId: "run-1",
        at: "2026-10-22T00:00:00Z",
        repo: "/repo",
        promptHead: "",
        promptHash: "h",
        pricesAsOf: "2026-01-01",
        cells: [],
        totalPrompt: 10,
        totalCompletion: 5,
        totalCostUsd: 2
      })
      const files = yield* storeOf({
        "/t/trace.jsonl": encode([event(1, used)]),
        "/t/costs.jsonl": JSON.stringify(record) + "\n"
      })
      const costs = yield* costsOfRun(files, "/t/trace.jsonl", "/t/costs.jsonl", "run-1")
      assert.strictEqual(costs.total, 1.5)
      assert.strictEqual(costs.ledger, 2)
      assert.isTrue(costs.differs)
      const none = yield* costsOfRun(files, "/t/trace.jsonl", "/t/costs.jsonl", "other")
      assert.isUndefined(none.ledger)
      assert.isFalse(none.differs)
    })
  )
})
