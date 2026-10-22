import { join } from "node:path"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import { Board, BoardStatus, BoardVersion } from "@llm4ts/flow/BoardSync"
import { CostLedgerFileName } from "@llm4ts/flow/CostLedger"
import { buildCostReport } from "@llm4ts/flow/CostReport"
import { describeFlowError, type FlowError } from "@llm4ts/flow/FlowError"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"
import {
  CostsOut,
  Diagnosis,
  OperatorRun,
  PreflightResult,
  ReadFailed,
  RunStatus,
  StoryDetail,
  UnknownEpic,
  UnknownRepo,
  UnknownRun,
  UnknownStory,
  type ConnectorHealthOut,
  type ExecutorHealthOut
} from "@llm4ts/flow/OperatorSchemas"
import { loadVersioned } from "@llm4ts/flow/Persistence"
import { defaultPlanPath } from "@llm4ts/flow/Plan"
import { readRetroIndex, retroApprovalOf, retroPaths } from "@llm4ts/flow/Retro"
import { rolesOf } from "@llm4ts/flow/Roster"
import { makeStoryPlanStore } from "@llm4ts/flow/StoryPlan"
import { emptyTree, treeInputsOfTrace } from "@llm4ts/runner/AgentTree"
import { CostsResult, makeCostsProgram } from "@llm4ts/runner/Costs"
import type { DoctorReport } from "@llm4ts/runner/Doctor"
import type { RosterReport } from "@llm4ts/runner/ExecutorRoster"
import { ProfileReport, profileOf } from "@llm4ts/runner/Profile"
import {
  TraceUnreadable,
  costsOfRun,
  eventsAfter,
  foldTrace,
  runDiagnosisOf,
  runStatusOf,
  type RunSources
} from "@llm4ts/runner/RunReaders"
import { storyDetailOf, storyDiagnosisOf } from "@llm4ts/runner/StoryReaders"
import { loadTranscript, tailLinesOf, type TranscriptFiles } from "@llm4ts/runner/Transcripts"
import type { DiscoveredFlow } from "./FlowCatalog.ts"
import type { OperatorConfig } from "./OperatorConfig.ts"
import {
  discoveredRuns,
  epicDirOf,
  epicOfRun,
  epicsDir,
  readEpicRunsStrict,
  readFailed,
  resolveRun,
  runTraceLines,
  stateRoot,
  tracePending,
  transcriptsDir,
  type RunLookupDeps
} from "./OperatorRuns.ts"
import { packageVersion } from "./Package.ts"

/**
 * The operator's read-only MCP tools (`llm4ts mcp`, ADR 0041): answers about
 * repositories, epics and runs from the files they write, over an
 * `OperatorDeps` record so tests call the handlers directly on memory stores
 * and fakes. A client never names a path: repositories, epics and runs are
 * ids resolved against the configuration and the files found on disk
 * (`OperatorRuns.ts`).
 */

export interface OperatorDeps extends RunLookupDeps {
  readonly config: OperatorConfig
  /** Relative paths of every regular file under a directory, recursively; none when absent. */
  readonly listFiles: (directory: string) => ReadonlyArray<string>
  readonly transcripts: TranscriptFiles
  readonly doctor: Effect.Effect<DoctorReport>
  readonly roster: (repoPath: string) => Effect.Effect<RosterReport, FlowError>
  readonly probe: (url: string) => Effect.Effect<boolean>
  readonly flows: (repoPath: string) => Effect.Effect<ReadonlyArray<DiscoveredFlow>, unknown>
  readonly now: Effect.Effect<number>
  readonly environment: Readonly<Record<string, string | undefined>>
}

/** The repository a tool call means; the id may be left out when the server serves one. */
export const resolveRepo = (
  config: OperatorConfig,
  id: string | undefined
): Effect.Effect<{ id: string; path: string }, UnknownRepo> => {
  const ids = config.repos.map((repo) => repo.id).join(", ")
  if (id === undefined) {
    const only = config.repos.length === 1 ? config.repos[0] : undefined
    return only === undefined
      ? Effect.fail(
          UnknownRepo.make({ message: `repo is required: this server serves ${ids || "none"}` })
        )
      : Effect.succeed({ id: only.id, path: only.path })
  }
  const repo = config.repos.find((candidate) => candidate.id === id)
  return repo === undefined
    ? Effect.fail(UnknownRepo.make({ message: `unknown repo '${id}': this server serves ${ids}` }))
    : Effect.succeed({ id: repo.id, path: repo.path })
}

/** A state file that exists but does not parse, named in the message. */
const readFailedAt =
  (path: string) =>
  (error: unknown): ReadFailed => {
    const message = describeFlowError(error)
    return ReadFailed.make({ message: message.includes(path) ? message : `${path}: ${message}` })
  }

const sourcesOf = (deps: OperatorDeps): RunSources => ({
  files: deps.files,
  listFiles: deps.listFiles
})

const lastLines = (text: string | undefined, count: number): ReadonlyArray<string> => {
  if (text === undefined || count <= 0) return []
  const rows = text.replace(/\r?\n$/u, "").split(/\r?\n/u)
  return rows.length === 1 && rows[0] === "" ? [] : rows.slice(-count)
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value))

// ---- Tools --------------------------------------------------------------------------------

const repoParam = Schema.optional(Schema.String)

export const preflight = Tool.make("preflight", {
  description:
    "Is this machine ready to run? Connector health (probe 'auth' is the CLI's own login check; 'version' only ran `<cli> --version` and does not prove a live session), roster executors with their health URL probed, Node and llm4ts versions.",
  parameters: Schema.Struct({ repo: repoParam }),
  success: PreflightResult,
  failure: Schema.Union([UnknownRepo])
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const FlowOut = Schema.Struct({
  name: Schema.String,
  tier: Schema.String,
  description: Schema.optionalKey(Schema.String),
  kit: Schema.optionalKey(Schema.String)
})

export const list_flows = Tool.make("list_flows", {
  description: "Flows that can be started, with their tier (project, global, builtin).",
  parameters: Schema.Struct({ repo: repoParam }),
  success: Schema.Array(FlowOut),
  failure: Schema.Union([UnknownRepo, ReadFailed])
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const EpicOut = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  stories: Schema.Int,
  board: Schema.Array(Schema.Struct({ id: Schema.String, status: BoardStatus })),
  lastRun: Schema.optionalKey(
    Schema.Struct({ runId: Schema.String, startedAt: Schema.Number, action: Schema.String })
  )
})

export const list_epics = Tool.make("list_epics", {
  description: "Epics under .llm4ts/epics/ with title, story count, board and last run.",
  parameters: Schema.Struct({ repo: repoParam }),
  success: Schema.Array(EpicOut),
  failure: Schema.Union([UnknownRepo, ReadFailed])
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const list_runs = Tool.make("list_runs", {
  description:
    "Runs this server started plus runs found in traces, newest first (default 20). A run found only in a trace has flow '?'.",
  parameters: Schema.Struct({
    repo: repoParam,
    epic: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Int)
  }),
  success: Schema.Array(OperatorRun),
  failure: Schema.Union([UnknownRepo, UnknownEpic, ReadFailed])
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const run_status = Tool.make("run_status", {
  description:
    "One run now: state, elapsed, lanes, stories board, tokens and cost so far, warnings, and a one-line summary.",
  parameters: Schema.Struct({ runId: Schema.String }),
  success: RunStatus,
  failure: Schema.Union([UnknownRun, TraceUnreadable, ReadFailed])
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const run_events = Tool.make("run_events", {
  description:
    "Raw trace lines after sinceSeq, optionally only the given kinds; limit defaults to 200, at most 1000.",
  parameters: Schema.Struct({
    runId: Schema.String,
    sinceSeq: Schema.optional(Schema.Int),
    kinds: Schema.optional(Schema.Array(Schema.String)),
    limit: Schema.optional(Schema.Int)
  }),
  success: Schema.Array(TraceLine),
  failure: Schema.Union([UnknownRun, TraceUnreadable, ReadFailed])
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const RunLogOut = Schema.Struct({
  stdout: Schema.Array(Schema.String),
  stderr: Schema.Array(Schema.String)
})

export const run_log = Tool.make("run_log", {
  description:
    "The last lines (default 100) of a run's stdout and stderr; only runs this server started have logs.",
  parameters: Schema.Struct({ runId: Schema.String, lines: Schema.optional(Schema.Int) }),
  success: RunLogOut,
  failure: Schema.Union([UnknownRun, ReadFailed])
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const story_detail = Tool.make("story_detail", {
  description:
    "One story of an epic: durable state, board entry, plan tasks, findings, last judge verdict, gate logs.",
  parameters: Schema.Struct({ repo: repoParam, epic: Schema.String, story: Schema.String }),
  success: StoryDetail,
  failure: Schema.Union([UnknownRepo, UnknownEpic, UnknownStory, ReadFailed])
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const diagnose = Tool.make("diagnose", {
  description:
    "Why a run or one of its stories failed: a digest, the failure, gate log tails and the transcript tail, within a character budget (default 12000). A story needs an epic run.",
  parameters: Schema.Struct({
    runId: Schema.String,
    story: Schema.optional(Schema.String),
    chars: Schema.optional(Schema.Int)
  }),
  success: Diagnosis,
  failure: Schema.Union([UnknownRun, UnknownStory, TraceUnreadable, ReadFailed])
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const transcript_tail = Tool.make("transcript_tail", {
  description:
    "The last rows (default 40) of a lane's transcript, optionally one role; empty when the run kept none.",
  parameters: Schema.Struct({
    runId: Schema.String,
    lane: Schema.String,
    entries: Schema.optional(Schema.Int),
    role: Schema.optional(Schema.String)
  }),
  success: Schema.Array(Schema.String),
  failure: Schema.Union([UnknownRun, ReadFailed])
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const costs = Tool.make("costs", {
  description:
    "What one run cost (trace total, the ledger's figure and whether they differ), or the repository's costs over every trace when runId is left out.",
  parameters: Schema.Struct({ repo: repoParam, runId: Schema.optional(Schema.String) }),
  success: Schema.Union([CostsOut, CostsResult]),
  failure: Schema.Union([UnknownRepo, UnknownRun, TraceUnreadable, ReadFailed])
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const profile = Tool.make("profile", {
  description: "Where a run's time went: per story, model, gate and tool.",
  parameters: Schema.Struct({ runId: Schema.String }),
  success: ProfileReport,
  failure: Schema.Union([UnknownRun, TraceUnreadable, ReadFailed])
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const RetroOut = Schema.Struct({
  runId: Schema.String,
  at: Schema.Number,
  approved: Schema.Boolean,
  applied: Schema.Boolean
})

export const retro_list = Tool.make("retro_list", {
  description: "Retros written for an epic, oldest first, with their approval state.",
  parameters: Schema.Struct({ repo: repoParam, epic: Schema.String }),
  success: Schema.Array(RetroOut),
  failure: Schema.Union([UnknownRepo, UnknownEpic])
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const readToolkit = Toolkit.make(
  preflight,
  list_flows,
  list_epics,
  list_runs,
  run_status,
  run_events,
  run_log,
  story_detail,
  diagnose,
  transcript_tail,
  costs,
  profile,
  retro_list
)

// ---- Handlers -----------------------------------------------------------------------------

const defaultRunLimit = 20
const defaultEventLimit = 200
const maxEventLimit = 1_000
const defaultLogLines = 100
const defaultDiagnoseChars = 12_000
const defaultTranscriptEntries = 40
const transcriptWidth = 160

const isExcluded = (report: RosterReport, id: string, now: number): boolean =>
  report.exclusions.some(
    (exclusion) =>
      exclusion.id === id && (exclusion.kind !== "until" || (exclusion.until ?? 0) > now)
  )

const executorsOf = (
  deps: OperatorDeps,
  report: RosterReport
): Effect.Effect<ReadonlyArray<ExecutorHealthOut>> =>
  Effect.gen(function* () {
    const now = yield* deps.now
    return yield* Effect.forEach(report.document?.executors ?? [], (spec) =>
      Effect.gen(function* () {
        const healthy = spec.health === undefined ? undefined : yield* deps.probe(spec.health)
        return {
          id: spec.id,
          harness: spec.harness,
          roles: rolesOf(spec),
          disabled: spec.disabled === true || isExcluded(report, spec.id, now),
          ...(healthy === undefined ? {} : { healthy })
        }
      })
    )
  })

const firstLine = (text: string): string => text.split("\n")[0]?.trim() ?? ""

export const readHandlers = (
  deps: OperatorDeps
): Toolkit.HandlersFrom<Toolkit.Tools<typeof readToolkit>> =>
  readToolkit.of({
    preflight: ({ repo: repoId }) =>
      Effect.gen(function* () {
        const repo = yield* resolveRepo(deps.config, repoId)
        const doctor = yield* deps.doctor
        const connectors = doctor.connectors.map(
          (connector): ConnectorHealthOut => ({
            id: connector.id,
            availability: connector.status.availability,
            authStatus: connector.status.authStatus,
            probe: connector.probe,
            ...(connector.status.latency === undefined
              ? {}
              : { latencyMs: Math.round(Duration.toMillis(connector.status.latency)) })
          })
        )
        const roster = yield* deps.roster(repo.path).pipe(
          Effect.map((report) => ({ report, note: undefined })),
          Effect.catch((error) =>
            Effect.succeed({ report: undefined, note: `roster: ${describeFlowError(error)}` })
          )
        )
        const executors = roster.report === undefined ? [] : yield* executorsOf(deps, roster.report)
        return PreflightResult.make({
          llm4ts: packageVersion,
          node: process.version,
          connectors,
          executors,
          notes: [...doctor.lines, ...(roster.note === undefined ? [] : [roster.note])]
        })
      }),

    list_flows: ({ repo: repoId }) =>
      Effect.gen(function* () {
        const repo = yield* resolveRepo(deps.config, repoId)
        const flows = yield* deps.flows(repo.path).pipe(Effect.mapError(readFailed))
        return flows.map((flow) => ({
          name: flow.name,
          tier: flow.tier,
          ...(flow.description === undefined ? {} : { description: flow.description }),
          ...(flow.kit === undefined ? {} : { kit: flow.kit })
        }))
      }),

    list_epics: ({ repo: repoId }) =>
      Effect.gen(function* () {
        const repo = yield* resolveRepo(deps.config, repoId)
        return yield* Effect.forEach(deps.listEpics(epicsDir(repo)), (id) =>
          Effect.gen(function* () {
            const dir = join(epicsDir(repo), id)
            const planPath = join(dir, "plan.md")
            const plan = yield* makeStoryPlanStore(deps.files)
              .load(planPath)
              .pipe(Effect.mapError(readFailedAt(planPath)))
            const boardPath = join(dir, "board.json")
            const board = yield* loadVersioned(deps.files, boardPath, BoardVersion, Board).pipe(
              Effect.mapError(readFailedAt(boardPath))
            )
            const runs = yield* readEpicRunsStrict(deps.files, dir)
            const last = runs[runs.length - 1]
            const planTitle = plan === undefined ? "" : firstLine(plan.epic)
            return {
              id,
              title: planTitle.length > 0 ? planTitle : (board?.title ?? id),
              stories: plan?.stories.length ?? board?.items.length ?? 0,
              board: (board?.items ?? []).map((item) => ({ id: item.id, status: item.status })),
              ...(last === undefined
                ? {}
                : {
                    lastRun: { runId: last.runId, startedAt: last.startedAt, action: last.action }
                  })
            }
          })
        )
      }),

    list_runs: ({ repo: repoId, epic, limit }) =>
      Effect.gen(function* () {
        const repo = yield* resolveRepo(deps.config, repoId)
        const supervised = yield* deps.supervisor.list(repo.id)
        const discovered = yield* discoveredRuns(
          deps,
          repo,
          new Set(supervised.map((run) => run.runId))
        )
        let runs = [...supervised, ...discovered]
        if (epic !== undefined) {
          const dir = yield* epicDirOf(deps, repo, epic)
          const epicRuns = yield* readEpicRunsStrict(deps.files, dir)
          const ids = new Set(epicRuns.map((run) => run.runId))
          runs = runs.filter((run) => run.knobs.epic === epic || ids.has(run.runId))
        }
        return runs
          .sort((a, b) => b.startedAt - a.startedAt)
          .slice(0, Math.max(0, limit ?? defaultRunLimit))
      }),

    run_status: ({ runId }) =>
      Effect.gen(function* () {
        const run = yield* resolveRun(deps, runId)
        const epic = yield* epicOfRun(deps, run)
        const fold = (yield* tracePending(deps.files, run))
          ? { lines: [], state: emptyTree(), seq: 0 }
          : yield* foldTrace(deps.files, run.tracePath, epic?.dir)
        return runStatusOf(fold, run, yield* deps.now)
      }),

    run_events: ({ runId, sinceSeq, kinds, limit }) =>
      Effect.gen(function* () {
        const run = yield* resolveRun(deps, runId)
        const lines = yield* runTraceLines(deps.files, run)
        return eventsAfter(
          lines,
          sinceSeq ?? 0,
          kinds,
          clamp(limit ?? defaultEventLimit, 0, maxEventLimit)
        )
      }),

    run_log: ({ runId, lines }) =>
      Effect.gen(function* () {
        const run = yield* resolveRun(deps, runId)
        const logDir = run.supervised?.logDir
        if (logDir === undefined || logDir.length === 0) {
          return { stdout: [], stderr: [] }
        }
        const count = lines ?? defaultLogLines
        const stdout = yield* deps.files
          .read(join(logDir, "stdout.log"))
          .pipe(Effect.mapError(readFailed))
        const stderr = yield* deps.files
          .read(join(logDir, "stderr.log"))
          .pipe(Effect.mapError(readFailed))
        return { stdout: lastLines(stdout, count), stderr: lastLines(stderr, count) }
      }),

    story_detail: ({ repo: repoId, epic, story }) =>
      Effect.gen(function* () {
        const repo = yield* resolveRepo(deps.config, repoId)
        const dir = yield* epicDirOf(deps, repo, epic)
        return yield* storyDetailOf(sourcesOf(deps), dir, story).pipe(
          Effect.mapError((error) => (error instanceof UnknownStory ? error : readFailed(error)))
        )
      }),

    diagnose: ({ runId, story, chars }) =>
      Effect.gen(function* () {
        const run = yield* resolveRun(deps, runId)
        const budget = chars ?? defaultDiagnoseChars
        const transcripts = transcriptsDir(run.repo, run.runId)
        if (story !== undefined) {
          const epic = yield* epicOfRun(deps, run)
          if (epic === undefined) {
            return yield* UnknownStory.make({
              message: `run ${runId} is not an epic run, so it has no story '${story}'`
            })
          }
          return yield* storyDiagnosisOf(sourcesOf(deps), {
            stateDir: epic.dir,
            storyId: story,
            runId: run.runId,
            tracePath: run.tracePath,
            transcriptsDir: transcripts,
            budget
          }).pipe(
            Effect.mapError((error) =>
              error instanceof UnknownStory || error instanceof TraceUnreadable
                ? error
                : readFailed(error)
            )
          )
        }
        const task = run.supervised?.knobs.task
        return yield* runDiagnosisOf(sourcesOf(deps), {
          runId: run.runId,
          tracePath: run.tracePath,
          planPath: task === undefined ? undefined : join(run.repo.path, defaultPlanPath(task)),
          transcriptsDir: transcripts,
          gateLogDir: undefined,
          budget
        })
      }),

    transcript_tail: ({ runId, lane, entries, role }) =>
      Effect.gen(function* () {
        const run = yield* resolveRun(deps, runId)
        const loaded = yield* loadTranscript(
          deps.transcripts,
          transcriptsDir(run.repo, run.runId),
          { lane }
        )
        return (
          tailLinesOf(
            loaded,
            { lane },
            role,
            transcriptWidth,
            Math.max(0, entries ?? defaultTranscriptEntries)
          ) ?? []
        )
      }),

    costs: ({ repo: repoId, runId }) =>
      Effect.gen(function* () {
        if (runId !== undefined) {
          const run = yield* resolveRun(deps, runId)
          if (yield* tracePending(deps.files, run)) {
            return CostsOut.make({ report: buildCostReport([]), total: 0, differs: false })
          }
          return yield* costsOfRun(
            deps.files,
            run.tracePath,
            join(stateRoot(run.repo), CostLedgerFileName),
            run.runId
          )
        }
        const repo = yield* resolveRepo(deps.config, repoId)
        return yield* makeCostsProgram(
          { repos: [repo.path] },
          { files: deps.files, listTraces: deps.listTraces }
        )
      }),

    profile: ({ runId }) =>
      Effect.gen(function* () {
        const run = yield* resolveRun(deps, runId)
        const lines = yield* runTraceLines(deps.files, run)
        return profileOf(treeInputsOfTrace(lines))
      }),

    retro_list: ({ repo: repoId, epic }) =>
      Effect.gen(function* () {
        const repo = yield* resolveRepo(deps.config, repoId)
        const dir = yield* epicDirOf(deps, repo, epic)
        const index = yield* readRetroIndex(deps.files, dir)
        return yield* Effect.forEach(index, (entry) =>
          deps.files.read(retroPaths(dir, entry.runId).report).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
            Effect.map((markdown) => ({
              runId: entry.runId,
              at: entry.at,
              ...retroApprovalOf(markdown ?? "")
            }))
          )
        )
      })
  })
