import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import { replayGap } from "../src/Watch.ts"
import { WebFrameJson, type WebFrame } from "../src/WebFrame.ts"
import { PageError, sseFrames, type EventSourceLike, type FrameSource } from "../web-src/frames.ts"
import {
  countAtSeq,
  countAtTime,
  makeReplayController,
  type ReplayState
} from "../web-src/replay.ts"
import { frameAfter, steps } from "./WebWatchFixture.ts"

/**
 * The page's data side (ADR 0051) without a browser: the replay controller
 * over a fake frame source on the TestClock, and the server-sent frames
 * decoded through the shared schema.
 */

const runSteps = steps.map((step) => ({ seq: step.seq, at: step.at }))

/** Frames as the server makes them, each after its replay gap; records every stream it opens. */
const makeFakeSource = Effect.fn("test/makeFakeSource")(function* (
  options: { readonly failAt?: number } = {}
) {
  const opened = yield* Ref.make<ReadonlyArray<{ readonly count: number; readonly speed: number }>>(
    []
  )
  const closed = yield* Ref.make(0)
  const source: FrameSource = {
    run: Effect.die("not asked"),
    frame: (count) => Effect.succeed(frameAfter(count ?? steps.length)),
    stream: (replay) => {
      const from = replay?.count ?? steps.length
      const speed = replay?.speed ?? 10
      const later = Stream.fromIterable(runSteps.slice(from).map((_, index) => from + index + 1))
      return Stream.unwrap(
        Effect.as(
          Ref.update(opened, (all) => [...all, { count: from, speed }]),
          Stream.make(from)
        )
      ).pipe(
        Stream.concat(
          Stream.mapEffect(later, (count) =>
            count === options.failAt
              ? Effect.fail(new PageError({ message: "a frame did not decode: at seq 33" }))
              : Effect.as(
                  Effect.sleep(
                    Duration.millis(
                      replayGap(runSteps[count - 2]?.at ?? 0, runSteps[count - 1]?.at ?? 0, speed)
                    )
                  ),
                  count
                )
          )
        ),
        Stream.map((count) => frameAfter(count)),
        Stream.ensuring(Ref.update(closed, (n) => n + 1))
      )
    }
  }
  return { source, opened, closed }
})

const makeRecorder = Effect.fn("test/makeRecorder")(function* () {
  const drawn = yield* Ref.make<
    ReadonlyArray<{ readonly seq: number | undefined; readonly animate: boolean }>
  >([])
  const chrome = yield* Ref.make<ReadonlyArray<ReplayState>>([])
  const failures = yield* Ref.make<ReadonlyArray<string>>([])
  const view = {
    draw: (frame: WebFrame, animate: boolean) =>
      Effect.runSync(Ref.update(drawn, (all) => [...all, { seq: frame.seq, animate }])),
    chrome: (state: ReplayState) => Effect.runSync(Ref.update(chrome, (all) => [...all, state])),
    failed: (error: PageError) =>
      Effect.runSync(Ref.update(failures, (all) => [...all, error.message]))
  }
  return { view, drawn, chrome, failures }
})

/** Lets the fibers a command forked run up to their first wait. */
const settle = TestClock.adjust(Duration.zero)

/** Long enough for any replay of the fixture at ×10. */
const wholeRun = Duration.minutes(10)

describe("watch --web replay controller", () => {
  it.effect("plays to the last step and pauses there by itself", () =>
    Effect.gen(function* () {
      const { source, closed } = yield* makeFakeSource()
      const { view, drawn } = yield* makeRecorder()
      const controller = yield* makeReplayController(
        source,
        { steps: steps.length, count: 46, speed: 10 },
        view
      )
      yield* controller.play
      assert.isTrue((yield* controller.state).playing)
      yield* TestClock.adjust(wholeRun)
      const state = yield* controller.state
      assert.deepStrictEqual(state, { count: 50, steps: 50, speed: 10, playing: false })
      assert.deepStrictEqual(
        (yield* Ref.get(drawn)).map((frame) => [frame.seq, frame.animate]),
        [
          [46, false],
          [47, true],
          [48, true],
          [49, true],
          [50, true]
        ]
      )
      assert.strictEqual(yield* Ref.get(closed), 1)
    })
  )

  it.effect("plays again from the first step once it stands at the last", () =>
    Effect.gen(function* () {
      const { source, opened } = yield* makeFakeSource()
      const { view } = yield* makeRecorder()
      const controller = yield* makeReplayController(
        source,
        { steps: steps.length, count: 50, speed: 50 },
        view
      )
      yield* controller.play
      yield* settle
      assert.deepStrictEqual(yield* Ref.get(opened), [{ count: 1, speed: 50 }])
    })
  )

  it.effect("waits each step's gap: nothing moves before it, the frame lands after it", () =>
    Effect.gen(function* () {
      const { source } = yield* makeFakeSource()
      const { view } = yield* makeRecorder()
      const controller = yield* makeReplayController(
        source,
        { steps: steps.length, count: 1, speed: 10 },
        view
      )
      yield* controller.play
      yield* settle
      const gap = replayGap(runSteps[0]?.at ?? 0, runSteps[1]?.at ?? 0, 10)
      assert.isAbove(gap, 0)
      yield* TestClock.adjust(Duration.millis(gap - 1))
      assert.strictEqual((yield* controller.state).count, 1)
      yield* TestClock.adjust(Duration.millis(1))
      assert.isAbove((yield* controller.state).count, 1)
    })
  )

  it.effect("pauses: the stream closes and no frame lands after it", () =>
    Effect.gen(function* () {
      const { source, closed } = yield* makeFakeSource()
      const { view, drawn } = yield* makeRecorder()
      const controller = yield* makeReplayController(
        source,
        { steps: steps.length, count: 1, speed: 10 },
        view
      )
      yield* controller.play
      yield* TestClock.adjust(Duration.seconds(1))
      yield* controller.pause
      const seen = (yield* Ref.get(drawn)).length
      const at = (yield* controller.state).count
      yield* TestClock.adjust(wholeRun)
      assert.strictEqual((yield* Ref.get(drawn)).length, seen)
      assert.deepStrictEqual(yield* controller.state, {
        count: at,
        steps: 50,
        speed: 10,
        playing: false
      })
      assert.strictEqual(yield* Ref.get(closed), 1)
    })
  )

  it.effect("steps one frame at a time, and stops at either end", () =>
    Effect.gen(function* () {
      const { source } = yield* makeFakeSource()
      const { view, drawn } = yield* makeRecorder()
      const controller = yield* makeReplayController(
        source,
        { steps: steps.length, count: 1, speed: 10 },
        view
      )
      yield* controller.step(-1)
      assert.strictEqual((yield* controller.state).count, 1)
      yield* controller.step(1)
      yield* controller.step(1)
      assert.strictEqual((yield* controller.state).count, 3)
      yield* controller.step(-1)
      assert.strictEqual((yield* controller.state).count, 2)
      yield* controller.seek(50, false)
      yield* controller.step(1)
      assert.strictEqual((yield* controller.state).count, 50)
      assert.deepStrictEqual(
        (yield* Ref.get(drawn)).map((frame) => [frame.seq, frame.animate]),
        [1, 2, 3, 2, 50, 50].map((count, index) => [runSteps[count - 1]?.seq, index !== 4])
      )
    })
  )

  it.effect("a new speed while playing goes on from the same step at that speed", () =>
    Effect.gen(function* () {
      const { source, opened, closed } = yield* makeFakeSource()
      const { view, chrome } = yield* makeRecorder()
      const controller = yield* makeReplayController(
        source,
        { steps: steps.length, count: 1, speed: 10 },
        view
      )
      yield* controller.play
      yield* TestClock.adjust(Duration.seconds(2))
      const at = (yield* controller.state).count
      assert.isAbove(at, 1)
      yield* controller.setSpeed(50)
      yield* settle
      assert.deepStrictEqual(yield* Ref.get(opened), [
        { count: 1, speed: 10 },
        { count: at, speed: 50 }
      ])
      assert.strictEqual(yield* Ref.get(closed), 1)
      assert.deepStrictEqual((yield* Ref.get(chrome)).at(-1), {
        count: at,
        steps: 50,
        speed: 50,
        playing: true
      })
      yield* controller.pause
      yield* controller.setSpeed(1)
      assert.deepStrictEqual(yield* controller.state, {
        count: at,
        steps: 50,
        speed: 1,
        playing: false
      })
      assert.strictEqual((yield* Ref.get(opened)).length, 2)
    })
  )

  it.effect("a click on the scrubber pauses and lands on the step at that time", () =>
    Effect.gen(function* () {
      const { source } = yield* makeFakeSource()
      const { view, drawn } = yield* makeRecorder()
      const controller = yield* makeReplayController(
        source,
        { steps: steps.length, count: 1, speed: 10 },
        view
      )
      yield* controller.play
      const at = (runSteps[29]?.at ?? 0) + 1
      const count = countAtTime(runSteps, at)
      assert.strictEqual(count, 30)
      yield* controller.seek(count, true)
      assert.deepStrictEqual(yield* controller.state, {
        count: 30,
        steps: 50,
        speed: 10,
        playing: false
      })
      assert.strictEqual((yield* Ref.get(drawn)).at(-1)?.seq, runSteps[29]?.seq)
      assert.strictEqual(countAtTime(runSteps, 0), 1)
    })
  )

  it.effect("?seq=33 opens on the iban failure", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<WebFrame | undefined>(undefined)
      const { source } = yield* makeFakeSource()
      const { view } = yield* makeRecorder()
      const controller = yield* makeReplayController(
        source,
        { steps: steps.length, count: countAtSeq(runSteps, 33), speed: 10 },
        {
          ...view,
          draw: (frame, animate) => {
            view.draw(frame, animate)
            Effect.runSync(Ref.set(seen, frame))
          }
        }
      )
      yield* controller.seek((yield* controller.state).count, false)
      const frame = yield* Ref.get(seen)
      assert.strictEqual(frame?.seq, 33)
      const iban = frame?.stories.find((story) => story.id === "iban")
      assert.strictEqual(iban?.status, "failed")
      assert.strictEqual(iban?.failMessage, "pi error: Connection error.")
      assert.strictEqual(countAtSeq(runSteps, 5), countAtSeq(runSteps, 4))
    })
  )

  it.effect("a stream that fails is reported and leaves the replay paused", () =>
    Effect.gen(function* () {
      const { source } = yield* makeFakeSource({ failAt: 4 })
      const { view, failures } = yield* makeRecorder()
      const controller = yield* makeReplayController(
        source,
        { steps: steps.length, count: 1, speed: 10 },
        view
      )
      yield* controller.play
      yield* TestClock.adjust(wholeRun)
      assert.deepStrictEqual(yield* Ref.get(failures), ["a frame did not decode: at seq 33"])
      assert.deepStrictEqual(yield* controller.state, {
        count: 3,
        steps: 50,
        speed: 10,
        playing: false
      })
    })
  )
})

/** An `EventSource` the test drives by hand. */
const makeFakeEventSource = () => {
  const listeners = new Map<string, Array<(event: { readonly data?: unknown }) => void>>()
  let closed = 0
  const source: EventSourceLike = {
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    close: () => {
      closed += 1
    }
  }
  return {
    source,
    ready: () => listeners.size > 0,
    emit: (type: string, data?: string) => {
      for (const listener of listeners.get(type) ?? []) {
        listener(data === undefined ? {} : { data })
      }
    },
    closed: () => closed
  }
}

const wire = (frame: WebFrame): string => Schema.encodeSync(WebFrameJson)(frame)

describe("watch --web server-sent frames", () => {
  it.effect("decodes each frame in order until the server says end, then closes the source", () =>
    Effect.gen(function* () {
      const fake = makeFakeEventSource()
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(sseFrames(() => fake.source, { endOnError: true }))
      )
      while (!fake.ready()) {
        yield* Effect.yieldNow
      }
      fake.emit("frame", wire(frameAfter(1)))
      fake.emit("frame", wire(frameAfter(2)))
      fake.emit("end")
      const frames = yield* Fiber.join(fiber)
      assert.deepStrictEqual(
        frames.map((frame) => frame.count),
        [1, 2]
      )
      assert.strictEqual(fake.closed(), 1)
    })
  )

  it.effect("a live frame that does not decode fails the stream with what was wrong", () =>
    Effect.gen(function* () {
      const fake = makeFakeEventSource()
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(sseFrames(() => fake.source, { endOnError: false }))
      )
      while (!fake.ready()) {
        yield* Effect.yieldNow
      }
      fake.emit("frame", wire(frameAfter(1)))
      fake.emit("error")
      fake.emit("frame", JSON.stringify({ ...JSON.parse(wire(frameAfter(2))), count: "two" }))
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isFailure(exit))
      const error = yield* Effect.flip(Fiber.join(fiber))
      assert.strictEqual(error._tag, "PageError")
      assert.include(error.message, "a frame did not decode")
      assert.include(error.message, "count")
      assert.strictEqual(fake.closed(), 1)
    })
  )

  it.effect("interrupting the stream closes the source", () =>
    Effect.gen(function* () {
      const fake = makeFakeEventSource()
      const fiber = yield* Effect.forkChild(
        Stream.runDrain(sseFrames(() => fake.source, { endOnError: false }))
      )
      while (!fake.ready()) {
        yield* Effect.yieldNow
      }
      fake.emit("frame", wire(frameAfter(1)))
      yield* Fiber.interrupt(fiber)
      assert.strictEqual(fake.closed(), 1)
    })
  )
})
