import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { FlowError } from "@llm4ts/flow/FlowError"
import type { FlowEvent, Timed } from "@llm4ts/flow/FlowEvents"
import { readTrace } from "@llm4ts/flow/Replay"
import { duration, treeInputsOfTrace, type TreeInput } from "./AgentTree.ts"

export { duration }
import { formatCount } from "./Terminal.ts"
import {
  resolveTraceTarget,
  type TraceChoice,
  type TraceSources,
  type WatchTargetMissing
} from "./Watch.ts"

/**
 * `llm4ts profile`: where a run's time went. A pure fold over the
 * same inputs as the agent tree: per story, its wall time split into model,
 * the coder's tools, gates, merge and waiting, the rest left as unaccounted;
 * per role and executor the model calls, per command the gates; and the
 * biggest sinks ranked in plain words.
 *
 * Content-free by design, so a report can leave a customer's server: story
 * ids, roles, executor ids, tool names, gate commands as configured, counts
 * and durations — never a prompt, a reply, an argument or an output.
 *
 * A trace from before the `Timed` event (2.22) is estimated: a model call is
 * the gap before its token report in the same lane, and the report says so.
 */

const Ms = Schema.Number

export const ProfileTime = Schema.Struct({
  model: Ms,
  tools: Ms,
  gates: Ms,
  merge: Ms,
  waiting: Ms,
  unaccounted: Ms
})
export type ProfileTime = typeof ProfileTime.Type

export const TurnStats = Schema.Struct({
  count: Schema.Int,
  avgMs: Ms,
  maxMs: Ms,
  firstPrompt: Schema.optionalKey(Schema.Int),
  lastPrompt: Schema.optionalKey(Schema.Int),
  maxPrompt: Schema.optionalKey(Schema.Int),
  /** The last prompt is more than three times the first. */
  promptGrowth: Schema.Boolean,
  /** Tool calls per finished turn: each is a model round trip. */
  avgSteps: Schema.Number,
  /** The model's own time per round trip: a turn's time less its tools, over its steps + 1. */
  avgStepMs: Ms
})
export type TurnStats = typeof TurnStats.Type

/** A stretch of a story's time no `Timed` event covers, named by the events around it. */
export const Gap = Schema.Struct({
  ms: Ms,
  after: Schema.String,
  before: Schema.String
})
export type Gap = typeof Gap.Type

export const StoryProfile = Schema.Struct({
  id: Schema.String,
  executor: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["done", "failed", "running"]),
  wallMs: Ms,
  /** From the plan being ready to this story starting: dependencies and free coder slots. */
  queuedMs: Schema.optionalKey(Ms),
  time: ProfileTime,
  turns: TurnStats,
  /** Its largest untimed stretches, 30 seconds or more: where "unaccounted" sits. */
  gaps: Schema.Array(Gap),
  /**
   * A coder turn the trace shows working (tool calls after its last finished
   * call) but not ended: a run still going. Counted as model time so far.
   */
  openTurnMs: Ms,
  openTurnTools: Schema.Int
})
export type StoryProfile = typeof StoryProfile.Type

export const ModelRow = Schema.Struct({
  role: Schema.String,
  executor: Schema.optionalKey(Schema.String),
  calls: Schema.Int,
  ms: Ms,
  avgMs: Ms,
  avgFirstMs: Schema.optionalKey(Ms),
  /** As the backend reported them. */
  apiMs: Schema.optionalKey(Ms),
  toolMs: Schema.optionalKey(Ms)
})
export type ModelRow = typeof ModelRow.Type

export const GateRow = Schema.Struct({
  command: Schema.String,
  runs: Schema.Int,
  ms: Ms,
  avgMs: Ms,
  failed: Schema.Int
})
export type GateRow = typeof GateRow.Type

export const CountRow = Schema.Struct({ label: Schema.String, count: Schema.Int, ms: Ms })
export type CountRow = typeof CountRow.Type

export const Finding = Schema.Struct({ text: Schema.String, ms: Schema.optionalKey(Ms) })
export type Finding = typeof Finding.Type

export const ProfileReport = Schema.Struct({
  /** No `Timed` events: model time is estimated from gaps, the rest is unknown. */
  estimated: Schema.Boolean,
  wallMs: Ms,
  stories: Schema.Array(StoryProfile),
  /** Stories merged on an earlier run: this run only skipped them. */
  skipped: Schema.Array(Schema.String),
  totals: ProfileTime,
  models: Schema.Array(ModelRow),
  gates: Schema.Array(GateRow),
  tools: Schema.Array(CountRow),
  /** Coder tool time by kind of work: explore, edit, test, build, install, git, other. */
  toolCategories: Schema.Array(CountRow),
  waits: Schema.Array(CountRow),
  /** Timed on the run's events, in no story: the run's own planning, or a seat no story owns. */
  outside: Schema.Array(CountRow),
  findings: Schema.Array(Finding)
})
export type ProfileReport = typeof ProfileReport.Type

// ── fold ────────────────────────────────────────────────────────────────────

interface TimedAt {
  readonly at: number
  readonly event: Timed
}

interface Lane {
  readonly id: string
  start: number
  end: number | undefined
  status: "done" | "failed" | "running"
  executor: string | undefined
  readonly timed: Array<TimedAt>
  /** Coder prompt sizes, in order. */
  readonly prompts: Array<number>
  /** Estimated mode: the gaps before each token report. */
  readonly estimatedCalls: Array<number>
  /** The last turn boundary: any lane event but a tool call inside a turn. */
  last: number
  skipped: boolean
  /** Every event on the lane, described without its content, for the gaps. */
  readonly moments: Array<{ readonly at: number; readonly what: string }>
  /** Since when a coder turn has been working without ending, and its tool calls. */
  openSince: number | undefined
  openTools: number
}

interface Lease {
  readonly at: number
  readonly executor: string
  readonly role: string
  readonly label: string | undefined
}

const storyStage = /^story (\S+)$/u

/** Events a coder turn emits while it runs: not where a model call starts. */
const withinTurn: ReadonlySet<FlowEvent["_tag"]> = new Set([
  "ToolUse",
  "UsageProgress",
  "CapabilityUsed",
  "AssistantMessage"
])

const sum = (values: ReadonlyArray<number>): number =>
  values.reduce((total, value) => total + value, 0)

const average = (values: ReadonlyArray<number>): number | undefined =>
  values.length === 0 ? undefined : sum(values) / values.length

const groupBy = <A>(items: ReadonlyArray<A>, key: (item: A) => string): Map<string, Array<A>> => {
  const groups = new Map<string, Array<A>>()
  for (const item of items) {
    const group = groups.get(key(item)) ?? []
    group.push(item)
    groups.set(key(item), group)
  }
  return groups
}

const laneOf = (event: FlowEvent): string | undefined =>
  "lane" in event && typeof event.lane === "string" ? event.lane : undefined

/** An event as the gaps name it: its kind, never its content. */
const describe = (event: FlowEvent): string => {
  switch (event._tag) {
    case "StageStarted":
      return "a stage start"
    case "StageCompleted":
      return "a stage end"
    case "StageFailed":
      return "a stage failure"
    case "ToolUse":
      return "a coder tool call"
    case "TokensUsed":
      return "a token report"
    case "Info":
      return "a log note"
    case "ReviewFindings":
      return "a review round"
    case "StoryJudged":
      return "a judge verdict"
    case "AssistantMessage":
      return "an assistant message"
    case "CapabilityUsed":
    case "CapabilityDenied":
    case "CapabilityUnenforceable":
      return "a capability check"
    case "ExecutorLeased":
    case "ExecutorReleased":
    case "ExecutorExcluded":
    case "ExecutorResumed":
    case "ExecutorHandedOver":
      return "a roster change"
    case "Timed":
      switch (event.kind) {
        case "model":
          return `the end of a ${event.label} call`
        case "tool":
          return `the end of tool ${event.label}`
        case "gate":
          return `the end of gate ${event.label}`
        case "wait":
          return `the end of a wait for the ${event.label}`
        default:
          return `the end of ${event.label}`
      }
    default:
      return "an event"
  }
}

const gapThresholdMs = 30_000

/** The parts of each step between two lane events that no timed interval covers, largest first. */
const gapsOf = (lane: Lane): ReadonlyArray<Gap> => {
  const covered = [
    ...lane.timed.map((item) => [item.at - item.event.ms, item.at] as const),
    // A turn still open is model time, not a gap.
    ...(lane.openSince === undefined || lane.end !== undefined
      ? []
      : [[lane.openSince, Number.POSITIVE_INFINITY] as const])
  ].sort((left, right) => left[0] - right[0])
  const uncovered = (from: number, to: number): number => {
    let free = 0
    let cursor = from
    for (const [start, end] of covered) {
      if (end <= cursor || start >= to) {
        continue
      }
      free += Math.max(0, start - cursor)
      cursor = Math.max(cursor, end)
    }
    return free + Math.max(0, to - cursor)
  }
  const moments = [...lane.moments].sort((left, right) => left.at - right.at)
  return moments
    .slice(1)
    .flatMap((next, index) => {
      const previous = moments[index]
      if (previous === undefined) {
        return []
      }
      const ms = uncovered(previous.at, next.at)
      return ms >= gapThresholdMs ? [{ ms, after: previous.what, before: next.what }] : []
    })
    .sort((left, right) => right.ms - left.ms)
    .slice(0, 3)
}

/** The roster role a seat label stands for, to find its lease. */
const leaseRole = (label: string): string => (label === "reasoning" ? "reviewer" : label)

export const profileOf = (inputs: ReadonlyArray<TreeInput>): ProfileReport => {
  const lanes = new Map<string, Lane>()
  const leases: Array<Lease> = []
  const allTimed: Array<TimedAt> = []
  let first: number | undefined
  let lastAt = 0
  let planReady: number | undefined

  for (const input of inputs) {
    first = first ?? input.at
    lastAt = Math.max(lastAt, input.at)
    if (input._tag !== "Event") {
      continue
    }
    const { event, at } = input
    const laneId = laneOf(event)
    const lane = laneId === undefined ? undefined : lanes.get(laneId)
    switch (event._tag) {
      case "StageStarted": {
        const story = storyStage.exec(event.stage)?.[1]
        if (story !== undefined && event.lane === story) {
          lanes.set(story, {
            id: story,
            start: at,
            end: undefined,
            status: "running",
            executor: event.executor,
            timed: [],
            prompts: [],
            estimatedCalls: [],
            last: at,
            skipped: false,
            moments: [{ at, what: describe(event) }],
            openSince: undefined,
            openTools: 0
          })
          continue
        }
        break
      }
      case "StageCompleted":
      case "StageFailed":
        if (event.stage === "story plan" && event.lane === undefined) {
          planReady = at
        }
        if (lane !== undefined && event.stage === `story ${lane.id}`) {
          lane.end = at
          lane.status = event._tag === "StageFailed" ? "failed" : "done"
        }
        break
      case "Timed": {
        allTimed.push({ at, event })
        lane?.timed.push({ at, event })
        if (lane !== undefined && event.kind === "model" && event.label === "coder") {
          lane.openSince = undefined
          lane.openTools = 0
        }
        break
      }
      case "ToolUse":
        if (lane !== undefined) {
          // A tool call opens a turn until a coder call ends: it began at
          // the last turn boundary.
          lane.openSince = lane.openSince ?? lane.last
          lane.openTools += 1
        }
        break
      case "TokensUsed":
        if (lane !== undefined) {
          if (event.agent === "coder") {
            lane.prompts.push(event.usage.prompt)
          }
          lane.estimatedCalls.push(at - lane.last)
        }
        break
      case "ExecutorLeased":
        leases.push({ at, executor: event.executor, role: event.role, label: event.label })
        break
      case "Info":
        if (lane !== undefined && event.message.startsWith(`story ${lane.id}: already merged`)) {
          lane.skipped = true
        }
        break
      default:
        break
    }
    if (lane !== undefined) {
      lane.moments.push({ at, what: describe(event) })
      lane.executor = lane.executor ?? ("executor" in event ? event.executor : undefined)
      if (!withinTurn.has(event._tag)) {
        lane.last = at
      }
    }
  }

  const estimated = allTimed.length === 0
  const stories = [...lanes.values()]
    .filter((lane) => !lane.skipped)
    .map((lane) => storyProfile(lane, lastAt, planReady, estimated))
  const skipped = [...lanes.values()].filter((lane) => lane.skipped).map((lane) => lane.id)

  const executorOf = (item: TimedAt): string | undefined => {
    if (item.event.executor !== undefined) {
      return item.event.executor
    }
    const role = leaseRole(item.event.label)
    const lease = [...leases]
      .reverse()
      .find(
        (candidate) =>
          candidate.at <= item.at && candidate.role === role && candidate.label === item.event.lane
      )
    return lease?.executor
  }

  const modelCalls = allTimed.filter((item) => item.event.kind === "model")
  const models = [
    ...groupBy(modelCalls, (item) => `${item.event.label}\u0000${executorOf(item) ?? ""}`).values()
  ].map((calls): ModelRow => {
    const sample = calls[0]
    const executor = sample === undefined ? undefined : executorOf(sample)
    const ms = sum(calls.map((item) => item.event.ms))
    const firsts = calls.flatMap((item) =>
      item.event.firstMs === undefined ? [] : [item.event.firstMs]
    )
    const apis = calls.flatMap((item) => (item.event.apiMs === undefined ? [] : [item.event.apiMs]))
    const toolsReported = calls.flatMap((item) =>
      item.event.toolMs === undefined ? [] : [item.event.toolMs]
    )
    const avgFirstMs = average(firsts)
    return {
      role: sample?.event.label ?? "",
      ...(executor === undefined ? {} : { executor }),
      calls: calls.length,
      ms,
      avgMs: ms / calls.length,
      ...(avgFirstMs === undefined ? {} : { avgFirstMs }),
      ...(apis.length === 0 ? {} : { apiMs: sum(apis) }),
      ...(toolsReported.length === 0 ? {} : { toolMs: sum(toolsReported) })
    }
  })

  const gates = [
    ...groupBy(
      allTimed.filter((item) => item.event.kind === "gate"),
      (item) => item.event.label
    ).entries()
  ].map(([command, runs]): GateRow => {
    const ms = sum(runs.map((item) => item.event.ms))
    return {
      command,
      runs: runs.length,
      ms,
      avgMs: ms / runs.length,
      failed: runs.filter((item) => (item.event.exitCode ?? 0) !== 0 || item.event.failed === true)
        .length
    }
  })

  const counted = (kind: Timed["kind"]): ReadonlyArray<CountRow> =>
    [
      ...groupBy(
        allTimed.filter((item) => item.event.kind === kind),
        (item) => item.event.label
      ).entries()
    ].map(([label, items]) => ({
      label,
      count: items.length,
      ms: sum(items.map((item) => item.event.ms))
    }))
  const tools = counted("tool")
  const toolCategories = [
    ...groupBy(
      allTimed.filter((item) => item.event.kind === "tool" && item.event.category !== undefined),
      (item) => item.event.category ?? ""
    ).entries()
  ]
    .map(([label, items]) => ({
      label,
      count: items.length,
      ms: sum(items.map((item) => item.event.ms))
    }))
    .sort((left, right) => right.ms - left.ms)
  const waits = counted("wait")
  const steps = stepStats(estimated ? [] : [...lanes.values()].flatMap(turnSteps))
  const outside = [
    ...groupBy(
      allTimed.filter((item) => item.event.lane === undefined),
      (item) => item.event.label
    ).entries()
  ].map(([label, items]) => ({
    label,
    count: items.length,
    ms: sum(items.map((item) => item.event.ms))
  }))
  const merges = [...counted("merge"), ...counted("git")]

  const totals = stories.reduce<ProfileTime>(
    (total, story) => ({
      model: total.model + story.time.model,
      tools: total.tools + story.time.tools,
      gates: total.gates + story.time.gates,
      merge: total.merge + story.time.merge,
      waiting: total.waiting + story.time.waiting,
      unaccounted: total.unaccounted + story.time.unaccounted
    }),
    { model: 0, tools: 0, gates: 0, merge: 0, waiting: 0, unaccounted: 0 }
  )
  const storyTime = sum(stories.map((story) => story.wallMs))

  return {
    estimated,
    wallMs: first === undefined ? 0 : lastAt - first,
    stories,
    skipped,
    totals,
    models,
    gates,
    tools,
    toolCategories,
    waits,
    outside,
    findings: findingsOf({
      steps,
      toolCategories,
      stories,
      models,
      gates,
      tools,
      waits,
      merges,
      storyTime,
      estimated
    })
  }
}

const stepStats = (
  turns: ReadonlyArray<{ readonly steps: number; readonly stepMs: number }>
): { readonly avgSteps: number; readonly avgStepMs: number } => ({
  avgSteps: average(turns.map((turn) => turn.steps)) ?? 0,
  avgStepMs: average(turns.map((turn) => turn.stepMs)) ?? 0
})

/** Each finished coder turn's steps (its tool calls) and model time per step. */
const turnSteps = (
  lane: Lane
): ReadonlyArray<{ readonly steps: number; readonly stepMs: number }> => {
  const tools = lane.timed.filter((item) => item.event.kind === "tool")
  return lane.timed
    .filter((item) => item.event.kind === "model" && item.event.label === "coder")
    .map((turn) => {
      const start = turn.at - turn.event.ms
      const inside = tools.filter((tool) => tool.at > start && tool.at <= turn.at)
      const toolMs = sum(inside.map((tool) => tool.event.ms))
      return {
        steps: inside.length,
        stepMs: Math.max(0, turn.event.ms - toolMs) / (inside.length + 1)
      }
    })
}

const storyProfile = (
  lane: Lane,
  lastAt: number,
  planReady: number | undefined,
  estimated: boolean
): StoryProfile => {
  const wallMs = (lane.end ?? lastAt) - lane.start
  const of = (kind: Timed["kind"]) =>
    sum(lane.timed.filter((item) => item.event.kind === kind).map((item) => item.event.ms))
  const coderCalls = lane.timed
    .filter((item) => item.event.kind === "model" && item.event.label === "coder")
    .map((item) => item.event.ms)
  const tools = of("tool")
  // Only a story still running has a turn in progress; in a finished one an
  // unclosed turn is a timing that never came, left to the gaps.
  const open = !estimated && lane.end === undefined && lane.openSince !== undefined
  const openTurnMs = open && lane.openSince !== undefined ? lastAt - lane.openSince : 0
  const model = estimated ? sum(lane.estimatedCalls) : Math.max(0, of("model") + openTurnMs - tools)
  const gates = of("gate")
  const merge = of("merge") + of("git")
  const waiting = of("wait")
  const turnTimes = estimated ? lane.estimatedCalls : coderCalls
  const firstPrompt = lane.prompts[0]
  const lastPrompt = lane.prompts.at(-1)
  const maxPrompt = lane.prompts.length === 0 ? undefined : Math.max(...lane.prompts)
  return {
    gaps: estimated ? [] : gapsOf(lane),
    openTurnMs,
    openTurnTools: open ? lane.openTools : 0,
    id: lane.id,
    ...(lane.executor === undefined ? {} : { executor: lane.executor }),
    status: lane.status,
    wallMs,
    ...(planReady === undefined ? {} : { queuedMs: Math.max(0, lane.start - planReady) }),
    time: {
      model,
      tools,
      gates,
      merge,
      waiting,
      unaccounted: Math.max(0, wallMs - model - tools - gates - merge - waiting)
    },
    turns: {
      count: turnTimes.length,
      avgMs: average(turnTimes) ?? 0,
      maxMs: turnTimes.length === 0 ? 0 : Math.max(...turnTimes),
      ...(firstPrompt === undefined ? {} : { firstPrompt }),
      ...(lastPrompt === undefined ? {} : { lastPrompt }),
      ...(maxPrompt === undefined ? {} : { maxPrompt }),
      ...stepStats(estimated ? [] : turnSteps(lane)),
      promptGrowth:
        firstPrompt !== undefined &&
        lastPrompt !== undefined &&
        firstPrompt > 0 &&
        lastPrompt > 3 * firstPrompt
    }
  }
}

// ── words ───────────────────────────────────────────────────────────────────

const stepsText = (steps: number): string =>
  `${Number.isInteger(steps) ? steps : steps.toFixed(1)} step${steps === 1 ? "" : "s"}`

const share = (ms: number, of: number): string => (of <= 0 ? "" : `${Math.round((ms / of) * 100)}%`)

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`

const findingsOf = (facts: {
  readonly steps: { readonly avgSteps: number; readonly avgStepMs: number }
  readonly toolCategories: ReadonlyArray<CountRow>
  readonly stories: ReadonlyArray<StoryProfile>
  readonly models: ReadonlyArray<ModelRow>
  readonly gates: ReadonlyArray<GateRow>
  readonly tools: ReadonlyArray<CountRow>
  readonly waits: ReadonlyArray<CountRow>
  readonly merges: ReadonlyArray<CountRow>
  readonly storyTime: number
  readonly estimated: boolean
}): ReadonlyArray<Finding> => {
  const ofStories = (ms: number) => `${duration(ms)} (${share(ms, facts.storyTime)} of story time)`
  const byRole = [...groupBy(facts.models, (row) => row.role).entries()].map(([role, rows]) => {
    const calls = sum(rows.map((row) => row.calls))
    const ms = sum(rows.map((row) => row.ms))
    const firsts = rows.flatMap((row) => (row.avgFirstMs === undefined ? [] : [row.avgFirstMs]))
    const firstMs = average(firsts)
    const first = firstMs === undefined ? "" : `, first output after ${duration(firstMs)}`
    return {
      ms,
      text:
        role === "coder"
          ? `coder turns: ${calls}, ${ofStories(ms)}, avg ${duration(ms / calls)}${first}${
              facts.steps.avgSteps > 0
                ? `, ${stepsText(facts.steps.avgSteps)} per turn, ${duration(facts.steps.avgStepMs)} of model per step`
                : ""
            }`
          : `${role} calls: ${calls}, ${ofStories(ms)}, avg ${duration(ms / calls)}${first}`
    }
  })
  const candidates: Array<{ readonly ms: number; readonly text: string }> = [
    ...byRole,
    ...facts.gates.map((row) => ({
      ms: row.ms,
      text: `gate \`${row.command}\`: ${plural(row.runs, "run")}, ${ofStories(row.ms)}${
        row.failed === 0 ? "" : `, ${row.failed} failed`
      }`
    })),
    // By kind of work when the trace has it (2.23), else by tool name.
    ...(facts.toolCategories.length > 0
      ? facts.toolCategories.map((row) => ({
          ms: row.ms,
          text: `coder tools, ${row.label}: ${plural(row.count, "call")}, ${ofStories(row.ms)}`
        }))
      : facts.tools.map((row) => ({
          ms: row.ms,
          text: `coder tool \`${row.label}\`: ${plural(row.count, "call")}, ${ofStories(row.ms)}`
        }))),
    ...facts.waits.map((row) => ({
      ms: row.ms,
      text: `waiting for the ${row.label}: ${row.count}×, ${ofStories(row.ms)}`
    })),
    ...facts.merges.map((row) => ({
      ms: row.ms,
      text: `${row.label}: ${row.count}×, ${ofStories(row.ms)}`
    }))
  ]
  for (const story of facts.stories) {
    if (story.openTurnMs >= 1_000) {
      candidates.push({
        ms: story.openTurnMs,
        text: `${story.id}: a coder turn still running for ${duration(story.openTurnMs)} (${plural(story.openTurnTools, "tool call")} so far)`
      })
    }
  }
  const queued = sum(facts.stories.map((story) => story.queuedMs ?? 0))
  if (queued >= 1_000) {
    candidates.push({
      ms: queued,
      text: `stories queued before starting (dependencies, free coder slots): ${duration(queued)} in all`
    })
  }
  const estimated = facts.estimated
    ? facts.stories.map((story) => ({
        ms: story.time.model,
        text: `${story.id}: model calls (estimated) ${duration(story.time.model)} of ${duration(story.wallMs)}`
      }))
    : []
  const ranked = [...candidates, ...estimated]
    .filter((candidate) => candidate.ms >= 1_000)
    .sort((left, right) => right.ms - left.ms)
    .slice(0, 3)
  const growth = facts.stories.flatMap((story) =>
    story.turns.promptGrowth &&
    story.turns.firstPrompt !== undefined &&
    story.turns.lastPrompt !== undefined
      ? [
          {
            text: `${story.id}: coder prompts grew ${(story.turns.lastPrompt / story.turns.firstPrompt).toFixed(1)}× (${formatCount(story.turns.firstPrompt)} → ${formatCount(story.turns.lastPrompt)} tokens): every turn resends the history`
          }
        ]
      : []
  )
  return [...ranked, ...growth]
}

const table = (
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>
): Array<string> => {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length))
  )
  const line = (cells: ReadonlyArray<string>) =>
    `  ${cells.map((cell, column) => (column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0))).join("  ")}`.trimEnd()
  return [line(header), ...rows.map(line)]
}

export const renderProfile = (report: ProfileReport): string => {
  const storyTime = sum(report.stories.map((story) => story.wallMs))
  const categories: ReadonlyArray<readonly [string, number]> = [
    [report.estimated ? "model + tools + gates (estimated)" : "model", report.totals.model],
    ["coder tools", report.totals.tools],
    ["gates", report.totals.gates],
    ["git + merge", report.totals.merge],
    ["waiting", report.totals.waiting],
    ["unaccounted", report.totals.unaccounted]
  ]
  return [
    `llm4ts profile · ${duration(report.wallMs)} wall · ${report.stories.length} ${report.stories.length === 1 ? "story" : "stories"}${
      report.estimated
        ? " · estimated: this trace has no timings (before 2.22), model time is read from gaps"
        : ""
    }`,
    "",
    "Where the time goes",
    ...(report.findings.length === 0
      ? ["  nothing timed yet"]
      : report.findings.map((finding, index) => `  ${index + 1}. ${finding.text}`)),
    "",
    "Story time",
    ...table(
      ["category", "time", "share"],
      categories.map(([name, ms]) => [name, duration(ms), share(ms, storyTime)])
    ),
    "",
    "Stories",
    ...table(
      [
        "story",
        "status",
        "wall",
        "queued",
        "model",
        "tools",
        "gates",
        "git+merge",
        "wait",
        "other",
        "turns",
        "avg turn",
        "steps/turn",
        "model/step",
        "prompt ×"
      ],
      report.stories.map((story) => [
        story.id,
        story.status,
        duration(story.wallMs),
        story.queuedMs === undefined ? "" : duration(story.queuedMs),
        duration(story.time.model),
        duration(story.time.tools),
        duration(story.time.gates),
        duration(story.time.merge),
        duration(story.time.waiting),
        duration(story.time.unaccounted),
        String(story.turns.count),
        duration(story.turns.avgMs),
        story.turns.avgSteps === 0 ? "" : story.turns.avgSteps.toFixed(1),
        story.turns.avgSteps === 0 ? "" : duration(story.turns.avgStepMs),
        story.turns.firstPrompt !== undefined &&
        story.turns.lastPrompt !== undefined &&
        story.turns.firstPrompt > 0
          ? `${(story.turns.lastPrompt / story.turns.firstPrompt).toFixed(1)}×`
          : ""
      ])
    ),
    ...(report.skipped.length === 0
      ? []
      : [`  skipped (merged on an earlier run): ${report.skipped.join(", ")}`]),
    ...(report.stories.every((story) => story.gaps.length === 0)
      ? []
      : [
          "",
          "Unaccounted, largest gaps (no timing covers them)",
          ...report.stories.flatMap((story) =>
            story.gaps.map(
              (gap) => `  ${story.id}: ${duration(gap.ms)} between ${gap.after} and ${gap.before}`
            )
          )
        ]),
    ...(report.outside.length === 0
      ? []
      : [
          "",
          "Timed outside any story (the run's own planning, or a seat no story owns)",
          ...table(
            ["label", "count", "total"],
            report.outside.map((row) => [row.label, String(row.count), duration(row.ms)])
          )
        ]),
    ...(report.models.length === 0
      ? []
      : [
          "",
          "Model calls",
          ...table(
            [
              "role",
              "executor",
              "calls",
              "total",
              "avg",
              "first output",
              "api (reported)",
              "tools (reported)"
            ],
            report.models.map((row) => [
              row.role,
              row.executor ?? "",
              String(row.calls),
              duration(row.ms),
              duration(row.avgMs),
              row.avgFirstMs === undefined ? "" : duration(row.avgFirstMs),
              row.apiMs === undefined ? "" : duration(row.apiMs),
              row.toolMs === undefined ? "" : duration(row.toolMs)
            ])
          )
        ]),
    ...(report.gates.length === 0
      ? []
      : [
          "",
          "Gates",
          ...table(
            ["command", "runs", "total", "avg", "failed"],
            report.gates.map((row) => [
              row.command,
              String(row.runs),
              duration(row.ms),
              duration(row.avgMs),
              String(row.failed)
            ])
          )
        ]),
    ...(report.toolCategories.length === 0
      ? []
      : [
          "",
          "Coder tools by kind",
          ...table(
            ["kind", "calls", "total", "avg"],
            report.toolCategories.map((row) => [
              row.label,
              String(row.count),
              duration(row.ms),
              duration(row.ms / row.count)
            ])
          )
        ])
  ].join("\n")
}

export interface ProfileOptions extends TraceChoice {
  readonly json?: boolean
}

const encodeReport = Schema.encodeSync(Schema.fromJsonString(ProfileReport))

/** The report for a trace, an epic's latest run, or the newest trace: text, or JSON for comparing runs. */
export const makeProfileProgram = Effect.fn("@llm4ts/runner/Profile.make")(function* (
  options: ProfileOptions,
  sources: TraceSources
): Effect.fn.Return<string, FlowError | WatchTargetMissing> {
  const target = yield* resolveTraceTarget(options, sources)
  const report = profileOf(treeInputsOfTrace(yield* readTrace(sources.files, target.tracePath)))
  return options.json === true ? encodeReport(report) : renderProfile(report)
})
