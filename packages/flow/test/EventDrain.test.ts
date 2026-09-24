import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { makeCostTracker } from "@llm4ts/flow/CostTracker"
import {
  awaitConsumed,
  Info,
  makeFlowEventHub,
  type FlowEventHub,
  UsageProgress
} from "@llm4ts/flow/FlowEvents"
import { makeFlowRecorder } from "@llm4ts/flow/FlowRecorder"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"

/**
 * The runner writes its cost summary only once every consumer reports
 * drained. These cover the two ways that used to never happen: a target no
 * consumer could reach, and an unbounded wait on it. The symptom was a run
 * whose stages all printed and ticked green with no summary ever following.
 */
describe("event drain", () => {
  const unreachable = (hub: FlowEventHub): FlowEventHub => ({
    ...hub,
    publishedCount: Effect.succeed(1)
  })

  it.live("gives up rather than spinning on a target that can never be reached", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* makeFlowEventHub()
        const tracker = yield* makeCostTracker()
        yield* tracker.consume(hub)

        assert.isFalse(yield* tracker.awaitDrained(unreachable(hub), "20 millis"))
      })
    )
  )

  it.live("bounds the recorder's drain the same way", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* makeFlowEventHub()
        const files = yield* makeMemoryPlainFileStore()
        const recorder = yield* makeFlowRecorder(files.store, "/trace.jsonl", "run-1")
        yield* recorder.consume(hub)

        assert.isFalse(yield* recorder.awaitDrained(unreachable(hub), "20 millis"))
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

  it.live("counts every event a subscribed consumer will actually see", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* makeFlowEventHub()
        const consumed = yield* Ref.make(0)
        yield* tap(hub, consumed)
        yield* Effect.forEach([1, 2, 3], (n) =>
          hub.publish(Info.make({ message: `event ${n.toString()}` }))
        )

        assert.strictEqual(yield* hub.publishedCount, 3)
        assert.isTrue(yield* awaitConsumed(hub, consumed, "2 seconds"))
        assert.strictEqual(yield* Ref.get(consumed), 3)
      })
    )
  )
})

/** Counts events the way the real consumers do, off a live subscription. */
const tap = (hub: FlowEventHub, consumed: Ref.Ref<number>) =>
  Effect.gen(function* () {
    const subscription = yield* hub.subscribe
    yield* Stream.fromSubscription(subscription).pipe(
      Stream.runForEach(() => Ref.update(consumed, (count) => count + 1)),
      Effect.forkScoped,
      Effect.asVoid
    )
  })
