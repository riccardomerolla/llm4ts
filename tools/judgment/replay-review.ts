/**
 * Replay the review lenses over recent commits, with and without the judgment
 * pre-screen (ADR 0017), and report what the pre-screen would have cost and
 * lost. Runs outside CI against a real model.
 *
 *   LLM4TS_PROVIDER=mlx-lm LLM4TS_MODEL=<path> pnpm judgment:replay [--commits 30] [--repo .]
 *
 * The reviewer seat comes from LLM4TS_PROVIDER / LLM4TS_MODEL; the judgment
 * seat from LLM4TS_JUDGMENT_PROVIDER / LLM4TS_JUDGMENT_MODEL, defaulting to
 * the reviewer seat. Acceptance to turn the pre-screen on by default: zero
 * Critical issues lost and at least 40% fewer review tokens.
 */
import {
  argValue,
  commits,
  lenses,
  backendFromEnvironment,
  batchingFromEnvironment,
  judgmentBackend,
  writeReport,
  JudgmentToolError
} from "./lib.ts"
import { Batching } from "@llm4ts/core/judgment/LlmJudgment"
import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import {
  evaluateJudgments,
  renderEvalReport,
  replayEvalItems,
  replayMissesAgree,
  type EvalItem
} from "@llm4ts/flow/JudgmentEval"
import * as Effect from "effect/Effect"
import { TokensUsed, makeCollectingFlowEvents, type FlowEvent } from "@llm4ts/flow/FlowEvents"
import { prescreenReviewers, reviewWith, type ReviewResult } from "@llm4ts/flow/Review"
import type { Reviewer } from "@llm4ts/flow/Reviewer"
import { apiConnectorFromEnvironment, prepareConnector } from "@llm4ts/runner/Connectors"
import { nodeFlowRunnerDependencies } from "@llm4ts/runner/FlowRunner"

const usage =
  "Usage: pnpm judgment:replay [--commits 30] [--repo .] [--diff-cap 60000] [--out <path>] [--batching independent|shared-prefix]"
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const Arguments = Schema.Struct({
  commitCount: PositiveInt,
  repo: Schema.String.check(Schema.isNonEmpty()),
  diffCap: PositiveInt,
  out: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty())),
  batching: Batching
})

const tokensIn = (events: ReadonlyArray<FlowEvent>): number =>
  events.reduce((sum, event) => (event._tag === "TokensUsed" ? sum + event.usage.total : sum), 0)

interface LensRun {
  readonly lens: Reviewer
  readonly result: ReviewResult
  readonly tokens: number
  readonly ms: number
}

const program = Effect.gen(function* () {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage)
    return
  }
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? ""
    if (
      !["--commits", "--repo", "--diff-cap", "--out", "--batching"].includes(flag) ||
      seen.has(flag) ||
      args[index + 1] === undefined ||
      args[index + 1]?.startsWith("--")
    )
      return yield* JudgmentToolError.make({ message: usage })
    seen.add(flag)
  }
  const { commitCount, repo, diffCap, out, batching } = yield* Schema.decodeUnknownEffect(
    Arguments
  )({
    commitCount: Number(argValue("commits", "30", args)),
    repo: argValue("repo", process.cwd(), args),
    diffCap: Number(argValue("diff-cap", "60000", args)),
    ...(seen.has("--out") ? { out: argValue("out", "", args) } : {}),
    batching: argValue("batching", batchingFromEnvironment(process.env), args)
  }).pipe(Effect.mapError(() => JudgmentToolError.make({ message: usage })))
  const environment = process.env
  const dependencies = nodeFlowRunnerDependencies()
  const reviewerConfig = yield* apiConnectorFromEnvironment(environment)
  const reviewer = yield* dependencies.registry.resolve(
    prepareConnector(reviewerConfig, repo, environment)
  )
  const screenEvents = yield* makeCollectingFlowEvents
  const backend = yield* judgmentBackend(
    backendFromEnvironment(environment),
    environment,
    repo,
    dependencies,
    {
      onUsage: (usage, model) =>
        screenEvents.publish(
          new TokensUsed({ agent: "judgment", usage, ...(model === undefined ? {} : { model }) })
        )
    },
    batching
  )
  const labelledAt = DateTime.formatIso(yield* DateTime.now)
  const items: Array<EvalItem> = []
  const markdown: Array<string> = []
  const print = (line: string) => {
    markdown.push(line)
  }
  const sample = commits(repo, commitCount, diffCap)
  if (sample.length === 0)
    return yield* JudgmentToolError.make({ message: "No non-empty commits to replay." })
  print(`# Review pre-screen replay\n`)
  print(
    `${sample.length} commits from ${repo}; reviewer ${reviewerConfig.connectorId.value}/${reviewerConfig.model ?? "default"}; judgment ${backend.judgment.identity}/${backend.model}\n`
  )
  print(
    "| commit | full tokens | full ms | screen tokens | screen ms | skipped | kept tokens | lost (C/W/I) |"
  )
  print("| --- | ---: | ---: | ---: | ---: | --- | ---: | --- |")

  let fullTokens = 0
  let screenedTokens = 0
  let judgmentTokens = 0
  let fullMs = 0
  let screenedMs = 0
  let lostCritical = 0
  let lostWarning = 0
  let lostInfo = 0
  let skippedTotal = 0
  let lensRuns = 0
  let missedPositiveLenses = 0

  for (const commit of sample) {
    const runs: Array<LensRun> = []
    for (const lens of lenses) {
      const events = yield* makeCollectingFlowEvents
      const started = Date.now()
      const result = yield* reviewWith(reviewer, events, lens, commit.title, commit.diff).pipe(
        Effect.mapError(() =>
          JudgmentToolError.make({
            message: `Full review failed for ${commit.sha}:${lens.name}; replay aborted without deriving a label.`
          })
        )
      )
      const recorded = yield* events.recorded
      runs.push({ lens, result, tokens: tokensIn(recorded), ms: Date.now() - started })
    }
    const tokensBefore = tokensIn(yield* screenEvents.recorded)
    const screenStarted = Date.now()
    const { reviewers: kept, observations } = yield* prescreenReviewers(
      { judgment: backend.judgment, mode: "act" },
      screenEvents,
      commit.diff,
      lenses
    )
    const screenMs = Date.now() - screenStarted
    const screenTokens = tokensIn(yield* screenEvents.recorded) - tokensBefore
    items.push(...replayEvalItems(commit, runs, observations, screenMs, labelledAt))
    const skipped = runs.filter((run) => !kept.includes(run.lens))
    const lost = skipped.flatMap((run) => run.result.issues)
    missedPositiveLenses += skipped.filter((run) => run.result.issues.length > 0).length
    const lostC = lost.filter((issue) => issue.severity === "Critical").length
    const lostW = lost.filter((issue) => issue.severity === "Warning").length
    const lostI = lost.filter((issue) => issue.severity === "Info").length
    const commitFull = runs.reduce((sum, run) => sum + run.tokens, 0)
    const commitFullMs = runs.reduce((sum, run) => sum + run.ms, 0)
    const commitKept = runs
      .filter((run) => kept.includes(run.lens))
      .reduce((sum, run) => sum + run.tokens, 0)
    const commitKeptMs = runs
      .filter((run) => kept.includes(run.lens))
      .reduce((sum, run) => sum + run.ms, 0)
    fullTokens += commitFull
    fullMs += commitFullMs
    screenedTokens += commitKept
    judgmentTokens += screenTokens
    screenedMs += screenMs + commitKeptMs
    lostCritical += lostC
    lostWarning += lostW
    lostInfo += lostI
    skippedTotal += skipped.length
    lensRuns += runs.length
    print(
      `| ${commit.sha.slice(0, 8)} ${commit.title.slice(0, 40).replace(/\|/g, "/")} | ${commitFull} | ${commitFullMs} | ${screenTokens} | ${screenMs} | ${skipped.map((run) => run.lens.name).join(", ") || "-"} | ${commitKept} | ${lostC}/${lostW}/${lostI} |`
    )
  }

  const report = evaluateJudgments(items)
  if (
    !replayMissesAgree(
      report,
      { Critical: lostCritical, Warning: lostWarning, Info: lostInfo },
      missedPositiveLenses
    )
  )
    return yield* JudgmentToolError.make({
      message: "Replay lost issues and evaluation missed lenses/severities disagree."
    })
  const metric = (value: number | null | undefined) => (value == null ? "n/a" : value.toFixed(4))
  const saved = fullTokens === 0 ? 0 : 1 - screenedTokens / fullTokens
  print(`\n## Totals\n`)
  print(`- lens runs: ${lensRuns}, skipped by the pre-screen: ${skippedTotal}`)
  print(
    `- reviewer-seat tokens: full ${fullTokens}, pre-screened ${screenedTokens} (${(saved * 100).toFixed(1)}% fewer)`
  )
  print(
    `- wall time: full ${(fullMs / 1000).toFixed(1)}s, pre-screened ${(screenedMs / 1000).toFixed(1)}s`
  )
  print(`- issues lost: Critical ${lostCritical}, Warning ${lostWarning}, Info ${lostInfo}`)
  print(`- judgment-seat tokens: ${judgmentTokens}`)
  print(
    `- expected calibration error (10 bins): ${metric(report.overall.ece)}; Brier: ${metric(report.overall.brier)}`
  )
  print(
    `- missed positive lenses: ${report.missedIssues?.count ?? 0}; missed rate: ${metric(report.missedIssues?.rate)}`
  )
  print(
    `- issues on missed positive lenses: Critical ${report.missedIssues?.severities?.Critical ?? 0}, Warning ${report.missedIssues?.severities?.Warning ?? 0}, Info ${report.missedIssues?.severities?.Info ?? 0} (agrees with lost C/W/I)`
  )
  const passes = lostCritical === 0 && saved >= 0.4
  print(
    `\n**Acceptance (zero Critical lost, ≥40% fewer reviewer-seat tokens): ${passes ? "PASS" : "FAIL"}**`
  )
  print(
    `Calibration (information only): ECE ${metric(report.overall.ece)}, Brier ${metric(report.overall.brier)}; missed rate ${metric(report.missedIssues?.rate)}.`
  )
  print("")
  print(
    renderEvalReport(report, {
      title: "Outcome-derived labels (lens reported an issue), not human labels",
      date: labelledAt.slice(0, 10),
      decision: "review-prescreen",
      backend: backend.judgment.identity,
      model: backend.model,
      latencyNote:
        "Screening-call latency is divided evenly across all lens questions, including unanswered questions; p50/p95 use answered items only. No per-question timing is available."
    })
  )
  yield* writeReport({
    markdown: markdown.join("\n"),
    out,
    root: process.cwd(),
    tool: "replay",
    args,
    environment,
    files: dependencies.files,
    commitRange: `${sample.at(-1)?.sha ?? "none"}..${sample[0]?.sha ?? "none"} (inclusive, ${sample.length} non-merge commits; diff cap ${diffCap})`
  })
})

Effect.runPromise(program).catch((error: unknown) => {
  console.error(
    error instanceof JudgmentToolError
      ? error.message
      : "Replay failed; check provider, repository and output configuration."
  )
  process.exitCode = 1
})
