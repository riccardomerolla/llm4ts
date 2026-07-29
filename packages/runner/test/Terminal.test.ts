import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { TokenUsage } from "@llm4ts/core/Models"
import {
  AssistantMessage,
  StageCompleted,
  StageFailed,
  StageStarted,
  TokensUsed,
  makeFlowEventHub
} from "@llm4ts/flow/FlowEvents"
import { TestClock } from "effect/testing"
import {
  consumeTerminalEvents,
  formatDurationMs,
  indentBlock,
  indentDepths,
  makeLiveTerminalSurface,
  makeTerminalPalette,
  plainTerminalPalette,
  terminalLine,
  terminalSafe,
  terminalSupportsColor,
  type TerminalSurface
} from "@llm4ts/runner/Terminal"

describe("terminal rendering", () => {
  it("sanitizes controls and renders stable tree lines", () => {
    assert.strictEqual(terminalSafe("safe\u001b[2J title\u0007"), "safe title")
    assert.strictEqual(
      terminalSafe("\u001b]0;malicious title\u0007safe\u001b]2;again\u001b\\"),
      "safe"
    )
    assert.strictEqual(
      terminalLine(StageFailed.make({ stage: "build", message: "boom" })),
      "✖ build — boom"
    )
    assert.strictEqual(indentBlock(1, "● first\nsecond"), "  ● first\n    second")
    assert.deepStrictEqual(
      indentDepths([
        StageStarted.make({ stage: "a" }),
        AssistantMessage.make({ text: "x" }),
        StageStarted.make({ stage: "b" }),
        StageCompleted.make({ stage: "b" }),
        StageCompleted.make({ stage: "a" })
      ]),
      [0, 1, 1, 1, 0]
    )
  })

  it("colors semantic glyphs only when terminal color is enabled", () => {
    const colored = terminalLine(StageStarted.make({ stage: "branch" }), makeTerminalPalette(true))
    assert.include(colored, "\u001b[")
    assert.include(colored, "▶")
    assert.include(colored, "branch")
    assert.isFalse(terminalLine(StageStarted.make({ stage: "branch" })).includes("\u001b["))
    assert.isTrue(terminalSupportsColor({ isTTY: true, write: () => undefined }, {}))
    assert.isFalse(terminalSupportsColor({ isTTY: true, write: () => undefined }, { NO_COLOR: "" }))
    assert.isFalse(terminalSupportsColor({ isTTY: false, write: () => undefined }, {}))
  })

  it.effect("animates a pinned status line while preserving completed log lines", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const output: Array<string> = []
        const surface = yield* makeLiveTerminalSurface(
          (text) => {
            output.push(text)
          },
          makeTerminalPalette(true),
          "1 hour"
        )
        yield* surface.setStatus("build")
        yield* surface.log("completed step")
        const rendered = output.join("")

        assert.include(rendered, "⠋")
        assert.include(rendered, "build")
        assert.include(rendered, "completed step\n")
        assert.include(rendered, "\r\u001b[2K")
      })
    )
  )

  it.effect("drains trailing failures and applies verbosity without breaking depth", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lines = yield* Ref.make<ReadonlyArray<string>>([])
        const surface: TerminalSurface = {
          palette: plainTerminalPalette,
          log: (line) => Ref.update(lines, (current) => [...current, line]),
          setStatus: (_label) => Effect.void,
          suspend: (effect) => effect
        }
        const hub = yield* makeFlowEventHub()
        const consumer = yield* consumeTerminalEvents(hub, surface, "Quiet")
        yield* hub.publish(StageStarted.make({ stage: "build" }))
        yield* hub.publish(
          TokensUsed.make({
            agent: "coder",
            usage: TokenUsage.make({
              prompt: 1,
              completion: 2,
              total: 3
            })
          })
        )
        yield* hub.publish(StageFailed.make({ stage: "build", message: "boom" }))
        yield* consumer.awaitDrained()
        const rendered = yield* Ref.get(lines)

        assert.isTrue(rendered.some((line) => line.includes("▶ build")))
        assert.isTrue(rendered.some((line) => line.includes("✖ build — boom")))
        assert.isFalse(rendered.some((line) => line.includes("tokens:")))
      })
    )
  )

  it.effect("restores the parent stage status after nested work completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const statuses = yield* Ref.make<ReadonlyArray<string | undefined>>([])
        const surface: TerminalSurface = {
          palette: plainTerminalPalette,
          log: (_line) => Effect.void,
          setStatus: (label) => Ref.update(statuses, (current) => [...current, label]),
          suspend: (effect) => effect
        }
        const hub = yield* makeFlowEventHub()
        const consumer = yield* consumeTerminalEvents(hub, surface)
        yield* hub.publish(StageStarted.make({ stage: "outer" }))
        yield* hub.publish(StageStarted.make({ stage: "inner" }))
        yield* hub.publish(StageCompleted.make({ stage: "inner" }))
        yield* hub.publish(StageCompleted.make({ stage: "outer" }))
        yield* consumer.awaitDrained()

        assert.deepStrictEqual(yield* Ref.get(statuses), ["outer", "inner", "outer", undefined])
      })
    )
  )

  it("formats durations for humans", () => {
    assert.strictEqual(formatDurationMs(0), "0ms")
    assert.strictEqual(formatDurationMs(830), "830ms")
    assert.strictEqual(formatDurationMs(12_400), "12.4s")
    assert.strictEqual(formatDurationMs(272_000), "4m32s")
  })

  it.effect("renders stage durations, timestamps, and run stats", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lines = yield* Ref.make<ReadonlyArray<string>>([])
        const surface: TerminalSurface = {
          palette: plainTerminalPalette,
          log: (line) => Ref.update(lines, (current) => [...current, line]),
          setStatus: (_label) => Effect.void,
          suspend: (effect) => effect
        }
        const hub = yield* makeFlowEventHub()
        const consumer = yield* consumeTerminalEvents(hub, surface, "Normal", {
          timestamps: true
        })
        yield* hub.publish(StageStarted.make({ stage: "build" }))
        yield* TestClock.adjust("1500 millis")
        yield* hub.publish(StageCompleted.make({ stage: "build" }))
        yield* hub.publish(StageStarted.make({ stage: "verify" }))
        yield* TestClock.adjust("250 millis")
        yield* hub.publish(StageFailed.make({ stage: "verify", message: "boom" }))
        yield* consumer.awaitDrained()

        const rendered = yield* Ref.get(lines)
        const stats = yield* consumer.stats

        assert.isTrue(rendered.some((line) => line.includes("\u2714 build (1.5s)")))
        assert.isTrue(rendered.some((line) => line.includes("\u2716 verify \u2014 boom (250ms)")))
        assert.isTrue(rendered.every((line) => /^\d{2}:\d{2}:\d{2} /.test(line)))
        assert.deepStrictEqual(stats, { stagesCompleted: 1, stagesFailed: 1 })
      })
    )
  )
})
