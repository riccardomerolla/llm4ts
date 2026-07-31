import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { LlmChunk } from "@llm4ts/core/Models"
import { summariseToolArgs, toolUseFrom, withToolActivity } from "@llm4ts/flow/Activity"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"

const toolChunk = (name: string, input: string): LlmChunk =>
  LlmChunk.make({
    delta: "",
    metadata: { event: "tool_use", tool_name: name, tool_input: input }
  })

describe("summariseToolArgs", () => {
  it("lifts the salient value out of the argument object", () => {
    assert.strictEqual(
      summariseToolArgs(JSON.stringify({ command: "ls -R docs/modernization" })),
      "ls -R docs/modernization"
    )
    assert.strictEqual(
      summariseToolArgs(JSON.stringify({ file_path: "src/Main.java", limit: 40 })),
      "src/Main.java"
    )
  })

  it("falls back to the lone value, then to a compact key=value list", () => {
    assert.strictEqual(summariseToolArgs(JSON.stringify({ note: "only field" })), "only field")
    assert.strictEqual(
      summariseToolArgs(JSON.stringify({ alpha: 1, beta: "two" })),
      "alpha=1, beta=two"
    )
  })

  it("passes through non-JSON input and collapses whitespace", () => {
    assert.strictEqual(summariseToolArgs("  raw   text\n here "), "raw text here")
    assert.strictEqual(summariseToolArgs(""), "")
    assert.strictEqual(summariseToolArgs("{}"), "")
  })

  it("truncates long arguments to one bounded line", () => {
    const summary = summariseToolArgs(JSON.stringify({ command: "x".repeat(400) }))
    assert.strictEqual(summary.length, 120)
    assert.isTrue(summary.endsWith("…"))
  })
})

describe("toolUseFrom", () => {
  it("reads a tool call, ignoring other chunks", () => {
    const event = toolUseFrom(toolChunk("run_shell_command", '{"command":"ls"}'))
    assert.strictEqual(event?.tool, "run_shell_command")
    assert.strictEqual(event?.args, "ls")
    assert.isUndefined(toolUseFrom(LlmChunk.make({ delta: "hello" })))
    assert.isUndefined(
      toolUseFrom(LlmChunk.make({ delta: "", metadata: { event: "tool_result", tool_id: "t1" } }))
    )
    assert.isUndefined(
      toolUseFrom(LlmChunk.make({ delta: "", metadata: { event: "tool_use", tool_name: "  " } }))
    )
  })
})

describe("withToolActivity", () => {
  // `collect` folds a stream into its final response and drops the zero-delta
  // tool chunks, which is why a working agent used to render as a bare spinner.
  it.effect("publishes each tool call while passing the stream through intact", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const chunks = yield* Stream.runCollect(
        withToolActivity(
          events,
          Stream.make(
            toolChunk("update_topic", '{"topic":"Reverse-Engineering Complete"}'),
            LlmChunk.make({ delta: "working" }),
            toolChunk("run_shell_command", '{"command":"ls -R docs/modernization"}'),
            LlmChunk.make({ delta: " done", finishReason: "stop" })
          )
        )
      )

      assert.deepStrictEqual(
        chunks.map((chunk) => chunk.delta),
        ["", "working", "", " done"]
      )
      assert.deepStrictEqual(
        (yield* events.recorded).map((event) =>
          event._tag === "ToolUse" ? `${event.tool}|${event.args}` : event._tag
        ),
        ["update_topic|Reverse-Engineering Complete", "run_shell_command|ls -R docs/modernization"]
      )
    })
  )
})
