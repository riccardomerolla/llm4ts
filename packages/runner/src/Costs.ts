import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { CostLedgerFileName, loadCostLedger, type CostRecord } from "@llm4ts/flow/CostLedger"
import {
  CostReport,
  buildCostReport,
  reconcileWithLedger,
  renderCostReport,
  usageSamplesFromTrace,
  type UsageSample
} from "@llm4ts/flow/CostReport"
import { describeFlowError } from "@llm4ts/flow/FlowError"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { readTrace } from "@llm4ts/flow/Replay"
import { nodePlainFileStore } from "./NodePlainFileStore.ts"

/**
 * `llm4ts costs`: the budgeting view over every trace the runner wrote.
 *
 * Traces are the source for timing: a run can span hours and only the trace
 * carries a timestamp per token report, which the hourly buckets need. The
 * cost ledger is the source for each run's total: its line is the run's own
 * summary, and a trace can be short (`CostReport.reconcileWithLedger`). One
 * unreadable trace is reported and skipped rather than failing the whole
 * report — the other runs still answer the question.
 */

export const TraceDirectoryName = ".llm4ts"

/** `trace-<timestamp>.jsonl` as the runner writes it, or a prefixed variant like `loop-trace-…`. */
export const isTraceFileName = (name: string): boolean => /(?:^|-)trace-\d+\.jsonl$/u.test(name)

export const nodeListTraces = (directory: string): ReadonlyArray<string> =>
  existsSync(directory)
    ? readdirSync(directory)
        .filter(isTraceFileName)
        .sort()
        .map((name) => join(directory, name))
    : []

export interface CostsOptions {
  /** Repositories whose `.llm4ts/` traces are read. */
  readonly repos: ReadonlyArray<string>
  /** Drop token reports before this epoch millisecond. */
  readonly since?: number
  readonly timeZone?: DateTime.TimeZone
  readonly runsPerDay?: number
}

export interface CostsDependencies {
  readonly files: PlainFileStoreShape
  /** Absolute trace paths under one `.llm4ts/` directory. */
  readonly listTraces: (directory: string) => ReadonlyArray<string>
}

export const nodeCostsDependencies = (): CostsDependencies => ({
  files: nodePlainFileStore,
  listTraces: nodeListTraces
})

export class SkippedTrace extends Schema.Class<SkippedTrace>("SkippedTrace")({
  path: Schema.String,
  reason: Schema.String
}) {}

export class CostsResult extends Schema.Class<CostsResult>("CostsResult")({
  report: CostReport,
  traces: Schema.Int,
  skipped: Schema.Array(SkippedTrace),
  /** Runs whose trace was short or missing, completed from their cost ledger line. */
  ledgerRuns: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<string>>([])),
    Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<string>>([]))
  )
}) {}

export const makeCostsProgram = Effect.fn("@llm4ts/runner/Costs.make")(function* (
  options: CostsOptions,
  dependencies: CostsDependencies = nodeCostsDependencies()
): Effect.fn.Return<CostsResult> {
  const paths = options.repos.flatMap((repo) =>
    dependencies.listTraces(join(repo, TraceDirectoryName))
  )
  const skipped: Array<SkippedTrace> = []
  const traced: Array<UsageSample> = []
  for (const path of paths) {
    const lines = yield* readTrace(dependencies.files, path).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          skipped.push(SkippedTrace.make({ path, reason: describeFlowError(error) }))
          return []
        })
      )
    )
    traced.push(...usageSamplesFromTrace(lines))
  }
  // An unreadable ledger is no ledger: the traces still answer, uncorrected.
  const records: Array<CostRecord> = []
  for (const repo of options.repos) {
    const path = join(repo, TraceDirectoryName, CostLedgerFileName)
    records.push(
      ...(yield* loadCostLedger(dependencies.files, path).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            skipped.push(SkippedTrace.make({ path, reason: describeFlowError(error) }))
            return []
          })
        )
      ))
    )
  }
  const reconciled = reconcileWithLedger(traced, records)
  const samples = reconciled.samples.filter(
    (sample) => options.since === undefined || sample.at >= options.since
  )
  return CostsResult.make({
    report: buildCostReport(samples, {
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
      ...(options.runsPerDay === undefined ? {} : { runsPerDay: options.runsPerDay })
    }),
    traces: paths.length,
    skipped,
    ledgerRuns: reconciled.filledRuns
  })
})

export const renderCostsResult = (result: CostsResult): string => {
  const skipped =
    result.skipped.length === 0
      ? []
      : ["", ...result.skipped.map((entry) => `skipped ${entry.path}: ${entry.reason}`)]
  const ledger =
    result.ledgerRuns.length === 0
      ? []
      : [
          `${result.ledgerRuns.length} run${result.ledgerRuns.length === 1 ? "" : "s"} completed from the cost ledger (trace short or missing, remainder at the run's start): ${result.ledgerRuns.join(", ")}`
        ]
  return [
    renderCostReport(result.report),
    "",
    `traces read: ${result.traces - result.skipped.length} of ${result.traces}`,
    ...ledger,
    ...skipped
  ].join("\n")
}
