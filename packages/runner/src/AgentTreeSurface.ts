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
  fitToRows,
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

const enterScreen = "\u001b[?1049h\u001b[?25l"
const leaveScreen = "\u001b[?25h\u001b[?1049l"
const home = "\u001b[H\u001b[2J"
const redrawEvery = "100 millis"

export const makeAgentTreeHost = Effect.fn("@llm4ts/runner/AgentTreeSurface.make")(function* (
  hub: FlowEventHub,
  classic: TerminalSurface,
  output: AgentTreeOutput,
  keys: Stream.Stream<string>
): Effect.fn.Return<AgentTreeHost, never, Scope.Scope> {
  const state = yield* Ref.make(emptyTree())
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

  const render = (rows: number | undefined): Effect.Effect<string> =>
    Effect.gen(function* () {
      const lines = renderTree(yield* Ref.get(state), {
        width: Math.max(90, output.columns() ?? 90),
        colour: output.colour,
        view: yield* Ref.get(view)
      })
      return fitToRows(lines, rows).join("\n")
    })
  /** The full screen fits the terminal; the last frame left behind is whole. */
  const frame = render(undefined)
  const screen = Effect.suspend(() => render(output.rows()))

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
  yield* Effect.forever(
    Effect.andThen(
      Effect.sleep(redrawEvery),
      whileShown(Effect.flatMap(screen, (text) => output.write(`${home}${text}`)))
    )
  ).pipe(Effect.forkScoped)
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
                lock.withPermit(Effect.andThen(Ref.set(active, true), output.write(enterScreen)))
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
