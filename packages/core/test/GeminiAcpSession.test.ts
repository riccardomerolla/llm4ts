import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { makeProcessExecutor } from "@llm4ts/core/ProcessExecutor"
import {
  acpPermissionResponseLine,
  acpUnsupportedFsResponseLine,
  alwaysApprove,
  geminiAcpArgv,
  openGeminiAcpSession,
  parseAcpSessionUpdate,
  type AcpApprovalPolicy
} from "@llm4ts/core/providers/GeminiAcpSession"

type Json = Record<string, unknown>

const parse = (line: string): Json => JSON.parse(line)

/**
 * The scripted peer's echo of our own stdin writes (e.g. a permission
 * response) is recorded when the background reader loop dequeues it, one
 * more loop turn after the turn that unblocks `prompt`'s caller — not
 * time-dependent, so `Effect.sleep` would hang under `it.effect`'s virtual
 * clock. Yielding repeatedly gives that fiber the scheduling turns it needs
 * without depending on any clock.
 */
const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, {
  discard: true
})

/**
 * A scripted fake ACP peer: reactive, not a static canned stream. Output is
 * produced only once the corresponding request is observed on `stdin`, so
 * response correlation (registered before the request line is sent) can
 * never race a fake that "replies" before the request exists — the failure
 * mode a purely static `Stream.fromIterable` fake would hit here, given this
 * module's multi-step handshake (unlike ClaudeAgentSession's single Deferred).
 */
const scriptedPeer = (respond: (request: Json) => ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const stdin = yield* Queue.unbounded<string>()
    const sent = yield* Ref.make<ReadonlyArray<string>>([])
    const stdout = Stream.fromQueue(stdin).pipe(
      Stream.mapEffect((line) => Ref.updateAndGet(sent, (current) => [...current, line])),
      Stream.flatMap((history) =>
        Stream.fromIterable(respond(parse(history[history.length - 1] ?? "{}")))
      )
    )
    const executor = makeProcessExecutor({
      run: () => Effect.die("not used"),
      runStreaming: () => Stream.empty,
      runBidirectional: () => Effect.succeed([stdin, stdout])
    })
    return { executor, sent }
  })

describe("GeminiAcpSession", () => {
  describe("parseAcpSessionUpdate", () => {
    it("reads a text delta", () => {
      const event = parseAcpSessionUpdate({
        update: { type: "content_chunk", content: { type: "text", text: "hi" } }
      })
      assert.strictEqual(event?._tag, "TextChunk")
    })

    it("reads a tool call", () => {
      const event = parseAcpSessionUpdate({
        update: { type: "tool_call", toolCall: { id: "t1", name: "Read", input: { path: "a" } } }
      })
      assert.strictEqual(event?._tag, "ToolCallObserved")
      assert.strictEqual(event?._tag === "ToolCallObserved" && event.id, "t1")
    })

    it("ignores an unrecognized update shape", () => {
      assert.isUndefined(parseAcpSessionUpdate({ update: { type: "plan" } }))
    })
  })

  it.effect("opens a session and accumulates a turn's text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* scriptedPeer((request) => {
          switch (request.method) {
            case "initialize":
              return [JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })]
            case "session/new":
              return [
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: request.id,
                  result: { sessionId: "sess-1" }
                })
              ]
            case "session/prompt":
              return [
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: "sess-1",
                    update: { type: "content_chunk", content: { type: "text", text: "Hello " } }
                  }
                }),
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    sessionId: "sess-1",
                    update: { type: "content_chunk", content: { type: "text", text: "world" } }
                  }
                }),
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: request.id,
                  result: { stopReason: "Completed" }
                })
              ]
            default:
              return []
          }
        })
        const session = yield* openGeminiAcpSession(executor, geminiAcpArgv(undefined), "/repo")
        const sessionId = yield* session.newSession("/repo", "http://127.0.0.1:8731/mcp")
        assert.strictEqual(sessionId, "sess-1")

        const result = yield* session.prompt(sessionId, "hi")
        assert.strictEqual(result.text, "Hello world")
        assert.strictEqual(result.stopReason, "Completed")
      })
    )
  )

  it.effect("auto-approves a permission request and answers it on stdin", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor, sent } = yield* scriptedPeer((request) => {
          switch (request.method) {
            case "initialize":
              return [JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })]
            case "session/new":
              return [
                JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: "s" } })
              ]
            case "session/prompt":
              return [
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: "perm-1",
                  method: "session/request_permission",
                  params: {
                    sessionId: "s",
                    toolCall: { id: "tool-1", name: "Read", input: { path: "a" } }
                  }
                }),
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: request.id,
                  result: { stopReason: "Completed" }
                })
              ]
            default:
              return []
          }
        })
        const session = yield* openGeminiAcpSession(executor, geminiAcpArgv(undefined), "/repo")
        const sessionId = yield* session.newSession("/repo", "http://127.0.0.1:8731/mcp")
        yield* session.prompt(sessionId, "hi")

        yield* settle
        const history = yield* Ref.get(sent)
        assert.include(history, acpPermissionResponseLine("perm-1", true))
      })
    )
  )

  it.effect("denies when given a policy that declines", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor, sent } = yield* scriptedPeer((request) => {
          switch (request.method) {
            case "initialize":
              return [JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })]
            case "session/new":
              return [
                JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: "s" } })
              ]
            case "session/prompt":
              return [
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: "perm-1",
                  method: "session/request_permission",
                  params: { sessionId: "s", toolCall: { id: "tool-1", name: "Bash", input: {} } }
                }),
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: request.id,
                  result: { stopReason: "Completed" }
                })
              ]
            default:
              return []
          }
        })
        const denyAll: AcpApprovalPolicy = { decide: () => Effect.succeed(false) }
        const session = yield* openGeminiAcpSession(
          executor,
          geminiAcpArgv(undefined),
          "/repo",
          {},
          denyAll
        )
        const sessionId = yield* session.newSession("/repo", "http://127.0.0.1:8731/mcp")
        yield* session.prompt(sessionId, "hi")

        yield* settle
        const history = yield* Ref.get(sent)
        assert.include(history, acpPermissionResponseLine("perm-1", false))
      })
    )
  )

  it.effect("rejects an fs request even though the session declared no fs capability", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor, sent } = yield* scriptedPeer((request) => {
          switch (request.method) {
            case "initialize":
              return [JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })]
            case "session/new":
              return [
                JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: "s" } })
              ]
            case "session/prompt":
              return [
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: "fs-1",
                  method: "fs/read_text_file",
                  params: { sessionId: "s", path: "/etc/passwd" }
                }),
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: request.id,
                  result: { stopReason: "Completed" }
                })
              ]
            default:
              return []
          }
        })
        const session = yield* openGeminiAcpSession(executor, geminiAcpArgv(undefined), "/repo")
        const sessionId = yield* session.newSession("/repo", "http://127.0.0.1:8731/mcp")
        yield* session.prompt(sessionId, "hi")

        yield* settle
        const history = yield* Ref.get(sent)
        assert.include(history, acpUnsupportedFsResponseLine("fs-1"))
      })
    )
  )

  it.effect("fails the call with a typed error on a JSON-RPC error response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { executor } = yield* scriptedPeer((request) => {
          if (request.method === "initialize") {
            return [
              JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                error: { message: "not logged in" }
              })
            ]
          }
          return []
        })
        const session = yield* openGeminiAcpSession(executor, geminiAcpArgv(undefined), "/repo")
        const outcome = yield* Effect.result(
          session.newSession("/repo", "http://127.0.0.1:8731/mcp")
        )
        assert.strictEqual(outcome._tag, "Failure")
      })
    )
  )

  it("alwaysApprove approves any tool", () =>
    Effect.runPromise(alwaysApprove.decide("Bash", {})).then((approved) => {
      assert.isTrue(approved)
    }))
})
