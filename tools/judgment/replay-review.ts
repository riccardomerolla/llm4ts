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
import { execFileSync } from "node:child_process"
import * as Effect from "effect/Effect"
import { makeLlmJudgment } from "@llm4ts/core/judgment/LlmJudgment"
import { TokensUsed, makeCollectingFlowEvents, type FlowEvent } from "@llm4ts/flow/FlowEvents"
import {
  correctnessReviewer,
  effectReviewer,
  performanceReviewer,
  prescreenReviewers,
  readabilityReviewer,
  reviewWith,
  securityReviewer,
  structureReviewer,
  testReviewer,
  type ReviewResult
} from "@llm4ts/flow/Review"
import type { Reviewer } from "@llm4ts/flow/Reviewer"
import {
  apiConnectorFromEnvironment,
  judgmentConnectorFromEnvironment,
  prepareConnector
} from "@llm4ts/runner/Connectors"
import { nodeFlowRunnerDependencies } from "@llm4ts/runner/FlowRunner"

const lenses: ReadonlyArray<Reviewer> = [
  correctnessReviewer,
  readabilityReviewer,
  testReviewer,
  structureReviewer,
  performanceReviewer,
  securityReviewer,
  effectReviewer
]

const argValue = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}

const commitCount = Number.parseInt(argValue("commits", "30"), 10)
const repo = argValue("repo", process.cwd())
const diffCap = Number.parseInt(argValue("diff-cap", "60000"), 10)

const git = (...args: ReadonlyArray<string>): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })

interface Commit {
  readonly sha: string
  readonly title: string
  readonly diff: string
}

const commits = (): ReadonlyArray<Commit> =>
  git("log", "--no-merges", `-${commitCount}`, "--format=%H%x1f%s")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha = "", title = ""] = line.split("\x1f")
      const diff = git("show", "--format=", "--no-color", sha)
      return { sha, title, diff: diff.length > diffCap ? `${diff.slice(0, diffCap)}\n…` : diff }
    })
    .filter((commit) => commit.diff.trim().length > 0)

const tokensIn = (events: ReadonlyArray<FlowEvent>): number =>
  events.reduce((sum, event) => (event._tag === "TokensUsed" ? sum + event.usage.total : sum), 0)

interface LensRun {
  readonly lens: Reviewer
  readonly result: ReviewResult | undefined
  readonly tokens: number
  readonly ms: number
}

const program = Effect.gen(function* () {
  const environment = process.env
  const dependencies = nodeFlowRunnerDependencies()
  const reviewerConfig = yield* apiConnectorFromEnvironment(environment)
  const judgmentConfig = (yield* judgmentConnectorFromEnvironment(environment)) ?? reviewerConfig
  const reviewer = yield* dependencies.registry.resolve(
    prepareConnector(reviewerConfig, repo, environment)
  )
  const judgmentSeat =
    judgmentConfig === reviewerConfig
      ? reviewer
      : yield* dependencies.registry.resolve(prepareConnector(judgmentConfig, repo, environment))

  const sample = commits()
  console.log(`# Review pre-screen replay\n`)
  console.log(
    `${sample.length} commits from ${repo}; reviewer ${reviewerConfig.connectorId.value}/${reviewerConfig.model ?? "default"}; judgment ${judgmentConfig.connectorId.value}/${judgmentConfig.model ?? "default"}\n`
  )
  console.log(
    "| commit | full tokens | full ms | screen tokens | screen ms | skipped | kept tokens | lost (C/W/I) |"
  )
  console.log("| --- | ---: | ---: | ---: | ---: | --- | ---: | --- |")

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

  for (const commit of sample) {
    const runs: Array<LensRun> = []
    for (const lens of lenses) {
      const events = yield* makeCollectingFlowEvents
      const started = Date.now()
      const result = yield* reviewWith(reviewer, events, lens, commit.title, commit.diff).pipe(
        Effect.map((value): ReviewResult | undefined => value),
        Effect.catch(() => Effect.succeed<ReviewResult | undefined>(undefined))
      )
      const recorded = yield* events.recorded
      runs.push({ lens, result, tokens: tokensIn(recorded), ms: Date.now() - started })
    }
    const screenEvents = yield* makeCollectingFlowEvents
    const judgment = makeLlmJudgment(judgmentSeat, undefined, {
      onUsage: (usage, model) =>
        screenEvents.publish(
          new TokensUsed({ agent: "judgment", usage, ...(model === undefined ? {} : { model }) })
        )
    })
    const screenStarted = Date.now()
    const kept = yield* prescreenReviewers({ judgment }, screenEvents, commit.diff, lenses)
    const screenMs = Date.now() - screenStarted
    const screenTokens = tokensIn(yield* screenEvents.recorded)
    const skipped = runs.filter((run) => !kept.includes(run.lens))
    const lost = skipped.flatMap((run) => run.result?.issues ?? [])
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
    console.log(
      `| ${commit.sha.slice(0, 8)} ${commit.title.slice(0, 40).replace(/\|/g, "/")} | ${commitFull} | ${commitFullMs} | ${screenTokens} | ${screenMs} | ${skipped.map((run) => run.lens.name).join(", ") || "-"} | ${commitKept} | ${lostC}/${lostW}/${lostI} |`
    )
  }

  const saved = fullTokens === 0 ? 0 : 1 - screenedTokens / fullTokens
  console.log(`\n## Totals\n`)
  console.log(`- lens runs: ${lensRuns}, skipped by the pre-screen: ${skippedTotal}`)
  console.log(
    `- review tokens: full ${fullTokens}, pre-screened ${screenedTokens} (${(saved * 100).toFixed(1)}% fewer)`
  )
  console.log(
    `- wall time: full ${(fullMs / 1000).toFixed(1)}s, pre-screened ${(screenedMs / 1000).toFixed(1)}s`
  )
  console.log(`- issues lost: Critical ${lostCritical}, Warning ${lostWarning}, Info ${lostInfo}`)
  const passes = lostCritical === 0 && saved >= 0.4
  console.log(
    `\n**Acceptance (zero Critical lost, ≥40% fewer reviewer-seat tokens): ${passes ? "PASS" : "FAIL"}**`
  )
})

Effect.runPromise(program).catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
