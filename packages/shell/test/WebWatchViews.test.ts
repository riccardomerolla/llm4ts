import { assert, describe, it } from "@effect/vitest"
import {
  progressOf,
  searchWithView,
  tasksIn,
  viewOfSearch,
  viewOnKey,
  type ViewKey
} from "../web-src/views.ts"
import { clonesFrame } from "./WebWatchFixture.ts"

const press = (key: string, more: Partial<ViewKey> = {}): ViewKey => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  target: { tagName: "BODY" },
  ...more
})

describe("watch --web views", () => {
  it("reads the view from ?view=, and anything else is the graph", () => {
    assert.strictEqual(viewOfSearch("?view=executors"), "executors")
    assert.strictEqual(viewOfSearch("?seq=33&view=boards&freeze"), "boards")
    assert.strictEqual(viewOfSearch("?view=lanes"), "flow")
    assert.strictEqual(viewOfSearch(""), "flow")
  })

  it("writes the view into the query, keeping ?seq and ?freeze, and drops it for the graph", () => {
    assert.strictEqual(searchWithView("?seq=33&freeze", "boards"), "?seq=33&freeze=&view=boards")
    assert.strictEqual(searchWithView("?view=boards", "executors"), "?view=executors")
    assert.strictEqual(searchWithView("?seq=33&view=boards", "flow"), "?seq=33")
    assert.strictEqual(searchWithView("?view=boards", "flow"), "")
  })

  it("toggles e and b as the terminal tree does: the shown one goes back to the graph", () => {
    assert.strictEqual(viewOnKey("flow", press("e")), "executors")
    assert.strictEqual(viewOnKey("executors", press("e")), "flow")
    assert.strictEqual(viewOnKey("executors", press("b")), "boards")
    assert.strictEqual(viewOnKey("boards", press("b")), "flow")
    assert.isUndefined(viewOnKey("flow", press("l")))
  })

  it("leaves e and b alone while typing in a field or with a modifier held", () => {
    assert.isUndefined(viewOnKey("flow", press("e", { target: { tagName: "INPUT" } })))
    assert.isUndefined(viewOnKey("flow", press("b", { target: { tagName: "textarea" } })))
    assert.isUndefined(
      viewOnKey("flow", press("e", { target: { tagName: "DIV", isContentEditable: true } }))
    )
    assert.isUndefined(viewOnKey("flow", press("b", { metaKey: true })))
    assert.isUndefined(viewOnKey("flow", press("e", { ctrlKey: true })))
    assert.strictEqual(viewOnKey("flow", press("b", { target: null })), "boards")
  })

  it("splits a story's tasks into the board's columns, review empty, with its progress", () => {
    const s01 = clonesFrame().stories.find((story) => story.id === "S01")
    assert.isDefined(s01)
    if (s01 === undefined) {
      return
    }
    assert.deepStrictEqual(
      (["todo", "doing", "review", "done"] as const).map((column) =>
        tasksIn(s01, column).map((task) => task.index)
      ),
      [[4, 5], [3], [], [1, 2]]
    )
    assert.deepStrictEqual(progressOf(s01), { done: 2, total: 5 })
  })
})
