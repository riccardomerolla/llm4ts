import { assert, describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import { TokenUsage } from "@llm4ts/core/Models"
import {
  CostReport,
  UsageProjection,
  UsageSample,
  buildCostReport,
  renderCostReport,
  usageSamplesFromTrace
} from "@llm4ts/flow/CostReport"
import { TokensUsed } from "@llm4ts/flow/FlowEvents"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"

const at = (iso: string): number => Date.parse(iso)

const traceLine = (
  seq: number,
  timestamp: number,
  runId: string,
  kind: string,
  event: unknown
): TraceLine =>
  TraceLine.make({
    schemaVersion: 1,
    seq,
    timestamp,
    runId,
    kind,
    fields: { event: typeof event === "string" ? event : JSON.stringify(event) }
  })

const tokens = (
  seq: number,
  timestamp: number,
  runId: string,
  usage: TokenUsage,
  model?: string,
  agent = "coder"
): TraceLine =>
  traceLine(
    seq,
    timestamp,
    runId,
    "TokensUsed",
    TokensUsed.make({ agent, usage, ...(model === undefined ? {} : { model }) })
  )

const sample = (
  timestamp: number,
  runId: string,
  total: number,
  options: { model?: string; estimated?: boolean; costUsd?: number; agent?: string } = {}
): UsageSample =>
  UsageSample.make({
    at: timestamp,
    runId,
    agent: options.agent ?? "coder",
    model: options.model ?? "claude-sonnet-4",
    prompt: total - 1,
    completion: 1,
    total,
    estimated: options.estimated ?? false,
    ...(options.costUsd === undefined ? {} : { costUsd: options.costUsd })
  })

describe("usageSamplesFromTrace", () => {
  it("keeps only well-formed TokensUsed lines and prices them like the tracker", () => {
    const measured = TokenUsage.make({ prompt: 1_000_000, completion: 100_000, total: 1_100_000 })
    const reported = TokenUsage.make({ prompt: 10, completion: 5, total: 15, costUsd: 0.5 })
    const lines = [
      traceLine(0, at("2026-09-18T10:00:00Z"), "run-a", "StageStarted", { stage: "Plan" }),
      tokens(1, at("2026-09-18T10:00:01Z"), "run-a", measured, "claude-sonnet-4"),
      tokens(2, at("2026-09-18T10:00:02Z"), "run-a", reported, "gpt-5.5", "reviewer"),
      tokens(3, at("2026-09-18T10:00:03Z"), "run-a", measured, "estimated:claude-sonnet-4"),
      tokens(4, at("2026-09-18T10:00:04Z"), "run-a", measured),
      traceLine(5, at("2026-09-18T10:00:05Z"), "run-a", "TokensUsed", "{not json"),
      traceLine(6, at("2026-09-18T10:00:06Z"), "run-a", "TokensUsed", { agent: "coder" })
    ]

    const samples = usageSamplesFromTrace(lines)

    assert.deepStrictEqual(
      samples.map((entry) => [entry.model, entry.agent, entry.estimated, entry.costUsd]),
      [
        ["claude-sonnet-4", "coder", false, 4.5],
        ["gpt-5.5", "reviewer", false, 0.5],
        ["estimated:claude-sonnet-4", "coder", true, undefined],
        ["(unknown)", "coder", false, undefined]
      ]
    )
    assert.strictEqual(samples[0]?.at, at("2026-09-18T10:00:01Z"))
    assert.strictEqual(samples[0]?.runId, "run-a")
    assert.strictEqual(samples[0]?.total, 1_100_000)
  })
})

describe("buildCostReport", () => {
  const samples: ReadonlyArray<UsageSample> = [
    sample(at("2026-09-18T09:10:00Z"), "run-1", 1_000, { costUsd: 0.5 }),
    sample(at("2026-09-18T09:40:00Z"), "run-1", 3_000, { costUsd: 0.25 }),
    sample(at("2026-09-18T11:05:00Z"), "run-2", 2_000, { costUsd: 0.25, model: "gpt-5.5" }),
    sample(at("2026-09-20T15:00:00Z"), "run-3", 12_000, {
      model: "estimated:claude-sonnet-4",
      estimated: true,
      costUsd: 2
    })
  ]

  it("buckets usage by day and by hour with measured and estimated kept apart", () => {
    const report = buildCostReport(samples)

    assert.strictEqual(report.timeZone, "UTC")
    assert.strictEqual(report.runs, 3)
    assert.strictEqual(report.from, "2026-09-18T09:10:00.000Z")
    assert.strictEqual(report.to, "2026-09-20T15:00:00.000Z")
    assert.deepStrictEqual(
      report.byDay.map((bucket) => [
        bucket.key,
        bucket.runs,
        bucket.measured.total,
        bucket.estimated.total
      ]),
      [
        ["2026-09-18", 2, 6_000, 0],
        ["2026-09-20", 1, 0, 12_000]
      ]
    )
    assert.deepStrictEqual(
      report.byHour.map((bucket) => [bucket.key, bucket.measured.requests, bucket.measured.total]),
      [
        ["2026-09-18 09:00", 2, 4_000],
        ["2026-09-18 11:00", 1, 2_000],
        ["2026-09-20 15:00", 0, 0]
      ]
    )
    assert.strictEqual(report.measured.total, 6_000)
    assert.strictEqual(report.measured.costUsd, 1)
    assert.strictEqual(report.estimated.total, 12_000)
    assert.deepStrictEqual(
      report.byModel.map((entry) => [entry.model, entry.estimated, entry.totals.total]),
      [
        ["claude-sonnet-4", false, 4_000],
        ["gpt-5.5", false, 2_000],
        ["estimated:claude-sonnet-4", true, 12_000]
      ]
    )
  })

  it("derives the averages a budget needs from active and calendar spans", () => {
    const { averages } = buildCostReport(samples)

    assert.strictEqual(averages.activeDays, 2)
    assert.strictEqual(averages.calendarDays, 3)
    assert.strictEqual(averages.activeHours, 3)
    assert.strictEqual(averages.tokensPerActiveDay, 9_000)
    assert.strictEqual(averages.tokensPerCalendarDay, 6_000)
    assert.strictEqual(averages.tokensPerActiveHour, 6_000)
    assert.strictEqual(averages.tokensPerRun, 6_000)
    assert.strictEqual(averages.costUsdPerActiveDay, 1.5)
    assert.strictEqual(averages.costUsdPerRun, 1)
    assert.strictEqual(averages.peakDay, "2026-09-20")
    assert.strictEqual(averages.peakHour, "2026-09-20 15:00")
  })

  it("projects a daily figure from an assumed number of runs per day", () => {
    const report = buildCostReport(samples, { runsPerDay: 5 })

    assert.deepStrictEqual(
      report.projection,
      UsageProjection.make({ runsPerDay: 5, tokensPerDay: 30_000, costUsdPerDay: 5 })
    )
    assert.strictEqual(buildCostReport(samples).projection, undefined)
  })

  it("buckets in the requested time zone", () => {
    const late = [sample(at("2026-09-18T23:30:00Z"), "run-1", 100)]
    const report = buildCostReport(late, { timeZone: DateTime.zoneMakeNamedUnsafe("Europe/Rome") })

    assert.strictEqual(report.timeZone, "Europe/Rome")
    assert.deepStrictEqual(
      report.byDay.map((bucket) => bucket.key),
      ["2026-09-19"]
    )
    assert.deepStrictEqual(
      report.byHour.map((bucket) => bucket.key),
      ["2026-09-19 01:00"]
    )
  })

  it("describes an empty window without dividing by zero", () => {
    const report = buildCostReport([])

    assert.strictEqual(report.runs, 0)
    assert.strictEqual(report.from, undefined)
    assert.strictEqual(report.averages.tokensPerRun, 0)
    assert.strictEqual(report.averages.calendarDays, 0)
    assert.match(renderCostReport(report), /no usage recorded/)
  })

  it("renders a readable report and encodes as JSON", () => {
    const report = buildCostReport(samples, { runsPerDay: 5 })
    const text = renderCostReport(report)

    assert.match(text, /2026-09-18T09:10:00\.000Z .* 2026-09-20T15:00:00\.000Z \(UTC\)/)
    assert.match(text, /runs: 3/)
    assert.match(text, /measured: 5,997 in, 3 out, 6,000 total \(\$1\.0000\)/)
    assert.match(text, /estimated: 11,999 in, 1 out, 12,000 total \(\$2\.0000\)/)
    assert.match(text, /per active day: 9,000 tokens \(\$1\.5000\) over 2 days/)
    assert.match(text, /per calendar day: 6,000 tokens \(\$1\.0000\) over 3 days/)
    assert.match(text, /per active hour: 6,000 tokens \(\$1\.0000\) over 3 hours/)
    assert.match(text, /per run: 6,000 tokens \(\$1\.0000\)/)
    assert.match(text, /peak day 2026-09-20 \(12,000\), peak hour 2026-09-20 15:00 \(12,000\)/)
    assert.match(text, /at 5 runs\/day: 30,000 tokens \(\$5\.0000\) per day/)
    assert.match(text, /2026-09-18 {2}2 runs {2}6,000 measured {2}0 estimated/)
    assert.match(text, /estimated:claude-sonnet-4 {2}12,000/)
    assert.match(text, /estimated:\S+ rows come from character counts/)

    const encoded = Schema.encodeSync(Schema.fromJsonString(CostReport))(report)
    const decoded = Schema.decodeSync(Schema.fromJsonString(CostReport))(encoded)
    assert.deepStrictEqual(decoded, report)
  })
})
