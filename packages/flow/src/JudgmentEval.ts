import * as Schema from "effect/Schema"
import { expectedScore, type Answer } from "@llm4ts/core/judgment/Schemas"
import { decide } from "./Judgment.ts"
import { DatasetDecision, type LabelledItem } from "./JudgmentDataset.ts"

export interface EvalItem {
  readonly item: LabelledItem
  readonly answer: Answer | undefined
  readonly latencyMs: number
  readonly failure?: string
}

const Metric = Schema.NullOr(Schema.Number)
export const EvalMemory = Schema.Struct({ restMb: Schema.Number, peakMb: Schema.Number })
export const CalibrationBin = Schema.Struct({
  lower: Schema.Number,
  upper: Schema.Number,
  count: Schema.Int,
  meanLabelProbability: Metric
})
export const EvalMeasures = Schema.Struct({
  items: Schema.Int,
  answered: Schema.Int,
  failed: Schema.Int,
  accuracy: Metric,
  ece: Metric,
  brier: Metric,
  bins: Schema.Array(CalibrationBin),
  decisions: Schema.Struct({ act: Schema.Int, caution: Schema.Int, hold: Schema.Int }),
  latencyMs: Schema.Struct({ p50: Metric, p95: Metric })
})

export class EvalReport extends Schema.Class<EvalReport>("EvalReport")({
  overall: EvalMeasures,
  decisions: Schema.Array(Schema.Struct({ decision: DatasetDecision, measures: EvalMeasures })),
  missedIssues: Schema.optionalKey(
    Schema.Struct({ count: Schema.Int, positiveAnswered: Schema.Int, rate: Metric })
  ),
  memory: Schema.optionalKey(EvalMemory)
}) {}

const measured = ({ item, answer, failure, latencyMs }: EvalItem) => {
  if (failure !== undefined || answer === undefined) return undefined
  if (
    item.question.type === "truth" &&
    answer.type === "truth" &&
    typeof item.label === "boolean"
  ) {
    return {
      answer,
      latencyMs,
      correct: answer.truth >= 0.5 === item.label,
      probability: item.label ? answer.truth : 1 - answer.truth
    }
  }
  if (item.question.type === "score" && answer.type === "score" && typeof item.label === "number") {
    return {
      answer,
      latencyMs,
      correct: Math.round(expectedScore(answer.probabilities)) === item.label,
      probability: answer.probabilities[String(item.label)] ?? 0
    }
  }
  return undefined
}

/** Nearest rank, with no interpolation; no observations means no metric. */
const percentile = (sorted: ReadonlyArray<number>, fraction: number): number | null =>
  sorted[Math.ceil(sorted.length * fraction) - 1] ?? null

const measures = (items: ReadonlyArray<EvalItem>): typeof EvalMeasures.Type => {
  const answered = items.flatMap((item) => {
    const value = measured(item)
    return value === undefined ? [] : [value]
  })
  const count = answered.length
  const average = (sum: number): number | null => (count === 0 ? null : sum / count)
  const bins = Array.from({ length: 10 }, (_, index) => {
    const members = answered.filter(
      ({ probability }) => Math.min(9, Math.floor(probability * 10)) === index
    )
    return {
      lower: index / 10,
      upper: (index + 1) / 10,
      count: members.length,
      meanLabelProbability:
        members.length === 0
          ? null
          : members.reduce((sum, member) => sum + member.probability, 0) / members.length
    }
  })
  const decisions = answered.map(({ answer }) => decide(answer))
  const latencies = answered.map(({ latencyMs }) => latencyMs).sort((a, b) => a - b)
  return {
    items: items.length,
    answered: count,
    failed: items.length - count,
    accuracy: average(answered.filter(({ correct }) => correct).length),
    // The labelled outcome occurred (target 1), regardless of the predicted class.
    ece: average(
      bins.reduce((sum, bin) => sum + bin.count * Math.abs(1 - (bin.meanLabelProbability ?? 1)), 0)
    ),
    brier: average(answered.reduce((sum, value) => sum + (1 - value.probability) ** 2, 0)),
    bins,
    decisions: {
      act: decisions.filter((decision) => decision === "act").length,
      caution: decisions.filter((decision) => decision === "caution").length,
      hold: decisions.filter((decision) => decision === "hold").length
    },
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) }
  }
}

/** Failures and mismatched answer kinds count as failed and are excluded from all metrics. */
export const evaluateJudgments = (
  items: ReadonlyArray<EvalItem>,
  memory?: typeof EvalMemory.Type
): EvalReport => {
  const decisions = [...new Set(items.map(({ item }) => item.decision))].sort()
  const positives = items
    .filter(({ item }) => item.decision === "review-prescreen" && item.label === true)
    .flatMap((item) => {
      const value = measured(item)
      return value === undefined ? [] : [value.answer]
    })
  const missed = positives.filter(
    (answer) => answer.type === "truth" && answer.truth < 0.5 && decide(answer) === "act"
  ).length
  return EvalReport.make({
    overall: measures(items),
    decisions: decisions.map((decision) => ({
      decision,
      measures: measures(items.filter(({ item }) => item.decision === decision))
    })),
    ...(decisions.includes("review-prescreen")
      ? {
          missedIssues: {
            count: missed,
            positiveAnswered: positives.length,
            rate: positives.length === 0 ? null : missed / positives.length
          }
        }
      : {}),
    ...(memory === undefined ? {} : { memory })
  })
}

export interface EvalReportMeta {
  readonly date: string
  readonly decision: string
  readonly backend: string
  readonly model: string
  readonly memoryNote?: string
}

const cell = (value: string): string => value.replace(/\|/g, "&#124;").replace(/[\r\n]/g, " ")
const number = (value: number | null): string => (value === null ? "n/a" : value.toFixed(4))

export const renderEvalReport = (report: EvalReport, meta: EvalReportMeta): string => {
  const rows = [
    ...report.decisions.map(({ decision, measures }) => ({ name: decision, measures })),
    { name: "Overall", measures: report.overall }
  ]
  return [
    "# Judgment evaluation",
    "",
    `- Date: ${cell(meta.date)}`,
    `- Decision: ${cell(meta.decision)}`,
    `- Backend identity: ${cell(meta.backend)}`,
    `- Model: ${cell(meta.model)}`,
    "",
    "## Measures",
    "",
    "| Decision | Items | Answered | Failed | Accuracy | ECE (10 bins) | Brier | p50 ms | p95 ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map(
      ({ name, measures: m }) =>
        `| ${name} | ${m.items} | ${m.answered} | ${m.failed} | ${number(m.accuracy)} | ${number(m.ece)} | ${number(m.brier)} | ${number(m.latencyMs.p50)} | ${number(m.latencyMs.p95)} |`
    ),
    "",
    "Metrics use answered items only; n/a means no observations. Overall is item-weighted.",
    "Accuracy: Truth >= 0.5; Score rounds the expected level index.",
    "ECE bins the labelled-outcome probability p into [0, 0.1), ..., [0.9, 1]; target = 1.",
    "ECE = sum(bin count / answered * |1 - mean p|); Brier = mean((1 - p)^2).",
    "These are labelled-outcome metrics, not predicted-confidence ECE or multiclass Brier.",
    "Latency uses nearest-rank percentiles per independent question, excluding failures.",
    "",
    "## Default policy decisions",
    "",
    "| Decision | Act | Caution | Hold |",
    "| --- | ---: | ---: | ---: |",
    ...rows.map(
      ({ name, measures: m }) =>
        `| ${name} | ${m.decisions.act} | ${m.decisions.caution} | ${m.decisions.hold} |`
    ),
    ...(report.missedIssues === undefined
      ? []
      : [
          "",
          "## Pre-screen missed issues",
          "",
          "| Missed positive items | Answered positive items | Missed rate |",
          "| ---: | ---: | ---: |",
          `| ${report.missedIssues.count} | ${report.missedIssues.positiveAnswered} | ${number(report.missedIssues.rate)} |`,
          "",
          "A miss requires label=true, truth<0.5 and decide=act (the lens would be skipped).",
          "Severity breakdown unavailable: LabelledItem records presence, not issue counts or severity."
        ]),
    "",
    "## Judgment seat resident memory",
    "",
    "| Rest MiB | Sampled peak MiB |",
    "| ---: | ---: |",
    `| ${number(report.memory?.restMb ?? null)} | ${number(report.memory?.peakMb ?? null)} |`,
    "",
    meta.memoryNote ??
      (report.memory === undefined
        ? "Memory not supplied."
        : "Memory supplied by the caller; peak is the maximum sampled RSS."),
    ""
  ].join("\n")
}
