import { readdirSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { Board, BoardVersion } from "@llm4ts/flow/BoardSync"
import { readEpicRuns, type EpicRun } from "@llm4ts/flow/EpicRuns"
import type { FlowError } from "@llm4ts/flow/FlowError"
import { loadVersioned, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { readTrace } from "@llm4ts/flow/Replay"
import {
  emptyTree,
  initialView,
  onTreeKey,
  reduceTree,
  renderTree,
  tailTargetOf,
  treeInputsOfTrace,
  type TreeInput,
  type TreeState,
  type TreeView
} from "./AgentTree.ts"
import { enterScreen, leaveScreen, makeScreenPainter, nodeTreeKeys } from "./AgentTreeSurface.ts"
import {
  loadTranscript,
  nodeTranscriptFiles,
  renderTranscript,
  tailLinesOf,
  transcriptFileOf,
  type TailTarget,
  type TranscriptFiles
} from "./Transcripts.ts"
import { nodeListTraces, TraceDirectoryName } from "./Costs.ts"
import { nodePlainFileStore } from "./NodePlainFileStore.ts"

/**
 * `llm4ts watch` (ADR 0022): the agent tree over a trace file — a live run
 * followed as it grows, a finished run's last frame, or a replay on the
 * trace's own timestamps. The trace is the only source; the epic's board
 * adds the stories that have not started.
 */

export interface WatchOptions {
  readonly repo: string
  /** A trace file; the newest in the repository's `.llm4ts/` when omitted. */
  readonly trace?: string
  /** An epic id: its latest recorded run. */
  readonly epic?: string
  readonly replay?: boolean
  /** Replay speed-up (default 10). */
  readonly speed?: number
  /** A live lane with no event for this long is marked idle (`LLM4TS_IDLE_AFTER`). */
  readonly idleAfterMs?: number
  /** Print this story's or executor's transcript as it grows, instead of the tree. */
  readonly tail?: string
}

export interface WatchOutput {
  readonly write: (text: string) => Effect.Effect<void>
  readonly columns: () => number | undefined
  readonly rows: () => number | undefined
  /** A terminal a person looks at: full-screen, keys, following. */
  readonly interactive: boolean
  readonly colour: boolean
}

export interface WatchDependencies {
  readonly files: PlainFileStoreShape
  readonly listTraces: (directory: string) => ReadonlyArray<string>
  /** Epic folder names under `.llm4ts/epics/`. */
  readonly listEpics: (directory: string) => ReadonlyArray<string>
  readonly output: WatchOutput
  /** Key names as `onTreeKey` reads them: "up", "enter", "q", … */
  readonly keys: Stream.Stream<string>
  /** A run's transcript files (`--transcript`); the disk by default. */
  readonly transcripts?: TranscriptFiles
}

export class WatchTargetMissing extends Schema.TaggedError<WatchTargetMissing>()(
  "WatchTargetMissing",
  { message: Schema.String }
) {}

/** Where a run's trace and its epic are read from. */
export type TraceSources = Pick<WatchDependencies, "files" | "listTraces" | "listEpics">

/** A trace to read: given, an epic's latest run, or the newest in the repository. */
export type TraceChoice = Pick<WatchOptions, "repo" | "trace" | "epic">

export interface WatchTarget {
  readonly tracePath: string
  readonly epicDir: string | undefined
  readonly run: EpicRun | undefined
}

const epicsDirOf = (repo: string): string => join(repo, TraceDirectoryName, "epics")

/** The epic whose `runs.jsonl` names this trace, if one does. */
const epicOfTrace = (
  tracePath: string,
  repo: string,
  dependencies: TraceSources
): Effect.Effect<{ readonly dir: string; readonly run: EpicRun } | undefined, FlowError> =>
  Effect.gen(function* () {
    const epicsDir = epicsDirOf(repo)
    for (const epic of dependencies.listEpics(epicsDir)) {
      const dir = join(epicsDir, epic)
      const run = [...(yield* readEpicRuns(dependencies.files, dir))]
        .reverse()
        .find((candidate) => candidate.tracePath === tracePath)
      if (run !== undefined) {
        return { dir, run }
      }
    }
    return undefined
  })

export const resolveTraceTarget = (
  options: TraceChoice,
  dependencies: TraceSources
): Effect.Effect<WatchTarget, FlowError | WatchTargetMissing> =>
  Effect.gen(function* () {
    if (options.epic !== undefined) {
      const dir = join(epicsDirOf(options.repo), options.epic)
      const run = (yield* readEpicRuns(dependencies.files, dir)).at(-1)
      if (run === undefined) {
        return yield* WatchTargetMissing.make({
          message: `epic ${options.epic} has no recorded run in ${dir}/runs.jsonl`
        })
      }
      return { tracePath: run.tracePath, epicDir: dir, run }
    }
    const tracePath =
      options.trace ?? dependencies.listTraces(join(options.repo, TraceDirectoryName)).at(-1)
    if (tracePath === undefined) {
      return yield* WatchTargetMissing.make({
        message: `no trace in ${join(options.repo, TraceDirectoryName)}; pass a trace file or --epic`
      })
    }
    const epic = yield* epicOfTrace(tracePath, options.repo, dependencies)
    return { tracePath, epicDir: epic?.dir, run: epic?.run }
  })

const actionWords = (run: EpicRun | undefined): string | undefined => {
  if (run === undefined) {
    return undefined
  }
  switch (run.action) {
    case "RunPlan":
      return "run plan"
    case "RunRound":
      return `round ${run.round ?? "?"}`
    case "PlanRound":
      return `plan round ${run.round ?? "?"}`
    case "Land":
      return "land"
    default:
      return run.action
  }
}

/** The tree before any event: the epic's board, when the trace belongs to one. */
const startingTree = (
  target: WatchTarget,
  files: PlainFileStoreShape,
  idleAfterMs: number | undefined
): Effect.Effect<TreeState, FlowError> =>
  Effect.gen(function* () {
    const action = actionWords(target.run)
    const idle = idleAfterMs === undefined ? {} : { idleAfterMs }
    if (target.epicDir === undefined) {
      return emptyTree({ ...idle, ...(action === undefined ? {} : { action }) })
    }
    const boardDir =
      target.run?.round === undefined
        ? target.epicDir
        : join(target.epicDir, "rounds", String(target.run.round))
    const board = yield* loadVersioned(files, join(boardDir, "board.json"), BoardVersion, Board)
    const epicId = target.epicDir.split("/").at(-1) ?? "epic"
    return emptyTree({
      title: board === undefined ? `epic ${epicId}` : board.title.replace(/^Epic:\s*/u, "epic "),
      stories: (board?.items ?? []).map((item) => ({ id: item.id, status: item.status })),
      ...idle,
      ...(action === undefined ? {} : { action })
    })
  })

const readInputs = (
  target: WatchTarget,
  files: PlainFileStoreShape
): Effect.Effect<ReadonlyArray<TreeInput>, FlowError> =>
  Effect.map(readTrace(files, target.tracePath), treeInputsOfTrace)

const pollInterval = Duration.millis(500)
const replayGapCap = 2_000

const draw = (
  state: TreeState,
  view: TreeView,
  output: WatchOutput,
  height?: number,
  tail?: ReadonlyArray<string>
): string =>
  renderTree(state, {
    width: Math.max(90, output.columns() ?? 90),
    colour: output.colour,
    view,
    ...(height === undefined ? {} : { height }),
    ...(tail === undefined ? {} : { tail })
  }).join("\n")

/** A full-screen frame: no taller than the terminal. */
const screenLines = (
  state: TreeState,
  view: TreeView,
  output: WatchOutput,
  tail?: ReadonlyArray<string>
): ReadonlyArray<string> => draw(state, view, output, output.rows(), tail).split("\n")

/** Rows the tail pane shows. */
const tailRows = 16

/** Where a trace's run kept its transcript: `.llm4ts/transcripts/<run-id>/`. */
const transcriptDirOf = (
  repo: string,
  target: WatchTarget,
  files: PlainFileStoreShape
): Effect.Effect<string | undefined, FlowError> =>
  Effect.map(readTrace(files, target.tracePath), (lines) => {
    const runId = lines[0]?.runId
    return runId === undefined ? undefined : join(repo, TraceDirectoryName, "transcripts", runId)
  })

export const makeWatchProgram = Effect.fn("@llm4ts/runner/Watch.make")(function* (
  options: WatchOptions,
  dependencies: WatchDependencies
): Effect.fn.Return<void, FlowError | WatchTargetMissing> {
  const target = yield* resolveTraceTarget(options, dependencies)
  const { files, output } = dependencies
  const fold = (inputs: ReadonlyArray<TreeInput>): Effect.Effect<TreeState, FlowError> =>
    Effect.map(startingTree(target, files, options.idleAfterMs), (start) =>
      inputs.reduce(reduceTree, start)
    )

  const transcripts = dependencies.transcripts ?? nodeTranscriptFiles
  const transcriptDir = yield* transcriptDirOf(options.repo, target, files)

  if (options.tail !== undefined) {
    if (transcriptDir === undefined || transcripts.list(transcriptDir).length === 0) {
      return yield* WatchTargetMissing.make({
        message: "no transcript for this run — start it with llm4ts run … --transcript"
      })
    }
    return yield* followTail(options.tail, transcriptDir, transcripts, output, () =>
      Effect.map(readInputs(target, files), (inputs) =>
        inputs.some((input) => input._tag === "RunEnded")
      )
    )
  }

  /** The open tail's lines, for the view's selection. */
  const tailFor = (view: TreeView): Effect.Effect<ReadonlyArray<string> | undefined> => {
    const selected = tailTargetOf(view)
    return !view.tail || selected === undefined || transcriptDir === undefined
      ? Effect.succeed(undefined)
      : Effect.map(loadTranscript(transcripts, transcriptDir, selected), (entries) =>
          tailLinesOf(
            entries,
            selected,
            view.tailRole,
            Math.max(90, output.columns() ?? 90) - 32,
            tailRows,
            view.tailBack
          )
        )
  }

  if (!output.interactive) {
    const state = yield* Effect.flatMap(readInputs(target, files), fold)
    return yield* output.write(`${draw(state, initialView, output)}\n`)
  }

  yield* Effect.scoped(
    Effect.gen(function* () {
      const keys = yield* Queue.unbounded<string>()
      yield* Effect.forkScoped(
        Stream.runForEach(dependencies.keys, (key) => Queue.offer(keys, key))
      )
      const view = yield* Ref.make<TreeView>(initialView)
      const all = yield* readInputs(target, files)
      // Replay steps through the inputs on their timestamps; otherwise the
      // whole trace is shown and re-read while the run goes on.
      const shown = yield* Ref.make(options.replay === true ? Math.min(1, all.length) : all.length)
      const inputs = yield* Ref.make(all)
      const speed = Math.max(1, options.speed ?? 10)

      /** Waits for a key or for `wait`; true when the key was `q`. */
      const awaitKey = (wait: Duration.Duration): Effect.Effect<boolean> =>
        Effect.raceFirst(
          Effect.flatMap(Queue.take(keys), (key) =>
            Effect.gen(function* () {
              const state = yield* Effect.orDie(
                Effect.flatMap(Ref.get(inputs), (current) =>
                  Effect.flatMap(Ref.get(shown), (count) => fold(current.slice(0, count)))
                )
              )
              const next = onTreeKey(yield* Ref.get(view), key, state)
              if (next === "quit") {
                return true
              }
              yield* Ref.set(view, next)
              return false
            })
          ),
          Effect.as(Effect.sleep(wait), false)
        )

      const painter = yield* makeScreenPainter
      yield* output.write(enterScreen)
      yield* Effect.gen(function* () {
        while (true) {
          const current = yield* Ref.get(inputs)
          const count = yield* Ref.get(shown)
          const folded = yield* fold(current.slice(0, count))
          // Following a live run, the clock moves between events; a replay
          // and a finished run keep the trace's own time.
          const state =
            options.replay !== true && folded.ended === undefined
              ? reduceTree(folded, { _tag: "Tick", at: yield* Clock.currentTimeMillis })
              : folded
          const text = yield* painter.paint(
            screenLines(state, yield* Ref.get(view), output, yield* tailFor(yield* Ref.get(view))),
            `${output.columns()}x${output.rows()}`
          )
          if (text.length > 0) {
            yield* output.write(text)
          }
          const replaying = options.replay === true && count < current.length
          const gap = replaying
            ? Math.min(replayGapCap, (current[count]?.at ?? 0) - (current[count - 1]?.at ?? 0)) /
              speed
            : Duration.toMillis(pollInterval)
          if (yield* awaitKey(Duration.millis(Math.max(0, gap)))) {
            return
          }
          if (replaying) {
            yield* Ref.update(shown, (shownCount) => shownCount + 1)
          } else if (state.ended === undefined) {
            const reread = yield* readInputs(target, files)
            yield* Ref.set(inputs, reread)
            yield* Ref.set(shown, reread.length)
          }
        }
      }).pipe(Effect.ensuring(output.write(leaveScreen)))
    })
  )
})

// ── node wiring ─────────────────────────────────────────────────────────────

const nodeListEpics = (directory: string): ReadonlyArray<string> =>
  existsSync(directory)
    ? readdirSync(directory).filter((name) => statSync(join(directory, name)).isDirectory())
    : []

export const nodeTraceSources: TraceSources = {
  files: nodePlainFileStore,
  listTraces: nodeListTraces,
  listEpics: nodeListEpics
}

export const nodeWatchDependencies = (
  environment: Readonly<Record<string, string | undefined>> = process.env
): WatchDependencies => {
  const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true
  return {
    files: nodePlainFileStore,
    listTraces: nodeListTraces,
    listEpics: nodeListEpics,
    output: {
      write: (text) => Effect.sync(() => void process.stdout.write(text)),
      columns: () => process.stdout.columns,
      rows: () => process.stdout.rows,
      interactive,
      colour: process.stdout.isTTY === true && environment.NO_COLOR === undefined
    },
    keys: nodeTreeKeys("detach")
  }
}

// ── tail ────────────────────────────────────────────────────────────────────

/**
 * `llm4ts watch --tail <story|executor>`: the transcript printed as it grows,
 * like `tail -f` — a call's reply streams in as written — until the run ends.
 * A name with its own file is a story; any other is an executor.
 */
const followTail = (
  name: string,
  directory: string,
  transcripts: TranscriptFiles,
  output: WatchOutput,
  ended: () => Effect.Effect<boolean, FlowError>
): Effect.Effect<void, FlowError> =>
  Effect.gen(function* () {
    const target: TailTarget = transcripts.list(directory).includes(transcriptFileOf(name))
      ? { lane: name }
      : { executor: name }
    const width = Math.max(60, output.columns() ?? 100)
    let shown = 0
    let start: number | undefined
    const wanted = new Set<string>()
    let replying: string | undefined
    while (true) {
      const done = yield* ended()
      const entries = (yield* loadTranscript(transcripts, directory, target)) ?? []
      for (const entry of entries.slice(shown)) {
        start = start ?? entry.at
        if (entry._tag === "Call" && ("lane" in target || entry.executor === target.executor)) {
          wanted.add(entry.call)
        }
        if (!wanted.has(entry.call)) {
          continue
        }
        if (entry._tag === "Reply") {
          // A reply streams: its text as it arrived, on one growing paragraph.
          yield* output.write(`${replying === entry.call ? "" : "◀ "}${entry.text}`)
          replying = entry.call
          continue
        }
        const lines = renderTranscript([entry], { width, since: start })
        yield* output.write(`${replying === undefined ? "" : "\n"}${lines.join("\n")}\n`)
        replying = undefined
      }
      shown = entries.length
      if (done) {
        return
      }
      yield* Effect.sleep(pollInterval)
    }
  })
