import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { TokenUsage } from "@llm4ts/core/Models"
import {
  AssistantMessage,
  JudgmentObserved,
  StageCompleted,
  StageFailed,
  StageStarted,
  ToolUse,
  TokensUsed,
  makeFlowEventHub,
  withLane
} from "@llm4ts/flow/FlowEvents"
import { TestClock } from "effect/testing"
import { origins, truth, truthAnswer } from "@llm4ts/core/judgment/Schemas"
import {
  consumeTerminalEvents,
  fitToWidth,
  formatDurationMs,
  statusBlock,
  indentBlock,
  indentDepths,
  makeLiveTerminalSurface,
  makeTerminalPalette,
  plainTerminalPalette,
  rendersEvent,
  terminalLine,
  terminalSafe,
  terminalSupportsColor,
  type TerminalSurface
} from "@llm4ts/runner/Terminal"

describe("terminal rendering", () => {
  it("leaves judgment telemetry silent; advice arrives as Info", () => {
    const event = JudgmentObserved.make({
      consumer: "satisfied-probe",
      key: "satisfied",
      state: "reply",
      question: truth("Satisfied?"),
      answer: truthAnswer(1, origins.fake()),
      judgmentIdentity: "fake:test",

      decision: "act",
      certainty: 1,
      support: 1,
      origin: origins.fake(),
      outcome: { _tag: "SatisfiedProbe", literalMatch: true },
      mode: "observe"
    })
    assert.isFalse(rendersEvent("Normal", event))
    assert.isFalse(rendersEvent("Verbose", event))
    assert.strictEqual(terminalLine(event), "")
  })

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

  it.effect("keeps concurrent stories apart: tagged lines, own stages, one status row each", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lines = yield* Ref.make<ReadonlyArray<string>>([])
        const statuses = yield* Ref.make<ReadonlyArray<string | undefined>>([])
        const surface: TerminalSurface = {
          palette: plainTerminalPalette,
          log: (line) => Ref.update(lines, (current) => [...current, line]),
          setStatus: (label) => Ref.update(statuses, (current) => [...current, label]),
          suspend: (effect) => effect
        }
        const hub = yield* makeFlowEventHub()
        const consumer = yield* consumeTerminalEvents(hub, surface)
        const form = withLane(hub, {
          lane: "bonifico-form",
          executor: Effect.succeed("pi-lmstudio"),
          workDir: "/wt/form"
        })
        const list = withLane(hub, {
          lane: "bonifici-list",
          executor: Effect.succeed("lemonade-deepseek"),
          workDir: "/wt/list"
        })
        yield* form.publish(StageStarted.make({ stage: "story bonifico-form" }))
        yield* list.publish(StageStarted.make({ stage: "story bonifici-list" }))
        yield* form.publish(StageStarted.make({ stage: "Write the tests" }))
        yield* list.publish(ToolUse.make({ tool: "shell", args: "cd /wt/list && pnpm test" }))
        yield* list.publish(ToolUse.make({ tool: "read", args: "/wt/list/src/a.tsx" }))
        // bonifici-list ends while bonifico-form is still inside a task.
        yield* list.publish(StageCompleted.make({ stage: "story bonifici-list" }))
        yield* form.publish(StageCompleted.make({ stage: "Write the tests" }))
        yield* consumer.awaitDrained()

        const printed = yield* Ref.get(lines)
        assert.include(printed, "[bonifico-form · pi-lmstudio] ▶ story bonifico-form")
        assert.include(printed, "[bonifico-form · pi-lmstudio]   ▶ Write the tests")
        assert.isTrue(
          printed.some((line) =>
            line.startsWith("[bonifici-list · lemonade-deepseek] ✔ story bonifici-list")
          )
        )
        assert.isTrue(
          printed.some((line) =>
            line.startsWith("[bonifico-form · pi-lmstudio]   ✔ Write the tests")
          )
        )
        // Tool calls are counted, not printed, at normal verbosity.
        assert.isFalse(printed.some((line) => line.includes("pnpm test")))
        const seen = (yield* Ref.get(statuses)).filter(
          (status): status is string => status !== undefined
        )
        assert.isTrue(
          seen.some(
            (status) =>
              status.includes("bonifico-form · pi-lmstudio · Write the tests") &&
              status.includes("bonifici-list · lemonade-deepseek · story bonifici-list") &&
              status.includes("2 tool calls")
          ),
          JSON.stringify(seen)
        )
        // Once bonifici-list ended, only bonifico-form has a row.
        assert.notInclude(seen.at(-1) ?? "", "bonifici-list")
      })
    )
  )

  it.effect("prints every tool call, tagged and without the worktree path, when verbose", () =>
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
        const consumer = yield* consumeTerminalEvents(hub, surface, "Verbose")
        const list = withLane(hub, { lane: "bonifici-list", workDir: "/wt/list" })
        yield* list.publish(ToolUse.make({ tool: "shell", args: "cd /wt/list && pnpm test" }))
        yield* list.publish(ToolUse.make({ tool: "read", args: "/wt/list/src/a.tsx" }))
        yield* consumer.awaitDrained()
        assert.deepStrictEqual(yield* Ref.get(lines), [
          "[bonifici-list] ● shell (pnpm test)",
          "[bonifici-list] ● read (src/a.tsx)"
        ])
      })
    )
  )

  it.effect("draws and clears a multi-line status block, cut to the terminal's width", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const output: Array<string> = []
        const surface = yield* makeLiveTerminalSurface(
          (text) => {
            output.push(text)
          },
          makeTerminalPalette(false),
          "1 hour",
          () => 40
        )
        yield* surface.setStatus(`first row\n${"x".repeat(80)}`)
        yield* surface.log("a line")
        const rendered = output.join("")
        assert.include(rendered, "first row\n")
        // The second row was cut to fit, so the redraw arithmetic holds.
        assert.include(rendered, `${"x".repeat(35)}…`)
        // Clearing a two-row block moves up one line.
        assert.include(rendered, "\r\u001b[2K\u001b[1A\r\u001b[2K")
        assert.include(rendered, "a line\n")
        assert.strictEqual(fitToWidth("short", 40), "short")
        assert.strictEqual(
          statusBlock("epic branch", [
            { lane: "a", executor: "pi", stage: "task 1", elapsedMs: 65_000, tools: 1 },
            { lane: "b", executor: undefined, stage: undefined, elapsedMs: 0, tools: 0 }
          ]),
          "epic branch\na · pi · task 1 · 1m05s · 1 tool call"
        )
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
