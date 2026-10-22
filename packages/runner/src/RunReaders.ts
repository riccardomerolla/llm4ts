import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Board, BoardVersion } from "@llm4ts/flow/BoardSync"
import { loadCostLedger } from "@llm4ts/flow/CostLedger"
import { buildCostReport, usageSamplesFromTrace } from "@llm4ts/flow/CostReport"
import { describeFlowError, type FlowError } from "@llm4ts/flow/FlowError"
import { FlowEvent } from "@llm4ts/flow/FlowEvents"
import { RunOutcome, type TraceLine } from "@llm4ts/flow/FlowRecorder"
import {
  CostsOut,
  Diagnosis,
  RunStatus,
  type LaneStatusOut,
  type MeaningfulEvent,
  type OperatorRunState
} from "@llm4ts/flow/OperatorSchemas"
import { loadVersioned, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { parsePlan } from "@llm4ts/flow/Plan"
import { readTrace } from "@llm4ts/flow/Replay"
import { emptyTree, reduceTree, treeInputsOfTrace, type TreeState } from "./AgentTree.ts"
import { summarizeTree } from "./RunSummary.ts"
import { loadTranscript, tailLinesOf, type TranscriptFiles } from "./Transcripts.ts"

/**
 * Read-only answers about a run, from the files it writes: how it stands,
 * what happened since a sequence number, why it failed, what it cost. Every
 * reader takes the file store as a parameter, so a test feeds it a memory
 * store and the MCP operator feeds it the real one.
 */

export class TraceUnreadable extends Schema.TaggedError<TraceUnreadable>()("TraceUnreadable", {
  path: Schema.String,
  message: Schema.String
}) {}

export interface RunSources {
  readonly files: PlainFileStoreShape
  /** File names in a directory; none when it does not exist. */
  readonly listFiles: (directory: string) => ReadonlyArray<string>
}

export interface TraceFold {
  readonly lines: ReadonlyArray<TraceLine>
  readonly state: TreeState
  readonly seq: number
}

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(FlowEvent))
const isOutcome = Schema.is(RunOutcome)

const eventOf = (line: TraceLine): FlowEvent | undefined => {
  const raw = line.fields.event
  return typeof raw === "string" ? Option.getOrUndefined(decodeEvent(raw)) : undefined
}

const unreadable =
  (path: string) =>
  (error: FlowError): TraceUnreadable =>
    TraceUnreadable.make({ path, message: describeFlowError(error) })

const readLines = (
  files: PlainFileStoreShape,
  path: string
): Effect.Effect<ReadonlyArray<TraceLine>, TraceUnreadable> =>
  readTrace(files, path).pipe(Effect.mapError(unreadable(path)))

const lastSeq = (lines: ReadonlyArray<TraceLine>): number => lines[lines.length - 1]?.seq ?? 0

/** The trace folded into the watch TUI's tree, seeded from the epic's board when there is one. */
export const foldTrace = (
  files: PlainFileStoreShape,
  tracePath: string,
  boardDir?: string
): Effect.Effect<TraceFold, TraceUnreadable> =>
  Effect.gen(function* () {
    const lines = yield* readLines(files, tracePath)
    const board =
      boardDir === undefined
        ? undefined
        : yield* loadVersioned(files, join(boardDir, "board.json"), BoardVersion, Board).pipe(
            Effect.catch(() => Effect.succeed(undefined))
          )
    const start = emptyTree(
      board === undefined
        ? {}
        : {
            title: board.title.replace(/^Epic:\s*/u, "epic "),
            stories: board.items.map((item) => ({ id: item.id, status: item.status }))
          }
    )
    const state = treeInputsOfTrace(lines).reduce(reduceTree, start)
    return { lines, state, seq: lastSeq(lines) }
  })

export const runStatusOf = (
  fold: TraceFold,
  run: {
    readonly runId: string
    readonly flow: string
    readonly state: OperatorRunState
  },
  now: number
): RunStatus => {
  const { state } = fold
  const lanes = state.lanes.map((lane): LaneStatusOut => {
    const stage = lane.stages[lane.stages.length - 1]
    return {
      id: lane.id,
      status: lane.status,
      ...(stage === undefined ? {} : { stage }),
      ...(lane.executor === undefined ? {} : { executor: lane.executor }),
      ...(lane.activity === undefined ? {} : { activity: lane.activity.text }),
      lastEventAgeMs: Math.max(0, Math.round(now - lane.lastEventAt)),
      costUsd: lane.costUsd
    }
  })
  const unenforceable = fold.lines.flatMap((line) => {
    const event = eventOf(line)
    return event?._tag === "CapabilityUnenforceable" ? [event.detail] : []
  })
  const end = state.ended === undefined ? now : (state.now ?? now)
  return RunStatus.make({
    runId: run.runId,
    state: run.state,
    ...(state.ended !== undefined && isOutcome(state.ended) ? { ended: state.ended } : {}),
    elapsedMs: state.startedAt === undefined ? 0 : Math.max(0, Math.round(end - state.startedAt)),
    lanes,
    stories: state.stories.map((story) => ({ id: story.id, status: story.status })),
    tokens: Math.round(state.tokens),
    costUsd: state.costUsd,
    warnings: [
      ...unenforceable,
      ...state.exclusions.map((entry) => `${entry.executor} excluded: ${entry.reason}`)
    ],
    seq: fold.seq,
    summary: summarizeTree(state, run.flow)
  })
}

export const meaningfulKinds: ReadonlySet<string> = new Set([
  "StoryStatusChanged",
  "StageFailed",
  "Aborted",
  "CapabilityUnenforceable",
  "ExecutorExcluded",
  "ExecutorHandedOver",
  "StoryJudged",
  "Began",
  "RunEnded"
])

const textOf = (
  event: FlowEvent
): { readonly text: string; readonly lane?: string } | undefined => {
  switch (event._tag) {
    case "StoryStatusChanged":
      return { text: `story ${event.id} ${event.status}`, lane: event.id }
    case "StageFailed":
      return {
        text: `${event.stage} failed: ${event.message}`,
        ...(event.lane === undefined ? {} : { lane: event.lane })
      }
    case "Aborted":
      return { text: `aborted: ${event.message}` }
    case "CapabilityUnenforceable":
      return { text: `capability unenforceable: ${event.detail}` }
    case "ExecutorExcluded":
      return { text: `${event.executor} excluded: ${event.reason}` }
    case "ExecutorHandedOver":
      return {
        text: `${event.from} handed over ${event.role} (${event.scope}): ${event.reason}`,
        ...(event.label === undefined ? {} : { lane: event.label })
      }
    case "StoryJudged":
      return {
        text: `${event.lane} judged round ${event.round}: ${event.cleared ? "cleared" : `${event.issues} issues`}`,
        lane: event.lane
      }
    case "Began":
      return {
        text: `began ${event.kind} ${event.label}`,
        ...(event.lane === undefined ? {} : { lane: event.lane })
      }
    default:
      return undefined
  }
}

export const meaningfulEventsAfter = (
  lines: ReadonlyArray<TraceLine>,
  sinceSeq: number
): ReadonlyArray<MeaningfulEvent> =>
  lines.flatMap((line): ReadonlyArray<MeaningfulEvent> => {
    if (line.seq <= sinceSeq || !meaningfulKinds.has(line.kind)) {
      return []
    }
    if (line.kind === "RunEnded") {
      const outcome = line.fields.outcome
      return [
        {
          seq: line.seq,
          at: line.timestamp,
          kind: line.kind,
          text: `run ${typeof outcome === "string" ? outcome : "completed"}`
        }
      ]
    }
    const event = eventOf(line)
    const rendered = event === undefined ? undefined : textOf(event)
    return rendered === undefined
      ? []
      : [
          {
            seq: line.seq,
            at: line.timestamp,
            kind: line.kind,
            ...(rendered.lane === undefined ? {} : { lane: rendered.lane }),
            text: rendered.text
          }
        ]
  })

export const eventsAfter = (
  lines: ReadonlyArray<TraceLine>,
  sinceSeq: number,
  kinds: ReadonlyArray<string> | undefined,
  limit: number
): ReadonlyArray<TraceLine> =>
  lines
    .filter(
      (line) =>
        line.seq > sinceSeq && (kinds === undefined || kinds.some((kind) => kind === line.kind))
    )
    .slice(0, Math.max(0, limit))

const digestTail = 40
const tailRows = 30
const tailWidth = 120

const quiet = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A | undefined> =>
  effect.pipe(Effect.catch(() => Effect.succeed(undefined)))

const capText = (text: string, remaining: number): string => text.slice(0, Math.max(0, remaining))

export const runDiagnosisOf = (
  sources: RunSources,
  args: {
    readonly runId: string
    readonly tracePath: string
    readonly planPath: string | undefined
    readonly transcriptsDir: string | undefined
    readonly gateLogDir: string | undefined
    readonly budget: number
  }
): Effect.Effect<Diagnosis, TraceUnreadable> =>
  Effect.gen(function* () {
    const lines = yield* readLines(sources.files, args.tracePath)
    const events = lines.flatMap((line) => {
      const event = eventOf(line)
      return event === undefined ? [] : [event]
    })
    const failed = events.filter(
      (event) => event._tag === "StageFailed" || event._tag === "Aborted"
    )
    const last = failed[failed.length - 1]
    const failure =
      last === undefined
        ? undefined
        : last._tag === "StageFailed"
          ? {
              stage: last.stage,
              message: last.message,
              ...(last.lane === undefined ? {} : { lane: last.lane })
            }
          : last._tag === "Aborted"
            ? { message: last.message }
            : undefined

    const markdown =
      args.planPath === undefined ? undefined : yield* quiet(sources.files.read(args.planPath))
    const plan = markdown === undefined ? undefined : yield* quiet(parsePlan(markdown))
    const taskLines = (plan?.tasks ?? []).map(
      (task) => `- [${task.completed ? "x" : " "}] ${task.title}`
    )
    const recent = events
      .flatMap((event) =>
        event._tag === "Info"
          ? [event.message]
          : event._tag === "StageFailed"
            ? [`${event.stage} failed: ${event.message}`]
            : []
      )
      .slice(-digestTail)
    const digest = capText([...taskLines, ...recent].join("\n"), args.budget)
    let remaining = args.budget - digest.length

    const gateLogTails: Array<{ path: string; tail: string }> = []
    if (args.gateLogDir !== undefined) {
      for (const name of sources.listFiles(args.gateLogDir)) {
        const path = join(args.gateLogDir, name)
        const text = yield* quiet(sources.files.read(path))
        if (text === undefined || remaining <= 0) continue
        const tail = capText(text.trimEnd().split(/\r?\n/u).slice(-tailRows).join("\n"), remaining)
        remaining -= tail.length
        gateLogTails.push({ path, tail })
      }
    }

    const transcriptTail: Array<string> = []
    if (args.transcriptsDir !== undefined) {
      const transcriptFiles: TranscriptFiles = {
        read: (path) => quiet(sources.files.read(path)),
        list: sources.listFiles
      }
      const entries = yield* loadTranscript(transcriptFiles, args.transcriptsDir, { lane: "run" })
      const rows = tailLinesOf(entries, { lane: "run" }, undefined, tailWidth, tailRows) ?? []
      for (const row of rows) {
        if (remaining <= 0) break
        const kept = capText(row, remaining)
        remaining -= kept.length
        transcriptTail.push(kept)
      }
    }

    return Diagnosis.make({
      runId: args.runId,
      digest,
      ...(failure === undefined ? {} : { failure }),
      gateLogTails,
      transcriptTail
    })
  })

const ledgerTolerance = 0.005

export const costsOfRun = (
  files: PlainFileStoreShape,
  tracePath: string,
  ledgerPath: string,
  runId: string
): Effect.Effect<CostsOut, TraceUnreadable> =>
  Effect.gen(function* () {
    const lines = yield* readLines(files, tracePath)
    const report = buildCostReport(usageSamplesFromTrace(lines))
    const total = (report.measured.costUsd ?? 0) + (report.estimated.costUsd ?? 0)
    const records = yield* loadCostLedger(files, ledgerPath).pipe(
      Effect.mapError(unreadable(ledgerPath))
    )
    const ledger = records.find((record) => record.runId === runId)?.totalCostUsd
    return CostsOut.make({
      report,
      total,
      ...(ledger === undefined ? {} : { ledger }),
      differs: ledger !== undefined && Math.abs(total - ledger) > ledgerTolerance
    })
  })
