import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import { toolEventChunk, toolResultChunk } from "@llm4ts/core/providers/CliSupport"
import { LlmChunk, TokenUsage } from "@llm4ts/core/Models"
import {
  summariseToolArgs,
  toolCategory,
  toolUseFrom,
  withToolActivity
} from "@llm4ts/flow/Activity"
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

  it.effect(
    "publishes a streaming call's usage as progress, and closes it when the call ends",
    () =>
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const usage = (output: number) =>
          LlmChunk.make({
            delta: "",
            usage: TokenUsage.make({ prompt: 100, completion: output, total: 100 + output })
          })
        yield* Stream.runDrain(
          withToolActivity(
            events,
            Stream.make(usage(400), toolChunk("bash", '{"command":"pnpm test"}'), usage(900))
          )
        )
        const progress = (yield* events.recorded).flatMap((event) =>
          event._tag === "UsageProgress" ? [event] : []
        )
        assert.deepStrictEqual(
          progress.map((event) => [event.usage?.completion, event.done]),
          [
            [400, undefined],
            [900, undefined],
            [undefined, true]
          ]
        )
        // One call, one id.
        assert.strictEqual(new Set(progress.map((event) => event.call)).size, 1)
      })
  )

  it.effect("times each tool from its start to its end, by id or in order", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const at = (seconds: number, chunk: LlmChunk) =>
        Stream.fromEffect(Effect.as(Effect.sleep(`${seconds} seconds`), chunk))
      const fiber = yield* Effect.forkChild(
        Stream.runDrain(
          withToolActivity(
            events,
            Stream.concat(
              at(0, toolEventChunk("read", { path: "a.ts" }, "t1")),
              Stream.concat(
                at(1, toolEventChunk("bash", { command: "pnpm test" }, "t2")),
                Stream.concat(
                  at(2, toolResultChunk("t1")),
                  Stream.concat(
                    at(60, toolResultChunk("t2", { failed: true })),
                    Stream.concat(
                      at(0, toolEventChunk("edit", { path: "b.ts" })),
                      at(4, toolResultChunk(undefined))
                    )
                  )
                )
              )
            )
          )
        )
      )
      yield* TestClock.adjust("2 minutes")
      yield* Fiber.join(fiber)
      const timed = (yield* events.recorded).flatMap((event) =>
        event._tag === "Timed" ? [[event.kind, event.label, event.ms, event.failed]] : []
      )
      assert.deepStrictEqual(timed, [
        ["tool", "read", 3_000, undefined],
        ["tool", "bash", 62_000, true],
        ["tool", "edit", 4_000, undefined]
      ])
    })
  )

  it.effect("reports a tool seen only at its end (an older codex) as it used to", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      yield* Stream.runDrain(
        withToolActivity(
          events,
          Stream.make(toolResultChunk("c1", { tool: "Bash", input: { command: "cargo test" } }))
        )
      )
      assert.deepStrictEqual(
        (yield* events.recorded).map((event) =>
          event._tag === "ToolUse" ? `${event.tool}|${event.args}` : event._tag
        ),
        ["Bash|cargo test"]
      )
    })
  )

  it("sorts a tool call into a category from its name and command, keeping nothing else", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["read_file", "src/a.ts", "explore"],
      ["grep", "useAccounts", "explore"],
      ["edit", "src/a.ts", "edit"],
      ["write_file", "src/b.ts", "edit"],
      ["run_shell_command", "ls -R src", "explore"],
      ["bash", "cd /wt/a && find src -name '*.tsx'", "explore"],
      ["bash", "cd /wt/a && pnpm test src/a.test.ts", "test"],
      ["Bash", "npx vitest run", "test"],
      ["bash", "pnpm typecheck && pnpm lint", "build"],
      ["bash", "pnpm install --offline", "install"],
      ["bash", "git status --short", "git"],
      ["bash", "node scripts/seed.mjs", "other"]
    ]
    for (const [tool, args, category] of cases) {
      assert.strictEqual(toolCategory(tool, args), category, `${tool} ${args}`)
    }
  })

  it.effect("puts the category on a tool's timing", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      yield* Stream.runDrain(
        withToolActivity(
          events,
          Stream.make(
            toolEventChunk("bash", { command: "cd /wt/a && pnpm test" }, "t1"),
            toolResultChunk("t1")
          )
        )
      )
      const timed = (yield* events.recorded).flatMap((event) =>
        event._tag === "Timed" ? [[event.label, event.category]] : []
      )
      assert.deepStrictEqual(timed, [["bash", "test"]])
    })
  )
})
