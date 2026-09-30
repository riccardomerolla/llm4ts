import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import { StageStarted, makeFlowEventHub } from "@llm4ts/flow/FlowEvents"
import { makeAgentTreeHost } from "@llm4ts/runner/AgentTreeSurface"
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
