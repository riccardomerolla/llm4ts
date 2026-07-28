import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { BenchRecord, CurrentBenchSchema, type BenchPhase } from "./Bench.ts"
import { PlanParseError, UnsupportedSchemaVersion, type FlowError } from "./FlowError.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"
import { estimateCostUsd } from "./PriceList.ts"
import { TokenUsage } from "@llm4ts/core/Models"

export const median = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

type Direction = "lower" | "higher" | "neutral"

interface Metric {
  readonly label: string
  readonly direction: Direction
  readonly value: (record: BenchRecord) => number | undefined
  readonly format: (value: number) => string
  readonly gap?: (value: number) => string
}

const formatDuration = (milliseconds: number): string => {
  if (milliseconds >= 3_600_000) {
    return `${(milliseconds / 3_600_000).toFixed(1)}h`
  }
  if (milliseconds >= 60_000) {
    return `${(milliseconds / 60_000).toFixed(1)}m`
  }
  return `${(milliseconds / 1_000).toFixed(1)}s`
}

const formatTokens = (tokens: number): string => {
  if (Math.abs(tokens) >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (Math.abs(tokens) >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`
  }
  return Math.round(tokens).toString()
}

const formatInteger = (value: number): string => Math.round(value).toString()
const formatPercent = (value: number): string => `${value.toFixed(1)}%`
const formatBoolean = (value: number): string => (value >= 0.5 ? "yes" : "no")

const spread = (records: ReadonlyArray<BenchRecord>, metric: Metric): string => {
  const values = records.flatMap((record) => {
    const value = metric.value(record)
    return value === undefined ? [] : [value]
  })
  if (values.length === 0) {
    return "–"
  }
  const center = median(values)
  const base = metric.format(center)
  return values.length > 1 && Math.min(...values) !== Math.max(...values)
    ? `${base} (${metric.format(Math.min(...values))}–${metric.format(Math.max(...values))})`
    : base
}

const judgePercent = (record: BenchRecord): number | undefined => {
  const scores = record.quality?.judgeScores ?? []
  const maximum = scores.reduce((sum, score) => sum + score.max, 0)
  return maximum <= 0
    ? undefined
    : (scores.reduce((sum, score) => sum + score.score, 0) / maximum) * 100
}

const totalOutputTokens = (record: BenchRecord): number =>
  record.phases.reduce((sum, phase) => sum + phase.tokens.completion, 0)

const totalCachedTokens = (record: BenchRecord): number =>
  record.phases.reduce((sum, phase) => sum + phase.tokens.cached, 0)

const headlineMetrics = (judgesComparable: boolean): ReadonlyArray<Metric> => [
  {
    label: "Total time",
    direction: "lower",
    value: (record) => record.totalMs,
    format: formatDuration
  },
  {
    label: "Total tokens",
    direction: "lower",
    value: (record) => record.totalTokens,
    format: formatTokens
  },
  {
    label: "Output tokens",
    direction: "lower",
    value: totalOutputTokens,
    format: formatTokens
  },
  {
    label: "Cached reads",
    direction: "neutral",
    value: totalCachedTokens,
    format: formatTokens
  },
  {
    label: "Self-healing actions",
    direction: "lower",
    value: (record) => record.selfHealing,
    format: formatInteger
  },
  {
    label: "Gate cleared",
    direction: "higher",
    value: (record) =>
      record.quality?.gateCleared === undefined ? undefined : record.quality.gateCleared ? 1 : 0,
    format: formatBoolean,
    gap: formatInteger
  },
  {
    label: "Build passed",
    direction: "higher",
    value: (record) =>
      record.quality?.buildPassed === undefined ? undefined : record.quality.buildPassed ? 1 : 0,
    format: formatBoolean,
    gap: formatInteger
  },
  {
    label: "Coverage %",
    direction: "higher",
    value: (record) => record.quality?.coveragePct,
    format: formatPercent
  },
  {
    label: "Judge score",
    direction: judgesComparable ? "higher" : "neutral",
    value: judgePercent,
    format: formatPercent
  }
]

const gapCell = (metric: Metric, values: ReadonlyArray<number>): string => {
  if (values.length < 2) {
    return ""
  }
  const low = Math.min(...values)
  const high = Math.max(...values)
  const difference = high - low
  const percent = low === 0 ? 100 : (difference / Math.abs(low)) * 100
  return `+${(metric.gap ?? metric.format)(difference)} (+${percent.toFixed(1)}%)`
}

const metricRow = (
  metric: Metric,
  providers: ReadonlyArray<string>,
  byProvider: ReadonlyMap<string, ReadonlyArray<BenchRecord>>
): string => {
  const centers = providers.map((provider) => {
    const values = (byProvider.get(provider) ?? []).flatMap((record) => {
      const value = metric.value(record)
      return value === undefined ? [] : [value]
    })
    return values.length === 0 ? undefined : median(values)
  })
  const comparable = centers.filter((value): value is number => value !== undefined)
  const best =
    metric.direction === "neutral" || comparable.length < 2
      ? undefined
      : metric.direction === "lower"
        ? Math.min(...comparable)
        : Math.max(...comparable)
  const worst =
    metric.direction === "neutral" || comparable.length < 2
      ? undefined
      : metric.direction === "lower"
        ? Math.max(...comparable)
        : Math.min(...comparable)
  const cells = providers.map((provider, index) => {
    const value = centers[index]
    const display = spread(byProvider.get(provider) ?? [], metric)
    if (value === undefined || best === undefined || best === worst) {
      return display
    }
    return value === best ? `**${display} ✅**` : value === worst ? `${display} ⚠️` : display
  })
  return `| ${metric.label} | ${cells.join(" | ")} | ${gapCell(metric, comparable)} |`
}

const costForPhase = (
  record: BenchRecord,
  phase: BenchPhase
): readonly [cost: number, estimatedAtReportTime: boolean] | undefined => {
  if (phase.costUsd !== undefined) {
    return [phase.costUsd, false]
  }
  if (phase.tokens.prompt === 0 && phase.tokens.completion === 0 && phase.tokens.cached === 0) {
    return undefined
  }
  const cost = estimateCostUsd(
    record.modelRequested,
    TokenUsage.make({
      prompt: phase.tokens.prompt,
      completion: phase.tokens.completion,
      total: phase.tokens.total,
      ...(phase.tokens.cached <= 0 ? {} : { cached: phase.tokens.cached })
    })
  )
  return cost === undefined ? undefined : [cost, true]
}

const costForRecord = (
  record: BenchRecord
): readonly [cost: number, estimatedAtReportTime: boolean] | undefined => {
  const values = record.phases.flatMap((phase) => {
    const cost = costForPhase(record, phase)
    return cost === undefined ? [] : [cost]
  })
  return values.length === 0
    ? undefined
    : [values.reduce((sum, [cost]) => sum + cost, 0), values.some(([, estimated]) => estimated)]
}

const costRow = (
  providers: ReadonlyArray<string>,
  byProvider: ReadonlyMap<string, ReadonlyArray<BenchRecord>>,
  select: (record: BenchRecord) => readonly [number, boolean] | undefined
): string => {
  const cells = providers.map((provider) => {
    const values = (byProvider.get(provider) ?? []).flatMap((record) => {
      const value = select(record)
      return value === undefined ? [] : [value]
    })
    if (values.length === 0) {
      return "–"
    }
    const suffix = values.some(([, estimated]) => estimated) ? "*" : ""
    const costs = values.map(([cost]) => cost)
    return `$${median(costs).toFixed(2)}${suffix}`
  })
  return `| Est. cost (USD) | ${cells.join(" | ")} |  |`
}

const projection = (
  programs: number,
  providers: ReadonlyArray<string>,
  byProvider: ReadonlyMap<string, ReadonlyArray<BenchRecord>>
): string => {
  const rows = providers.map((provider) => {
    const records = byProvider.get(provider) ?? []
    const perProgramTokens = records.flatMap((record) => {
      const count = record.quality?.programs ?? 0
      return count <= 0 ? [] : [record.totalTokens / count]
    })
    const perProgramMs = records.flatMap((record) => {
      const count = record.quality?.programs ?? 0
      return count <= 0 ? [] : [record.totalMs / count]
    })
    if (perProgramTokens.length === 0 || perProgramMs.length === 0) {
      return `| ${provider} | – | – | – |`
    }
    const tokens = median(perProgramTokens)
    const milliseconds = median(perProgramMs)
    return `| ${provider} | ${formatTokens(tokens)} | ${formatTokens(
      tokens * programs
    )} | ${formatDuration(milliseconds * programs)} |`
  })
  return [
    `## Projection @ ${programs} programs`,
    "",
    "| Provider | Tokens/program | Projected tokens | Projected time |",
    "| -------- | -------------- | ---------------- | -------------- |",
    ...rows,
    "",
    "_Linear extrapolation from recorded medians; not a delivery forecast._"
  ].join("\n")
}

const renderSection = (
  records: ReadonlyArray<BenchRecord>,
  projectPrograms: number | undefined
): string => {
  const providers = [...new Set(records.map((record) => record.provider))].sort()
  const byProvider = new Map<string, ReadonlyArray<BenchRecord>>(
    providers.map((provider) => [
      provider,
      records.filter((record) => record.provider === provider)
    ])
  )
  const first = records[0]
  if (first === undefined) {
    return ""
  }
  const judgesComparable =
    new Set(records.map((record) => `${record.judge.provider}\0${record.judge.model}`)).size === 1
  const judgeLine = judgesComparable
    ? `Judge: ${first.judge.provider}/${first.judge.model} — same examiner for all runs`
    : "Judges: self-graded — scores NOT cross-comparable"
  const header = `| Metric | ${providers.join(" | ")} | Gap |`
  const separator = `| ------ | ${providers.map(() => "------").join(" | ")} | --- |`
  const outcomes = `| Outcome | ${providers
    .map((provider) => {
      const group = byProvider.get(provider) ?? []
      return group.some((record) => record.resumed === true)
        ? `${group[0]?.outcome ?? "unknown"} ♻`
        : (group[0]?.outcome ?? "unknown")
    })
    .join(" | ")} |  |`
  const phaseNames = [
    ...new Set(records.flatMap((record) => record.phases.map((phase) => phase.name)))
  ]
  const phaseSections = phaseNames.map((phaseName) => {
    const duration: Metric = {
      label: "Duration",
      direction: "lower",
      value: (record) => record.phases.find((phase) => phase.name === phaseName)?.ms,
      format: formatDuration
    }
    const tokens: Metric = {
      label: "Tokens",
      direction: "lower",
      value: (record) => {
        const phase = record.phases.find((item) => item.name === phaseName)
        return phase === undefined ? undefined : phase.tokens.total + phase.tokens.cached
      },
      format: formatTokens
    }
    return [
      `### ${phaseName}`,
      "",
      header,
      separator,
      metricRow(duration, providers, byProvider),
      metricRow(tokens, providers, byProvider),
      costRow(providers, byProvider, (record) => {
        const phase = record.phases.find((item) => item.name === phaseName)
        return phase === undefined ? undefined : costForPhase(record, phase)
      })
    ].join("\n")
  })
  const failures = records.filter((record) => !record.completed)
  const estimated = records.some((record) => costForRecord(record)?.[1] === true)
  const extras = [
    ...(failures.length === 0
      ? []
      : [
          "## Failures",
          ...failures.map((record) => `- ${record.provider} ${record.runId}: ${record.outcome}`)
        ]),
    ...(projectPrograms === undefined ? [] : [projection(projectPrograms, providers, byProvider)]),
    ...(records.some((record) => record.resumed === true)
      ? [
          "_♻ resumed run: duration and tokens include only work after resume and are not fresh-run comparable._"
        ]
      : []),
    ...(estimated
      ? ["_\\* Cost estimated at report time from recorded tokens × the requested model._"]
      : []),
    `_Machines: ${[...new Set(records.map((record) => record.machine.hostname))].sort().join(", ")}._`
  ]
  return [
    `# Benchmark — ${first.pack} @ ${first.fixtureFingerprint.slice(0, 8)}`,
    "",
    `_${judgeLine}_`,
    "",
    "## Headline",
    "",
    header,
    separator,
    outcomes,
    ...headlineMetrics(judgesComparable).map((metric) => metricRow(metric, providers, byProvider)),
    costRow(providers, byProvider, costForRecord),
    "",
    "## Phases",
    "",
    ...phaseSections,
    ...extras
  ].join("\n")
}

export const renderBenchReport = (
  records: ReadonlyArray<BenchRecord>,
  projectPrograms?: number
): string => {
  const groups = new Map<string, Array<BenchRecord>>()
  for (const record of records) {
    const key = `${record.pack}\0${record.fixtureFingerprint}`
    groups.set(key, [...(groups.get(key) ?? []), record])
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => renderSection(group, projectPrograms))
    .join("\n\n")
}

const benchCodec = Schema.fromJsonString(BenchRecord)

export const appendBenchRecord = Effect.fn("@llm4ts/flow/BenchReport.append")(function* (
  files: PlainFileStoreShape,
  path: string,
  record: BenchRecord
): Effect.fn.Return<void, FlowError> {
  const encoded = yield* Schema.encodeEffect(benchCodec)(record).pipe(
    Effect.mapError((error) =>
      PlanParseError.make({
        message: `failed to encode benchmark record: ${String(error)}`
      })
    )
  )
  yield* files.append(path, `${encoded}\n`)
})

export const loadBenchRecords = Effect.fn("@llm4ts/flow/BenchReport.load")(function* (
  files: PlainFileStoreShape,
  path: string
): Effect.fn.Return<ReadonlyArray<BenchRecord>, FlowError> {
  const contents = yield* files.read(path)
  if (contents === undefined) {
    return []
  }
  const records = yield* Effect.forEach(
    contents
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    (line, index) =>
      Schema.decodeUnknownEffect(benchCodec)(line).pipe(
        Effect.mapError((error) =>
          PlanParseError.make({
            message: `malformed benchmark record at ${path}:${index + 1}: ${String(error)}`
          })
        )
      ),
    { concurrency: 1 }
  )
  for (const record of records) {
    if (record.schemaVersion !== CurrentBenchSchema) {
      return yield* UnsupportedSchemaVersion.make({
        path,
        expected: CurrentBenchSchema,
        actual: record.schemaVersion
      })
    }
  }
  return records
})
