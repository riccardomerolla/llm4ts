import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import { makeCostTracker } from "@llm4ts/flow/CostTracker"
import { Info, makeFlowEventHub, UsageProgress } from "@llm4ts/flow/FlowEvents"
import { makeFlowRecorder } from "@llm4ts/flow/FlowRecorder"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"

/**
 * The runner writes its cost summary only once every consumer reports
 * drained. These cover the two ways that used to never happen: a target no
 * consumer could reach, and an unbounded wait on it. The symptom was a run
 * whose stages all printed and ticked green with no summary ever following.
 */
describe("event drain", () => {
  it.live("gives up rather than spinning on a consumer that never catches up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* makeFlowEventHub()
        const tracker = yield* makeCostTracker()
        yield* tracker.consume(hub)
        yield* hub.consume("stuck", () => Effect.never)
        yield* hub.publish(Info.make({ message: "one" }))

        assert.isFalse(yield* tracker.awaitDrained(hub, "20 millis"))
      })
    )
  )

  it.live("records every event but display-only progress", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* makeFlowEventHub()
        const files = yield* makeMemoryPlainFileStore()
        const recorder = yield* makeFlowRecorder(files.store, "/trace.jsonl", "run-1")
        yield* recorder.consume(hub)
        yield* hub.publish(Info.make({ message: "one" }))
        yield* hub.publish(UsageProgress.make({ call: "c1", done: true }))
        yield* hub.publish(Info.make({ message: "two" }))

        assert.isTrue(yield* recorder.awaitDrained(hub, "2 seconds"))
        const trace = (yield* files.files)["/trace.jsonl"] ?? ""
        assert.include(trace, "one")
        assert.include(trace, "two")
        assert.notInclude(trace, "UsageProgress")
      })
    )
  )

  it.live("reports a drain that did catch up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* makeFlowEventHub()
        const tracker = yield* makeCostTracker()
        yield* tracker.consume(hub)
        yield* hub.publish(Info.make({ message: "one" }))

        assert.isTrue(yield* tracker.awaitDrained(hub, "2 seconds"))
      })
    )
  )

  // The root cause: the count is the drain's target, so an event that never
  // reached the PubSub must never be counted.
  it.live("does not count a publish interrupted before delivery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* makeFlowEventHub(1)
        yield* hub.subscribe
        yield* hub.publish(Info.make({ message: "fills the one slot" }))
        const blocked = yield* Effect.forkChild(
          hub.publish(Info.make({ message: "backpressured, never delivered" }))
        )
        yield* Effect.sleep("30 millis")
        yield* Fiber.interrupt(blocked)

        assert.strictEqual(yield* hub.publishedCount, 1)
      })
    )
  )
})

describe("hub consumers", () => {
  const info = (message: string) => Info.make({ message })

  it.live("hands every event to each consumer and reports a complete drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* makeFlowEventHub()
        const seen = yield* Ref.make<ReadonlyArray<string>>([])
        yield* hub.consume("list", (event) =>
          Ref.update(seen, (all) => [...all, event._tag === "Info" ? event.message : event._tag])
        )
        yield* Effect.forEach(["a", "b", "c"], (message) => hub.publish(info(message)))

        assert.deepStrictEqual(yield* hub.drained("2 seconds"), {
          complete: true,
          behind: [],
          late: []
        })
        assert.deepStrictEqual(yield* Ref.get(seen), ["a", "b", "c"])
      })
    )
  )

  it.live("names the consumer that did not catch up, and by how much", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* makeFlowEventHub()
        yield* hub.consume("fast", () => Effect.void)
        yield* hub.consume("stuck", () => Effect.never)
        yield* hub.publish(info("a"))
        yield* hub.publish(info("b"))

        assert.deepStrictEqual(yield* hub.drained("20 millis"), {
          complete: false,
          behind: [{ name: "stuck", missing: 2 }],
          late: []
        })
      })
    )
  )

  // The 3.2.5 defect: a consumer meant to see the whole run subscribed after
  // events were published, and the run waited out the drain for events that
  // consumer could never receive. Now it is named at once.
  it.live("names a late subscriber without waiting out the timeout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* makeFlowEventHub()
        yield* hub.publish(info("before anyone listened"))
        yield* hub.publish(info("still nobody"))
        yield* hub.consume("terminal", () => Effect.void)
        yield* hub.publish(info("seen"))

        const started = Date.now()
        const report = yield* hub.drained("5 seconds")
        assert.isBelow(Date.now() - started, 1000)
        assert.deepStrictEqual(report, {
          complete: false,
          behind: [],
          late: [{ name: "terminal", missed: 2 }]
        })
      })
    )
  )

  it.live("owes a consumer that joins from now only what follows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* makeFlowEventHub()
        const seen = yield* Ref.make(0)
        yield* hub.publish(info("before"))
        const tap = yield* hub.consume("tap", () => Ref.update(seen, (count) => count + 1), {
          from: "now"
        })
        yield* hub.publish(info("after"))

        assert.isTrue(yield* tap.caughtUp("2 seconds"))
        assert.strictEqual(yield* Ref.get(seen), 1)
        assert.deepStrictEqual(yield* hub.drained("2 seconds"), {
          complete: true,
          behind: [],
          late: []
        })
      })
    )
  )

  it.live("stops waiting on a consumer whose scope has closed", () =>
    Effect.gen(function* () {
      const hub = yield* makeFlowEventHub()
      yield* Effect.scoped(hub.consume("gone", () => Effect.never))
      yield* hub.publish(info("after it left"))

      assert.isTrue((yield* hub.drained("20 millis")).complete)
    })
  )

  it.live("counts no event twice when consumers register while events are published", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* makeFlowEventHub()
        const publishing = yield* Effect.forkChild(
          Effect.forEach(
            Array.from({ length: 200 }, (_, index) => index),
            (index) => hub.publish(info(index.toString())).pipe(Effect.andThen(Effect.yieldNow))
          )
        )
        const taps = yield* Effect.forEach(
          Array.from({ length: 20 }, (_, index) => index),
          (index) =>
            hub
              .consume(`tap-${index.toString()}`, () => Effect.void, { from: "now" })
              .pipe(Effect.andThen(Effect.yieldNow))
        )
        yield* Fiber.join(publishing)

        assert.strictEqual(taps.length, 20)
        assert.deepStrictEqual(yield* hub.drained("2 seconds"), {
          complete: true,
          behind: [],
          late: []
        })
      })
    )
  )
})
