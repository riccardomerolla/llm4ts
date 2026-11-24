import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeMemoryControlInbox } from "@llm4ts/flow/Control"
import {
  epicFor,
  epicsOf,
  inboxListing,
  renderInboxListing,
  retryOf,
  skipOf
} from "@llm4ts/shell/Inbox"

describe("llm4ts inbox", () => {
  it.effect("lists what is pending and what was answered, newest first", () =>
    Effect.gen(function* () {
      const { inbox } = yield* makeMemoryControlInbox()
      const first = yield* inbox.submit("conto", { by: "cli", command: retryOf("home") })
      yield* inbox.submit("conto", { by: "cli", command: skipOf("list", "not this week") })
      yield* inbox.receipt("conto", {
        id: first.id,
        runId: "run-1",
        outcome: "refused",
        reason: "story home is running"
      })
      const listing = yield* inboxListing(inbox, "conto")
      assert.strictEqual(listing.pending.length, 1)
      assert.strictEqual(listing.answered.length, 1)
      const text = renderInboxListing(listing)
      assert.include(text, "epic conto")
      assert.match(text, /skip list \(not this week\) — pending {2}\[c-2, by cli\]/)
      assert.match(text, /retry home — refused: story home is running {2}\[c-1, by cli\]/)
      assert.include(
        renderInboxListing(yield* inboxListing(inbox, "other")),
        "epic other\npending: none"
      )
    })
  )

  it.effect("takes the only epic, and asks for --epic when there are several", () =>
    Effect.gen(function* () {
      const listEpics = (directory: string) =>
        directory === "/repo/.llm4ts/epics" ? ["conto", "bonifici"] : []
      assert.deepStrictEqual(epicsOf(listEpics, "/repo"), ["conto", "bonifici"])
      assert.strictEqual(yield* epicFor(["conto"], undefined), "conto")
      assert.strictEqual(yield* epicFor(["conto", "bonifici"], "bonifici"), "bonifici")
      const several = yield* Effect.flip(epicFor(["conto", "bonifici"], undefined))
      assert.strictEqual(several.message, "--epic is needed: this repository has conto, bonifici")
      const unknown = yield* Effect.flip(epicFor(["conto"], "../x"))
      assert.strictEqual(unknown.message, "unknown epic '../x'; this repository has conto")
      const none = yield* Effect.flip(epicFor([], undefined))
      assert.strictEqual(none.message, "this repository has no epic under .llm4ts/epics/")
    })
  )
})
