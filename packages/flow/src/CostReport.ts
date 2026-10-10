import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { TokenUsage } from "@llm4ts/core/Models"
import { isEstimatedModel } from "./EstimatedUsage.ts"
import { TokensUsed, cloneName } from "./FlowEvents.ts"
import type { TraceLine } from "./FlowRecorder.ts"
import { estimateCostUsd, PricesAsOf } from "./PriceList.ts"

/**
 * Cross-run usage report for budgeting.
 *
 * A run's cost summary (`CostTracker`) answers "what did this run cost"; this
 * module answers "what do my runs cost per day, per hour, and per run" from
 * the `TokensUsed` lines every trace already records. Measured usage (a
 * backend's own token counts) and estimated usage (`EstimatedUsage`'s
 * character-count fallback, labelled `estimated:<model>`) are kept in separate
 * columns so a budget never mistakes one for the other.
 */

export const UnknownModel = "(unknown)"

export class UsageSample extends Schema.Class<UsageSample>("UsageSample")({
  /** Epoch milliseconds of the token report. */
  at: Schema.Number,
  runId: Schema.String,
  agent: Schema.String,
  model: Schema.String,
  prompt: Schema.Int,
  completion: Schema.Int,
  total: Schema.Int,
  cached: Schema.optionalKey(Schema.Int),
  costUsd: Schema.optionalKey(Schema.Number),
  estimated: Schema.Boolean,
  /** The lane's executor and clone, when the usage came from a roster lane (ADR 0033). */
  executor: Schema.optionalKey(Schema.String),
  clone: Schema.optionalKey(Schema.Int)
}) {}

export class UsageTotals extends Schema.Class<UsageTotals>("UsageTotals")({
  requests: Schema.Int,
  prompt: Schema.Int,
  completion: Schema.Int,
  total: Schema.Int,
  cached: Schema.optionalKey(Schema.Int),
  costUsd: Schema.optionalKey(Schema.Number)
}) {}

export class UsageBucket extends Schema.Class<UsageBucket>("UsageBucket")({
  /** `YYYY-MM-DD` for a day, `YYYY-MM-DD HH:00` for an hour, in the report's zone. */
  key: Schema.String,
  runs: Schema.Int,
  measured: UsageTotals,
  estimated: UsageTotals
}) {}

export class ModelUsage extends Schema.Class<ModelUsage>("ModelUsage")({
  model: Schema.String,
  estimated: Schema.Boolean,
  totals: UsageTotals
}) {}

/** Spend by the seat's label (coder, planner, reviewer, judge, judgment, chat): what each role cost (ADR 0029). */
export class AgentUsage extends Schema.Class<AgentUsage>("AgentUsage")({
  agent: Schema.String,
  totals: UsageTotals,
  /** Share of all tokens, measured and estimated together. */
  share: Schema.Number
}) {}

export class UsageAverages extends Schema.Class<UsageAverages>("UsageAverages")({
  activeDays: Schema.Int,
  calendarDays: Schema.Int,
  activeHours: Schema.Int,
  tokensPerActiveDay: Schema.Int,
  tokensPerCalendarDay: Schema.Int,
  tokensPerActiveHour: Schema.Int,
  tokensPerRun: Schema.Int,
  costUsdPerActiveDay: Schema.optionalKey(Schema.Number),
  costUsdPerCalendarDay: Schema.optionalKey(Schema.Number),
  costUsdPerActiveHour: Schema.optionalKey(Schema.Number),
  costUsdPerRun: Schema.optionalKey(Schema.Number),
  peakDay: Schema.optionalKey(Schema.String),
  peakHour: Schema.optionalKey(Schema.String)
}) {}

export class UsageProjection extends Schema.Class<UsageProjection>("UsageProjection")({
  runsPerDay: Schema.Number,
  tokensPerDay: Schema.Int,
  costUsdPerDay: Schema.optionalKey(Schema.Number)
}) {}

/** One executor clone's usage: `codex#2`, or the bare executor when the usage carried no clone. */
export class ExecutorUsage extends Schema.Class<ExecutorUsage>("ExecutorUsage")({
  executor: Schema.String,
  totals: UsageTotals,
  share: Schema.Number
}) {}

export class CostReport extends Schema.Class<CostReport>("CostReport")({
  schemaVersion: Schema.Int,
  timeZone: Schema.String,
  pricesAsOf: Schema.String,
  from: Schema.optionalKey(Schema.String),
  to: Schema.optionalKey(Schema.String),
  runs: Schema.Int,
  requests: Schema.Int,
  measured: UsageTotals,
  estimated: UsageTotals,
  averages: UsageAverages,
  projection: Schema.optionalKey(UsageProjection),
  byDay: Schema.Array(UsageBucket),
  byHour: Schema.Array(UsageBucket),
  byModel: Schema.Array(ModelUsage),
  byAgent: Schema.Array(AgentUsage),
  /** Per executor clone, for lanes served by a roster (schema 3, ADR 0033). */
  byExecutor: Schema.Array(ExecutorUsage)
}) {}

export const CurrentCostReportSchema = 3

const tokensUsedCodec = Schema.fromJsonString(TokensUsed)
const decodeTokensUsed = Schema.decodeUnknownOption(tokensUsedCodec)

// Backend-reported cost is authoritative; the pricing table only fills in
// when the backend said nothing (the same rule as `CostTracker`).
const costOf = (model: string, usage: TokenUsage): number | undefined =>
  usage.costUsd ?? (model === UnknownModel ? undefined : estimateCostUsd(model, usage))

/** The token reports of one trace, in trace order; malformed lines are skipped. */
export const usageSamplesFromTrace = (
  lines: ReadonlyArray<TraceLine>
): ReadonlyArray<UsageSample> =>
  lines.flatMap((line) => {
    if (line.kind !== "TokensUsed") {
      return []
    }
    const raw = line.fields.event
    if (typeof raw !== "string") {
      return []
    }
    const decoded = decodeTokensUsed(raw)
    if (Option.isNone(decoded)) {
      return []
    }
    const event = decoded.value
    const model = event.model ?? UnknownModel
    const costUsd = costOf(model, event.usage)
    return [
      UsageSample.make({
        at: line.timestamp,
        runId: line.runId,
        agent: event.agent,
        model,
        prompt: event.usage.prompt,
        completion: event.usage.completion,
        total: event.usage.total,
        ...(event.usage.cached === undefined ? {} : { cached: event.usage.cached }),
        ...(costUsd === undefined ? {} : { costUsd }),
        estimated: isEstimatedModel(model),
        ...(event.executor === undefined ? {} : { executor: event.executor }),
        ...(event.clone === undefined ? {} : { clone: event.clone })
      })
    ]
  })

const sumOptional = (values: ReadonlyArray<number | undefined>): number | undefined => {
  const present = values.flatMap((value) => (value === undefined ? [] : [value]))
  return present.length === 0 ? undefined : present.reduce((sum, value) => sum + value, 0)
}

const totalsOf = (samples: ReadonlyArray<UsageSample>): UsageTotals => {
  const cached = sumOptional(samples.map((sample) => sample.cached))
  const costUsd = sumOptional(samples.map((sample) => sample.costUsd))
  return UsageTotals.make({
    requests: samples.length,
    prompt: samples.reduce((sum, sample) => sum + sample.prompt, 0),
    completion: samples.reduce((sum, sample) => sum + sample.completion, 0),
    total: samples.reduce((sum, sample) => sum + sample.total, 0),
    ...(cached === undefined ? {} : { cached }),
    ...(costUsd === undefined ? {} : { costUsd })
  })
}

const distinctRuns = (samples: ReadonlyArray<UsageSample>): number =>
  new Set(samples.map((sample) => sample.runId)).size

const pad = (value: number): string => value.toString().padStart(2, "0")

interface ZonedParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
}

const partsIn = (timeZone: DateTime.TimeZone, at: number): ZonedParts => {
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(at, { timeZone }))
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour }
}

const dayKey = (parts: ZonedParts): string => `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`

const hourKey = (parts: ZonedParts): string => `${dayKey(parts)} ${pad(parts.hour)}:00`

const zoneLabel = (timeZone: DateTime.TimeZone): string =>
  timeZone._tag === "Named"
    ? timeZone.id
    : timeZone.offset === 0
      ? "UTC"
      : DateTime.zoneToString(timeZone)

const bucketsBy = (
  samples: ReadonlyArray<UsageSample>,
  keyOf: (sample: UsageSample) => string
): ReadonlyArray<UsageBucket> => {
  const groups = new Map<string, Array<UsageSample>>()
  for (const sample of samples) {
    const key = keyOf(sample)
    groups.set(key, [...(groups.get(key) ?? []), sample])
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, members]) =>
      UsageBucket.make({
        key,
        runs: distinctRuns(members),
        measured: totalsOf(members.filter((sample) => !sample.estimated)),
        estimated: totalsOf(members.filter((sample) => sample.estimated))
      })
    )
}

const bucketTokens = (bucket: UsageBucket): number => bucket.measured.total + bucket.estimated.total

const bucketCost = (bucket: UsageBucket): number | undefined =>
  sumOptional([bucket.measured.costUsd, bucket.estimated.costUsd])

/** The first bucket carrying the most tokens, in chronological order. */
const peakOf = (buckets: ReadonlyArray<UsageBucket>): UsageBucket | undefined =>
  buckets.reduce<UsageBucket | undefined>(
    (best, bucket) =>
      best === undefined || bucketTokens(bucket) > bucketTokens(best) ? bucket : best,
    undefined
  )

const calendarDaysBetween = (first: ZonedParts, last: ZonedParts): number =>
  Math.round(
    (Date.UTC(last.year, last.month - 1, last.day) -
      Date.UTC(first.year, first.month - 1, first.day)) /
      86_400_000
  ) + 1

const ratio = (value: number, count: number): number => (count === 0 ? 0 : value / count)

const costRatio = (cost: number | undefined, count: number): number | undefined =>
  cost === undefined || count === 0 ? undefined : cost / count

export interface CostReportOptions {
  /** Zone the day and hour buckets are cut in. Default UTC. */
  readonly timeZone?: DateTime.TimeZone
  /** Assumed daily run count for the projection line; none when absent. */
  readonly runsPerDay?: number
}

export const buildCostReport = (
  samples: ReadonlyArray<UsageSample>,
  options: CostReportOptions = {}
): CostReport => {
  const timeZone = options.timeZone ?? DateTime.zoneMakeOffset(0)
  const ordered = [...samples].sort((left, right) => left.at - right.at)
  const byDay = bucketsBy(ordered, (sample) => dayKey(partsIn(timeZone, sample.at)))
  const byHour = bucketsBy(ordered, (sample) => hourKey(partsIn(timeZone, sample.at)))
  const measured = totalsOf(ordered.filter((sample) => !sample.estimated))
  const estimated = totalsOf(ordered.filter((sample) => sample.estimated))
  const tokens = measured.total + estimated.total
  const cost = sumOptional([measured.costUsd, estimated.costUsd])
  const runs = distinctRuns(ordered)
  const first = ordered[0]
  const last = ordered[ordered.length - 1]
  const calendarDays =
    first === undefined || last === undefined
      ? 0
      : calendarDaysBetween(partsIn(timeZone, first.at), partsIn(timeZone, last.at))
  const tokensPerRun = ratio(tokens, runs)
  const costUsdPerRun = costRatio(cost, runs)
  const costUsdPerActiveDay = costRatio(cost, byDay.length)
  const costUsdPerCalendarDay = costRatio(cost, calendarDays)
  const costUsdPerActiveHour = costRatio(cost, byHour.length)
  const peakDay = peakOf(byDay)
  const peakHour = peakOf(byHour)
  const projection =
    options.runsPerDay === undefined
      ? undefined
      : UsageProjection.make({
          runsPerDay: options.runsPerDay,
          tokensPerDay: Math.round(tokensPerRun * options.runsPerDay),
          ...(costUsdPerRun === undefined
            ? {}
            : { costUsdPerDay: costUsdPerRun * options.runsPerDay })
        })

  const byModelGroups = new Map<string, Array<UsageSample>>()
  for (const sample of ordered) {
    byModelGroups.set(sample.model, [...(byModelGroups.get(sample.model) ?? []), sample])
  }
  const byModel = [...byModelGroups.entries()]
    .map(([model, members]) =>
      ModelUsage.make({ model, estimated: isEstimatedModel(model), totals: totalsOf(members) })
    )
    .sort((left, right) =>
      left.estimated === right.estimated
        ? left.model.localeCompare(right.model)
        : left.estimated
          ? 1
          : -1
    )

  const byAgentGroups = new Map<string, Array<UsageSample>>()
  for (const sample of ordered) {
    byAgentGroups.set(sample.agent, [...(byAgentGroups.get(sample.agent) ?? []), sample])
  }
  const byAgent = [...byAgentGroups.entries()]
    .map(([agent, members]) => {
      const agentTotals = totalsOf(members)
      return AgentUsage.make({
        agent,
        totals: agentTotals,
        share: tokens === 0 ? 0 : agentTotals.total / tokens
      })
    })
    .sort(
      (left, right) =>
        right.totals.total - left.totals.total || left.agent.localeCompare(right.agent)
    )

  const byExecutorGroups = new Map<string, Array<UsageSample>>()
  for (const sample of ordered) {
    if (sample.executor !== undefined) {
      const key = cloneName(sample.executor, sample.clone)
      byExecutorGroups.set(key, [...(byExecutorGroups.get(key) ?? []), sample])
    }
  }
  const byExecutor = [...byExecutorGroups.entries()]
    .map(([executor, members]) => {
      const executorTotals = totalsOf(members)
      return ExecutorUsage.make({
        executor,
        totals: executorTotals,
        share: tokens === 0 ? 0 : executorTotals.total / tokens
      })
    })
    .sort((left, right) => left.executor.localeCompare(right.executor))

  return CostReport.make({
    schemaVersion: CurrentCostReportSchema,
    timeZone: zoneLabel(timeZone),
    pricesAsOf: PricesAsOf,
    ...(first === undefined ? {} : { from: new Date(first.at).toISOString() }),
    ...(last === undefined ? {} : { to: new Date(last.at).toISOString() }),
    runs,
    requests: ordered.length,
    measured,
    estimated,
    averages: UsageAverages.make({
      activeDays: byDay.length,
      calendarDays,
      activeHours: byHour.length,
      tokensPerActiveDay: Math.round(ratio(tokens, byDay.length)),
      tokensPerCalendarDay: Math.round(ratio(tokens, calendarDays)),
      tokensPerActiveHour: Math.round(ratio(tokens, byHour.length)),
      tokensPerRun: Math.round(tokensPerRun),
      ...(costUsdPerActiveDay === undefined ? {} : { costUsdPerActiveDay }),
      ...(costUsdPerCalendarDay === undefined ? {} : { costUsdPerCalendarDay }),
      ...(costUsdPerActiveHour === undefined ? {} : { costUsdPerActiveHour }),
      ...(costUsdPerRun === undefined ? {} : { costUsdPerRun }),
      ...(peakDay === undefined ? {} : { peakDay: peakDay.key }),
      ...(peakHour === undefined ? {} : { peakHour: peakHour.key })
    }),
    ...(projection === undefined ? {} : { projection }),
    byDay,
    byHour,
    byModel,
    byAgent,
    byExecutor
  })
}

const thousands = (value: number): string =>
  Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/gu, ",")

const money = (cost: number | undefined): string =>
  cost === undefined ? "" : ` ($${cost.toFixed(4)})`

const totalsLine = (label: string, totals: UsageTotals): string => {
  const cached =
    totals.cached === undefined || totals.cached <= 0 ? "" : ` (${thousands(totals.cached)} cached)`
  return `${label}: ${thousands(totals.prompt)} in${cached}, ${thousands(totals.completion)} out, ${thousands(totals.total)} total${money(totals.costUsd)}`
}

const runsLabel = (runs: number): string => `${runs} run${runs === 1 ? "" : "s"}`

const bucketLine = (bucket: UsageBucket): string =>
  `  ${bucket.key}  ${runsLabel(bucket.runs)}  ${thousands(bucket.measured.total)} measured  ${thousands(bucket.estimated.total)} estimated${money(bucketCost(bucket))}`

export const renderCostReport = (report: CostReport): string => {
  if (report.from === undefined || report.to === undefined) {
    return "llm4ts costs\n\nno usage recorded — run a flow whose backend reports token counts, then try again"
  }
  const averages = report.averages
  const peakDay = peakOf(report.byDay)
  const peakHour = peakOf(report.byHour)
  const peaks = [
    ...(peakDay === undefined
      ? []
      : [`peak day ${peakDay.key} (${thousands(bucketTokens(peakDay))})`]),
    ...(peakHour === undefined
      ? []
      : [`peak hour ${peakHour.key} (${thousands(bucketTokens(peakHour))})`])
  ]
  const sections: Array<string> = [
    "llm4ts costs",
    `window: ${report.from} → ${report.to} (${report.timeZone})`,
    `runs: ${report.runs} · requests: ${report.requests}`,
    totalsLine("measured", report.measured),
    totalsLine("estimated", report.estimated),
    "",
    "averages (measured + estimated):",
    `  per active day: ${thousands(averages.tokensPerActiveDay)} tokens${money(averages.costUsdPerActiveDay)} over ${averages.activeDays} day${averages.activeDays === 1 ? "" : "s"}`,
    `  per calendar day: ${thousands(averages.tokensPerCalendarDay)} tokens${money(averages.costUsdPerCalendarDay)} over ${averages.calendarDays} day${averages.calendarDays === 1 ? "" : "s"}`,
    `  per active hour: ${thousands(averages.tokensPerActiveHour)} tokens${money(averages.costUsdPerActiveHour)} over ${averages.activeHours} hour${averages.activeHours === 1 ? "" : "s"}`,
    `  per run: ${thousands(averages.tokensPerRun)} tokens${money(averages.costUsdPerRun)}`,
    ...(peaks.length === 0 ? [] : [`  ${peaks.join(", ")}`])
  ]
  if (report.projection !== undefined) {
    sections.push(
      "projection:",
      `  at ${report.projection.runsPerDay} runs/day: ${thousands(report.projection.tokensPerDay)} tokens${money(report.projection.costUsdPerDay)} per day`
    )
  }
  sections.push("", "by day:", ...report.byDay.map(bucketLine))
  sections.push("", "by hour:", ...report.byHour.map(bucketLine))
  sections.push(
    "",
    "by model:",
    ...report.byModel.map(
      (entry) =>
        `  ${entry.model}  ${thousands(entry.totals.total)} tokens${money(entry.totals.costUsd)}`
    )
  )
  if (report.byAgent.length > 0) {
    sections.push(
      "",
      "by role (the seat's label):",
      ...report.byAgent.map(
        (entry) =>
          `  ${entry.agent}  ${thousands(entry.totals.total)} tokens (${Math.round(entry.share * 100)}%)${money(entry.totals.costUsd)}`
      )
    )
  }
  if (report.byExecutor.length > 0) {
    sections.push(
      "",
      "by executor clone:",
      ...report.byExecutor.map(
        (entry) =>
          `  ${entry.executor}  ${thousands(entry.totals.total)} tokens (${Math.round(entry.share * 100)}%)${money(entry.totals.costUsd)}`
      )
    )
  }
  const notes = [
    `costs are backend-reported where available, otherwise estimated from the pricing table (rates as of ${report.pricesAsOf} — may be stale)`,
    ...(report.estimated.requests === 0
      ? []
      : [
          "estimated:<model> rows come from character counts (LLM4TS_ESTIMATE_MODEL), not backend token counts"
        ])
  ]
  sections.push("", ...notes.map((note) => `* ${note}`))
  return sections.join("\n")
}
