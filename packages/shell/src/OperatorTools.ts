import { join } from "node:path"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import { Board, BoardStatus, BoardVersion } from "@llm4ts/flow/BoardSync"
import { CostLedgerFileName } from "@llm4ts/flow/CostLedger"
import { readEpicRuns, type EpicRun } from "@llm4ts/flow/EpicRuns"
import { describeFlowError, type FlowError } from "@llm4ts/flow/FlowError"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"
import {
  CostsOut,
  Diagnosis,
  OperatorRun,
  PreflightResult,
  RunStatus,
  StoryDetail,
  UnknownRepo,
  UnknownRun,
  UnknownStory,
  type ConnectorHealthOut,
  type ExecutorHealthOut,
  type OperatorRunState
} from "@llm4ts/flow/OperatorSchemas"
import { loadVersioned, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { defaultPlanPath } from "@llm4ts/flow/Plan"
import { readRetroIndex, retroApprovalOf, retroPaths } from "@llm4ts/flow/Retro"
import { readTrace } from "@llm4ts/flow/Replay"
import { rolesOf } from "@llm4ts/flow/Roster"
import { makeStoryPlanStore } from "@llm4ts/flow/StoryPlan"
import { treeInputsOfTrace } from "@llm4ts/runner/AgentTree"
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
import { packageVersion } from "./Package.ts"
import type { RunSupervisorShape } from "./RunSupervisor.ts"

/**
 * The operator's read-only MCP tools (`llm4ts mcp`, ADR 0041): answers about
 * repositories, epics and runs from the files they write, over an
 * `OperatorDeps` record so tests call the handlers directly on memory stores
 * and fakes. A client never names a path: repositories, epics and runs are
 * ids resolved against the configuration and the files found on disk.
 */

// ---- Errors -----------------------------------------------------------------------------

/** An epic id that is not a folder under the repository's `.llm4ts/epics/`. */
export class UnknownEpic extends Schema.TaggedError<UnknownEpic>()("UnknownEpic", {
  message: Schema.String
}) {}

/** A state file that exists but could not be read or parsed. */
export class ReadFailed extends Schema.TaggedError<ReadFailed>()("ReadFailed", {
  message: Schema.String
}) {}

const readFailed = (error: unknown): ReadFailed =>
  ReadFailed.make({ message: describeFlowError(error) })

// ---- Dependencies -----------------------------------------------------------------------

export interface OperatorDeps {
  readonly config: OperatorConfig
  readonly files: PlainFileStoreShape
  /** Relative paths of every regular file under a directory, recursively; none when absent. */
  readonly listFiles: (directory: string) => ReadonlyArray<string>
  /** Absolute trace paths under one `.llm4ts/` directory. */
  readonly listTraces: (directory: string) => ReadonlyArray<string>
  /** Folder names under `.llm4ts/epics/`. */
  readonly listEpics: (directory: string) => ReadonlyArray<string>
  readonly transcripts: TranscriptFiles
  readonly supervisor: RunSupervisorShape
  readonly doctor: Effect.Effect<DoctorReport>
  readonly roster: (repoPath: string) => Effect.Effect<RosterReport, FlowError>
  readonly probe: (url: string) => Effect.Effect<boolean>
  readonly flows: (repoPath: string) => Effect.Effect<ReadonlyArray<DiscoveredFlow>, unknown>
  readonly now: Effect.Effect<number>
  readonly environment: Readonly<Record<string, string | undefined>>
}

interface Repo {
  readonly id: string
  readonly path: string
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

// ---- Locations --------------------------------------------------------------------------

const stateRoot = (repo: Repo): string => join(repo.path, ".llm4ts")
const epicsDir = (repo: Repo): string => join(stateRoot(repo), "epics")
const transcriptsDir = (repo: Repo, runId: string): string =>
  join(stateRoot(repo), "transcripts", runId)

const sourcesOf = (deps: OperatorDeps): RunSources => ({
  files: deps.files,
  listFiles: deps.listFiles
})

/** The epic's state folder, only for an id found on disk, so no client text becomes a path. */
const epicDirOf = (
  deps: OperatorDeps,
  repo: Repo,
  epic: string
): Effect.Effect<string, UnknownEpic> =>
  deps.listEpics(epicsDir(repo)).includes(epic)
    ? Effect.succeed(join(epicsDir(repo), epic))
    : Effect.fail(UnknownEpic.make({ message: `unknown epic '${epic}' in ${repo.id}` }))

interface EpicRunEntry {
  readonly epic: string
  readonly dir: string
  readonly run: EpicRun
}

const epicRunsOf = (deps: OperatorDeps, repo: Repo): Effect.Effect<ReadonlyArray<EpicRunEntry>> =>
  Effect.forEach(deps.listEpics(epicsDir(repo)), (epic) => {
    const dir = join(epicsDir(repo), epic)
    return readEpicRuns(deps.files, dir).pipe(
      Effect.catch(() => Effect.succeed([])),
      Effect.map((runs) => runs.map((run) => ({ epic, dir, run })))
    )
  }).pipe(Effect.map((all) => all.flat()))

const decodeTraceLine = Schema.decodeUnknownOption(Schema.fromJsonString(TraceLine))

interface TraceHead {
  readonly runId: string
  readonly startedAt: number
  readonly ended: boolean
}

/** The run a trace belongs to and whether it ended, from its first and last lines. */
const traceHead = (
  files: PlainFileStoreShape,
  path: string
): Effect.Effect<TraceHead | undefined> =>
  files.read(path).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
    Effect.map((contents) => {
      const rows = (contents ?? "").split(/\r?\n/u).filter((row) => row.trim().length > 0)
      const first = Option.getOrUndefined(decodeTraceLine(rows[0] ?? ""))
      if (first === undefined) return undefined
      const last = Option.getOrUndefined(decodeTraceLine(rows[rows.length - 1] ?? ""))
      return { runId: first.runId, startedAt: first.timestamp, ended: last?.kind === "RunEnded" }
    })
  )

const traceState = (head: TraceHead | undefined): OperatorRunState =>
  head === undefined ? "lost" : head.ended ? "exited" : "running"

interface ResolvedRun {
  readonly runId: string
  readonly repo: Repo
  readonly flow: string
  readonly state: OperatorRunState
  readonly tracePath: string
  readonly supervised?: OperatorRun
}

/** A run id through the supervisor first, then each repository's epic runs and traces. */
const resolveRun = (deps: OperatorDeps, runId: string): Effect.Effect<ResolvedRun, UnknownRun> =>
  Effect.gen(function* () {
    const supervised = yield* deps.supervisor.get(runId)
    if (supervised !== undefined) {
      const repo = deps.config.repos.find((candidate) => candidate.id === supervised.repo)
      if (repo === undefined) {
        return yield* UnknownRun.make({
          message: `run ${runId} belongs to repo '${supervised.repo}', which this server does not serve`
        })
      }
      if (supervised.tracePath === undefined) {
        return yield* UnknownRun.make({ message: `run ${runId} has no trace yet` })
      }
      return {
        runId,
        repo,
        flow: supervised.flow,
        state: supervised.state,
        tracePath: supervised.tracePath,
        supervised
      }
    }
    for (const repo of deps.config.repos) {
      for (const entry of yield* epicRunsOf(deps, repo)) {
        if (entry.run.runId === runId) {
          const head = yield* traceHead(deps.files, entry.run.tracePath)
          return {
            runId,
            repo,
            flow: "?",
            state: traceState(head),
            tracePath: entry.run.tracePath
          }
        }
      }
      for (const path of deps.listTraces(stateRoot(repo))) {
        const head = yield* traceHead(deps.files, path)
        if (head?.runId === runId) {
          return { runId, repo, flow: "?", state: traceState(head), tracePath: path }
        }
      }
    }
    return yield* UnknownRun.make({ message: `unknown run '${runId}'` })
  })

/** The epic a run worked on: the epic whose `runs.jsonl` lists it. */
const epicOfRun = (deps: OperatorDeps, run: ResolvedRun): Effect.Effect<EpicRunEntry | undefined> =>
  Effect.map(epicRunsOf(deps, run.repo), (entries) =>
    entries.find((entry) => entry.run.runId === run.runId || entry.run.tracePath === run.tracePath)
  )

/** Runs found on disk (epic run lists and traces) that the supervisor does not hold. */
const discoveredRuns = (
  deps: OperatorDeps,
  repo: Repo,
  known: ReadonlySet<string>
): Effect.Effect<ReadonlyArray<OperatorRun>> =>
  Effect.gen(function* () {
    const found = new Map<string, OperatorRun>()
    const add = (runId: string, tracePath: string, startedAt: number, state: OperatorRunState) => {
      if (known.has(runId) || found.has(runId)) return
      found.set(
        runId,
        new OperatorRun({
          runId,
          repo: repo.id,
          flow: "?",
          args: [],
          knobs: {},
          startedAt,
          tracePath,
          logDir: "",
          state
        })
      )
    }
    for (const entry of yield* epicRunsOf(deps, repo)) {
      const head = yield* traceHead(deps.files, entry.run.tracePath)
      add(entry.run.runId, entry.run.tracePath, entry.run.startedAt, traceState(head))
    }
    for (const path of deps.listTraces(stateRoot(repo))) {
      const head = yield* traceHead(deps.files, path)
      if (head !== undefined) add(head.runId, path, head.startedAt, traceState(head))
    }
    return [...found.values()]
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
    "Is this machine ready to run? Connector health (a probe of 'version' only ran `<cli> --version` and does not prove a live session), roster executors with their health URL probed, Node and llm4ts versions.",
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
  failure: Schema.Union([UnknownRepo])
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
  failure: Schema.Union([UnknownRepo, UnknownEpic])
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const run_status = Tool.make("run_status", {
  description:
    "One run now: state, elapsed, lanes, stories board, tokens and cost so far, warnings, and a one-line summary.",
  parameters: Schema.Struct({ runId: Schema.String }),
  success: RunStatus,
  failure: Schema.Union([UnknownRun, TraceUnreadable])
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
  failure: Schema.Union([UnknownRun, TraceUnreadable])
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
  failure: Schema.Union([UnknownRun])
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const costs = Tool.make("costs", {
  description:
    "What one run cost (trace total, the ledger's figure and whether they differ), or the repository's costs over every trace when runId is left out.",
  parameters: Schema.Struct({ repo: repoParam, runId: Schema.optional(Schema.String) }),
  success: Schema.Union([CostsOut, CostsResult]),
  failure: Schema.Union([UnknownRepo, UnknownRun, TraceUnreadable])
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)

export const profile = Tool.make("profile", {
  description: "Where a run's time went: per story, model, gate and tool.",
  parameters: Schema.Struct({ runId: Schema.String }),
  success: ProfileReport,
  failure: Schema.Union([UnknownRun, TraceUnreadable])
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

const readTraceLines = (
  files: PlainFileStoreShape,
  path: string
): Effect.Effect<ReadonlyArray<TraceLine>, TraceUnreadable> =>
  readTrace(files, path).pipe(
    Effect.mapError((error) => TraceUnreadable.make({ path, message: describeFlowError(error) }))
  )

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
            const plan = yield* makeStoryPlanStore(deps.files)
              .load(join(dir, "plan.md"))
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
            const board = yield* loadVersioned(
              deps.files,
              join(dir, "board.json"),
              BoardVersion,
              Board
            ).pipe(Effect.catch(() => Effect.succeed(undefined)))
            const runs = yield* readEpicRuns(deps.files, dir).pipe(
              Effect.catch(() => Effect.succeed([]))
            )
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
          const epicRuns = yield* readEpicRuns(deps.files, dir).pipe(
            Effect.catch(() => Effect.succeed([]))
          )
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
        const fold = yield* foldTrace(deps.files, run.tracePath, epic?.dir)
        return runStatusOf(fold, run, yield* deps.now)
      }),

    run_events: ({ runId, sinceSeq, kinds, limit }) =>
      Effect.gen(function* () {
        const run = yield* resolveRun(deps, runId)
        const lines = yield* readTraceLines(deps.files, run.tracePath)
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
        const lines = yield* readTraceLines(deps.files, run.tracePath)
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
