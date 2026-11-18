import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import {
  ChatRequest,
  ChatState,
  chatDir,
  loadRequests,
  loadState,
  notePosted,
  postedLimit,
  putRequest,
  saveState
} from "@llm4ts/shell/ChatState"

const state = ChatState.make({
  space: "spaces/AAA",
  trigger: "/bot",
  marker: "🌙 chief:",
  cursor: "2026-11-18T10:00:00Z",
  posted: ["spaces/AAA/messages/1"],
  ownerId: "users/1",
  baseBranch: "main"
})

const request = (over: Partial<ConstructorParameters<typeof ChatRequest>[0]> = {}) =>
  ChatRequest.make({
    messageName: "spaces/AAA/messages/1",
    createTime: "2026-11-18T10:00:00Z",
    sender: "users/1",
    text: "/bot implement x",
    status: "received",
    ...over
  })

describe("ChatState", () => {
  it("builds the directory from the bare space id", () => {
    assert.strictEqual(chatDir("/r", "AAA"), "/r/.llm4ts/chat/AAA")
  })

  it.effect("round trips state", () =>
    Effect.gen(function* () {
      const { store } = yield* makeMemoryPlainFileStore()
      assert.strictEqual(yield* loadState(store, "/d"), undefined)
      yield* saveState(store, "/d", state)
      assert.deepStrictEqual(yield* loadState(store, "/d"), state)
    })
  )

  it.effect("a corrupt state file is a PersistenceError naming the path", () =>
    Effect.gen(function* () {
      const { store } = yield* makeMemoryPlainFileStore({ "/d/state.md": "# nope\n" })
      const exit = yield* Effect.exit(loadState(store, "/d"))
      assert.isTrue(Exit.isFailure(exit))
      const text = String(exit)
      assert.include(text, "Persistence")
      assert.include(text, "/d/state.md")
    })
  )

  it("notePosted keeps the newest 500 of 501", () => {
    const names = Array.from({ length: postedLimit }, (_, i) => `m${i}`)
    const next = notePosted(ChatState.make({ ...state, posted: names }), "new")
    assert.strictEqual(next.posted.length, postedLimit)
    assert.strictEqual(next.posted[0], "m1")
    assert.strictEqual(next.posted[postedLimit - 1], "new")
  })

  it.effect("putRequest replaces by messageName and keeps others", () =>
    Effect.gen(function* () {
      const { store } = yield* makeMemoryPlainFileStore()
      yield* putRequest(store, "/d", request())
      yield* putRequest(store, "/d", request({ messageName: "spaces/AAA/messages/2" }))
      yield* putRequest(store, "/d", request({ status: "answered", reply: "ok" }))
      const all = yield* loadRequests(store, "/d")
      assert.strictEqual(all.length, 2)
      assert.strictEqual(all[0]?.status, "answered")
      assert.strictEqual(all[0]?.reply, "ok")
      assert.strictEqual(all[1]?.messageName, "spaces/AAA/messages/2")
    })
  )

  it.effect("request text with a fence and ### survives", () =>
    Effect.gen(function* () {
      const { store } = yield* makeMemoryPlainFileStore()
      const text = '/bot go\n### not a heading\n```json\n{"a":1}\n```\nend'
      yield* putRequest(store, "/d", request({ text }))
      yield* putRequest(store, "/d", request({ messageName: "spaces/AAA/messages/2", text }))
      const all = yield* loadRequests(store, "/d")
      assert.strictEqual(all.length, 2)
      assert.strictEqual(all[0]?.text, text)
    })
  )

  it.effect("no requests file is an empty list", () =>
    Effect.gen(function* () {
      const { store } = yield* makeMemoryPlainFileStore()
      assert.deepStrictEqual(yield* loadRequests(store, "/d"), [])
    })
  )
})
