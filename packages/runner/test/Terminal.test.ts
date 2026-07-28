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
import {
  consumeTerminalEvents,
  indentBlock,
  indentDepths,
  terminalLine,
  terminalSafe,
  type TerminalSurface
} from "@llm4ts/runner/Terminal"

describe("terminal rendering", () => {
  it("sanitizes controls and renders stable tree lines", () => {
    assert.strictEqual(terminalSafe("safe\u001b[2J title\u0007"), "safe title")
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

  it.effect("drains trailing failures and applies verbosity without breaking depth", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lines = yield* Ref.make<ReadonlyArray<string>>([])
        const surface: TerminalSurface = {
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
})
