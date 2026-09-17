import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import type { LlmError } from "@llm4ts/core/Errors"
import { makeProcessExecutor } from "@llm4ts/core/ProcessExecutor"
import type { GeminiAcpSessionShape } from "@llm4ts/core/providers/GeminiAcpSession"
import {
  jsonArray,
  jsonField,
  jsonStringField,
  type JsonValue
} from "@llm4ts/core/providers/CliSupport"
import { nodeHttpClient } from "@llm4ts/runner/NodeHttpClient"
import {
  anthropicToolToMcpTool,
  handleMessagesRequest,
  makeBridgeState,
  runGeminiAcpBridge
} from "@llm4ts/runner/NodeGeminiAcpBridge"

/** Deterministic scheduling turns for a forked background fiber to catch up — see GeminiAcpSession.test.ts. */
const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, {
  discard: true
})

const forkBackground = <A>(effect: Effect.Effect<A, LlmError>): Effect.Effect<void> =>
  Effect.sync(() => {
    Effect.runFork(effect)
  })

const neverPrompt: GeminiAcpSessionShape = {
  events: Stream.empty,
  newSession: () => Effect.succeed("session-1"),
  prompt: () => Effect.never,
  cancel: Effect.void
}

const textPrompt = (text: string): GeminiAcpSessionShape => ({
  events: Stream.empty,
  newSession: () => Effect.succeed("session-1"),
  prompt: () => Effect.succeed({ text, stopReason: "Completed" }),
  cancel: Effect.void
})

const firstBlock = (response: JsonValue): JsonValue | undefined =>
  jsonArray(jsonField(response, "content"))[0]

describe("NodeGeminiAcpBridge", () => {
  describe("handleMessagesRequest", () => {
    it.effect("resolves a fresh turn with no tools as text", () =>
      Effect.gen(function* () {
        const state = yield* makeBridgeState(
          textPrompt("hello from gemini"),
          "/repo",
          "http://127.0.0.1:0/mcp",
          forkBackground
        )
        const requestBody: JsonValue = {
          model: "gemini-x",
          messages: [{ role: "user", content: "hi" }]
        }
        const response = yield* handleMessagesRequest(state, requestBody)
        assert.strictEqual(response.stop_reason, "end_turn")
        assert.strictEqual(jsonStringField(firstBlock(response), "text"), "hello from gemini")
      })
    )

    it.effect("pauses a tool call and resumes it from the next request's tool_result", () =>
      Effect.gen(function* () {
        const state = yield* makeBridgeState(
          neverPrompt,
          "/repo",
          "http://127.0.0.1:0/mcp",
          forkBackground
        )
        const mcpTool = anthropicToolToMcpTool(state, {
          name: "Read",
          description: "read a file",
          inputSchema: {}
        })

        const freshBody: JsonValue = {
          model: "gemini-x",
          tools: [{ name: "Read", description: "read a file", input_schema: {} }],
          messages: [{ role: "user", content: "read foo" }]
        }
        const requestFiber = yield* Effect.forkChild(handleMessagesRequest(state, freshBody))
        yield* settle

        const toolCallFiber = yield* Effect.forkChild(mcpTool.call({ path: "foo" }))
        yield* settle

        const firstResponse = yield* Fiber.join(requestFiber)
        assert.strictEqual(firstResponse.stop_reason, "tool_use")
        const toolUseBlock = firstBlock(firstResponse)
        const toolUseId = jsonStringField(toolUseBlock, "id")
        assert.isString(toolUseId)

        const continuationBody: JsonValue = {
          model: "gemini-x",
          messages: [
            { role: "user", content: "read foo" },
            { role: "assistant", content: [toolUseBlock ?? {}] },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: toolUseId ?? "", content: "file contents" }
              ]
            }
          ]
        }
        const continuationFiber = yield* Effect.forkChild(
          handleMessagesRequest(state, continuationBody)
        )
        yield* settle

        const toolCallResult = yield* Fiber.join(toolCallFiber)
        assert.strictEqual(toolCallResult, "file contents")

        yield* Fiber.interrupt(continuationFiber)
      })
    )

    it.effect("rejects a tool_result that doesn't match a pending call", () =>
      Effect.gen(function* () {
        const state = yield* makeBridgeState(
          neverPrompt,
          "/repo",
          "http://127.0.0.1:0/mcp",
          forkBackground
        )
        const body: JsonValue = {
          model: "gemini-x",
          messages: [
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "unknown", content: "x" }]
            }
          ]
        }
        const outcome = yield* Effect.result(handleMessagesRequest(state, body))
        assert.strictEqual(outcome._tag, "Failure")
      })
    )
  })

  describe("HTTP server", () => {
    it.effect("serves /v1/messages and rejects unknown routes", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const stdin = yield* Queue.unbounded<string>()
          const executor = makeProcessExecutor({
            run: () => Effect.die("not used"),
            runStreaming: () => Stream.empty,
            runBidirectional: () => Effect.succeed([stdin, Stream.never])
          })
          const bridge = yield* runGeminiAcpBridge({
            port: 0,
            cwd: "/repo",
            executor
          })

          const notFound = yield* nodeHttpClient
            .get(`${bridge.baseUrl}/nope`, {}, Duration.seconds(5))
            .pipe(Effect.result)
          assert.strictEqual(notFound._tag, "Failure")
        })
      )
    )

    it.effect("fails fast when the fixed port is already bound", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const stdin = yield* Queue.unbounded<string>()
          const executor = makeProcessExecutor({
            run: () => Effect.die("not used"),
            runStreaming: () => Stream.empty,
            runBidirectional: () => Effect.succeed([stdin, Stream.never])
          })
          const first = yield* runGeminiAcpBridge({ port: 0, cwd: "/repo", executor })
          const second = yield* runGeminiAcpBridge({
            port: first.port,
            cwd: "/repo",
            executor
          }).pipe(Effect.result)
          assert.strictEqual(second._tag, "Failure")
        })
      )
    )
  })
})
