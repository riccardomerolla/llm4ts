import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  controlLogPath,
  decideControl,
  makeMemoryControlInbox,
  readControlLog,
  RetryStory,
  SkipStory,
  type ControlState
} from "@llm4ts/flow/Control"
import { Story, StoryPlan } from "@llm4ts/flow/StoryPlan"

const story = (id: string, dependsOn: ReadonlyArray<string> = []): Story =>
  Story.make({
    id,
    title: `Story ${id}`,
    description: `Implement ${id}.`,
    dependsOn,
    owned: [`src/features/${id}`],
    sharedReadOnly: [],
    provides: []
  })

// a and b independent, c needs a, d needs b and c.
const plan = StoryPlan.make({
  epicId: "diamond",
  epic: "A diamond of four stories.",
  stories: [story("a"), story("b"), story("c", ["a"]), story("d", ["b", "c"])]
})

const state = (given: {
  readonly done?: ReadonlyArray<string>
  readonly failed?: ReadonlyArray<string>
  readonly skipped?: ReadonlyArray<string>
  readonly running?: ReadonlyArray<string>
  readonly waiting?: Readonly<Record<string, string>>
  readonly halted?: string
}): ControlState => ({
  done: new Set(given.done ?? []),
  failed: new Set(given.failed ?? []),
  skipped: new Set(given.skipped ?? []),
  running: new Set(given.running ?? []),
  waiting: new Map(Object.entries(given.waiting ?? {})),
  ...(given.halted === undefined ? {} : { halted: given.halted })
})

const retry = (id: string) => RetryStory.make({ story: id })
const skip = (id: string) => SkipStory.make({ story: id, reason: "not this week" })

describe("decideControl", () => {
  it("retries a failed story and releases the dependents held behind it", () => {
    const failed = state({
      failed: ["a"],
      running: ["b"],
      waiting: { c: "waiting for a", d: "waiting for a" }
    })
    assert.deepStrictEqual(decideControl(plan, failed, retry("a")), {
      _tag: "Retry",
      story: "a",
      release: ["c", "d"]
    })
    // A dependent held behind another story stays held.
    const two = state({ failed: ["a", "b"], waiting: { c: "waiting for a", d: "waiting for b" } })
    assert.deepStrictEqual(decideControl(plan, two, retry("a")), {
      _tag: "Retry",
      story: "a",
      release: ["c"]
    })
  })

  it("refuses a retry of a story that is running, done, unknown or not failed", () => {
    const current = state({ done: ["b"], running: ["a"], skipped: ["c"] })
    const reasonOf = (id: string) => {
      const decision = decideControl(plan, current, retry(id))
      return decision._tag === "Refused" ? decision.reason : decision._tag
    }
    assert.strictEqual(reasonOf("a"), "story a is running")
    assert.strictEqual(reasonOf("b"), "story b is done")
    assert.strictEqual(reasonOf("c"), "story c did not fail in this run")
    assert.strictEqual(reasonOf("d"), "story d did not fail in this run")
    assert.strictEqual(reasonOf("zz"), "'zz' is not a story of epic diamond")
    assert.deepStrictEqual(
      decideControl(
        plan,
        state({ failed: ["a"], halted: "the serving engine is down" }),
        retry("a")
      ),
      {
        _tag: "Refused",
        reason: "the run launches no further story: the serving engine is down"
      }
    )
  })

  it("skips any story that is not done, interrupting one that runs", () => {
    const current = state({ done: ["a"], running: ["b"], failed: ["c"], skipped: ["d"] })
    assert.deepStrictEqual(decideControl(plan, current, skip("b")), {
      _tag: "Skip",
      story: "b",
      reason: "not this week",
      interrupt: true
    })
    assert.deepStrictEqual(decideControl(plan, current, skip("c")), {
      _tag: "Skip",
      story: "c",
      reason: "not this week",
      interrupt: false
    })
    assert.deepStrictEqual(decideControl(plan, current, skip("a")), {
      _tag: "Refused",
      reason: "story a is done"
    })
    assert.deepStrictEqual(decideControl(plan, current, skip("d")), {
      _tag: "Refused",
      reason: "story d is already skipped"
    })
  })
})

describe("ControlInbox", () => {
  it.effect("a command is pending until it has a receipt, and an id is written once", () =>
    Effect.gen(function* () {
      const { inbox, files } = yield* makeMemoryControlInbox("/state/control/app-0a1b2c3d")
      const first = yield* inbox.submit("diamond", { by: "cli", command: retry("a") })
      const again = yield* inbox.submit("diamond", { id: first.id, by: "mcp", command: skip("b") })
      assert.deepStrictEqual(again, first)
      const second = yield* inbox.submit("diamond", { id: "req-7", by: "mcp", command: skip("b") })
      assert.deepStrictEqual(
        (yield* inbox.pending("diamond")).map((command) => command.id),
        ["c-1", "req-7"]
      )
      yield* inbox.receipt("diamond", {
        id: first.id,
        runId: "run-1",
        outcome: "refused",
        reason: "story a is running"
      })
      assert.deepStrictEqual(yield* inbox.pending("diamond"), [second])
      const log = yield* inbox.log("diamond")
      assert.strictEqual(log.commands.length, 2)
      assert.strictEqual(log.receipts.get("c-1")?.reason, "story a is running")
      // One file per epic, one line per command or receipt; another epic's is its own.
      const path = controlLogPath("/state/control/app-0a1b2c3d", "diamond")
      assert.strictEqual(path, "/state/control/app-0a1b2c3d/diamond.jsonl")
      assert.strictEqual(((yield* files)[path] ?? "").trim().split("\n").length, 3)
      assert.deepStrictEqual(yield* inbox.pending("other"), [])
    })
  )

  it("skips a torn line and keeps the first command of an id", () => {
    const line = (id: string, by: string) =>
      JSON.stringify({
        _tag: "ControlCommand",
        schemaVersion: 1,
        id,
        at: 1,
        by,
        command: { _tag: "RetryStory", story: "a" }
      })
    const log = readControlLog(
      [line("c-1", "cli"), '{"_tag":"ControlComm', line("c-1", "mcp"), line("c-2", "cli")].join(
        "\n"
      )
    )
    assert.deepStrictEqual(
      log.commands.map((command) => [command.id, command.by]),
      [
        ["c-1", "cli"],
        ["c-2", "cli"]
      ]
    )
    assert.strictEqual(readControlLog(undefined).commands.length, 0)
  })
})
