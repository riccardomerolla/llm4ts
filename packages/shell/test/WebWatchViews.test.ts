import { assert, describe, it } from "@effect/vitest"
import { emptyTree, initialView, onTreeKey, type TreeView } from "@llm4ts/runner/AgentTree"
import {
  detailActionNamed,
  detailAfter,
  detailOnKey,
  executorOnKey,
  initialDetail,
  tailRoles,
  tailTargetOf,
  transcriptPath,
  type DetailState,
  progressOf,
  searchWithView,
  tasksIn,
  viewOfSearch,
  viewOnKey,
  type ViewKey
} from "../web-src/views.ts"
import type { WebTailRole } from "../src/WebFrame.ts"
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

describe("watch --web detail keys", () => {
  const tail = (role?: WebTailRole): DetailState => ({
    ...initialDetail,
    body: { _tag: "Tail", role }
  })

  it("expands on enter, tails on t, cycles the role on r, closes on escape, toggles the log on l", () => {
    const expanded = detailOnKey(initialDetail, press("Enter"))
    assert.deepStrictEqual(expanded?.body, { _tag: "Expanded" })
    assert.deepStrictEqual(detailOnKey(expanded ?? initialDetail, press("Enter"))?.body, {
      _tag: "Short"
    })
    const tailing = detailOnKey(expanded ?? initialDetail, press("t"))
    assert.deepStrictEqual(tailing?.body, { _tag: "Tail", role: undefined })
    assert.deepStrictEqual(detailOnKey(tail(), press("t"))?.body, { _tag: "Short" })
    assert.deepStrictEqual(detailOnKey(tail(), press("r"))?.body, { _tag: "Tail", role: "coder" })
    assert.deepStrictEqual(detailOnKey(tail(), press("Escape"))?.body, { _tag: "Short" })
    assert.deepStrictEqual(detailOnKey(expanded ?? initialDetail, press("Escape"))?.body, {
      _tag: "Short"
    })
    const full = detailOnKey(tail("judge"), press("l"))
    assert.deepStrictEqual(full, { body: { _tag: "Tail", role: "judge" }, fullLog: true })
    assert.strictEqual(detailOnKey(full ?? initialDetail, press("l"))?.fullLog, false)
  })

  it("leaves keys that are not the cards', r with no tail, modifiers, fields and buttons alone", () => {
    assert.isUndefined(detailOnKey(initialDetail, press("x")))
    assert.isUndefined(detailOnKey(initialDetail, press("r")))
    assert.isUndefined(detailOnKey(initialDetail, press("t", { metaKey: true })))
    assert.isUndefined(detailOnKey(initialDetail, press("l", { ctrlKey: true })))
    assert.isUndefined(detailOnKey(initialDetail, press("Enter", { altKey: true })))
    assert.isUndefined(detailOnKey(initialDetail, press("t", { target: { tagName: "INPUT" } })))
    assert.isUndefined(
      detailOnKey(initialDetail, press("l", { target: { isContentEditable: true } }))
    )
    assert.isUndefined(
      detailOnKey(initialDetail, press("Enter", { target: { tagName: "BUTTON" } }))
    )
    assert.isDefined(detailOnKey(initialDetail, press("t", { target: { tagName: "BUTTON" } })))
  })

  it("cycles the tail's role as the terminal tree's r does", () => {
    let page: DetailState = tail()
    let view: TreeView = { ...initialView, tail: true }
    const state = emptyTree({ title: "epic" })
    for (let press = 0; press < tailRoles.length + 1; press += 1) {
      page = detailAfter(page, "role")
      const next = onTreeKey(view, "r", state)
      view = next === "quit" ? view : next
      assert.strictEqual(page.body._tag === "Tail" ? page.body.role : "closed", view.tailRole)
    }
  })

  it("names the buttons' actions, and nothing else", () => {
    assert.strictEqual(detailActionNamed("fullLog"), "fullLog")
    assert.strictEqual(detailActionNamed("expand"), "expand")
    assert.isUndefined(detailActionNamed("delete"))
    assert.isUndefined(detailActionNamed(undefined))
  })

  it("tails the clicked executor in the executors view, else the story on the card", () => {
    assert.deepStrictEqual(tailTargetOf("flow", "payments", "claude"), {
      target: "payments",
      of: "story"
    })
    assert.deepStrictEqual(tailTargetOf("boards", "payments", undefined), {
      target: "payments",
      of: "story"
    })
    assert.deepStrictEqual(tailTargetOf("executors", "payments", "claude"), {
      target: "claude",
      of: "executor"
    })
    assert.isUndefined(tailTargetOf("executors", "payments", undefined))
    assert.isUndefined(tailTargetOf("flow", undefined, "claude"))
  })

  it("asks for a tail with its target encoded, its role and the replay's count", () => {
    assert.strictEqual(
      transcriptPath({ target: "a b/../c", of: "story" }, undefined, undefined),
      "/api/transcript?target=a+b%2F..%2Fc&of=story"
    )
    assert.strictEqual(
      transcriptPath({ target: "claude", of: "executor" }, "judge", 33),
      "/api/transcript?target=claude&of=executor&role=judge&count=33"
    )
  })
})

describe("watch --web executor keys", () => {
  const names = ["codex", "pi-lmstudio", "lemonade", "claude"]
  const arrows: ReadonlyArray<readonly [string, string]> = [
    ["ArrowDown", "down"],
    ["ArrowRight", "right"],
    ["ArrowUp", "up"],
    ["ArrowLeft", "left"]
  ]

  it("moves the selection as the terminal tree's executors view does, stopping at the ends", () => {
    const state = { ...emptyTree({ title: "run" }), executors: names }
    const walk = [
      "ArrowDown",
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowDown",
      "ArrowUp",
      "ArrowLeft",
      "ArrowLeft",
      "ArrowLeft",
      "ArrowUp"
    ]
    for (const start of [undefined, ...names]) {
      let page: string | undefined = start
      let tree: TreeView = { ...initialView, mode: "executors", selected: start }
      for (const key of walk) {
        page = executorOnKey(names, page, press(key))
        const moved = onTreeKey(tree, arrows.find(([web]) => web === key)?.[1] ?? "", state)
        assert.notStrictEqual(moved, "quit")
        tree = moved === "quit" ? tree : moved
        assert.strictEqual(page, tree.selected, `from ${start ?? "none"} after ${key}`)
      }
    }
  })

  it("picks the first executor on any arrow when none is selected", () => {
    for (const [key] of arrows) {
      assert.strictEqual(executorOnKey(names, undefined, press(key)), "codex")
    }
    assert.strictEqual(executorOnKey(names, "gone", press("ArrowUp")), "codex")
  })

  it("leaves other keys, modifiers, fields and an empty roster alone", () => {
    assert.isUndefined(executorOnKey(names, "codex", press("e")))
    assert.isUndefined(executorOnKey(names, "codex", press("ArrowDown", { altKey: true })))
    assert.isUndefined(executorOnKey(names, "codex", press("ArrowDown", { metaKey: true })))
    assert.isUndefined(
      executorOnKey(names, "codex", press("ArrowDown", { target: { tagName: "INPUT" } }))
    )
    assert.isUndefined(executorOnKey([], undefined, press("ArrowDown")))
  })
})
