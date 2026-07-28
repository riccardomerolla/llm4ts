import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { TokenUsage } from "@llm4ts/core/Models"
import {
  BenchCounters,
  BenchJudge,
  BenchMachine,
  BenchQuality,
  BenchRecord,
  BenchScore,
  BenchTokens,
  CurrentBenchSchema,
  emptyBenchObservation,
  makeBenchPhase,
  observeBench,
  stageBenchCounters,
  stageBenchTokens
} from "@llm4ts/flow/Bench"
import {
  appendBenchRecord,
  loadBenchRecords,
  median,
  renderBenchReport
} from "@llm4ts/flow/BenchReport"
import { Info, StageCompleted, StageStarted, TokensUsed } from "@llm4ts/flow/FlowEvents"
import { memoryFiles } from "./MemoryFiles.ts"

const record = (provider: string, totalMs: number, prompt: number): BenchRecord =>
  BenchRecord.make({
    schemaVersion: CurrentBenchSchema,
    runId: `${provider}-${totalMs}`,
    startedAt: "2026-07-28T10:00:00Z",
    finishedAt: "2026-07-28T10:01:00Z",
    provider,
    modelRequested: "gpt-5.5",
    modelsServed: ["gpt-5.5"],
    judge: BenchJudge.make({
      provider: "fixed",
      model: "judge",
      fixed: true
    }),
    llm4tsVersion: "0.0.0",
    pack: "fixture",
    fixtureFingerprint: "abcdef1234",
    machine: BenchMachine.make({
      hostname: "host",
      os: "test",
      arch: "arm64",
      cores: 8,
      memoryGb: 32,
      runtime: "node"
    }),
    outcome: "completed",
    totalMs,
    phases: [
      makeBenchPhase(
        {
          ...emptyBenchObservation(),
          cells: new Map([
            [
              '["Extract","gpt-5.5"]',
              BenchTokens.make({
                prompt,
                completion: 100,
                cached: 0
              })
            ]
          ]),
          cellKeys: new Map([['["Extract","gpt-5.5"]', ["Extract", "gpt-5.5"]]])
        },
        "Extract",
        totalMs
      )
    ],
    quality: BenchQuality.make({
      buildPassed: true,
      coveragePct: 100,
      featureFiles: 1,
      scenarios: 1,
      malformedFeatures: 0,
      specFiles: 1,
      programs: 2,
      sourceFiles: 1,
      sourceLines: 10,
      testFiles: 1,
      testLines: 10,
      deterministicFindings: 0,
      judgeFindings: 0,
      gateCleared: true,
      judgeScores: [
        BenchScore.make({
          name: "quality",
          score: 2,
          max: 2,
          reasoning: "complete"
        })
      ]
    })
  })

describe("benchmark observation", () => {
  it("attributes tokens to outermost stages and counts robustness notices", () => {
    const events = [
      StageStarted.make({ stage: "Extract" }),
      StageStarted.make({ stage: "Inner" }),
      TokensUsed.make({
        agent: "coder",
        model: "gpt-5.5",
        usage: TokenUsage.make({
          prompt: 100,
          completion: 10,
          total: 110
        })
      }),
      Info.make({ message: "⟳ flaky stream retry 1" }),
      Info.make({ message: "turn limit hit after work" }),
      StageCompleted.make({ stage: "Inner" }),
      StageCompleted.make({ stage: "Extract" })
    ]
    const observation = events.reduce(observeBench, emptyBenchObservation())
    const phase = makeBenchPhase(observation, "Extract", 1_000)

    assert.deepStrictEqual(
      stageBenchTokens(observation, "Extract"),
      BenchTokens.make({ prompt: 100, completion: 10, cached: 0 })
    )
    assert.strictEqual(stageBenchCounters(observation, "Extract").flakyRetries, 1)
    assert.strictEqual(stageBenchCounters(observation, "Extract").turnLimitTrips, 1)
    assert.strictEqual(phase.name, "Extract")
  })
})

describe("benchmark report and codec", () => {
  it("renders deterministic comparisons, medians, projections, and neutral costs", () => {
    const report = renderBenchReport(
      [record("gemini", 8_000, 1_000_000), record("claude", 12_000, 1_500_000)],
      500
    )

    assert.strictEqual(median([3, 1, 2]), 2)
    assert.match(report, /\| Total time \| 12\.0s ⚠️ \| \*\*8\.0s ✅\*\*/)
    assert.match(report, /same examiner/)
    assert.match(report, /Projection @ 500 programs/)
    assert.match(report, /Linear extrapolation/)
    const costRow = report.split("\n").find((line) => line.startsWith("| Est. cost"))
    assert.notMatch(costRow ?? "", /✅|⚠️/)
  })

  it.effect("round-trips versioned benchmark JSONL records", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make<Readonly<Record<string, string>>>({})
      const files = memoryFiles(state)
      yield* appendBenchRecord(files, "bench.jsonl", record("gemini", 8_000, 100))
      const loaded = yield* loadBenchRecords(files, "bench.jsonl")

      assert.strictEqual(loaded.length, 1)
      assert.strictEqual(loaded[0]?.provider, "gemini")
      assert.strictEqual(loaded[0]?.completed, true)
    })
  )

  it("retains explicit counter semantics", () => {
    const counters = BenchCounters.make({
      flakyRetries: 1,
      transientRetries: 2,
      autoResumes: 3,
      turnLimitTrips: 9,
      shrinks: 4
    })
    assert.strictEqual(counters.selfHealing, 10)
  })
})
