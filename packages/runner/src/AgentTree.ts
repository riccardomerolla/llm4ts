import type { TokenUsage } from "@llm4ts/core/Models"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { toolCategory } from "@llm4ts/flow/Activity"
import { FlowEvent, cloneName } from "@llm4ts/flow/FlowEvents"
import type { TraceLine } from "@llm4ts/flow/FlowRecorder"
import { estimateCostUsd } from "@llm4ts/flow/PriceList"
import { formatCount } from "./Terminal.ts"

/**
 * The agent tree (ADR 0022): a full-screen view of a running or finished
 * flow — the orchestrator, the judgment layer, the story lanes on the
 * executor roster, the judge seat and a session log.
 *
 * Pure: `reduceTree` folds what a run published into a `TreeState`, and
 * `renderTree` draws that state at a width. Where the inputs come from (the
 * event hub of a live run, or a trace file) is the host's business, so a live
 * view, a finished run and a replay are the same fold.
 */

export type TreeInput =
  | { readonly _tag: "Event"; readonly at: number; readonly event: FlowEvent }
  | { readonly _tag: "RunEnded"; readonly at: number; readonly outcome: string }
  /** The clock moved: a live view's timers run between events. */
  | { readonly _tag: "Tick"; readonly at: number }

export type LaneStatus = "running" | "done" | "failed"

export interface TreeLane {
  readonly id: string
  /** The lane's open stages below `story <id>`, innermost last. */
  readonly stages: ReadonlyArray<string>
  readonly executor: string | undefined
  readonly startedAt: number
  readonly status: LaneStatus
  readonly lastTool: string | undefined
  /** The lane's most recent tool calls, oldest first, for the expanded view. */
  readonly tools: ReadonlyArray<string>
  readonly tokens: number
  readonly costUsd: number
  /** When the lane last published anything: a lane quiet for too long is idle. */
  readonly lastEventAt: number
  /** What the lane is doing now and since when: a tool, or thinking after one. */
  readonly activity:
    | { readonly text: string; readonly since: number; readonly tool: boolean }
    | undefined
  /** Its coder turns' durations, and its gates' total (`Timed`). */
  readonly turns: ReadonlyArray<number>
  readonly gatesMs: number
  /** Work it said `Began` and no `Timed` has ended yet, innermost last. */
  readonly running: ReadonlyArray<TreeWork>
  /** The coder's clone number, when its lease carried one (ADR 0033). */
  readonly clone: number | undefined
  /** The plan's tasks in order, as `TasksPlanned` and the task events reported them. */
  readonly tasks: ReadonlyArray<TreeTask>
  /** The running task: its index from 1 and the plan's count. */
  readonly task:
    | {
        readonly index: number
        readonly count: number
        readonly title: string
        readonly satisfies?: ReadonlyArray<number>
      }
    | undefined
  /** Sub-agents the harness spawned on this lane (a delegate tool call), oldest first. */
  readonly children: ReadonlyArray<TreeChild>
  /** A harness pause under way: `pi retry`, `pi compaction`. */
  readonly pause: { readonly label: string; readonly since: number } | undefined
}

/** One task of a lane's plan, as the checklist shows it. */
export interface TreeTask {
  readonly index: number
  readonly title: string
  readonly done: boolean
  readonly satisfies?: ReadonlyArray<number>
}

/** A sub-agent a harness spawned inside a lane, observed through its tool calls (ADR 0033). */
export interface TreeChild {
  readonly id: string
  readonly tool: string
  readonly args: string
  readonly since: number
  readonly lastTool: string | undefined
  readonly ended: boolean
}

/** Work under way: a model call, a gate or setup command, git, a merge, a wait. */
export interface TreeWork {
  readonly kind: string
  readonly label: string
  readonly since: number
}

/** The run's timed work by kind, for the status line's split. */
export interface TreeTimeSplit {
  readonly model: number
  readonly tools: number
  readonly gates: number
  readonly merge: number
  readonly wait: number
}

export type LogSource = "lane" | "run" | "roster" | "judge"

export interface TreeLogEntry {
  readonly at: number
  readonly source: LogSource
  /** The lane, executor or `flow` the entry is about. */
  readonly who: string
  readonly what: string
}

/** A story as the epic's board lists it, before or without a lane of its own. */
export interface TreeStory {
  readonly id: string
  readonly status: "planned" | "active" | "waiting" | "done" | "failed" | "skipped"
}

/** A lease an executor holds now: its role and who it is for (a story id). */
export interface TreeLease {
  readonly executor: string
  readonly role: string
  readonly label: string | undefined
  /** Which clone took the slot, when the lease carried one (ADR 0033). */
  readonly clone: number | undefined
}

/** The judge seat: who sits in it, and how often it was asked. */
export interface TreeJudge {
  readonly executor: string | undefined
  readonly reviews: number
  readonly verdicts: number
  /** Reviews and verdicts that ran on the story's own executor: not independent (ADR 0033). */
  readonly borrowed: number
}

/** The latest story verdict (`StoryJudged`). */
export interface TreeVerdict {
  readonly lane: string
  readonly round: number
  readonly cleared: boolean
  readonly issues: number
  readonly dimensions: ReadonlyArray<{
    readonly id: string
    readonly score: number
    readonly max: number
  }>
}

/** The latest typed judgment per key (`JudgmentObserved`). */
export interface TreeJudgment {
  readonly key: string
  readonly certainty: number
  readonly decision: string
}

export interface TreeState {
  readonly title: string
  readonly action: string | undefined
  /** The board's stories, in plan order; lanes not on it are added after. */
  readonly stories: ReadonlyArray<TreeStory>
  readonly startedAt: number | undefined
  readonly now: number | undefined
  /** Run-wide open stages, innermost last. */
  readonly stages: ReadonlyArray<string>
  /** Lanes in the order they started. */
  readonly lanes: ReadonlyArray<TreeLane>
  /** Executors in the order the run first named them. */
  readonly executors: ReadonlyArray<string>
  readonly leases: ReadonlyArray<TreeLease>
  /** Executors out of the round, with the roster's reason. */
  readonly exclusions: ReadonlyArray<{ readonly executor: string; readonly reason: string }>
  readonly judge: TreeJudge
  readonly verdict: TreeVerdict | undefined
  readonly judgments: ReadonlyArray<TreeJudgment>
  readonly log: ReadonlyArray<TreeLogEntry>
  readonly tokens: number
  /** Estimated: the backend's own figure when it reports one, else the price list. */
  readonly costUsd: number
  /** The run's outcome once its trace says it ended; a live run has none. */
  readonly ended: string | undefined
  readonly time: TreeTimeSplit
  /** Work under way outside any lane (the epic's own gates, its merges), innermost last. */
  readonly running: ReadonlyArray<TreeWork>
  /** A lane with no event for this long, and no tool running, is marked idle. */
  readonly idleAfterMs: number
  /** The lane that published last, which the detail box follows by default (ADR 0033). */
  readonly lastChanged: string | undefined
}

export interface TreeOptions {
  readonly title?: string
  /** What the run set out to do ("run plan", "round 2"), when the caller knows. */
  readonly action?: string
  readonly stories?: ReadonlyArray<TreeStory>
  /** Default two minutes (`LLM4TS_IDLE_AFTER`). */
  readonly idleAfterMs?: number
}

export const defaultIdleAfterMs = 120_000

/** `LLM4TS_IDLE_AFTER`: `90s`, `5m`, `1h` (a bare number is seconds); two minutes otherwise. */
export const idleAfterFrom = (
  environment: Readonly<Record<string, string | undefined>>
): number => {
  const match = /^(\d+)\s*(s|m|h)?$/u.exec(environment.LLM4TS_IDLE_AFTER?.trim() ?? "")
  if (match === null) {
    return defaultIdleAfterMs
  }
  const unit = match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : 1_000
  return Number(match[1]) * unit
}

export const emptyTree = (options: TreeOptions = {}): TreeState => ({
  title: options.title ?? "flow",
  action: options.action,
  stories: options.stories ?? [],
  startedAt: undefined,
  now: undefined,
  stages: [],
  lanes: [],
  executors: [],
  leases: [],
  exclusions: [],
  judge: { executor: undefined, reviews: 0, verdicts: 0, borrowed: 0 },
  verdict: undefined,
  judgments: [],
  log: [],
  tokens: 0,
  costUsd: 0,
  ended: undefined,
  time: { model: 0, tools: 0, gates: 0, merge: 0, wait: 0 },
  running: [],
  idleAfterMs: options.idleAfterMs ?? defaultIdleAfterMs,
  lastChanged: undefined
})

const costOf = (model: string | undefined, usage: TokenUsage): number =>
  usage.costUsd ?? (model === undefined ? undefined : estimateCostUsd(model, usage)) ?? 0

const logged = (state: TreeState, entry: TreeLogEntry): TreeState => ({
  ...state,
  log: [...state.log, entry]
})

const storyStage = /^story (\S+)$/u
const expandedTools = 20

const updateLane = (
  state: TreeState,
  id: string,
  update: (lane: TreeLane) => TreeLane
): TreeState => ({
  ...state,
  lanes: state.lanes.map((lane) => (lane.id === id ? update(lane) : lane))
})

/** A wait label that is a harness pausing itself, not the roster or a gate. */
const isPause = (label: string): boolean => /^pi (retry|compaction)$/u.test(label)

const newestOpenChild = (children: ReadonlyArray<TreeChild>): number => {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    if (children[index]?.ended === false) {
      return index
    }
  }
  return -1
}

const endNewestChild = (children: ReadonlyArray<TreeChild>): ReadonlyArray<TreeChild> => {
  const index = newestOpenChild(children)
  return index < 0
    ? children
    : children.map((child, position) => (position === index ? { ...child, ended: true } : child))
}

const withoutLast = <A>(items: ReadonlyArray<A>, item: A): ReadonlyArray<A> => {
  const index = items.lastIndexOf(item)
  return index < 0 ? items : [...items.slice(0, index), ...items.slice(index + 1)]
}

/** The work a `Timed` ends: the innermost of its kind and label, if it said it began. */
const ended = (
  running: ReadonlyArray<TreeWork>,
  kind: string,
  label: string
): ReadonlyArray<TreeWork> => {
  let index = running.length - 1
  while (index >= 0 && (running[index]?.kind !== kind || running[index]?.label !== label)) {
    index -= 1
  }
  return index < 0 ? running : [...running.slice(0, index), ...running.slice(index + 1)]
}

const withExecutor = (state: TreeState, executor: string): TreeState =>
  state.executors.includes(executor)
    ? state
    : { ...state, executors: [...state.executors, executor] }

const rosterLog = (state: TreeState, at: number, what: string): TreeState =>
  logged(state, { at, source: "roster", who: "roster", what })

const reduceLease = (
  state: TreeState,
  at: number,
  lease: TreeLease,
  borrowed: boolean
): TreeState => {
  const held = { ...withExecutor(state, lease.executor), leases: [...state.leases, lease] }
  const who = cloneName(lease.executor, lease.clone)
  const forLabel = lease.label === undefined ? "" : ` · ${lease.label}`
  switch (lease.role) {
    case "coder": {
      const lane = held.lanes.find((candidate) => candidate.id === lease.label)
      const placed =
        lane === undefined
          ? held
          : updateLane(held, lane.id, (open) => ({
              ...open,
              executor: lease.executor,
              clone: lease.clone
            }))
      return rosterLog(placed, at, `${who} → coder${forLabel}`)
    }
    case "reviewer":
    case "judge": {
      const seat = {
        ...held,
        judge: {
          ...held.judge,
          executor:
            lease.role === "judge" ? lease.executor : (held.judge.executor ?? lease.executor),
          reviews: held.judge.reviews + (lease.role === "reviewer" ? 1 : 0),
          verdicts: held.judge.verdicts + (lease.role === "judge" ? 1 : 0),
          borrowed: held.judge.borrowed + (borrowed ? 1 : 0)
        }
      }
      return borrowed
        ? rosterLog(seat, at, `${lease.role} borrowed from own executor ${who}${forLabel}`)
        : seat
    }
    default:
      return held
  }
}

const issueCount = (issues: number): string => `${issues} issue${issues === 1 ? "" : "s"}`

const verdictWords = (verdict: TreeVerdict): string =>
  verdict.cleared ? "cleared" : issueCount(verdict.issues)

const reduceEvent = (state: TreeState, at: number, event: FlowEvent): TreeState => {
  const lane =
    "lane" in event && event.lane !== undefined
      ? state.lanes.find((candidate) => candidate.id === event.lane)
      : undefined
  const executor = "executor" in event ? event.executor : undefined
  const named =
    executor === undefined || state.executors.includes(executor)
      ? state
      : { ...state, executors: [...state.executors, executor] }
  const current =
    lane === undefined
      ? named
      : {
          ...updateLane(named, lane.id, (open) => ({
            ...open,
            lastEventAt: at,
            ...(executor !== undefined && open.executor !== executor ? { executor } : {})
          })),
          lastChanged: lane.id
        }
  switch (event._tag) {
    case "StageStarted": {
      const story = storyStage.exec(event.stage)?.[1]
      if (story !== undefined && event.lane === story) {
        const fresh: TreeLane = {
          id: story,
          stages: [],
          executor: event.executor,
          startedAt: at,
          status: "running",
          lastTool: undefined,
          tools: [],
          tokens: 0,
          costUsd: 0,
          lastEventAt: at,
          activity: undefined,
          turns: [],
          gatesMs: 0,
          running: [],
          clone: undefined,
          tasks: [],
          task: undefined,
          children: [],
          pause: undefined
        }
        return {
          ...current,
          lanes: [...current.lanes.filter((open) => open.id !== story), fresh],
          lastChanged: story
        }
      }
      if (lane !== undefined) {
        return updateLane(current, lane.id, (open) => ({
          ...open,
          stages: [...open.stages, event.stage]
        }))
      }
      return { ...current, stages: [...current.stages, event.stage] }
    }
    case "StageCompleted":
    case "StageFailed": {
      if (lane !== undefined && event.stage === `story ${lane.id}`) {
        const status: LaneStatus = event._tag === "StageFailed" ? "failed" : "done"
        const closed = updateLane(current, lane.id, (open) => ({
          ...open,
          stages: [],
          running: [],
          status
        }))
        return logged(closed, {
          at,
          source: "lane",
          who: lane.id,
          what: event._tag === "StageFailed" ? `failed · ${event.message}` : "done"
        })
      }
      if (lane !== undefined) {
        return updateLane(current, lane.id, (open) => ({
          ...open,
          stages: withoutLast(open.stages, event.stage)
        }))
      }
      return { ...current, stages: withoutLast(current.stages, event.stage) }
    }
    case "Info": {
      // A story's own milestones are `story <id>: …` (resuming, merged,
      // skipped); its other chatter stays in the expanded lane.
      if (event.lane === undefined) {
        // Traces from before the roster's typed events (2.20) carry its notes
        // as prose: leases are chatter, the rest (exclusions, handovers) stays.
        const legacyRoster = /^roster: (.*)$/u.exec(event.message)?.[1]
        if (legacyRoster !== undefined) {
          return / takes \S+/u.test(legacyRoster)
            ? current
            : logged(current, { at, source: "roster", who: "roster", what: legacyRoster })
        }
        return logged(current, { at, source: "run", who: "flow", what: event.message })
      }
      const prefix = `story ${event.lane}: `
      return event.message.startsWith(prefix)
        ? logged(current, {
            at,
            source: "lane",
            who: event.lane,
            what: event.message.slice(prefix.length)
          })
        : current
    }
    case "Timed": {
      const time = current.time
      const split: TreeTimeSplit = {
        model:
          time.model +
          (event.kind === "model" ? event.ms : 0) -
          (event.kind === "tool" ? event.ms : 0),
        tools: time.tools + (event.kind === "tool" ? event.ms : 0),
        gates: time.gates + (event.kind === "gate" ? event.ms : 0),
        merge: time.merge + (event.kind === "merge" || event.kind === "git" ? event.ms : 0),
        wait: time.wait + (event.kind === "wait" ? event.ms : 0)
      }
      const counted = { ...current, time: split }
      return lane === undefined
        ? { ...counted, running: ended(counted.running, event.kind, event.label) }
        : updateLane(counted, lane.id, (open) => ({
            ...open,
            running: ended(open.running, event.kind, event.label),
            ...(event.kind === "tool"
              ? { activity: { text: "thinking", since: at, tool: false } }
              : event.kind === "model" && event.label === "coder"
                ? { activity: undefined, turns: [...open.turns, event.ms] }
                : {}),
            gatesMs: open.gatesMs + (event.kind === "gate" ? event.ms : 0),
            // The delegate call ended: its sub-agent is done.
            ...(event.kind === "tool" && event.category === "delegate"
              ? { children: endNewestChild(open.children) }
              : {}),
            ...(event.kind === "wait" && open.pause?.label === event.label
              ? { pause: undefined }
              : {})
          }))
    }
    case "Began": {
      const work: TreeWork = { kind: event.kind, label: event.label, since: at }
      return lane === undefined
        ? event.lane === undefined
          ? { ...current, running: [...current.running, work] }
          : current
        : updateLane(current, lane.id, (open) => ({
            ...open,
            running: [...open.running, work],
            // A harness pause (`pi retry`, `pi compaction`) is the lane's state while it lasts.
            ...(event.kind === "wait" && isPause(event.label)
              ? { pause: { label: event.label, since: at } }
              : {})
          }))
    }
    case "StoryJudged": {
      const verdict: TreeVerdict = {
        lane: event.lane,
        round: event.round,
        cleared: event.cleared,
        issues: event.issues,
        dimensions: event.dimensions
      }
      return logged(
        { ...current, verdict },
        {
          at,
          source: "judge",
          who: "judge",
          what: `${verdict.lane} r${verdict.round} · ${verdictWords(verdict)} → ${verdict.cleared ? "merge" : "coder"}`
        }
      )
    }
    case "JudgmentObserved":
      return {
        ...current,
        judgments: [
          ...current.judgments.filter((judgment) => judgment.key !== event.key),
          { key: event.key, certainty: event.certainty, decision: event.decision }
        ]
      }
    case "ExecutorLeased":
      return reduceLease(
        current,
        at,
        { executor: event.executor, role: event.role, label: event.label, clone: event.clone },
        event.borrowed === true
      )
    case "ExecutorReleased": {
      const index = current.leases.findIndex(
        (lease) =>
          lease.executor === event.executor &&
          lease.role === event.role &&
          lease.label === event.label
      )
      return index < 0
        ? current
        : {
            ...current,
            leases: [...current.leases.slice(0, index), ...current.leases.slice(index + 1)]
          }
    }
    case "ExecutorExcluded":
      return rosterLog(
        {
          ...withExecutor(current, event.executor),
          exclusions: [
            ...current.exclusions.filter((out) => out.executor !== event.executor),
            { executor: event.executor, reason: event.reason }
          ]
        },
        at,
        `${event.executor} out · ${event.reason}`
      )
    case "ExecutorResumed":
      return rosterLog(
        {
          ...current,
          exclusions: current.exclusions.filter((out) => out.executor !== event.executor)
        },
        at,
        `${event.executor} back · ${event.why}`
      )
    case "ExecutorHandedOver":
      return rosterLog(
        current,
        at,
        `${event.label ?? "the run"}: ${event.role} leaves ${event.from} · ${event.reason}`
      )
    case "ToolUse": {
      if (lane === undefined) {
        return current
      }
      const text = `${event.tool} ${event.args}`
      return updateLane(current, lane.id, (open) => {
        // A call inside a sub-agent lands on the newest open child; without
        // one (an older harness, a lost parent) it is the lane's as before.
        const child = event.parent === undefined ? -1 : newestOpenChild(open.children)
        if (child >= 0) {
          return {
            ...open,
            children: open.children.map((candidate, index) =>
              index === child ? { ...candidate, lastTool: text } : candidate
            )
          }
        }
        const delegated =
          toolCategory(event.tool, event.args) === "delegate"
            ? [
                ...open.children,
                {
                  id: `${open.id}:${open.children.length + 1}`,
                  tool: event.tool,
                  args: event.args,
                  since: at,
                  lastTool: undefined,
                  ended: false
                }
              ]
            : open.children
        return {
          ...open,
          activity: { text, since: at, tool: true },
          lastTool: text,
          tools: [...open.tools, text].slice(-expandedTools),
          children: delegated
        }
      })
    }
    case "TasksPlanned":
      return lane === undefined
        ? current
        : updateLane(current, lane.id, (open) => ({
            ...open,
            tasks: event.tasks.map((task, position) => ({
              index: position + 1,
              title: task.title,
              done: task.completed,
              ...(task.satisfies === undefined ? {} : { satisfies: task.satisfies })
            }))
          }))
    case "TaskStarted": {
      if (lane === undefined) {
        return current
      }
      const satisfies = event.satisfies === undefined ? {} : { satisfies: event.satisfies }
      return updateLane(current, lane.id, (open) => ({
        ...open,
        task: { index: event.index, count: event.count, title: event.title, ...satisfies },
        tasks: open.tasks.some((task) => task.index === event.index)
          ? open.tasks
          : [
              ...open.tasks,
              { index: event.index, title: event.title, done: false, ...satisfies }
            ].sort((left, right) => left.index - right.index)
      }))
    }
    case "TaskCompleted":
      return lane === undefined
        ? current
        : updateLane(current, lane.id, (open) => ({
            ...open,
            task: undefined,
            tasks: open.tasks.map((task) =>
              task.index === event.index ? { ...task, done: true } : task
            )
          }))
    case "StoryStatusChanged":
      return {
        ...current,
        stories: current.stories.some((story) => story.id === event.id)
          ? current.stories.map((story) =>
              story.id === event.id ? { ...story, status: event.status } : story
            )
          : [...current.stories, { id: event.id, status: event.status }]
      }
    case "TokensUsed": {
      const tokens = event.usage.total
      const costUsd = costOf(event.model, event.usage)
      const counted: TreeState = {
        ...current,
        tokens: current.tokens + tokens,
        costUsd: current.costUsd + costUsd
      }
      return lane === undefined
        ? counted
        : updateLane(counted, lane.id, (open) => ({
            ...open,
            tokens: open.tokens + tokens,
            costUsd: open.costUsd + costUsd
          }))
    }
    default:
      return current
  }
}

export const reduceTree = (state: TreeState, input: TreeInput): TreeState => {
  const timed: TreeState = {
    ...state,
    startedAt: state.startedAt ?? input.at,
    now: Math.max(state.now ?? input.at, input.at)
  }
  switch (input._tag) {
    case "Event":
      return reduceEvent(timed, input.at, input.event)
    case "RunEnded":
      return { ...timed, ended: input.outcome }
    case "Tick":
      return timed
  }
}

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(FlowEvent))

/**
 * A trace's lines as tree inputs. Kinds this version does not know — raw
 * stream lines, events from a newer llm4ts — are skipped, so any trace renders.
 */
export const treeInputsOfTrace = (lines: ReadonlyArray<TraceLine>): ReadonlyArray<TreeInput> =>
  lines.flatMap((line): ReadonlyArray<TreeInput> => {
    if (line.kind === "RunEnded") {
      const outcome = line.fields.outcome
      return [
        {
          _tag: "RunEnded",
          at: line.timestamp,
          outcome: typeof outcome === "string" ? outcome : "completed"
        }
      ]
    }
    const raw = line.fields.event
    if (typeof raw !== "string") {
      return []
    }
    return Option.match(decodeEvent(raw), {
      onNone: () => [],
      onSome: (event) => [{ _tag: "Event", at: line.timestamp, event }]
    })
  })

// ── drawing ─────────────────────────────────────────────────────────────────

type Style = "bold" | "dim" | "orchestrator" | "judgment" | "judge" | "log" | "running"

interface Span {
  readonly text: string
  readonly style?: Style
}

/** A frame line before colour: spans, so cutting to width never splits an escape. */
type Line = ReadonlyArray<Span>

const span = (text: string, style?: Style): Span =>
  style === undefined ? { text } : { text, style }

const lengthOf = (line: Line): number =>
  line.reduce((total, part) => total + [...part.text].length, 0)

/** Pads or cuts a line to exactly `width` characters; a cut ends in `…`. */
const fit = (line: Line, width: number): Line => {
  const length = lengthOf(line)
  if (length <= width) {
    return length === width ? line : [...line, span(" ".repeat(width - length))]
  }
  const kept: Array<Span> = []
  let room = width - 1
  for (const part of line) {
    if (room <= 0) {
      break
    }
    const characters = [...part.text]
    const taken = characters.slice(0, room).join("")
    kept.push(part.style === undefined ? span(taken) : span(taken, part.style))
    room -= Math.min(room, characters.length)
  }
  return [...kept, span("…")]
}

const centre = (line: Line, width: number): Line => {
  const pad = Math.max(0, Math.floor((width - lengthOf(line)) / 2))
  return fit([span(" ".repeat(pad)), ...line], width)
}

const box = (
  width: number,
  style: Style,
  body: ReadonlyArray<Line>,
  title?: string
): Array<Line> => {
  const inner = width - 4
  const top: Line =
    title === undefined
      ? [span(`┌${"─".repeat(width - 2)}┐`, style)]
      : fit(
          [
            span("┌─ ", style),
            span(title, "bold"),
            span(` ${"─".repeat(Math.max(0, width - 5 - [...title].length))}┐`, style)
          ],
          width
        )
  return [
    top,
    ...body.map((line): Line => [span("│ ", style), ...fit(line, inner), span(" │", style)]),
    [span(`└${"─".repeat(width - 2)}┘`, style)]
  ]
}

const beside = (
  columns: ReadonlyArray<ReadonlyArray<Line>>,
  widths: ReadonlyArray<number>,
  gap = 2
): Array<Line> => {
  const height = Math.max(0, ...columns.map((column) => column.length))
  return Array.from({ length: height }, (_, row) =>
    columns.flatMap((column, index) => [
      ...(index === 0 ? [] : [span(" ".repeat(gap))]),
      ...fit(column[row] ?? [], widths[index] ?? 0)
    ])
  )
}

const clock = (from: number | undefined, to: number): string => {
  const seconds = Math.max(0, Math.round((to - (from ?? to)) / 1_000))
  return [Math.floor(seconds / 3_600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")
}

const logStyle: Readonly<Record<LogSource, Style>> = {
  lane: "judgment",
  run: "orchestrator",
  roster: "running",
  judge: "judge"
}

const logLines = 5
const fullLogLines = 30

const logOf = (state: TreeState, count: number): Array<Line> => {
  const recent = state.log.slice(-count)
  return recent.length === 0
    ? [[span("—", "dim")]]
    : recent.map((entry) => [
        span(clock(state.startedAt, entry.at), "dim"),
        span("  "),
        ...fit([span(entry.who, logStyle[entry.source])], 16),
        span(" "),
        span(entry.what)
      ])
}

const dollars = (usd: number): string => `~$${usd.toFixed(2)}`

const elapsed = (from: number | undefined, to: number | undefined): string => {
  const seconds = Math.max(0, Math.floor(((to ?? 0) - (from ?? to ?? 0)) / 1_000))
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

const colours: Readonly<Record<Style, string>> = {
  bold: "\u001b[1m",
  dim: "\u001b[90m",
  orchestrator: "\u001b[38;5;173m",
  judgment: "\u001b[38;5;114m",
  judge: "\u001b[38;5;141m",
  log: "\u001b[38;5;244m",
  running: "\u001b[38;5;110m"
}

const paint = (line: Line, colour: boolean): string =>
  line
    .map((part) =>
      colour && part.style !== undefined ? `${colours[part.style]}${part.text}\u001b[0m` : part.text
    )
    .join("")

export type TreeMode = "lanes" | "executors"

/** What the reader chose to look at; the run's state is separate. */
export interface TreeView {
  readonly mode: TreeMode
  /** The selected lane's story id, or in the executors view the executor. */
  readonly selected: string | undefined
  readonly expanded: boolean
  readonly fullLog: boolean
  /** The transcript tail of the selection is open (`t`). */
  readonly tail: boolean
  /** Only this role's calls in the tail; all when undefined (`r` cycles). */
  readonly tailRole: string | undefined
  /** How many lines the tail is scrolled back from its end (page up/down). */
  readonly tailBack: number
}

export const initialView: TreeView = {
  mode: "lanes",
  selected: undefined,
  expanded: false,
  fullLog: false,
  tail: false,
  tailRole: undefined,
  tailBack: 0
}

const runningLanes = (state: TreeState): ReadonlyArray<TreeLane> =>
  state.lanes.filter((lane) => lane.status === "running")

const tailRoles: ReadonlyArray<string | undefined> = [undefined, "coder", "reviewer", "judge"]
const tailPage = 10

/** Whose transcript the tail shows: the selected story, or the selected executor. */
export const tailTargetOf = (
  view: TreeView
): { readonly lane: string } | { readonly executor: string } | undefined =>
  view.selected === undefined
    ? undefined
    : view.mode === "lanes"
      ? { lane: view.selected }
      : { executor: view.selected }

/**
 * The view after a key: arrows or 1–9 select a running lane (an executor in
 * the executors view), enter expands it, `t` tails its transcript, `r`
 * cycles the tail's role, escape closes, `e` switches lanes and executors,
 * `l` the full log, `q` quits. Keys it does not know return the same view.
 */
export const onTreeKey = (view: TreeView, key: string, state: TreeState): TreeView | "quit" => {
  const choices =
    view.mode === "lanes" ? runningLanes(state).map((lane) => lane.id) : state.executors
  const index = choices.findIndex((id) => id === view.selected)
  const select = (next: number): TreeView => {
    const id = choices[Math.max(0, Math.min(choices.length - 1, next))]
    return id === undefined ? view : { ...view, selected: id }
  }
  switch (key) {
    case "q":
      return "quit"
    case "down":
    case "right":
      return select(index + 1)
    case "up":
    case "left":
      return select(index < 0 ? 0 : index - 1)
    case "enter":
      return view.selected === undefined || view.mode !== "lanes"
        ? view
        : { ...view, expanded: !view.expanded }
    case "t":
      return view.selected === undefined
        ? view
        : { ...view, tail: !view.tail, expanded: false, tailBack: 0 }
    case "pageup":
      return view.tail ? { ...view, tailBack: view.tailBack + tailPage } : view
    case "pagedown":
      return view.tail ? { ...view, tailBack: Math.max(0, view.tailBack - tailPage) } : view
    case "r":
      return view.tail
        ? {
            ...view,
            tailRole: tailRoles[(tailRoles.indexOf(view.tailRole) + 1) % tailRoles.length]
          }
        : view
    case "escape":
      return { ...view, expanded: false, tail: false, tailBack: 0 }
    case "e":
      return {
        ...view,
        mode: view.mode === "lanes" ? "executors" : "lanes",
        selected: undefined,
        expanded: false,
        tail: false
      }
    case "l":
      return { ...view, fullLog: !view.fullLog }
    default:
      return /^[1-9]$/u.test(key) ? select(Number(key) - 1) : view
  }
}

export interface TreeRenderOptions {
  readonly width: number
  readonly colour: boolean
  readonly view: TreeView
  /** The terminal's rows; the frame fits them (see `renderTree`). */
  readonly height?: number
  /** The open tail's lines, read by the host; absent when the run has no transcript. */
  readonly tail?: ReadonlyArray<string>
}

const railWidth = 26
const maxLaneBoxes = 3

const counter = (label: string, value: number): Line => [
  span(`${label.padEnd(15)}${String(value).padStart(5)}`)
]

const railOf = (state: TreeState): Array<Line> =>
  box(railWidth, "judge", [
    centre([span("JUDGE SEAT", "bold")], railWidth - 4),
    centre([span(`${state.judge.executor ?? "—"} · on call`)], railWidth - 4),
    [],
    [span("last verdict:")],
    [
      span(
        state.verdict === undefined
          ? "» none yet"
          : `» ${state.verdict.lane} r${state.verdict.round}: ${verdictWords(state.verdict)}`,
        "judge"
      )
    ],
    [],
    counter("reviews", state.judge.reviews),
    counter("verdicts", state.judge.verdicts)
  ])

const laneBox = (
  lane: TreeLane,
  width: number,
  now: number | undefined,
  selected: boolean,
  idleAfterMs: number
): Array<Line> =>
  box(width, "running", [
    [span(selected ? `▸ ${lane.id}` : lane.id, "bold")],
    [span(lane.executor ?? "(leasing)")],
    [span(lane.stages.at(-1) ?? "starting")],
    doingLine(lane, now),
    [
      span(
        `${elapsed(lane.startedAt, now)} · ${formatCount(lane.tokens)} tok${lane.costUsd > 0 ? ` · ${dollars(lane.costUsd)}` : ""}`
      )
    ],
    ...(lane.turns.length === 0 && lane.gatesMs === 0
      ? []
      : [
          [
            span(
              `turns ${lane.turns.length} · avg ${elapsedMs(
                lane.turns.length === 0
                  ? 0
                  : lane.turns.reduce((total, turn) => total + turn, 0) / lane.turns.length
              )} · gates ${elapsedMs(lane.gatesMs)}`
            )
          ]
        ]),
    statusLine(lane, now, idleAfterMs)
  ])

/** Work under way as a card names it: the command itself, the call, the wait. */
export const workText = (work: TreeWork): string => {
  switch (work.kind) {
    case "model":
      return `${work.label} call`
    case "gate":
      return work.label
    case "wait":
      return `waiting for ${work.label}`
    case "merge":
      return "merge"
    default:
      return `${work.kind} ${work.label}`
  }
}

/**
 * The card's "doing now" line, duration first (a long command is cut at the
 * box edge, never the timer): a coder tool, else a command, git step, merge
 * or wait under way, else the coder thinking after a tool, else a model call
 * open, else the last tool it ran.
 */
const doingLine = (lane: TreeLane, now: number | undefined): Line => {
  const work = lane.running.at(-1)
  const timed = (since: number, text: string): Line => [
    span(`${elapsed(since, now)} · `),
    span(text, "dim")
  ]
  if (lane.activity?.tool === true) {
    return timed(lane.activity.since, lane.activity.text)
  }
  if (work !== undefined && work.kind !== "model") {
    return timed(work.since, workText(work))
  }
  if (lane.activity !== undefined) {
    return timed(lane.activity.since, lane.activity.text)
  }
  return work === undefined ? [span(lane.lastTool ?? "", "dim")] : timed(work.since, workText(work))
}

/**
 * Running, or why not: work the lane said began (a command, git, a merge, a
 * wait) is running however long it takes; a model call that has said nothing
 * for `idleAfterMs` is quiet; a lane with nothing under way and nothing said
 * for that long is idle — possibly stuck.
 */
const statusLine = (lane: TreeLane, now: number | undefined, idleAfterMs: number): Line => {
  const work = lane.running.at(-1)
  const quiet = now !== undefined && now - lane.lastEventAt >= idleAfterMs
  if (lane.activity?.tool === true || (work !== undefined && work.kind !== "model") || !quiet) {
    return [span("◐ running", "running")]
  }
  return work === undefined
    ? [span(`⏸ idle ${elapsed(lane.lastEventAt, now)}`, "judge")]
    : [span(`⏸ quiet ${elapsed(lane.lastEventAt, now)} · ${workText(work)} open`, "judge")]
}

const elapsedMs = (ms: number): string => elapsed(0, ms)

type ChipStatus = "planned" | "running" | "waiting" | "done" | "failed"

/** Every story once: the board's in plan order, then lanes the board does not list. */
const chipsOf = (
  state: TreeState
): ReadonlyArray<{ readonly id: string; readonly status: ChipStatus }> => {
  const laneStatus = (id: string): ChipStatus | undefined =>
    state.lanes.find((lane) => lane.id === id)?.status
  const onBoard = new Set(state.stories.map((story) => story.id))
  return [
    ...state.stories.map((story) => ({
      id: story.id,
      status:
        laneStatus(story.id) ??
        (story.status === "skipped" ? "done" : story.status === "active" ? "planned" : story.status)
    })),
    ...state.lanes
      .filter((lane) => !onBoard.has(lane.id))
      .map((lane) => ({ id: lane.id, status: lane.status }))
  ]
}

const chipMark: Readonly<Record<ChipStatus, readonly [string, Style | undefined]>> = {
  planned: ["·", "dim"],
  running: ["◐", "running"],
  waiting: ["◌", "judge"],
  done: ["✓", "judgment"],
  failed: ["✗", undefined]
}

const chipOf = (chip: { readonly id: string; readonly status: ChipStatus }): Line => {
  const [mark, style] = chipMark[chip.status]
  return [span(`${mark} ${chip.id}`, style)]
}

const wrapChips = (chips: ReadonlyArray<Line>, width: number): Array<Line> => {
  const rows: Array<Array<Span>> = []
  let row: Array<Span> = []
  for (const chip of chips) {
    if (row.length > 0 && lengthOf(row) + 2 + lengthOf(chip) > width) {
      rows.push(row)
      row = []
    }
    row = row.length === 0 ? [...chip] : [...row, span("  "), ...chip]
  }
  return row.length === 0 ? rows : [...rows, row]
}

/**
 * What an executor holds: its leases, or — for a trace from before the
 * roster's events — the running lanes that name it.
 */
const heldBy = (state: TreeState, executor: string): ReadonlyArray<string> => {
  const leases = state.leases
    .filter((lease) => lease.executor === executor)
    .map((lease) => `${lease.role}${lease.label === undefined ? "" : ` · ${lease.label}`}`)
  return leases.length > 0
    ? leases
    : runningLanes(state)
        .filter((lane) => lane.executor === executor)
        .map((lane) => `coder · ${lane.id}`)
}

const executorBox = (
  state: TreeState,
  executor: string,
  width: number,
  selected: boolean
): Array<Line> => {
  const held = heldBy(state, executor)
  const out = state.exclusions.find((exclusion) => exclusion.executor === executor)
  return box(width, "running", [
    [span(selected ? `▸ ${executor}` : executor, "bold")],
    ...(held.length === 0
      ? [[span("no lease", "dim")]]
      : held.slice(0, 3).map((lease): Line => [span(lease)])),
    out !== undefined
      ? [span(`✗ out: ${out.reason}`)]
      : held.length === 0
        ? [span("○ idle", "dim")]
        : [span("◐ busy", "running")]
  ])
}

/** One box per item, side by side, sharing `width` with a two-column gap. */
const columnsOf = <A>(
  items: ReadonlyArray<A>,
  width: number,
  draw: (item: A, width: number) => Array<Line>
): Array<Line> => {
  const each = Math.floor((width - 2 * (items.length - 1)) / items.length)
  return beside(
    items.map((item) => draw(item, each)),
    items.map(() => each)
  )
}

const expandedLane = (lane: TreeLane, width: number, now: number | undefined): Array<Line> =>
  box(
    width,
    "running",
    [
      [span(`story ${lane.id}`, "bold"), span(`  ${elapsed(lane.startedAt, now)}`)],
      ...lane.stages.map((stage): Line => [span(stage)]),
      [span(`tools (last ${lane.tools.length})`, "dim")],
      ...lane.tools.map((tool): Line => [span(`  ${tool}`, "dim")]),
      [span(`${formatCount(lane.tokens)} tok · ${dollars(lane.costUsd)}`)]
    ],
    `${lane.id} · ${lane.executor ?? "(leasing)"}`
  )

const barWidth = 10
const judgmentRows = 3

const meter = (fraction: number): ReadonlyArray<Span> => {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * barWidth)
  return [span("█".repeat(filled), "judgment"), span("░".repeat(barWidth - filled), "dim")]
}

const judgmentOf = (state: TreeState, width: number): Array<Line> => {
  const { verdict } = state
  const rows: Array<Line> = [
    ...(verdict?.dimensions ?? []).map(
      (dimension): Line => [
        span(dimension.id.padEnd(16)),
        ...meter(dimension.max === 0 ? 0 : dimension.score / dimension.max),
        span(`  ${dimension.score}/${dimension.max}`)
      ]
    ),
    ...state.judgments
      .slice(-judgmentRows)
      .map(
        (judgment): Line => [
          span(judgment.key.padEnd(16)),
          ...meter(judgment.certainty),
          span(`  ${judgment.certainty.toFixed(2)} ${judgment.decision}`)
        ]
      ),
    ...(verdict === undefined
      ? []
      : [
          [
            verdict.cleared
              ? span("cleared → merge", "judgment")
              : span(`${issueCount(verdict.issues)} → coder`, "judge")
          ]
        ])
  ]
  return box(
    width,
    "judgment",
    rows.length === 0 ? [[span("no verdicts yet", "dim")]] : rows,
    verdict === undefined ? "JUDGMENT" : `JUDGMENT · ${verdict.lane} r${verdict.round}`
  )
}

/** The transcript tail of the selection, in place of the boxes. */
const tailOf = (
  view: TreeView,
  tail: ReadonlyArray<string> | undefined,
  width: number
): Array<Line> =>
  box(
    width,
    "running",
    tail === undefined || tail.length === 0
      ? [
          [
            span(
              tail === undefined
                ? "no transcript for this run — start it with llm4ts run … --transcript"
                : "nothing said yet",
              "dim"
            )
          ]
        ]
      : tail.map((line): Line => [span(line)]),
    `tail · ${view.selected ?? ""} · ${view.tailRole ?? "all"}`
  )

const mainOf = (
  state: TreeState,
  width: number,
  view: TreeView,
  tail: ReadonlyArray<string> | undefined
): Array<Line> => {
  const running = state.lanes.filter((lane) => lane.status === "running")
  const orchestratorWidth = Math.min(46, width)
  const stage = state.stages.at(-1) ?? (running.length > 0 ? "implement stories" : "idle")
  // The run's own work under way (its gates, outside any story), innermost.
  const latest = state.running.at(-1)
  const orchestrator = box(
    orchestratorWidth,
    "orchestrator",
    [
      ...(state.action === undefined
        ? []
        : [centre([span(state.action, "bold")], orchestratorWidth - 4)]),
      [span("stage  "), span(stage)],
      ...(latest === undefined
        ? []
        : [
            [
              span("now    "),
              span(`${elapsed(latest.since, state.now)} · `),
              span(workText(latest), "dim")
            ]
          ]),
      [span(`stories ${chipsOf(state).length}  elapsed ${elapsed(state.startedAt, state.now)}`)]
    ],
    state.title
  )
  const selected = running.find((lane) => lane.id === view.selected)
  const shown = running.slice(0, maxLaneBoxes)
  const executors = state.executors.slice(0, maxLaneBoxes + 1)
  const lanes =
    view.tail && view.selected !== undefined
      ? tailOf(view, tail, width)
      : view.expanded && selected !== undefined
        ? expandedLane(selected, width, state.now)
        : view.mode === "executors"
          ? executors.length === 0
            ? [centre([span("no executors yet", "dim")], width)]
            : columnsOf(executors, width, (executor, each) =>
                executorBox(state, executor, each, executor === view.selected)
              )
          : shown.length === 0
            ? [centre([span("no stories in flight", "dim")], width)]
            : columnsOf(shown, width, (lane, each) =>
                laneBox(lane, each, state.now, lane.id === view.selected, state.idleAfterMs)
              )
  return [
    ...orchestrator.map((line) => centre(line, width)),
    centre([span("•", "orchestrator")], width),
    ...judgmentOf(state, width),
    centre([span(`delegate to roster · ${running.length} running`)], width),
    centre([span("▼", "dim")], width),
    ...lanes,
    [],
    ...wrapChips(chipsOf(state).map(chipOf), width)
  ]
}

/** `time [model 62% · tools 5% · gates 24% · wait 9%]`, once anything was timed. */
const timeSplitOf = (time: TreeTimeSplit): Array<Line> => {
  const total = time.model + time.tools + time.gates + time.merge + time.wait
  if (total <= 0) {
    return []
  }
  const part = (name: string, ms: number) =>
    `${name} ${Math.round((Math.max(0, ms) / total) * 100)}%`
  return [
    [
      span(
        `time [${[
          part("model", time.model),
          part("tools", time.tools),
          part("gates", time.gates),
          ...(time.merge > 0 ? [part("git", time.merge)] : []),
          part("wait", time.wait)
        ].join(" · ")}]`
      )
    ]
  ]
}

/** A frame with the session log at `logCount` lines, or without it. */
const frameOf = (
  state: TreeState,
  options: TreeRenderOptions,
  logCount: number | "none"
): ReadonlyArray<string> => {
  const { width } = options
  const mainWidth = width - railWidth - 2
  const chips = chipsOf(state)
  const busy = state.executors.filter((executor) => heldBy(state, executor).length > 0).length
  const count = (status: ChipStatus): number =>
    chips.filter((chip) => chip.status === status).length
  const lines: Array<Line> = [
    centre(
      [span("LLM4TS AGENT TREE", "bold"), span("  ·  "), span(state.title, "orchestrator")],
      width
    ),
    [span("═".repeat(width), "dim")],
    [],
    ...beside(
      [railOf(state), mainOf(state, mainWidth, options.view, options.tail)],
      [railWidth, mainWidth]
    ),
    ...(logCount === "none"
      ? []
      : [[], ...box(width, "log", logOf(state, logCount), "session log")]),
    [
      span(
        `stories [${count("done")}/${chips.length} done · ${count("running")} running · ${count("failed")} failed · ${count("waiting")} waiting]  roster [${busy}/${state.executors.length} busy]`
      )
    ],
    ...timeSplitOf(state.time),
    [
      span(`tokens [${formatCount(state.tokens)}]  cost [${dollars(state.costUsd)}]  run [`),
      state.ended === undefined ? span("live", "running") : span(state.ended, "bold"),
      span("]")
    ]
  ]
  return lines.map((line) => paint(fit(line, width), options.colour))
}

/**
 * The tree at a width and, when `height` is given, no taller: the session
 * log gives way first — fewer lines, down to one, then none — and only then
 * is the frame cut, keeping its status lines, so a redraw never scrolls.
 */
export const renderTree = (state: TreeState, options: TreeRenderOptions): ReadonlyArray<string> => {
  const wanted = options.view.fullLog ? fullLogLines : logLines
  const full = frameOf(state, options, wanted)
  const { height } = options
  if (height === undefined || full.length <= height) {
    return full
  }
  for (let count = wanted - 1; count >= 1; count -= 1) {
    const shorter = frameOf(state, options, count)
    if (shorter.length <= height) {
      return shorter
    }
  }
  return fitToRows(frameOf(state, options, "none"), height)
}

/**
 * A frame cut to a terminal's height: the top of the tree and its two status
 * lines, so a full-screen redraw never scrolls.
 */
const fitToRows = (
  lines: ReadonlyArray<string>,
  rows: number | undefined
): ReadonlyArray<string> =>
  rows === undefined || rows < 4 || lines.length <= rows
    ? lines
    : [...lines.slice(0, rows - 2), ...lines.slice(-2)]

/** `20s`, `4m00s`, `1h02m`. */
export const duration = (ms: number): string => {
  const seconds = Math.round(ms / 1_000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
  }
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`
}
