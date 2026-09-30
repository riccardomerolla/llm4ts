import type { TokenUsage } from "@llm4ts/core/Models"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { FlowEvent } from "@llm4ts/flow/FlowEvents"
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

export interface TreeState {
  readonly title: string
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
  readonly log: ReadonlyArray<TreeLogEntry>
  readonly tokens: number
  /** Estimated: the backend's own figure when it reports one, else the price list. */
  readonly costUsd: number
  /** The run's outcome once its trace says it ended; a live run has none. */
  readonly ended: string | undefined
}

export interface TreeOptions {
  readonly title?: string
  readonly stories?: ReadonlyArray<TreeStory>
}

export const emptyTree = (options: TreeOptions = {}): TreeState => ({
  title: options.title ?? "flow",
  stories: options.stories ?? [],
  startedAt: undefined,
  now: undefined,
  stages: [],
  lanes: [],
  executors: [],
  log: [],
  tokens: 0,
  costUsd: 0,
  ended: undefined
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

const withoutLast = <A>(items: ReadonlyArray<A>, item: A): ReadonlyArray<A> => {
  const index = items.lastIndexOf(item)
  return index < 0 ? items : [...items.slice(0, index), ...items.slice(index + 1)]
}

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
    lane !== undefined && executor !== undefined && lane.executor !== executor
      ? updateLane(named, lane.id, (open) => ({ ...open, executor }))
      : named
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
          costUsd: 0
        }
        return {
          ...current,
          lanes: [...current.lanes.filter((open) => open.id !== story), fresh]
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
        const closed = updateLane(current, lane.id, (open) => ({ ...open, stages: [], status }))
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
    case "ToolUse":
      return lane === undefined
        ? current
        : updateLane(current, lane.id, (open) => ({
            ...open,
            lastTool: `${event.tool} ${event.args}`,
            tools: [...open.tools, `${event.tool} ${event.args}`].slice(-expandedTools)
          }))
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

const logOf = (state: TreeState, full: boolean): Array<Line> => {
  const recent = state.log.slice(full ? -fullLogLines : -logLines)
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
  const seconds = Math.max(0, Math.round(((to ?? 0) - (from ?? to ?? 0)) / 1_000))
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
  /** The selected lane's story id. */
  readonly selected: string | undefined
  readonly expanded: boolean
  readonly fullLog: boolean
}

export const initialView: TreeView = {
  mode: "lanes",
  selected: undefined,
  expanded: false,
  fullLog: false
}

const runningLanes = (state: TreeState): ReadonlyArray<TreeLane> =>
  state.lanes.filter((lane) => lane.status === "running")

/**
 * The view after a key: arrows or 1–9 select a running lane, enter expands
 * it, escape collapses, `e` switches lanes and executors, `l` the full log,
 * `q` quits. Keys it does not know return the same view.
 */
export const onTreeKey = (view: TreeView, key: string, state: TreeState): TreeView | "quit" => {
  const running = runningLanes(state)
  const index = running.findIndex((lane) => lane.id === view.selected)
  const select = (next: number): TreeView => {
    const lane = running[Math.max(0, Math.min(running.length - 1, next))]
    return lane === undefined ? view : { ...view, selected: lane.id }
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
      return view.selected === undefined ? view : { ...view, expanded: !view.expanded }
    case "escape":
      return { ...view, expanded: false }
    case "e":
      return { ...view, mode: view.mode === "lanes" ? "executors" : "lanes" }
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
}

const railWidth = 26
const maxLaneBoxes = 3

const railOf = (): Array<Line> =>
  box(railWidth, "judge", [
    centre([span("JUDGE SEAT", "bold")], railWidth - 4),
    centre([span("— · on call")], railWidth - 4),
    [],
    [span("last verdict:")],
    [span("» none yet", "judge")]
  ])

const laneBox = (
  lane: TreeLane,
  width: number,
  now: number | undefined,
  selected: boolean
): Array<Line> =>
  box(width, "running", [
    [span(selected ? `▸ ${lane.id}` : lane.id, "bold")],
    [span(lane.executor ?? "(leasing)")],
    [span(lane.stages.at(-1) ?? "starting")],
    [span(lane.lastTool ?? "", "dim")],
    [
      span(
        `${elapsed(lane.startedAt, now)} · ${formatCount(lane.tokens)} tok${lane.costUsd > 0 ? ` · ${dollars(lane.costUsd)}` : ""}`
      )
    ],
    [span("◐ running", "running")]
  ])

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

const executorBox = (state: TreeState, executor: string, width: number): Array<Line> => {
  const held = state.lanes.filter((lane) => lane.status === "running" && lane.executor === executor)
  return box(width, "running", [
    [span(executor, "bold")],
    held.length === 0
      ? [span("no coder lease", "dim")]
      : [span(`coder · ${held.map((lane) => lane.id).join(", ")}`)],
    held.length === 0 ? [span("○ idle", "dim")] : [span("◐ busy", "running")]
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

const mainOf = (state: TreeState, width: number, view: TreeView): Array<Line> => {
  const running = state.lanes.filter((lane) => lane.status === "running")
  const orchestratorWidth = Math.min(46, width)
  const stage = state.stages.at(-1) ?? (running.length > 0 ? "implement stories" : "idle")
  const orchestrator = box(
    orchestratorWidth,
    "orchestrator",
    [
      [span("stage  "), span(stage)],
      [span(`stories ${chipsOf(state).length}  elapsed ${elapsed(state.startedAt, state.now)}`)]
    ],
    state.title
  )
  const selected = running.find((lane) => lane.id === view.selected)
  const shown = running.slice(0, maxLaneBoxes)
  const executors = state.executors.slice(0, maxLaneBoxes + 1)
  const lanes =
    view.expanded && selected !== undefined
      ? expandedLane(selected, width, state.now)
      : view.mode === "executors"
        ? executors.length === 0
          ? [centre([span("no executors yet", "dim")], width)]
          : columnsOf(executors, width, (executor, each) => executorBox(state, executor, each))
        : shown.length === 0
          ? [centre([span("no stories in flight", "dim")], width)]
          : columnsOf(shown, width, (lane, each) =>
              laneBox(lane, each, state.now, lane.id === view.selected)
            )
  return [
    ...orchestrator.map((line) => centre(line, width)),
    centre([span("•", "orchestrator")], width),
    ...box(width, "judgment", [[span("no verdicts yet", "dim")]], "JUDGMENT"),
    centre([span(`delegate to roster · ${running.length} running`)], width),
    centre([span("▼", "dim")], width),
    ...lanes,
    [],
    ...wrapChips(chipsOf(state).map(chipOf), width)
  ]
}

export const renderTree = (state: TreeState, options: TreeRenderOptions): ReadonlyArray<string> => {
  const { width } = options
  const mainWidth = width - railWidth - 2
  const chips = chipsOf(state)
  const busy = new Set(
    runningLanes(state).flatMap((lane) => (lane.executor === undefined ? [] : [lane.executor]))
  ).size
  const count = (status: ChipStatus): number =>
    chips.filter((chip) => chip.status === status).length
  const lines: Array<Line> = [
    centre(
      [span("LLM4TS AGENT TREE", "bold"), span("  ·  "), span(state.title, "orchestrator")],
      width
    ),
    [span("═".repeat(width), "dim")],
    [],
    ...beside([railOf(), mainOf(state, mainWidth, options.view)], [railWidth, mainWidth]),
    [],
    ...box(width, "log", logOf(state, options.view.fullLog), "session log"),
    [
      span(
        `stories [${count("done")}/${chips.length} done · ${count("running")} running · ${count("failed")} failed · ${count("waiting")} waiting]  roster [${busy}/${state.executors.length} busy]`
      )
    ],
    [
      span(`tokens [${formatCount(state.tokens)}]  cost [${dollars(state.costUsd)}]  run [`),
      state.ended === undefined ? span("live", "running") : span(state.ended, "bold"),
      span("]")
    ]
  ]
  return lines.map((line) => paint(fit(line, width), options.colour))
}
