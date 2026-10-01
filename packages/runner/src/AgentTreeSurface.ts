import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import { awaitConsumed, type FlowEventHub } from "@llm4ts/flow/FlowEvents"
import {
  emptyTree,
  initialView,
  onTreeKey,
  reduceTree,
  renderTree,
  type TreeView
} from "./AgentTree.ts"
import type { TerminalSurface } from "./Terminal.ts"

/**
 * The agent tree inside a running flow (`llm4ts run <flow> --ui tree`,
 * ADR 0022): a full-screen view fed from the run's event hub, in front of the
 * classic surface. While it shows, the classic event lines and status block
 * are silent; `q` hands the screen back to them for the rest of the run, and
 * the run's end leaves the last frame on screen before the summary.
 */

export interface AgentTreeOutput {
  readonly write: (text: string) => Effect.Effect<void>
  readonly columns: () => number | undefined
  readonly rows: () => number | undefined
  readonly colour: boolean
}

export interface AgentTreeHost {
  /** The surface the runner and the classic consumer write to. */
  readonly surface: TerminalSurface
  /** Catches up with the run's events, leaves the full screen and prints the last frame. */
  readonly close: Effect.Effect<void>
}

const beginUpdate = "\u001b[?2026h"
const endUpdate = "\u001b[?2026l"
const clearScreen = "\u001b[H\u001b[2J"
const at = (row: number): string => `\u001b[${row};1H`

/**
 * What to send to turn the screen showing `previous` into `next`: the whole
 * frame after a clear when there is no previous one (first paint, resize, a
 * prompt in between), otherwise only the rows that changed — never a clear,
 * which is what flickers under tmux and Windows terminals — and nothing at
 * all when the frame is the same. Each paint is one synchronized update, which
 * terminals that know it show at once and the rest ignore. Rows are drawn
 * at full width, so an overwritten row leaves nothing behind.
 */
export const paintFrame = (
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string>
): string => {
  if (previous === undefined) {
    return `${beginUpdate}${clearScreen}${next.map((line, row) => `${at(row + 1)}${line}`).join("")}${endUpdate}`
  }
  const changed = next.flatMap((line, row) =>
    line === previous[row] ? [] : [`${at(row + 1)}${line}`]
  )
  const shorter = next.length < previous.length ? `${at(next.length + 1)}\u001b[J` : ""
  return changed.length === 0 && shorter === ""
    ? ""
    : `${beginUpdate}${changed.join("")}${shorter}${endUpdate}`
}

/** A full-screen view's painter: remembers what is on screen, and at which size. */
export interface ScreenPainter {
  /** What to write to show `lines` at terminal size `size`; empty when nothing changed. */
  readonly paint: (lines: ReadonlyArray<string>, size: string) => Effect.Effect<string>
  /** The screen was cleared or covered: the next paint is a whole one. */
  readonly reset: Effect.Effect<void>
}

export const makeScreenPainter: Effect.Effect<ScreenPainter> = Effect.map(
  Ref.make<{ readonly lines: ReadonlyArray<string>; readonly size: string } | undefined>(undefined),
  (shown) => ({
    paint: (lines, size) =>
      Ref.modify(shown, (previous) => [
        paintFrame(previous?.size === size ? previous.lines : undefined, lines),
        { lines, size }
      ]),
    reset: Ref.set(shown, undefined)
  })
)

/** The alternate screen, cursor hidden, no auto-wrap: a full-width last row never scrolls. */
export const enterScreen = "\u001b[?1049h\u001b[?25l\u001b[?7l"
export const leaveScreen = "\u001b[?7h\u001b[?25h\u001b[?1049l"
const redrawEvery = "100 millis"

export const makeAgentTreeHost = Effect.fn("@llm4ts/runner/AgentTreeSurface.make")(function* (
  hub: FlowEventHub,
  classic: TerminalSurface,
  output: AgentTreeOutput,
  keys: Stream.Stream<string>,
  idleAfterMs?: number
): Effect.fn.Return<AgentTreeHost, never, Scope.Scope> {
  const state = yield* Ref.make(emptyTree(idleAfterMs === undefined ? {} : { idleAfterMs }))
  const view = yield* Ref.make<TreeView>(initialView)
  const active = yield* Ref.make(true)
  const consumed = yield* Ref.make(0)
  const lock = yield* Semaphore.make(1)

  const subscription = yield* hub.subscribe
  yield* Stream.fromSubscription(subscription).pipe(
    Stream.runForEach((event) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) =>
        Ref.update(state, (current) => reduceTree(current, { _tag: "Event", at, event }))
      ).pipe(Effect.andThen(Ref.update(consumed, (count) => count + 1)))
    ),
    Effect.forkScoped
  )

  const render = (rows: number | undefined): Effect.Effect<ReadonlyArray<string>> =>
    Effect.gen(function* () {
      return renderTree(yield* Ref.get(state), {
        width: Math.max(90, output.columns() ?? 90),
        colour: output.colour,
        view: yield* Ref.get(view),
        ...(rows === undefined ? {} : { height: rows })
      })
    })
  /** The full screen fits the terminal; the last frame left behind is whole. */
  const frame = Effect.map(render(undefined), (lines) => lines.join("\n"))
  const painter = yield* makeScreenPainter
  const repaint = Effect.gen(function* () {
    // The clock moves between events: lane timers and the idle marker run.
    const now = yield* Clock.currentTimeMillis
    yield* Ref.update(state, (current) => reduceTree(current, { _tag: "Tick", at: now }))
    const rows = output.rows()
    const text = yield* painter.paint(yield* render(rows), `${output.columns()}x${rows}`)
    if (text.length > 0) {
      yield* output.write(text)
    }
  })

  /** Runs `effect` only while the tree has the screen, under the drawing lock. */
  const whileShown = (effect: Effect.Effect<void>): Effect.Effect<void> =>
    lock.withPermit(Effect.flatMap(Ref.get(active), (shown) => (shown ? effect : Effect.void)))

  const leave = (withFrame: boolean): Effect.Effect<void> =>
    whileShown(
      Effect.gen(function* () {
        yield* Ref.set(active, false)
        yield* output.write(withFrame ? `${leaveScreen}${yield* frame}\n` : leaveScreen)
      })
    )

  yield* output.write(enterScreen)
  yield* Effect.addFinalizer(() => leave(false))
  yield* Effect.forever(Effect.andThen(Effect.sleep(redrawEvery), whileShown(repaint))).pipe(
    Effect.forkScoped
  )
  yield* Stream.runForEach(keys, (key) =>
    Effect.gen(function* () {
      const next = onTreeKey(yield* Ref.get(view), key, yield* Ref.get(state))
      if (next === "quit") {
        return yield* leave(false)
      }
      yield* Ref.set(view, next)
    })
  ).pipe(Effect.forkScoped)

  const surface: TerminalSurface = {
    palette: classic.palette,
    log: (line) =>
      Effect.flatMap(Ref.get(active), (shown) => (shown ? Effect.void : classic.log(line))),
    setStatus: (label) =>
      Effect.flatMap(Ref.get(active), (shown) => (shown ? Effect.void : classic.setStatus(label))),
    // A prompt needs the ordinary screen: step out of the tree for its length.
    suspend: (effect) =>
      Effect.flatMap(Ref.get(active), (shown) =>
        shown
          ? Effect.acquireUseRelease(
              lock.withPermit(Effect.andThen(Ref.set(active, false), output.write(leaveScreen))),
              () => classic.suspend(effect),
              () =>
                lock.withPermit(
                  Effect.all([Ref.set(active, true), painter.reset, output.write(enterScreen)])
                )
            )
          : classic.suspend(effect)
      )
  }

  return {
    surface,
    close: Effect.andThen(awaitConsumed(hub, consumed), leave(true))
  }
})

// ── node wiring ─────────────────────────────────────────────────────────────

const keyNames: Readonly<Record<string, string>> = {
  "\u001b[A": "up",
  "\u001b[B": "down",
  "\u001b[C": "right",
  "\u001b[D": "left",
  "\r": "enter",
  "\n": "enter",
  "\u001b": "escape"
}

const ctrlC = "\u0003"

/** Raw terminal input as key names; a burst of plain characters is one key each. */
export const keyNamesOf = (chunk: string): ReadonlyArray<string> => {
  const named = keyNames[chunk]
  if (named !== undefined) {
    return [named]
  }
  return chunk.startsWith("\u001b") ? [] : [...chunk]
}

/**
 * The terminal's keys while the tree has it (raw mode). Raw mode swallows
 * the interrupt signal, so ctrl-c is handled here: `detach` quits the viewer
 * (`watch`), `interrupt` raises SIGINT so a run aborts as it always has.
 */
export const nodeTreeKeys = (ctrlCMeans: "detach" | "interrupt"): Stream.Stream<string> =>
  Stream.callback<string>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const input = process.stdin
        if (!input.isTTY) {
          return undefined
        }
        const onData = (data: Buffer) => {
          const chunk = data.toString("utf8")
          if (chunk === ctrlC) {
            if (ctrlCMeans === "interrupt") {
              process.kill(process.pid, "SIGINT")
            } else {
              Queue.offerUnsafe(queue, "q")
            }
            return
          }
          for (const key of keyNamesOf(chunk)) {
            Queue.offerUnsafe(queue, key)
          }
        }
        input.setRawMode(true)
        input.resume()
        input.on("data", onData)
        return onData
      }),
      (onData) =>
        Effect.sync(() => {
          if (onData !== undefined) {
            process.stdin.off("data", onData)
            process.stdin.setRawMode(false)
            process.stdin.pause()
          }
        })
    )
  )
