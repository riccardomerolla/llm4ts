import type {
  WebChipStatus,
  WebStory,
  WebTailOf,
  WebTailRole,
  WebTask,
  WebTimelineItem
} from "../src/WebFrame.ts"

/**
 * What the flow card shows (ADR 0051), as the terminal tree's `TreeMode`
 * (ADR 0033): the graph, one card per executor, or the boards. Pure, so the
 * URL and key rules are tested without a DOM.
 */
export type PageView = "flow" | "executors" | "boards"

const views: ReadonlyArray<PageView> = ["flow", "executors", "boards"]

/** A view by name; anything else is the graph. */
export const viewNamed = (name: string | null | undefined): PageView =>
  views.find((view) => view === name) ?? "flow"

/** `?view=executors|boards`. */
export const viewOfSearch = (search: string): PageView =>
  viewNamed(new URLSearchParams(search).get("view"))

/** The query string with the view in it, the other parameters kept; the graph needs none. */
export const searchWithView = (search: string, view: PageView): string => {
  const params = new URLSearchParams(search)
  if (view === "flow") {
    params.delete("view")
  } else {
    params.set("view", view)
  }
  const query = params.toString()
  return query === "" ? "" : `?${query}`
}

/** What a key press asks of the page: only the parts a keydown handler reads. */
export interface ViewKey {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly target: { readonly tagName?: string; readonly isContentEditable?: boolean } | null
}

const typing = (target: ViewKey["target"]): boolean =>
  target !== null &&
  (target.isContentEditable === true ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName?.toUpperCase() ?? ""))

/** A plain key press the page may take: no modifier held, no field focused. */
const plain = (key: ViewKey): boolean =>
  !key.ctrlKey && !key.metaKey && !key.altKey && !typing(key.target)

const viewKeys: Readonly<Record<string, PageView>> = { e: "executors", b: "boards" }

/**
 * The view after a key, as `onTreeKey` toggles `e` and `b`: pressing the
 * shown one returns to the graph. Undefined when the key is not the page's
 * (another key, a modifier held, or focus in a field).
 */
export const viewOnKey = (view: PageView, key: ViewKey): PageView | undefined => {
  const asked = viewKeys[key.key]
  if (asked === undefined || !plain(key)) {
    return undefined
  }
  return asked === view ? "flow" : asked
}

// ── the detail and events cards ──

/**
 * What the detail card's body shows, as the terminal tree's `expanded` and
 * `tail` (ADR 0022, 0033): the short detail, every stage and the last tools,
 * or the selection's transcript in one role (all when unset).
 */
export type DetailBody =
  | { readonly _tag: "Short" }
  | { readonly _tag: "Expanded" }
  | { readonly _tag: "Tail"; readonly role: WebTailRole | undefined }

export interface DetailState {
  readonly body: DetailBody
  /** The events card shows the whole log, not the latest items. */
  readonly fullLog: boolean
}

export const initialDetail: DetailState = { body: { _tag: "Short" }, fullLog: false }

/** The roles `r` cycles through, as `onTreeKey` does: all, coder, reviewer, judge. */
export const tailRoles: ReadonlyArray<WebTailRole | undefined> = [
  undefined,
  "coder",
  "reviewer",
  "judge"
]

const nextRole = (role: WebTailRole | undefined): WebTailRole | undefined =>
  tailRoles[(tailRoles.indexOf(role) + 1) % tailRoles.length]

export type DetailAction = "expand" | "tail" | "role" | "close" | "fullLog"

/** What a detail or events button, or its key, does to the cards. */
export const detailAfter = (state: DetailState, action: DetailAction): DetailState => {
  const { body } = state
  switch (action) {
    case "expand":
      return { ...state, body: { _tag: body._tag === "Expanded" ? "Short" : "Expanded" } }
    case "tail":
      return {
        ...state,
        body: body._tag === "Tail" ? { _tag: "Short" } : { _tag: "Tail", role: undefined }
      }
    case "role":
      return body._tag === "Tail"
        ? { ...state, body: { _tag: "Tail", role: nextRole(body.role) } }
        : state
    case "close":
      return { ...state, body: { _tag: "Short" } }
    case "fullLog":
      return { ...state, fullLog: !state.fullLog }
  }
}

const detailActions: ReadonlyArray<DetailAction> = ["expand", "tail", "role", "close", "fullLog"]

/** A card button's `data-card-act`; anything else is no action. */
export const detailActionNamed = (name: string | undefined): DetailAction | undefined =>
  detailActions.find((action) => action === name)

const detailKeys: Readonly<Record<string, DetailAction>> = {
  Enter: "expand",
  t: "tail",
  r: "role",
  Escape: "close",
  l: "fullLog"
}

/**
 * The cards after a key, as `onTreeKey` reads enter, `t`, `r`, escape and
 * `l`; undefined when the key is not one of them, or `r` with no tail open,
 * or a modifier is held or a field has focus.
 */
export const detailOnKey = (state: DetailState, key: ViewKey): DetailState | undefined => {
  const action = detailKeys[key.key]
  // Enter on a focused button presses that button, not the card's.
  const pressing =
    action === "expand" && ["BUTTON", "A"].includes(key.target?.tagName?.toUpperCase() ?? "")
  if (
    action === undefined ||
    !plain(key) ||
    pressing ||
    (action === "role" && state.body._tag !== "Tail")
  ) {
    return undefined
  }
  return detailAfter(state, action)
}

/** Whose transcript the tail shows: the clicked executor in the executors view, else the story on the detail card. */
export const tailTargetOf = (
  view: PageView,
  story: string | undefined,
  executor: string | undefined
): { readonly target: string; readonly of: WebTailOf } | undefined => {
  const target = view === "executors" ? executor : story
  return target === undefined
    ? undefined
    : { target, of: view === "executors" ? "executor" : "story" }
}

/** `/api/transcript?…` for a target, a role and, in a replay, the steps on screen. */
export const transcriptPath = (
  tail: { readonly target: string; readonly of: WebTailOf },
  role: WebTailRole | undefined,
  count: number | undefined
): string => {
  const params = new URLSearchParams({ target: tail.target, of: tail.of })
  if (role !== undefined) {
    params.set("role", role)
  }
  if (count !== undefined) {
    params.set("count", String(count))
  }
  return `/api/transcript?${params.toString()}`
}

/**
 * The whole timeline up to a frame: what the page holds, with the frame's
 * latest items laid over its tail. A frame carries the last items of
 * `count` in all; undefined when they do not reach what the page holds (a
 * gap, so the page asks the run for its timeline again).
 */
export const timelineWith = (
  known: ReadonlyArray<WebTimelineItem>,
  latest: ReadonlyArray<WebTimelineItem>,
  count: number
): ReadonlyArray<WebTimelineItem> | undefined => {
  const from = count - latest.length
  return known.length < from ? undefined : [...known.slice(0, from), ...latest]
}

/** The epic board's columns, in the terminal's order. */
export const epicColumns: ReadonlyArray<WebChipStatus> = [
  "planned",
  "running",
  "waiting",
  "done",
  "failed"
]

export type StoryColumn = WebTask["column"] | "review"

/** The story board's columns; review stays empty until the task loop reports one. */
export const storyColumns: ReadonlyArray<StoryColumn> = ["todo", "doing", "review", "done"]

export const tasksIn = (story: WebStory, column: StoryColumn): ReadonlyArray<WebTask> =>
  story.tasks.filter((task) => task.column === column)

/** `2/5`: a story's done tasks of its plan. */
export const progressOf = (story: WebStory): { readonly done: number; readonly total: number } => ({
  done: tasksIn(story, "done").length,
  total: story.tasks.length
})
