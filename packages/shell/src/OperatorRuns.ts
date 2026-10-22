import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { EpicRun, epicRunsPath } from "@llm4ts/flow/EpicRuns"
import { describeFlowError } from "@llm4ts/flow/FlowError"
import { TraceLine } from "@llm4ts/flow/FlowRecorder"
import {
  OperatorRun,
  ReadFailed,
  UnknownEpic,
  UnknownRun,
  type OperatorRunState
} from "@llm4ts/flow/OperatorSchemas"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { readTrace } from "@llm4ts/flow/Replay"
import { TraceUnreadable } from "@llm4ts/runner/RunReaders"
import type { OperatorConfig } from "./OperatorConfig.ts"
import type { RunSupervisorShape } from "./RunSupervisor.ts"

/**
 * Where the operator finds a run: the supervisor's registry first, then each
 * served repository's epic `runs.jsonl` files and `.llm4ts/trace-*.jsonl`
 * traces. A client never names a path; epics and runs are ids found on disk.
 */

/** What run lookup reads; the operator's full dependency record extends it. */
export interface RunLookupDeps {
  readonly config: OperatorConfig
  readonly files: PlainFileStoreShape
  /** Absolute trace paths under one `.llm4ts/` directory. */
  readonly listTraces: (directory: string) => ReadonlyArray<string>
  /** Folder names under `.llm4ts/epics/`. */
  readonly listEpics: (directory: string) => ReadonlyArray<string>
  readonly supervisor: RunSupervisorShape
}

export interface Repo {
  readonly id: string
  readonly path: string
}

export const stateRoot = (repo: Repo): string => join(repo.path, ".llm4ts")
export const epicsDir = (repo: Repo): string => join(stateRoot(repo), "epics")
export const transcriptsDir = (repo: Repo, runId: string): string =>
  join(stateRoot(repo), "transcripts", runId)

export const readFailed = (error: unknown): ReadFailed =>
  ReadFailed.make({ message: describeFlowError(error) })

/** The epic's state folder, only for an id found on disk, so no client text becomes a path. */
export const epicDirOf = (
  deps: RunLookupDeps,
  repo: Repo,
  epic: string
): Effect.Effect<string, UnknownEpic> =>
  deps.listEpics(epicsDir(repo)).includes(epic)
    ? Effect.succeed(join(epicsDir(repo), epic))
    : Effect.fail(UnknownEpic.make({ message: `unknown epic '${epic}' in ${repo.id}` }))

const decodeEpicRun = Schema.decodeUnknownOption(Schema.fromJsonString(EpicRun))

/**
 * An epic's runs, oldest first. A missing file is no runs and a torn last line
 * (a write in progress) is skipped, but any other line that does not decode
 * fails `ReadFailed` naming the file.
 */
export const readEpicRunsStrict = (
  files: PlainFileStoreShape,
  stateDir: string
): Effect.Effect<ReadonlyArray<EpicRun>, ReadFailed> => {
  const path = epicRunsPath(stateDir)
  return files.read(path).pipe(
    Effect.mapError(readFailed),
    Effect.flatMap((contents) => {
      const rows = (contents ?? "").split("\n").filter((row) => row.trim().length > 0)
      const runs: Array<EpicRun> = []
      for (const [index, row] of rows.entries()) {
        const decoded = Option.getOrUndefined(decodeEpicRun(row))
        if (decoded !== undefined) {
          runs.push(decoded)
        } else if (index < rows.length - 1) {
          return Effect.fail(
            ReadFailed.make({ message: `malformed ${path}:${index + 1}: not an epic run record` })
          )
        }
      }
      return Effect.succeed(runs)
    })
  )
}

export interface EpicRunEntry {
  readonly epic: string
  readonly dir: string
  readonly run: EpicRun
}

export const epicRunsOf = (
  deps: RunLookupDeps,
  repo: Repo
): Effect.Effect<ReadonlyArray<EpicRunEntry>, ReadFailed> =>
  Effect.forEach(deps.listEpics(epicsDir(repo)), (epic) => {
    const dir = join(epicsDir(repo), epic)
    return readEpicRunsStrict(deps.files, dir).pipe(
      Effect.map((runs) => runs.map((run) => ({ epic, dir, run })))
    )
  }).pipe(Effect.map((all) => all.flat()))

const decodeTraceLine = Schema.decodeUnknownOption(Schema.fromJsonString(TraceLine))

export interface TraceHead {
  readonly runId: string
  readonly startedAt: number
  readonly ended: boolean
}

/** The run a trace belongs to and whether it ended, from its first and last lines. */
export const traceHead = (
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

export const traceState = (head: TraceHead | undefined): OperatorRunState =>
  head === undefined ? "lost" : head.ended ? "exited" : "running"

export interface ResolvedRun {
  readonly runId: string
  readonly repo: Repo
  readonly flow: string
  readonly state: OperatorRunState
  readonly tracePath: string
  readonly supervised?: OperatorRun
}

/** A run id through the supervisor first, then each repository's epic runs and traces. */
export const resolveRun = (
  deps: RunLookupDeps,
  runId: string
): Effect.Effect<ResolvedRun, UnknownRun | ReadFailed> =>
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
export const epicOfRun = (
  deps: RunLookupDeps,
  run: ResolvedRun
): Effect.Effect<EpicRunEntry | undefined, ReadFailed> =>
  Effect.map(epicRunsOf(deps, run.repo), (entries) =>
    entries.find((entry) => entry.run.runId === run.runId || entry.run.tracePath === run.tracePath)
  )

/** Runs found on disk (epic run lists and traces) that the supervisor does not hold. */
export const discoveredRuns = (
  deps: RunLookupDeps,
  repo: Repo,
  known: ReadonlySet<string>
): Effect.Effect<ReadonlyArray<OperatorRun>, ReadFailed> =>
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

/**
 * A run's trace lines. A supervised run whose trace file does not exist yet
 * (the flow has not written its first line) reads as an empty trace; any other
 * missing or unreadable trace fails `TraceUnreadable`.
 */
export const runTraceLines = (
  files: PlainFileStoreShape,
  run: ResolvedRun
): Effect.Effect<ReadonlyArray<TraceLine>, TraceUnreadable> =>
  Effect.gen(function* () {
    if (yield* tracePending(files, run)) return []
    return yield* readTrace(files, run.tracePath).pipe(
      Effect.mapError((error) =>
        TraceUnreadable.make({ path: run.tracePath, message: describeFlowError(error) })
      )
    )
  })

/** Whether the run is supervised and its flow has not written a trace yet. */
export const tracePending = (
  files: PlainFileStoreShape,
  run: ResolvedRun
): Effect.Effect<boolean, TraceUnreadable> =>
  run.supervised === undefined
    ? Effect.succeed(false)
    : files.read(run.tracePath).pipe(
        Effect.map((contents) => contents === undefined),
        Effect.mapError((error) =>
          TraceUnreadable.make({ path: run.tracePath, message: describeFlowError(error) })
        )
      )
