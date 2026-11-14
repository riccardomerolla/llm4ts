// @internal: the browser's view of a run for `llm4ts watch --web`; the shell's own
import type { TraceLine } from "@llm4ts/flow/FlowRecorder"
import {
  chipsOf,
  heldBy,
  initialView,
  leaseCounts,
  reduceTree,
  selectedLane,
  treeInputsOfTrace,
  type ChipStatus,
  type TreeInput,
  type TreeLogEntry,
  type TreeState,
  type TreeVerdict
} from "@llm4ts/runner/AgentTree"
import { presentationOf } from "@llm4ts/runner/EventPresentation"

/**
 * `llm4ts watch --web` (ADR 0051): what the browser draws, folded from the
 * same `TreeInput`s and `reduceTree` as the terminal tree. Pure: the server
 * folds, this module projects a `TreeState` into a frame of plain JSON, and
 * the page only lays it out.
 */

/** One trace line the tree reads, with the `seq` the trace gave it. */
export interface WebStep {
  readonly seq: number
  readonly at: number
  readonly input: TreeInput
}

/** A trace's lines as steps; lines the tree skips (raw output, unknown kinds) are not steps. */
export const stepsOfTrace = (lines: ReadonlyArray<TraceLine>): ReadonlyArray<WebStep> =>
  lines.flatMap((line) =>
    treeInputsOfTrace([line]).map((input) => ({ seq: line.seq, at: input.at, input }))
  )

/** How a timeline item is coloured: the tree's styles, and the node states. */
export type WebTone =
  | "orchestrator"
  | "judgment"
  | "judge"
  | "running"
  | "log"
  | "tool"
  | "done"
  | "failed"
  | "issue"

export interface WebTimelineItem {
  readonly seq: number
  readonly at: number
  readonly who: string
  readonly what: string
  readonly tone: WebTone
}

/** What the tree does not keep about a lane, read from the same events. */
interface LaneNotes {
  readonly stage: string | undefined
  readonly failStage: string | undefined
  readonly failMessage: string | undefined
  readonly endedAt: number | undefined
  readonly merged: boolean
  readonly model: string | undefined
  readonly prompt: number
  readonly completion: number
  readonly note: string | undefined
}

const noNotes: LaneNotes = {
  stage: undefined,
  failStage: undefined,
  failMessage: undefined,
  endedAt: undefined,
  merged: false,
  model: undefined,
  prompt: 0,
  completion: 0,
  note: undefined
}

/** A replay in progress: the tree after `count` steps, and what the page adds to it. */
export interface WebFold {
  readonly count: number
  readonly seq: number | undefined
  readonly state: TreeState
  readonly timeline: ReadonlyArray<WebTimelineItem>
  readonly verdicts: ReadonlyArray<TreeVerdict & { readonly seq: number }>
  readonly notes: Readonly<Record<string, LaneNotes>>
}

export const startFold = (start: TreeState): WebFold => ({
  count: 0,
  seq: undefined,
  state: start,
  timeline: [],
  verdicts: [],
  notes: {}
})

const toneOfLog = (entry: TreeLogEntry): WebTone => {
  if (/^failed\b| out · /u.test(entry.what)) {
    return "failed"
  }
  switch (entry.source) {
    case "run":
      return "orchestrator"
    case "judge":
      return / cleared /u.test(entry.what) ? "judgment" : "issue"
    case "roster":
      return / leaves /u.test(entry.what) ? "issue" : "running"
    case "lane":
      return /^(done|merged\b)/u.test(entry.what) ? "done" : "issue"
  }
}

/** A step's items: the session log's new lines, else the event's digest or activity. */
const itemsOf = (
  step: WebStep,
  before: TreeState,
  after: TreeState
): ReadonlyArray<WebTimelineItem> => {
  const logged = after.log.slice(before.log.length)
  if (logged.length > 0) {
    return logged.map((entry) => ({
      seq: step.seq,
      at: entry.at,
      who: entry.who,
      what: entry.what,
      tone: toneOfLog(entry)
    }))
  }
  if (step.input._tag !== "Event") {
    return []
  }
  const event = step.input.event
  const item = (who: string, what: string, tone: WebTone): ReadonlyArray<WebTimelineItem> => [
    { seq: step.seq, at: step.at, who, what, tone }
  ]
  const digest = presentationOf(event).digest?.(event)
  if (digest !== undefined) {
    return item(digest.lane ?? "flow", digest.text, event._tag === "StageFailed" ? "failed" : "log")
  }
  switch (event._tag) {
    case "ToolUse":
      return event.lane === undefined ? [] : item(event.lane, `${event.tool} ${event.args}`, "tool")
    case "ExecutorLeased":
      return item(
        "roster",
        `${event.executor} → ${event.role}${event.label === undefined ? "" : ` · ${event.label}`}`,
        event.role === "judge" ? "judge" : "running"
      )
    case "StageStarted":
      return event.lane !== undefined &&
        event.stage !== `story ${event.lane}` &&
        !event.stage.endsWith(": setup")
        ? item(event.lane, event.stage, "running")
        : []
    default:
      return []
  }
}

const noteLane = (
  notes: Readonly<Record<string, LaneNotes>>,
  lane: string,
  change: (open: LaneNotes) => Partial<LaneNotes>
): Readonly<Record<string, LaneNotes>> => {
  const open = notes[lane] ?? noNotes
  return { ...notes, [lane]: { ...open, ...change(open) } }
}

const notesOf = (fold: WebFold, step: WebStep): Readonly<Record<string, LaneNotes>> => {
  if (step.input._tag !== "Event") {
    return fold.notes
  }
  const event = step.input.event
  switch (event._tag) {
    case "StageStarted":
      return event.lane === undefined || event.stage === `story ${event.lane}`
        ? fold.notes
        : noteLane(fold.notes, event.lane, () => ({ stage: event.stage }))
    case "StageCompleted":
      return event.lane !== undefined && event.stage === `story ${event.lane}`
        ? noteLane(fold.notes, event.lane, () => ({ endedAt: step.at }))
        : fold.notes
    case "StageFailed":
      if (event.lane === undefined) {
        return fold.notes
      }
      return event.stage === `story ${event.lane}`
        ? noteLane(fold.notes, event.lane, (open) => ({
            endedAt: step.at,
            failMessage: open.failMessage ?? event.message
          }))
        : noteLane(fold.notes, event.lane, () => ({
            failStage: event.stage,
            failMessage: event.message
          }))
    case "TokensUsed":
      return event.lane === undefined || event.agent !== "coder"
        ? fold.notes
        : noteLane(fold.notes, event.lane, (open) => ({
            model: event.model ?? open.model,
            prompt: open.prompt + event.usage.prompt,
            completion: open.completion + event.usage.completion
          }))
    case "Info":
      if (event.lane === undefined) {
        return fold.notes
      }
      return / merged into /u.test(event.message)
        ? noteLane(fold.notes, event.lane, () => ({ merged: true }))
        : noteLane(fold.notes, event.lane, () => ({
            note: event.message.replace(`story ${event.lane}: `, "")
          }))
    default:
      return fold.notes
  }
}

/** One more step: the tree's own fold, and the page's notes beside it. */
export const advance = (fold: WebFold, step: WebStep): WebFold => {
  const state = reduceTree(fold.state, step.input)
  const verdict = state.verdict
  return {
    count: fold.count + 1,
    seq: step.seq,
    state,
    timeline: [...fold.timeline, ...itemsOf(step, fold.state, state)],
    verdicts:
      verdict !== undefined && verdict !== fold.state.verdict
        ? [...fold.verdicts, { ...verdict, seq: step.seq }]
        : fold.verdicts,
    notes: notesOf(fold, step)
  }
}

export const foldSteps = (start: TreeState, steps: ReadonlyArray<WebStep>): WebFold =>
  steps.reduce(advance, startFold(start))

// ── the frame ───────────────────────────────────────────────────────────────

export interface WebStory {
  readonly id: string
  readonly status: ChipStatus
  readonly executor: string | undefined
  readonly stage: string | undefined
  readonly startedAt: number | undefined
  readonly endedAt: number | undefined
  readonly tokens: number
  readonly prompt: number
  readonly completion: number
  readonly model: string | undefined
  readonly merged: boolean
  readonly failStage: string | undefined
  readonly failMessage: string | undefined
  readonly tools: ReadonlyArray<string>
  readonly activity: { readonly text: string; readonly since: number } | undefined
  readonly note: string | undefined
  readonly tasks: number
}

export interface WebExecutor {
  readonly name: string
  readonly state: "busy" | "idle" | "out"
  readonly text: string
}

export interface WebFrame {
  /** Steps folded, of `steps`; a live frame has folded them all. */
  readonly count: number
  readonly steps: number
  readonly seq: number | undefined
  readonly lastSeq: number | undefined
  readonly startedAt: number | undefined
  readonly now: number | undefined
  readonly ended: string | undefined
  readonly title: string
  readonly action: string | undefined
  readonly stage: string
  readonly agents: string
  readonly counts: Readonly<Record<ChipStatus, number>> & { readonly total: number }
  readonly tokens: number
  readonly costUsd: number
  readonly stories: ReadonlyArray<WebStory>
  /** The story the detail card follows until the reader picks one. */
  readonly focus: string | undefined
  readonly judge: {
    readonly executor: string | undefined
    readonly state: "idle" | "waiting" | "running"
    readonly reviews: number
    readonly verdicts: number
    readonly borrowed: number
  }
  readonly verdicts: ReadonlyArray<TreeVerdict & { readonly seq: number }>
  readonly merged: number
  readonly roster: ReadonlyArray<WebExecutor>
  /** The latest items; `timelineCount` says how many there are in all. */
  readonly timeline: ReadonlyArray<WebTimelineItem>
  readonly timelineCount: number
  /** The replay's wait before this frame, so the playhead moves as long. */
  readonly gapMs: number
}

const executorOf = (state: TreeState, name: string): WebExecutor => {
  const out = state.exclusions.find((exclusion) => exclusion.executor === name)
  if (out !== undefined) {
    return { name, state: "out", text: `✗ out: ${out.reason}` }
  }
  const held = heldBy(state, name)
  return held.length > 0
    ? { name, state: "busy", text: `◐ busy · ${held.join(", ")}` }
    : { name, state: "idle", text: "○ idle · no lease" }
}

/** At most this many of the latest timeline items travel with each frame. */
export const frameTimeline = 40

export const frameOf = (
  fold: WebFold,
  options: { readonly steps: number; readonly lastSeq: number | undefined; readonly gapMs?: number }
): WebFrame => {
  const state = fold.state
  const chips = chipsOf(state)
  const count = (status: ChipStatus): number =>
    chips.filter((chip) => chip.status === status).length
  const running = state.lanes.filter((lane) => lane.status === "running")
  const counts = leaseCounts(state)
  const stories = chips.map((chip): WebStory => {
    const lane = state.lanes.find((candidate) => candidate.id === chip.id)
    const notes = fold.notes[chip.id] ?? noNotes
    return {
      id: chip.id,
      status: chip.status,
      executor: lane?.executor,
      stage: lane?.stages.at(-1) ?? notes.stage,
      startedAt: lane?.startedAt,
      endedAt: lane?.status === "running" ? undefined : notes.endedAt,
      tokens: lane?.tokens ?? 0,
      prompt: notes.prompt,
      completion: notes.completion,
      model: notes.model,
      merged: notes.merged,
      failStage: notes.failStage,
      failMessage: chip.status === "failed" ? notes.failMessage : undefined,
      tools: lane?.tools.slice(-2) ?? [],
      activity:
        lane?.activity === undefined
          ? undefined
          : { text: lane.activity.text, since: lane.activity.since },
      note: notes.note,
      tasks: lane?.tasks.length ?? 0
    }
  })
  const judging = state.leases.some((lease) => lease.role === "judge")
  return {
    count: fold.count,
    steps: options.steps,
    seq: fold.seq,
    lastSeq: options.lastSeq,
    startedAt: state.startedAt,
    now: state.now,
    ended: state.ended,
    title: state.title,
    action: state.action,
    stage: state.stages.at(-1) ?? (running.length > 0 ? "implement stories" : "idle"),
    agents: `agents · ${running.length} running${counts.length === 0 ? "" : ` · ${counts}`}`,
    counts: {
      planned: count("planned"),
      running: count("running"),
      waiting: count("waiting"),
      done: count("done"),
      failed: count("failed"),
      total: chips.length
    },
    tokens: state.tokens,
    costUsd: state.costUsd,
    stories,
    focus: selectedLane(state, initialView)?.id ?? stories[0]?.id,
    judge: {
      executor: state.judge.executor,
      state: judging ? "running" : state.judge.executor === undefined ? "idle" : "waiting",
      reviews: state.judge.reviews,
      verdicts: state.judge.verdicts,
      borrowed: state.judge.borrowed
    },
    verdicts: fold.verdicts,
    merged: stories.filter((story) => story.merged).length,
    roster: state.executors.map((name) => executorOf(state, name)),
    timeline: fold.timeline.slice(-frameTimeline),
    timelineCount: fold.timeline.length,
    gapMs: options.gapMs ?? 0
  }
}
