import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { TokenUsage } from "@llm4ts/core/Models"
import { AssistantMessage, TokensUsed } from "@llm4ts/flow/FlowEvents"
import { makeFlowRecorder } from "@llm4ts/flow/FlowRecorder"
import {
  makeReplayConnector,
  readTrace,
  replayFromTrace,
  segmentReplayTurns
} from "@llm4ts/flow/Replay"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"

describe("trace replay", () => {
  it.effect("replays recorder output offline in deterministic sequence order", () =>
    Effect.gen(function* () {
      const files = (yield* makeMemoryPlainFileStore()).store
      const recorder = yield* makeFlowRecorder(files, "trace.jsonl", "run-1")
      yield* recorder.record(
        TokensUsed.make({
          agent: "coder",
          model: "m",
          usage: TokenUsage.make({ prompt: 2, completion: 1, total: 3 })
        })
      )
      yield* recorder.record(AssistantMessage.make({ text: "done" }))
      const lines = yield* readTrace(files, "trace.jsonl")
      const turns = segmentReplayTurns(lines)
      const connector = yield* makeReplayConnector(turns)
      const chunks = yield* Stream.runCollect(connector.executeStream("ignored"))
      const exhausted = yield* Effect.flip(Stream.runCollect(connector.executeStream("ignored")))

      assert.strictEqual(chunks[0]?.delta, "done")
      assert.strictEqual(chunks[0]?.usage?.total, 3)
      assert.match(exhausted.message, /exhausted/)
    })
  )

  it.effect("replays a recorded failure followed by success without provider access", () =>
    Effect.gen(function* () {
      const files = (yield* makeMemoryPlainFileStore()).store
      const recorder = yield* makeFlowRecorder(files, "trace.jsonl", "run-2")
      yield* recorder.streamError("gemini-cli", undefined, "empty response")
      yield* recorder.record(AssistantMessage.make({ text: "recovered" }))
      const connector = yield* replayFromTrace(files, "trace.jsonl")

      const first = yield* Effect.flip(Stream.runCollect(connector.executeStream("first")))
      const second = yield* Stream.runCollect(connector.executeStream("second"))

      assert.match(first.message, /empty response/)
      assert.strictEqual(second[0]?.delta, "recovered")
    })
  )

  it.effect("fails explicitly on corrupt and unsupported recordings", () =>
    Effect.gen(function* () {
      const corruptFiles = (yield* makeMemoryPlainFileStore({
        "trace.jsonl": "{broken}\n"
      })).store
      const unsupportedFiles = (yield* makeMemoryPlainFileStore({
        "trace.jsonl": JSON.stringify({
          schemaVersion: 99,
          seq: 0,
          timestamp: 0,
          runId: "r",
          kind: "Info",
          fields: {}
        })
      })).store
      const corrupt = yield* Effect.flip(readTrace(corruptFiles, "trace.jsonl"))
      const unsupported = yield* Effect.flip(readTrace(unsupportedFiles, "trace.jsonl"))

      assert.strictEqual(corrupt._tag, "PlanParse")
      assert.strictEqual(unsupported._tag, "UnsupportedSchemaVersion")
    })
  )
})
