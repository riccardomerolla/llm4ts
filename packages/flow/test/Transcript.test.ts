import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import { unsupportedScoreLabels } from "@llm4ts/core/LabelScoring"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { LlmChunk, Message } from "@llm4ts/core/Models"
import { toolEventChunk, toolResultChunk } from "@llm4ts/core/providers/CliSupport"
import { collect } from "@llm4ts/core/Streaming"
import { withTimedRole } from "@llm4ts/flow/Timing"
import { makeMemoryTranscriptSink, transcriptSeat } from "@llm4ts/flow/Transcript"

const unused = InvalidRequestError.make({ message: "unused" })

const replying: LlmServiceShape = {
  executeStream: (_prompt) => Stream.make(LlmChunk.make({ delta: "ok" })),
  executeStreamWithHistory: (_messages) =>
    Stream.make(
      LlmChunk.make({ delta: "Reading " }),
      toolEventChunk(
        "run_shell_command",
        { command: "pnpm test --token sk-ant-secretsecret" },
        "t1"
      ),
      toolResultChunk("t1", { failed: true, output: "FAIL a.test.ts\n".repeat(1_000) }),
      LlmChunk.make({ delta: "done." })
    ),
  executeWithTools: (_prompt, _tools) => Effect.fail(unused),
  executeStructured: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  scoreLabels: unsupportedScoreLabels,
  isAvailable: Effect.succeed(true)
}

describe("transcriptSeat", () => {
  it.effect("records the executor's clone on a call when the seat knows it", () =>
    Effect.gen(function* () {
      const transcript = yield* makeMemoryTranscriptSink
      const numbered = transcriptSeat(replying, transcript.sink, {
        lane: "home",
        role: "coder",
        executor: Effect.succeed("codex"),
        clone: Effect.succeed(2)
      })
      yield* collect(numbered.executeStream("Task 1"))
      const bare = transcriptSeat(replying, transcript.sink, {
        lane: "home",
        role: "coder",
        executor: Effect.succeed("codex"),
        clone: Effect.succeed(undefined)
      })
      yield* collect(bare.executeStream("Task 2"))
      const calls = (yield* transcript.entries).flatMap((entry) =>
        entry.entry._tag === "Call" ? [[entry.entry.executor, entry.entry.clone]] : []
      )
      assert.deepStrictEqual(calls, [
        ["codex", 2],
        ["codex", undefined]
      ])
    })
  )

  it.effect(
    "records a call's input, its reply, its tools and their results, redacted and capped",
    () =>
      Effect.gen(function* () {
        const transcript = yield* makeMemoryTranscriptSink
        const seat = transcriptSeat(replying, transcript.sink, {
          lane: "home",
          role: "coder",
          executor: Effect.succeed("gemini")
        })
        const system = Message.make({ role: "System", content: "You implement stories." })
        yield* collect(
          seat.executeStreamWithHistory([system, Message.make({ role: "User", content: "Task 1" })])
        )
        yield* collect(
          seat.executeStreamWithHistory([
            system,
            Message.make({ role: "User", content: "Task 1" }),
            Message.make({ role: "Assistant", content: "Reading done." }),
            Message.make({ role: "User", content: "Fix the failing test" })
          ])
        )
        const entries = yield* transcript.entries
        assert.isTrue(entries.every((entry) => entry.lane === "home"))
        const [call, ...rest] = entries.map((entry) => entry.entry)
        assert.deepStrictEqual(
          call?._tag === "Call"
            ? [call.role, call.executor, call.system, call.input, call.earlier]
            : [],
          ["coder", "gemini", "You implement stories.", "Task 1", undefined]
        )
        assert.deepStrictEqual(
          rest.slice(0, 5).map((entry) => entry._tag),
          ["Reply", "Tool", "ToolResult", "Reply", "End"]
        )
        const tool = rest[1]
        assert.isTrue(tool?._tag === "Tool" && tool.args.includes("[REDACTED]"))
        assert.notInclude(JSON.stringify(entries), "secretsecret")
        const result = rest[2]
        assert.isTrue(
          result?._tag === "ToolResult" && result.failed === true && result.output.length < 4_200
        )
        // The second call records only what is new, and how much came before it.
        const second = entries
          .map((entry) => entry.entry)
          .filter((entry) => entry._tag === "Call")[1]
        assert.deepStrictEqual(
          second?._tag === "Call" ? [second.system, second.input, second.earlier] : [],
          [undefined, "Fix the failing test", 2]
        )
      })
  )

  it.effect("names the call by the role it is made for", () =>
    Effect.gen(function* () {
      const transcript = yield* makeMemoryTranscriptSink
      const seat = transcriptSeat(replying, transcript.sink, { role: "reasoning" })
      yield* withTimedRole("judge", collect(seat.executeStream("verdict?")))
      const [first] = yield* transcript.entries
      assert.deepStrictEqual(
        first?.entry._tag === "Call" ? [first.lane, first.entry.role, first.entry.input] : [],
        [undefined, "judge", "verdict?"]
      )
    })
  )
})
