import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { TokenUsage } from "@llm4ts/core/Models"
import { TokensUsed } from "@llm4ts/flow/FlowEvents"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import {
  isTraceFileName,
  makeCostsProgram,
  renderCostsResult,
  type CostsDependencies
} from "@llm4ts/runner/Costs"

const at = (iso: string): number => Date.parse(iso)

const tokensLine = (seq: number, timestamp: number, runId: string, total: number): string =>
  JSON.stringify(
    TraceLine.make({
      schemaVersion: 1,
      seq,
      timestamp,
      runId,
      kind: "TokensUsed",
      fields: {
        event: JSON.stringify(
          TokensUsed.make({
            agent: "coder",
            model: "claude-sonnet-4",
            usage: TokenUsage.make({ prompt: total - 1, completion: 1, total })
          })
        )
      }
    })
  )

const traces: Readonly<Record<string, string>> = {
  "/a/.llm4ts/trace-1.jsonl": [
    tokensLine(0, at("2026-09-18T09:00:00Z"), "1", 1_000),
    tokensLine(1, at("2026-09-18T09:30:00Z"), "1", 3_000)
  ].join("\n"),
  "/a/.llm4ts/loop-trace-2.jsonl": tokensLine(0, at("2026-09-19T10:00:00Z"), "2", 2_000),
  "/b/.llm4ts/trace-3.jsonl": "{not a trace line",
  "/b/.llm4ts/trace-4.jsonl": tokensLine(0, at("2026-09-20T11:00:00Z"), "4", 500)
}

const dependencies = Effect.map(
  makeMemoryPlainFileStore(traces),
  (memory): CostsDependencies => ({
    files: memory.store,
    listTraces: (directory) =>
      Object.keys(traces)
        .filter((path) => path.startsWith(`${directory}/`))
        .sort()
  })
)

describe("trace discovery", () => {
  it("recognises the runner's trace names and prefixed variants only", () => {
    assert.isTrue(isTraceFileName("trace-1785321641666.jsonl"))
    assert.isTrue(isTraceFileName("loop-trace-1785321641666.jsonl"))
    assert.isFalse(isTraceFileName("costs.jsonl"))
    assert.isFalse(isTraceFileName("trace-notes.jsonl"))
    assert.isFalse(isTraceFileName("trace-1.jsonl.bak"))
  })
})

describe("makeCostsProgram", () => {
  it.effect("aggregates every readable trace across repositories and reports the rest", () =>
    Effect.gen(function* () {
      const result = yield* makeCostsProgram({ repos: ["/a", "/b"] }, yield* dependencies)

      assert.strictEqual(result.traces, 4)
      assert.deepStrictEqual(
        result.skipped.map((entry) => entry.path),
        ["/b/.llm4ts/trace-3.jsonl"]
      )
      assert.match(result.skipped[0]?.reason ?? "", /malformed trace/)
      assert.strictEqual(result.report.runs, 3)
      assert.strictEqual(result.report.measured.total, 6_500)
      assert.deepStrictEqual(
        result.report.byDay.map((bucket) => [bucket.key, bucket.measured.total]),
        [
          ["2026-09-18", 4_000],
          ["2026-09-19", 2_000],
          ["2026-09-20", 500]
        ]
      )

      const text = renderCostsResult(result)
      assert.match(text, /traces read: 3 of 4/)
      assert.match(text, /skipped \/b\/\.llm4ts\/trace-3\.jsonl: /)
    })
  )

  it.effect("drops token reports before the requested start and forwards the projection", () =>
    Effect.gen(function* () {
      const result = yield* makeCostsProgram(
        { repos: ["/a", "/b"], since: at("2026-09-19T00:00:00Z"), runsPerDay: 4 },
        yield* dependencies
      )

      assert.strictEqual(result.report.runs, 2)
      assert.strictEqual(result.report.measured.total, 2_500)
      assert.strictEqual(result.report.projection?.tokensPerDay, 5_000)
    })
  )

  it.effect("reports an empty window when a repository holds no traces", () =>
    Effect.gen(function* () {
      const result = yield* makeCostsProgram({ repos: ["/none"] }, yield* dependencies)

      assert.strictEqual(result.traces, 0)
      assert.match(renderCostsResult(result), /no usage recorded/)
    })
  )
})
