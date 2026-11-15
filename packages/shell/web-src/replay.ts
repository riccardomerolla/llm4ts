import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import type { WebFrame, WebRunStep } from "../src/WebFrame.ts"
import type { FrameSource, PageError } from "./frames.ts"

/**
 * The replay's transport (ADR 0051): play, pause, step, speed, scrub and
 * seek over a `FrameSource`. One fiber plays; pausing interrupts it, which
 * closes its stream. Commands run one at a time, so a click during a seek
 * waits for it instead of racing it. The DOM stays outside: the controller
 * calls `draw` with each frame and `chrome` with each new state.
 */

export interface ReplayState {
  /** Steps folded into the frame on screen, 1 to `steps`. */
  readonly count: number
  readonly steps: number
  readonly speed: number
  readonly playing: boolean
}

export interface ReplayView {
  readonly draw: (frame: WebFrame, animate: boolean) => void
  readonly chrome: (state: ReplayState) => void
  readonly failed: (error: PageError) => void
}

export interface ReplayController {
  readonly state: Effect.Effect<ReplayState>
  readonly play: Effect.Effect<void>
  readonly pause: Effect.Effect<void>
  readonly toggle: Effect.Effect<void>
  /** One step back or forward, from where the replay stands. */
  readonly step: (delta: -1 | 1) => Effect.Effect<void>
  /** Pauses and shows the frame after `count` steps. */
  readonly seek: (count: number, animate: boolean) => Effect.Effect<void>
  /** A new speed; a playing replay goes on from where it is at that speed. */
  readonly setSpeed: (speed: number) => Effect.Effect<void>
}

type Phase =
  | { readonly _tag: "Paused" }
  | { readonly _tag: "Playing"; readonly token: number; readonly fiber: Fiber.Fiber<void> }

const paused: Phase = { _tag: "Paused" }

/** The steps up to and including trace seq `seq`, at least one: `?seq=` opens there. */
export const countAtSeq = (steps: ReadonlyArray<WebRunStep>, seq: number): number =>
  Math.max(1, steps.filter((step) => step.seq <= seq).length)

/** The steps up to and including time `at`, at least one: where a click on the scrubber lands. */
export const countAtTime = (steps: ReadonlyArray<WebRunStep>, at: number): number =>
  Math.max(1, steps.filter((step) => step.at <= at).length)

export const makeReplayController = Effect.fn("watch-web/ReplayController.make")(function* (
  source: FrameSource,
  initial: { readonly steps: number; readonly count: number; readonly speed: number },
  view: ReplayView
): Effect.fn.Return<ReplayController, never, Scope.Scope> {
  const scope = yield* Effect.scope
  const lock = yield* Semaphore.make(1)
  const phase = yield* Ref.make<Phase>(paused)
  const position = yield* Ref.make({
    count: clamp(initial.count, initial.steps),
    speed: initial.speed
  })
  let tokens = 0

  const state: Effect.Effect<ReplayState> = Effect.gen(function* () {
    const { count, speed } = yield* Ref.get(position)
    const now = yield* Ref.get(phase)
    return { count, speed, steps: initial.steps, playing: now._tag === "Playing" }
  })
  const showChrome = Effect.flatMap(state, (current) => Effect.sync(() => view.chrome(current)))
  const exclusive = <A>(effect: Effect.Effect<A>): Effect.Effect<A> =>
    Semaphore.withPermit(lock, effect)

  const stop = Effect.gen(function* () {
    const now = yield* Ref.getAndSet(phase, paused)
    if (now._tag === "Playing") {
      yield* Fiber.interrupt(now.fiber)
    }
  })

  const drawn = (frame: WebFrame, animate: boolean): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Ref.update(position, (open) => ({ ...open, count: frame.count }))
      view.draw(frame, animate)
      yield* showChrome
    })

  /** The playing fiber ended by itself (its last frame, or an error): the replay is paused. */
  const finished = (token: number): Effect.Effect<void> =>
    exclusive(
      Effect.gen(function* () {
        const now = yield* Ref.get(phase)
        if (now._tag === "Playing" && now.token === token) {
          yield* Ref.set(phase, paused)
          yield* showChrome
        }
      })
    )

  const startPlaying = Effect.gen(function* () {
    yield* stop
    const open = yield* Ref.updateAndGet(position, (current) =>
      current.count >= initial.steps ? { ...current, count: 1 } : current
    )
    const token = ++tokens
    let first = true
    const playing = source.stream({ count: open.count, speed: open.speed }).pipe(
      Stream.runForEach((frame) => {
        const animate = !first
        first = false
        return drawn(frame, animate)
      }),
      Effect.catch((error) => Effect.sync(() => view.failed(error))),
      Effect.andThen(finished(token))
    )
    const fiber = yield* Effect.forkIn(playing, scope)
    yield* Ref.set(phase, { _tag: "Playing", token, fiber })
    yield* showChrome
  })

  const pauseNow = Effect.andThen(stop, showChrome)

  const seekNow = (count: number, animate: boolean): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* stop
      const target = clamp(count, initial.steps)
      yield* Ref.update(position, (open) => ({ ...open, count: target }))
      yield* Effect.matchEffect(source.frame(target), {
        onSuccess: (frame) => drawn(frame, animate),
        onFailure: (error) =>
          Effect.andThen(
            Effect.sync(() => view.failed(error)),
            showChrome
          )
      })
    })

  return {
    state,
    play: exclusive(startPlaying),
    pause: exclusive(pauseNow),
    toggle: exclusive(
      Effect.flatMap(Ref.get(phase), (now) => (now._tag === "Playing" ? pauseNow : startPlaying))
    ),
    step: (delta) =>
      exclusive(Effect.flatMap(Ref.get(position), (open) => seekNow(open.count + delta, true))),
    seek: (count, animate) => exclusive(seekNow(count, animate)),
    setSpeed: (speed) =>
      exclusive(
        Effect.gen(function* () {
          yield* Ref.update(position, (open) => ({ ...open, speed }))
          const now = yield* Ref.get(phase)
          yield* now._tag === "Playing" ? startPlaying : showChrome
        })
      )
  }
})

const clamp = (count: number, steps: number): number => Math.min(steps, Math.max(1, count))
