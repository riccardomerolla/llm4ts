import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import { StageStarted, makeFlowEventHub } from "@llm4ts/flow/FlowEvents"
import { makeAgentTreeHost, paintFrame } from "@llm4ts/runner/AgentTreeSurface"
import { plainTerminalPalette, type TerminalSurface } from "@llm4ts/runner/Terminal"

const setup = (keys: Stream.Stream<string>) =>
  Effect.gen(function* () {
    const hub = yield* makeFlowEventHub()
    const classicLines = yield* Ref.make<ReadonlyArray<string>>([])
    const written = yield* Ref.make("")
    const classic: TerminalSurface = {
      palette: plainTerminalPalette,
      log: (line) => Ref.update(classicLines, (lines) => [...lines, line]),
      setStatus: () => Effect.void,
      suspend: (effect) => effect
    }
    const host = yield* makeAgentTreeHost(
      hub,
      classic,
      {
        write: (text) => Ref.update(written, (all) => all + text),
        columns: () => 90,
        rows: () => 40,
        colour: false
      },
      keys
    )
    return { hub, host, classicLines, written }
  })

describe("agent tree host", () => {
  it.effect(
    "draws while the run goes on, then leaves its last frame and lets the summary through",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { hub, host, classicLines, written } = yield* setup(Stream.never)
          yield* hub.publish(
            StageStarted.make({ stage: "story home", lane: "home", executor: "codex" })
          )
          // An event line from the classic consumer: the tree shows the event instead.
          yield* host.surface.log("▶ story home")
          yield* TestClock.adjust("150 millis")
          yield* host.close
          yield* host.surface.log("cost: no usage reported")
          const text = yield* Ref.get(written)
          assert.isTrue(text.startsWith("\u001b[?1049h"))
          const [, after] = text.split("\u001b[?1049l")
          assert.include(after ?? "", "◐ home")
          assert.deepStrictEqual(yield* Ref.get(classicLines), ["cost: no usage reported"])
        })
      )
  )

  it.effect("clears the screen once and repaints only what changed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { hub, written } = yield* setup(Stream.never)
        yield* hub.publish(
          StageStarted.make({ stage: "story home", lane: "home", executor: "codex" })
        )
        yield* TestClock.adjust("150 millis")
        const first = yield* Ref.get(written)
        // Ticks within the same second send nothing; the next second repaints
        // only the rows whose timers moved.
        yield* TestClock.adjust("500 millis")
        assert.strictEqual(yield* Ref.get(written), first)
        yield* TestClock.adjust("1 second")
        const timers = (yield* Ref.get(written)).slice(first.length)
        assert.include(timers, "1s")
        assert.notInclude(timers, "\u001b[2J")
        assert.notInclude(timers, "LLM4TS AGENT TREE")
        yield* hub.publish(
          StageStarted.make({ stage: "story iban", lane: "iban", executor: "claude" })
        )
        yield* TestClock.adjust("150 millis")
        const all = yield* Ref.get(written)
        assert.strictEqual(all.split("\u001b[2J").length - 1, 1)
        const repaint = all.slice(first.length)
        assert.include(repaint, "◐ iban")
        assert.notInclude(repaint, "LLM4TS AGENT TREE")
      })
    )
  )

  it.effect("q hands the screen back to the classic view for the rest of the run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, classicLines, written } = yield* setup(Stream.make("q"))
        yield* TestClock.adjust("150 millis")
        yield* host.surface.log("▶ story home")
        yield* host.close
        assert.deepStrictEqual(yield* Ref.get(classicLines), ["▶ story home"])
        assert.isTrue((yield* Ref.get(written)).endsWith("\u001b[?1049l"))
      })
    )
  )
})

describe("paintFrame", () => {
  const begin = "\u001b[?2026h"
  const end = "\u001b[?2026l"
  const frame = ["header", "lane a 1s", "lane b 2s", "status"]

  it("paints the first frame whole, inside one synchronized update", () => {
    const text = paintFrame(undefined, frame)
    assert.isTrue(text.startsWith(`${begin}\u001b[H\u001b[2J`))
    assert.isTrue(text.endsWith(end))
    for (const [row, line] of frame.entries()) {
      assert.include(text, `\u001b[${row + 1};1H${line}`)
    }
  })

  it("sends nothing for an unchanged frame", () => {
    assert.strictEqual(paintFrame(frame, [...frame]), "")
  })

  it("rewrites only the rows that changed, without clearing the screen", () => {
    const next = ["header", "lane a 2s", "lane b 2s", "status"]
    assert.strictEqual(paintFrame(frame, next), `${begin}\u001b[2;1Hlane a 2s${end}`)
  })

  it("clears below a frame that got shorter", () => {
    const text = paintFrame(frame, ["header", "lane a 1s"])
    assert.strictEqual(text, `${begin}\u001b[3;1H\u001b[J${end}`)
  })

  it("turns any screen into the next frame through a sequence of paints", () => {
    const frames: ReadonlyArray<ReadonlyArray<string>> = [
      ["a1", "b1", "c1", "d1"],
      ["a1", "b2", "c1", "d2"],
      ["a1", "b2"],
      ["a3", "b2", "c3", "d3", "e3"]
    ]
    const screen = new Map<number, string>()
    let previous: ReadonlyArray<string> | undefined
    for (const frame of frames) {
      emulate(screen, paintFrame(previous, frame))
      assert.deepStrictEqual(visibleRows(screen), frame)
      previous = frame
    }
  })
})

/** Just enough of a terminal for the painter: cursor moves, clears and text, one row per line. */
const emulate = (screen: Map<number, string>, text: string): void => {
  let row = 1
  for (const [index, part] of text.split("\u001b[").entries()) {
    if (index === 0) {
      screen.set(row, (screen.get(row) ?? "") + part)
      continue
    }
    const command = /^([?\d;]*)([A-Za-z])/u.exec(part)
    const rest = part.slice(command?.[0].length ?? 0)
    const [, args = "", final = ""] = command ?? []
    if (final === "H") {
      row = Number(args.split(";")[0] || "1")
      screen.set(row, "")
    } else if (final === "J" && args === "2") {
      screen.clear()
    } else if (final === "J") {
      for (const key of [...screen.keys()]) {
        if (key >= row) screen.delete(key)
      }
    }
    if (rest.length > 0) {
      screen.set(row, (screen.get(row) ?? "") + rest)
    }
  }
}

const visibleRows = (screen: Map<number, string>): ReadonlyArray<string> =>
  [...screen.entries()]
    .filter(([, line]) => line.length > 0)
    .sort(([left], [right]) => left - right)
    .map(([, line]) => line)
