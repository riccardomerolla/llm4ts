/**
 * epic-retro: read what a failed epic-stories run left behind, explain each
 * failed story, and propose the fix the next run applies once approved.
 * The policy (digest, proposal schema, validation, report, apply) lives in
 * `@llm4ts/flow/Retro`; this module finds the run and its files and drives
 * one read-only seat.
 */
import { join } from "node:path"
import * as Effect from "effect/Effect"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { readEpicRuns, type EpicRun } from "@llm4ts/flow/EpicRuns"
import { Info, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import type { FlowError } from "@llm4ts/flow/FlowError"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { readTrace } from "@llm4ts/flow/Replay"
import {
  RetroProposal,
  defaultRetroChars,
  loadEpicFiles,
  loadStoryFiles,
  renderRetroDigest,
  retroCandidates,
  retroPaths,
  retroPrompt,
  retroProposalJsonSchema,
  validateRetroProposal,
  writeRetro,
  type RetroInputs,
  type RetroPaths
} from "@llm4ts/flow/Retro"
import { makeStoryPlanStore, type StoryPlan } from "@llm4ts/flow/StoryPlan"
import type { TranscriptEntry } from "@llm4ts/flow/Transcript"
import { structuredAndPublish } from "@llm4ts/flow/Usage"
import { ScriptUsage } from "@llm4ts/runner/FlowArgs"
import { roundDir } from "./epic-stories.ts"

export const epicRetroUsage = [
  "usage: llm4ts run epic-retro --repo <target> [-- --epic <id>] [-- --run <runId>]",
  "  --epic <id>   the epic (folder name or plan id); default: the one open epic",
  "  --run <id>    the run to look at; default: the epic's latest run",
  "Reads the run's trace, transcripts (when kept), board, report, story plans, findings and",
  "verdicts; writes .llm4ts/epics/<epic>/retro/<runId>.md with proposed fixes behind an",
  "approval line, and <runId>-library.md with advice for llm4ts when there is any."
].join("\n")

export interface EpicRetroArgs {
  readonly epic: string | undefined
  readonly run: string | undefined
  readonly rest: ReadonlyArray<string>
}

export const parseEpicRetroArgs = (
  argv: ReadonlyArray<string>
): Effect.Effect<EpicRetroArgs, ScriptUsage> =>
  Effect.gen(function* () {
    let epic: string | undefined
    let run: string | undefined
    const rest: Array<string> = []
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index] ?? ""
      const valued = (name: string): Effect.Effect<string, ScriptUsage> => {
        const value = argument.includes("=") ? argument.slice(name.length + 1) : argv[index + 1]
        if (!argument.includes("=")) {
          index += 1
        }
        return value === undefined || value.trim().length === 0 || value.startsWith("--")
          ? ScriptUsage.make({ message: `${name} needs a value\n${epicRetroUsage}` })
          : Effect.succeed(value.trim())
      }
      if (argument === "--epic" || argument.startsWith("--epic=")) {
        epic = yield* valued("--epic")
      } else if (argument === "--run" || argument.startsWith("--run=")) {
        run = yield* valued("--run")
      } else {
        rest.push(argument)
      }
    }
    return { epic, run, rest }
  })

/** Which run of the epic the retro looks at, and where that run's stories live. */
export interface RetroTarget {
  readonly run: EpicRun
  /** The epic's folder, or the refine round's folder the run worked in. */
  readonly stateDir: string
  readonly plan: StoryPlan
}

export const resolveRetroTarget = Effect.fn("epic-retro.resolveTarget")(function* (
  files: PlainFileStoreShape,
  epicStateDir: string,
  runId: string | undefined
): Effect.fn.Return<RetroTarget, FlowError | ScriptUsage> {
  const runs = yield* readEpicRuns(files, epicStateDir)
  const run =
    runId === undefined ? runs.at(-1) : runs.find((candidate) => candidate.runId === runId)
  if (run === undefined) {
    return yield* ScriptUsage.make({
      message:
        runId === undefined
          ? `no run recorded in ${join(epicStateDir, "runs.jsonl")}; run epic-stories first`
          : `no run '${runId}' in ${join(epicStateDir, "runs.jsonl")}; recorded: ${runs.map((r) => r.runId).join(", ") || "none"}`
    })
  }
  const stateDir =
    run.round !== undefined && (run.action === "RunRound" || run.action === "PlanRound")
      ? roundDir(epicStateDir, run.round)
      : epicStateDir
  const plan = yield* makeStoryPlanStore(files).load(join(stateDir, "plan.md"))
  if (plan === undefined) {
    return yield* ScriptUsage.make({ message: `no plan at ${join(stateDir, "plan.md")}` })
  }
  return { run, stateDir, plan }
})

export interface RetroDeps {
  readonly files: PlainFileStoreShape
  readonly events: FlowEventsShape
  /** The read-only seat that writes the proposal. */
  readonly seat: LlmServiceShape
  readonly workDir: string
  /** The epic folder's name, for the commands the report prints. */
  readonly epicDir: string
  readonly target: RetroTarget
  /** A story lane's transcript, or `undefined` when the run kept none. */
  readonly transcript: (lane: string) => Effect.Effect<ReadonlyArray<TranscriptEntry> | undefined>
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly now: number
}

export type RetroOutcome =
  | { readonly _tag: "NothingToDo"; readonly message: string }
  | {
      readonly _tag: "Written"
      readonly paths: RetroPaths
      readonly summary: ReadonlyArray<string>
    }

const retroChars = (environment: Readonly<Record<string, string | undefined>>): number => {
  const value = Number.parseInt(environment.LLM4TS_RETRO_CHARS ?? "", 10)
  return Number.isInteger(value) && value > 0 ? value : defaultRetroChars
}

/** The whole retro: evidence, one structured call, validation, the files. */
export const runRetro = Effect.fn("epic-retro.run")(function* (
  deps: RetroDeps
): Effect.fn.Return<RetroOutcome, FlowError> {
  const { files, target } = deps
  const { stateDir, plan, run } = target
  const trace = yield* readTrace(files, run.tracePath)
  const epic = yield* loadEpicFiles(files, stateDir)
  const stories = yield* Effect.forEach(plan.stories, (story) =>
    loadStoryFiles(files, stateDir, story)
  )
  const withoutTranscripts: RetroInputs = {
    runId: run.runId,
    plan,
    trace,
    transcripts: undefined,
    report: epic.report,
    board: epic.board,
    stories,
    budget: retroChars(deps.environment)
  }
  const candidates = retroCandidates(withoutTranscripts)
  if (candidates.length === 0) {
    return {
      _tag: "NothingToDo",
      message: `run ${run.runId} of epic ${plan.epicId} left no failed, waiting or unfinished story; nothing to look at`
    }
  }
  // Transcripts are read per candidate lane; the first answer says whether
  // the run kept any at all.
  const transcripts = new Map<string, ReadonlyArray<TranscriptEntry>>()
  let kept = false
  for (const candidate of candidates) {
    const entries = yield* deps.transcript(candidate.story.id)
    if (entries !== undefined) {
      kept = true
      transcripts.set(candidate.story.id, entries)
    }
  }
  const inputs: RetroInputs = { ...withoutTranscripts, transcripts: kept ? transcripts : undefined }
  const digest = renderRetroDigest(inputs)
  const paths = retroPaths(stateDir, run.runId)
  // The digest is on disk before the seat is asked: a failed call still leaves it to read.
  yield* files.writeAtomic(paths.digest, digest)
  yield* deps.events.publish(
    Info.make({
      message: `retro: ${candidates.length} stor${candidates.length === 1 ? "y" : "ies"} to look at in run ${run.runId}${kept ? "" : " (no transcripts; rerun with --transcript for more)"} — digest at ${paths.digest}`
    })
  )
  const withPlans = new Set(
    stories.filter((entry) => entry.plan !== undefined).map((entry) => entry.story.id)
  )
  const proposal = yield* structuredAndPublish(
    deps.seat,
    deps.events,
    retroPrompt(digest, [...withPlans]),
    RetroProposal,
    retroProposalJsonSchema,
    "retro"
  )
  const validated = validateRetroProposal(proposal, plan, withPlans)
  const written = yield* writeRetro(files, stateDir, {
    runId: run.runId,
    plan,
    validated,
    workDir: deps.workDir,
    epicDir: deps.epicDir,
    digest,
    at: deps.now
  })
  const applies = validated.proposal.stories.filter((s) => s.kind === "tasks" || s.kind === "story")
  const summary = [
    `retro of run ${run.runId}: ${validated.proposal.summary.trim()}`,
    ...validated.proposal.stories.map(
      (entry) =>
        `  ${entry.id}: ${entry.kind === "tasks" ? `${entry.tasks?.length ?? 0} task(s)` : entry.kind === "story" ? "edit the story (restart)" : entry.kind === "refine" ? "needs a refine round" : "no change"}`
    ),
    ...(validated.dropped.length === 0
      ? []
      : [`  dropped ${validated.dropped.length} item(s) the plan cannot take; see the report`]),
    `report: ${written.report}`,
    ...(validated.proposal.libraryAdvice.length === 0
      ? []
      : [`advice for llm4ts: ${written.library}`]),
    applies.length === 0
      ? "nothing to apply; the report is for reading"
      : `tick '- [x] Approved' in the report, then rerun: llm4ts run epic-stories --repo ${deps.workDir} -- --epic ${deps.epicDir}`
  ]
  for (const line of summary) {
    yield* deps.events.publish(Info.make({ message: line }))
  }
  return { _tag: "Written", paths: written, summary }
})
