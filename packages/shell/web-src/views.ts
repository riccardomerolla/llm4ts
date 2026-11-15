import type { WebChipStatus, WebStory, WebTask } from "../src/WebFrame.ts"

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

const viewKeys: Readonly<Record<string, PageView>> = { e: "executors", b: "boards" }

/**
 * The view after a key, as `onTreeKey` toggles `e` and `b`: pressing the
 * shown one returns to the graph. Undefined when the key is not the page's
 * (another key, a modifier held, or focus in a field).
 */
export const viewOnKey = (view: PageView, key: ViewKey): PageView | undefined => {
  const asked = viewKeys[key.key]
  if (asked === undefined || key.ctrlKey || key.metaKey || key.altKey || typing(key.target)) {
    return undefined
  }
  return asked === view ? "flow" : asked
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
