import type { TreeLane, TreeState } from "./AgentTree.ts"

/**
 * One sentence on how a run is going, for a chat agent that asked. Pure over
 * the watch TUI's folded state, so a live run and a replay read the same.
 */

const listed = 3

const elapsedOf = (state: TreeState): string => {
  const minutes =
    state.startedAt === undefined || state.now === undefined
      ? 0
      : Math.max(0, Math.floor((state.now - state.startedAt) / 60_000))
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** At most three entries; the rest collapse into `+<n>`. */
const capped = (items: ReadonlyArray<string>, separator: string): string =>
  items.length > listed
    ? [...items.slice(0, listed), `+${items.length - listed}`].join(separator)
    : items.join(separator)

const doing = (lane: TreeLane | undefined): string =>
  lane?.stages[lane.stages.length - 1] ?? lane?.activity?.text ?? "starting"

const lastLogOf = (state: TreeState, id: string): string => {
  for (let index = state.log.length - 1; index >= 0; index--) {
    const entry = state.log[index]
    if (entry !== undefined && entry.who === id) return entry.what
  }
  return "failed"
}

const parenthesized = (items: ReadonlyArray<string>, separator: string): string =>
  items.length === 0 ? "" : ` (${capped(items, separator)})`

export const summarizeTree = (state: TreeState, flow: string | undefined): string => {
  const ended = state.ended === undefined ? "" : `${state.ended}, `
  const head = `${ended}${flow ?? state.title}, ${elapsedOf(state)}`
  const cost = `$${state.costUsd.toFixed(2)}`
  const board = state.stories.length > 0
  if (!board && state.lanes.length === 0) return `${head}: no stories yet, ${cost}`
  const ids = (status: "done" | "active" | "failed"): ReadonlyArray<string> =>
    board
      ? state.stories.filter((story) => story.status === status).map((story) => story.id)
      : state.lanes
          .filter((lane) => lane.status === (status === "active" ? "running" : status))
          .map((lane) => lane.id)
  const active = ids("active")
  const failed = ids("failed")
  const activeItems = active.map((id) => {
    const lane = state.lanes.find((open) => open.id === id)
    return `${id}, ${lane?.executor ?? "?"}, ${doing(lane)}`
  })
  const failedItems = failed.map((id) => `${id}: ${lastLogOf(state, id)}`)
  return (
    `${head}: ${ids("done").length} stories done, ` +
    `${active.length} active${parenthesized(activeItems, "; ")}, ` +
    `${failed.length} failed${parenthesized(failedItems, "; ")}, ${cost}`
  )
}

export interface PlainProgress {
  readonly tasksTotal: number
  readonly tasksDone: number
  readonly ended?: {
    readonly outcome: string
    readonly minutes: number
    readonly costUsd: number
    readonly branch?: string
    readonly commits?: number
  }
}

/**
 * One sentence for a run with plan tasks and no stories, or `undefined` when
 * nothing worth saying changed. The end of the run wins over a task change in
 * the same step.
 */
export const plainProgressLine = (
  runId: string,
  previous: PlainProgress | undefined,
  next: PlainProgress
): string | undefined => {
  if (next.ended !== undefined) {
    const { outcome, minutes, costUsd, branch, commits } = next.ended
    const count =
      commits === undefined ? "" : `, ${commits} ${commits === 1 ? "commit" : "commits"}`
    const where = branch === undefined ? "" : ` Branch ${branch}${count}.`
    return `${runId} ${outcome} in ${minutes} min, $${costUsd.toFixed(2)}.${where}`
  }
  if (next.tasksTotal === 0) return undefined
  if (previous === undefined) {
    return `${runId}: plan written, ${next.tasksTotal} ${next.tasksTotal === 1 ? "task" : "tasks"}`
  }
  if (previous.tasksDone === next.tasksDone && previous.tasksTotal === next.tasksTotal)
    return undefined
  return `${runId}: task ${next.tasksDone} of ${next.tasksTotal} done`
}
