import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as PubSub from "effect/PubSub"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { ProviderError, type LlmError } from "../Errors.ts"
import type { ProcessExecutorShape } from "../ProcessExecutor.ts"
import {
  isJsonRecord,
  jsonField,
  jsonStringField,
  jsonText,
  parseJsonLine,
  type JsonRecord,
  type JsonValue
} from "./CliSupport.ts"

/**
 * ACP (Agent Client Protocol, `gemini --experimental-acp`) message shapes
 * are best-effort against public docs (geminicli.com/docs/cli/acp-mode,
 * agentclientprotocol.com) — there is no installed `gemini` binary in CI to
 * verify against (the repo's CI constraint is exactly "no installed
 * provider CLIs"). Tests here exercise this module against a scripted fake
 * peer, the same posture ClaudeAgentSession.test.ts takes against a fake
 * `claude` process. A first live run against a real `gemini` is an
 * integration smoke test, not a substitute for that determinism.
 */
export const geminiAcpArgv = (model: string | undefined): ReadonlyArray<string> => [
  "gemini",
  "--experimental-acp",
  ...(model === undefined ? [] : ["-m", model])
]

const clientCapabilities: JsonRecord = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false
}

export const acpInitializeParams: JsonRecord = {
  protocolVersion: 1,
  clientInfo: { name: "llm4ts", version: "1" },
  clientCapabilities
}

/**
 * `name` and `headers` are required by gemini-cli 0.59.0's own schema for an
 * `http`-type MCP server entry, confirmed against the real binary (a Zod
 * `invalid_union` error naming exactly these two as missing) — the public
 * ACP docs this was first built from show only `{type, url}` as a minimal
 * example, which the real server rejects outright. `headers` is an empty
 * array, not omitted: this is a local loopback bridge with no auth to add.
 */
export const acpNewSessionParams = (cwd: string, mcpServerUrl: string): JsonRecord => ({
  cwd,
  mcpServers: [{ type: "http", url: mcpServerUrl, name: "llm4ts-gemini-bridge", headers: [] }]
})

export const acpPromptParams = (sessionId: string, text: string): JsonRecord => ({
  sessionId,
  prompt: [{ type: "text", text }]
})

const jsonRpcRequest = (id: number, method: string, params: JsonRecord): string =>
  jsonText({ jsonrpc: "2.0", id, method, params })

export const acpInitializeLine = (id: number): string =>
  jsonRpcRequest(id, "initialize", acpInitializeParams)

export const acpNewSessionLine = (id: number, cwd: string, mcpServerUrl: string): string =>
  jsonRpcRequest(id, "session/new", acpNewSessionParams(cwd, mcpServerUrl))

export const acpPromptLine = (id: number, sessionId: string, text: string): string =>
  jsonRpcRequest(id, "session/prompt", acpPromptParams(sessionId, text))

export const acpPermissionResponseLine = (id: JsonValue, approved: boolean): string =>
  jsonText({
    jsonrpc: "2.0",
    id,
    result: { outcome: approved ? "Approved" : "Denied" }
  })

export const acpUnsupportedFsResponseLine = (id: JsonValue): string =>
  jsonText({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "fs access not supported by this client" }
  })

export class AcpTextChunk {
  readonly _tag = "TextChunk"
  constructor(readonly text: string) {}
}

export class AcpToolCallObserved {
  readonly _tag = "ToolCallObserved"
  constructor(
    readonly id: string,
    readonly name: string,
    readonly input: JsonValue
  ) {}
}

export class AcpPermissionRequested {
  readonly _tag = "PermissionRequested"
  constructor(
    readonly id: string,
    readonly toolCallId: string,
    readonly name: string
  ) {}
}

export type AcpSessionEvent = AcpTextChunk | AcpToolCallObserved | AcpPermissionRequested

export interface AcpPromptResult {
  readonly text: string
  readonly stopReason: string
}

export interface AcpApprovalPolicy {
  readonly decide: (toolName: string, input: JsonValue) => Effect.Effect<boolean>
}

/**
 * The safety decision belongs to whichever side actually executes the tool
 * (pi, over the MCP bridge) — gemini's own permission prompt is a formality
 * for a call this session never runs itself, so the default is to approve.
 */
export const alwaysApprove: AcpApprovalPolicy = {
  decide: () => Effect.succeed(true)
}

export interface GeminiAcpSessionShape {
  readonly events: Stream.Stream<AcpSessionEvent, LlmError>
  readonly newSession: (cwd: string, mcpServerUrl: string) => Effect.Effect<string, LlmError>
  readonly prompt: (sessionId: string, text: string) => Effect.Effect<AcpPromptResult, LlmError>
  readonly cancel: Effect.Effect<void>
}

const contentTextOf = (value: JsonValue | undefined): string | undefined =>
  jsonStringField(jsonField(value, "content"), "text")

/** `content_chunk` and `agent_message_chunk` are both seen across ACP revisions for a text delta. */
const textChunkUpdate = (update: JsonValue | undefined): string | undefined => {
  const type = jsonStringField(update, "type")
  return type === "content_chunk" || type === "agent_message_chunk"
    ? contentTextOf(update)
    : undefined
}

const toolCallUpdate = (update: JsonValue | undefined): AcpToolCallObserved | undefined => {
  if (jsonStringField(update, "type") !== "tool_call") {
    return undefined
  }
  const toolCall = jsonField(update, "toolCall")
  const id = jsonStringField(toolCall, "id")
  return id === undefined
    ? undefined
    : new AcpToolCallObserved(
        id,
        jsonStringField(toolCall, "name") ?? "",
        jsonField(toolCall, "input") ?? {}
      )
}

export const parseAcpSessionUpdate = (
  params: JsonValue | undefined
): AcpSessionEvent | undefined => {
  const update = jsonField(params, "update")
  const text = textChunkUpdate(update)
  return text !== undefined && text.length > 0 ? new AcpTextChunk(text) : toolCallUpdate(update)
}

export const openGeminiAcpSession = Effect.fn("@llm4ts/core/providers/GeminiAcpSession.open")(
  function* (
    executor: ProcessExecutorShape,
    argv: ReadonlyArray<string>,
    cwd: string,
    envVars: Readonly<Record<string, string>> = {},
    approval: AcpApprovalPolicy = alwaysApprove
  ): Effect.fn.Return<GeminiAcpSessionShape, LlmError, Scope.Scope> {
    const [stdin, stdout] = yield* executor.runBidirectional(argv, cwd, envVars)
    const events = yield* PubSub.unbounded<AcpSessionEvent>()
    // Accumulated directly by the background reader below rather than via a
    // subscription `prompt` opens on demand: a subscription opened only when
    // `prompt` runs can race a canned/fast-replaying stdout (real or faked in
    // tests) that the reader has already drained by then. One prompt in
    // flight at a time (the single-active-session assumption) makes
    // reset-then-read at each call's boundary sufficient.
    const accumulatedText = yield* Ref.make("")
    const nextId = yield* Ref.make(0)
    const pending = yield* Ref.make<ReadonlyMap<number, Deferred.Deferred<JsonValue, LlmError>>>(
      new Map()
    )
    // Keyed by request id purely for error messages: which ACP call a
    // response belongs to, so a failure names its method instead of just
    // "Gemini ACP error: Internal error" with no way to tell initialize
    // from session/new from session/prompt.
    const pendingMethods = yield* Ref.make<ReadonlyMap<number, string>>(new Map())

    const allocateId = Ref.updateAndGet(nextId, (current) => current + 1)

    const registerPending = Effect.fn("@llm4ts/core/providers/GeminiAcpSession.registerPending")(
      function* (id: number): Effect.fn.Return<Deferred.Deferred<JsonValue, LlmError>> {
        const deferred = yield* Deferred.make<JsonValue, LlmError>()
        yield* Ref.update(pending, (current) => {
          const next = new Map(current)
          next.set(id, deferred)
          return next
        })
        return deferred
      }
    )

    const resolvePending = Effect.fn("@llm4ts/core/providers/GeminiAcpSession.resolvePending")(
      function* (id: number, result: JsonValue | undefined, error: JsonValue | undefined) {
        const current = yield* Ref.get(pending)
        const deferred = current.get(id)
        if (deferred === undefined) {
          return
        }
        yield* Ref.update(pending, (map) => {
          const next = new Map(map)
          next.delete(id)
          return next
        })
        const methods = yield* Ref.get(pendingMethods)
        const method = methods.get(id) ?? "unknown method"
        yield* Ref.update(pendingMethods, (map) => {
          const next = new Map(map)
          next.delete(id)
          return next
        })
        if (error !== undefined) {
          const code = jsonField(error, "code")
          const data = jsonField(error, "data")
          const detail = [
            code === undefined ? undefined : `code=${jsonText(code)}`,
            data === undefined ? undefined : `data=${jsonText(data)}`
          ]
            .filter((part) => part !== undefined)
            .join(" ")
          yield* Deferred.fail(
            deferred,
            ProviderError.make({
              message:
                `Gemini ACP ${method} failed: ` +
                `${jsonStringField(error, "message") ?? jsonText(error)}` +
                `${detail.length === 0 ? "" : ` (${detail})`}`
            })
          )
          return
        }
        yield* Deferred.succeed(deferred, result ?? {})
      }
    )

    const respondToPermission = Effect.fn(
      "@llm4ts/core/providers/GeminiAcpSession.respondToPermission"
    )(function* (requestId: JsonValue, toolName: string, input: JsonValue) {
      const approved = yield* approval.decide(toolName, input)
      yield* Queue.offer(stdin, acpPermissionResponseLine(requestId, approved))
    })

    const handleAgentRequest = Effect.fn(
      "@llm4ts/core/providers/GeminiAcpSession.handleAgentRequest"
    )(function* (id: JsonValue, method: string, params: JsonValue | undefined) {
      switch (method) {
        case "session/request_permission": {
          const toolCall = jsonField(params, "toolCall")
          const toolCallId = jsonStringField(toolCall, "id") ?? ""
          const toolName = jsonStringField(toolCall, "name") ?? ""
          yield* PubSub.publish(
            events,
            new AcpPermissionRequested(
              typeof id === "string" ? id : jsonText(id),
              toolCallId,
              toolName
            )
          )
          yield* respondToPermission(id, toolName, jsonField(toolCall, "input") ?? {})
          return
        }
        case "fs/read_text_file":
        case "fs/write_text_file":
          yield* Queue.offer(stdin, acpUnsupportedFsResponseLine(id))
          return
        default:
          return
      }
    })

    const handleLine = Effect.fn("@llm4ts/core/providers/GeminiAcpSession.handleLine")(function* (
      line: string
    ) {
      const json = parseJsonLine(line)
      if (json === undefined || !isJsonRecord(json)) {
        return
      }
      const id = jsonField(json, "id")
      const method = jsonStringField(json, "method")

      if (method === "session/update") {
        const event = parseAcpSessionUpdate(jsonField(json, "params"))
        if (event !== undefined) {
          if (event._tag === "TextChunk") {
            yield* Ref.update(accumulatedText, (current) => current + event.text)
          }
          yield* PubSub.publish(events, event)
        }
        return
      }

      if (method !== undefined) {
        if (id !== undefined) {
          yield* handleAgentRequest(id, method, jsonField(json, "params"))
        }
        return
      }

      if (typeof id === "number") {
        yield* resolvePending(id, jsonField(json, "result"), jsonField(json, "error"))
      }
    })

    yield* stdout.pipe(
      Stream.mapEffect(handleLine),
      Stream.runDrain,
      Effect.catch(() => Effect.void),
      Effect.forkScoped
    )

    const call = Effect.fn("@llm4ts/core/providers/GeminiAcpSession.call")(function* (
      method: string,
      params: JsonRecord
    ): Effect.fn.Return<JsonValue, LlmError> {
      const id = yield* allocateId
      const deferred = yield* registerPending(id)
      yield* Ref.update(pendingMethods, (map) => new Map(map).set(id, method))
      yield* Queue.offer(stdin, jsonRpcRequest(id, method, params))
      return yield* Deferred.await(deferred)
    })

    const newSession = (cwd: string, mcpServerUrl: string): Effect.Effect<string, LlmError> =>
      Effect.gen(function* () {
        yield* call("initialize", acpInitializeParams)
        const result = yield* call("session/new", acpNewSessionParams(cwd, mcpServerUrl))
        const sessionId = jsonStringField(result, "sessionId")
        if (sessionId === undefined) {
          return yield* ProviderError.make({
            message: "Gemini ACP session/new did not return a sessionId"
          })
        }
        return sessionId
      })

    const prompt = (sessionId: string, text: string): Effect.Effect<AcpPromptResult, LlmError> =>
      Effect.gen(function* () {
        yield* Ref.set(accumulatedText, "")
        const result = yield* call("session/prompt", acpPromptParams(sessionId, text))
        const finalText = yield* Ref.get(accumulatedText)
        return {
          text: finalText,
          stopReason: jsonStringField(result, "stopReason") ?? "Completed"
        }
      })

    return {
      events: Stream.fromPubSub(events),
      newSession,
      prompt,
      cancel: Queue.shutdown(stdin)
    }
  }
)
