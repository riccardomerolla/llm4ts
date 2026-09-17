import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import type * as Scope from "effect/Scope"
import { InvalidRequestError, ProviderError, type LlmError } from "@llm4ts/core/Errors"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import {
  geminiAcpArgv,
  openGeminiAcpSession,
  type GeminiAcpSessionShape
} from "@llm4ts/core/providers/GeminiAcpSession"
import {
  isJsonRecord,
  jsonArray,
  jsonBooleanField,
  jsonField,
  jsonStringField,
  type JsonRecord,
  type JsonValue
} from "@llm4ts/core/providers/CliSupport"
import { FlowLlmError } from "@llm4ts/flow/FlowError"
import { handleMcpRequest, type McpTool } from "@llm4ts/flow/McpServer"

/**
 * Speaks the Anthropic Messages API on `/v1/messages` (what `pi`'s
 * `~/.pi/agent/models.json` custom-provider entry points at) and MCP over
 * HTTP on `/mcp` (what an ACP `session/new` registers with gemini). See
 * ADR 0016 for why: pi's tool loop — not gemini's — executes every tool
 * call, so a tool call gemini makes through the registered MCP tools pauses
 * here until pi's *next* `/v1/messages` request supplies the result.
 *
 * One active ACP session per bridge instance (ADR 0016's simplifying
 * assumption): correlation needs no session-id routing, just one pending
 * tool call and one "what happens next" slot at a time.
 */

interface AnthropicToolDef {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonRecord
}

interface ToolResultPayload {
  readonly content: string
  readonly isError: boolean
}

interface PendingToolCall {
  readonly id: string
  readonly name: string
  readonly resultDeferred: Deferred.Deferred<ToolResultPayload, LlmError>
}

export type TurnOutcome =
  | { readonly _tag: "Text"; readonly text: string }
  | {
      readonly _tag: "ToolUse"
      readonly id: string
      readonly name: string
      readonly input: JsonValue
    }

export interface BridgeState {
  readonly session: GeminiAcpSessionShape
  readonly cwd: string
  readonly mcpServerUrl: string
  readonly sessionId: Ref.Ref<Option.Option<string>>
  readonly tools: Ref.Ref<ReadonlyArray<AnthropicToolDef>>
  readonly pendingToolCall: Ref.Ref<Option.Option<PendingToolCall>>
  readonly turnOutcome: Ref.Ref<Option.Option<Deferred.Deferred<TurnOutcome, LlmError>>>
  readonly nextToolCallId: Ref.Ref<number>
  readonly forkBackground: <A>(effect: Effect.Effect<A, LlmError>) => Effect.Effect<void>
}

export const makeBridgeState = Effect.fn("@llm4ts/runner/NodeGeminiAcpBridge.makeBridgeState")(
  function* (
    session: GeminiAcpSessionShape,
    cwd: string,
    mcpServerUrl: string,
    forkBackground: <A>(effect: Effect.Effect<A, LlmError>) => Effect.Effect<void>
  ): Effect.fn.Return<BridgeState> {
    return {
      session,
      cwd,
      mcpServerUrl,
      sessionId: yield* Ref.make<Option.Option<string>>(Option.none()),
      tools: yield* Ref.make<ReadonlyArray<AnthropicToolDef>>([]),
      pendingToolCall: yield* Ref.make<Option.Option<PendingToolCall>>(Option.none()),
      turnOutcome: yield* Ref.make<Option.Option<Deferred.Deferred<TurnOutcome, LlmError>>>(
        Option.none()
      ),
      nextToolCallId: yield* Ref.make(0),
      forkBackground
    }
  }
)

const resolveTurnOutcomeSuccess = (state: BridgeState, outcome: TurnOutcome): Effect.Effect<void> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(state.turnOutcome)
    if (Option.isSome(current)) {
      yield* Deferred.succeed(current.value, outcome)
    }
  })

const resolveTurnOutcomeFailure = (state: BridgeState, error: LlmError): Effect.Effect<void> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(state.turnOutcome)
    if (Option.isSome(current)) {
      yield* Deferred.fail(current.value, error)
    }
  })

export const anthropicToolToMcpTool = (state: BridgeState, def: AnthropicToolDef): McpTool => ({
  name: def.name,
  description: def.description,
  inputSchema: def.inputSchema,
  call: (arguments_) =>
    Effect.gen(function* () {
      const id = yield* Ref.updateAndGet(state.nextToolCallId, (current) => current + 1)
      const toolCallId = `toolu_${id}`
      const resultDeferred = yield* Deferred.make<ToolResultPayload, LlmError>()
      yield* Ref.set(
        state.pendingToolCall,
        Option.some({ id: toolCallId, name: def.name, resultDeferred })
      )
      yield* resolveTurnOutcomeSuccess(state, {
        _tag: "ToolUse",
        id: toolCallId,
        name: def.name,
        input: arguments_
      })
      const outcome = yield* Deferred.await(resultDeferred)
      if (outcome.isError) {
        return yield* ProviderError.make({ message: outcome.content })
      }
      return outcome.content
    }).pipe(Effect.mapError((error) => FlowLlmError.from(error)))
})

const parseToolDefs = (body: JsonValue): ReadonlyArray<AnthropicToolDef> =>
  jsonArray(jsonField(body, "tools")).flatMap((tool) => {
    const name = jsonStringField(tool, "name")
    if (name === undefined) {
      return []
    }
    const inputSchema = jsonField(tool, "input_schema")
    return [
      {
        name,
        description: jsonStringField(tool, "description") ?? "",
        inputSchema: inputSchema !== undefined && isJsonRecord(inputSchema) ? inputSchema : {}
      }
    ]
  })

const lastMessage = (body: JsonValue): JsonValue | undefined => {
  const messages = jsonArray(jsonField(body, "messages"))
  return messages[messages.length - 1]
}

const contentBlocksText = (value: JsonValue | undefined): string =>
  typeof value === "string"
    ? value
    : jsonArray(value)
        .map((block) => jsonStringField(block, "text") ?? "")
        .join("\n")

const toolResultInLastMessage = (
  body: JsonValue
): { readonly id: string; readonly content: string; readonly isError: boolean } | undefined => {
  const message = lastMessage(body)
  if (jsonStringField(message, "role") !== "user") {
    return undefined
  }
  for (const block of jsonArray(jsonField(message, "content"))) {
    if (jsonStringField(block, "type") !== "tool_result") {
      continue
    }
    const id = jsonStringField(block, "tool_use_id")
    if (id === undefined) {
      continue
    }
    return {
      id,
      content: contentBlocksText(jsonField(block, "content")),
      isError: jsonBooleanField(block, "is_error") === true
    }
  }
  return undefined
}

const userTextInLastMessage = (body: JsonValue): string =>
  contentBlocksText(jsonField(lastMessage(body), "content"))

const anthropicResponse = (model: string, outcome: TurnOutcome): JsonRecord => ({
  id: `msg_${Date.now()}`,
  type: "message",
  role: "assistant",
  model,
  content:
    outcome._tag === "Text"
      ? [{ type: "text", text: outcome.text }]
      : [{ type: "tool_use", id: outcome.id, name: outcome.name, input: outcome.input }],
  stop_reason: outcome._tag === "Text" ? "end_turn" : "tool_use",
  // ACP does not currently surface per-request token counts to this bridge;
  // zero, not omitted, since the Anthropic Messages response shape requires
  // the field. Real usage accounting for this path is future work.
  usage: { input_tokens: 0, output_tokens: 0 }
})

export const handleMessagesRequest = Effect.fn(
  "@llm4ts/runner/NodeGeminiAcpBridge.handleMessagesRequest"
)(function* (state: BridgeState, body: JsonValue): Effect.fn.Return<JsonRecord, LlmError> {
  const continuation = toolResultInLastMessage(body)
  let pendingToResolve: PendingToolCall | undefined
  if (continuation !== undefined) {
    const pending = yield* Ref.get(state.pendingToolCall)
    if (Option.isNone(pending) || pending.value.id !== continuation.id) {
      return yield* InvalidRequestError.make({
        message: `no pending tool call matches tool_result id ${continuation.id}`
      })
    }
    yield* Ref.set(state.pendingToolCall, Option.none())
    pendingToResolve = pending.value
  }

  // Registered before anything that could resolve it (a resumed tool call
  // unblocking gemini's still-in-flight prompt, or — the first turn — the
  // forked prompt() call itself) can run: both can complete fast enough to
  // race an outcome slot only opened afterward, silently dropping it
  // forever with nothing left awaiting it.
  const outcomeDeferred = yield* Deferred.make<TurnOutcome, LlmError>()
  yield* Ref.set(state.turnOutcome, Option.some(outcomeDeferred))

  if (pendingToResolve !== undefined) {
    yield* Deferred.succeed(pendingToResolve.resultDeferred, {
      content: continuation?.content ?? "",
      isError: continuation?.isError ?? false
    })
  } else {
    yield* Ref.set(state.tools, parseToolDefs(body))
    const existing = yield* Ref.get(state.sessionId)
    const sessionId =
      existing._tag === "Some"
        ? existing.value
        : yield* Effect.tap(state.session.newSession(state.cwd, state.mcpServerUrl), (id) =>
            Ref.set(state.sessionId, Option.some(id))
          )
    const text = userTextInLastMessage(body)
    yield* state.forkBackground(
      state.session.prompt(sessionId, text).pipe(
        Effect.matchEffect({
          onSuccess: (result) =>
            resolveTurnOutcomeSuccess(state, { _tag: "Text", text: result.text }),
          onFailure: (error) => resolveTurnOutcomeFailure(state, error)
        })
      )
    )
  }

  const outcome = yield* Deferred.await(outcomeDeferred)
  yield* Ref.set(state.turnOutcome, Option.none())

  return anthropicResponse(jsonStringField(body, "model") ?? "gemini", outcome)
})

const readBody = (request: IncomingMessage): Effect.Effect<string, ProviderError> =>
  Effect.callback((resume) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resume(Effect.succeed(Buffer.concat(chunks).toString("utf8"))))
    request.on("error", (error) =>
      resume(ProviderError.make({ message: "failed to read request body", cause: error }))
    )
  })

const parseJson = (raw: string): JsonValue => JSON.parse(raw)

const parseJsonBody = (raw: string): Effect.Effect<JsonValue, InvalidRequestError> =>
  Effect.try({
    try: () => parseJson(raw),
    catch: () => InvalidRequestError.make({ message: "request body is not valid JSON" })
  })

const writeJson = (response: ServerResponse, status: number, body: JsonValue): void => {
  const text = JSON.stringify(body)
  response.writeHead(status, { "Content-Type": "application/json" })
  response.end(text)
}

const errorStatus = (error: LlmError | InvalidRequestError): number =>
  error._tag === "InvalidRequestError" ? 400 : error._tag === "AuthenticationError" ? 401 : 502

export interface GeminiAcpBridgeConfig {
  readonly port: number
  readonly cwd: string
  readonly model?: string
  readonly executor: ProcessExecutorShape
  readonly envVars?: Readonly<Record<string, string>>
}

export interface RunningGeminiAcpBridge {
  readonly port: number
  readonly baseUrl: string
}

const bindError = (port: number, cause: unknown): ProviderError =>
  ProviderError.make({
    message:
      `Gemini ACP bridge could not bind 127.0.0.1:${port} — another llm4ts run may already ` +
      "own it (concurrent runs against one bridge are unsupported; see ADR 0016)",
    cause
  })

const acquireServer = (
  port: number,
  listener: (request: IncomingMessage, response: ServerResponse) => void
): Effect.Effect<Server, ProviderError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<Server, ProviderError>((resume) => {
      const server = createServer(listener)
      const onError = (cause: Error): void => resume(Effect.fail(bindError(port, cause)))
      server.once("error", onError)
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError)
        resume(Effect.succeed(server))
      })
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        if (!server.listening) {
          resume(Effect.void)
          return
        }
        server.close(() => resume(Effect.void))
      })
  )

export const runGeminiAcpBridge = Effect.fn("@llm4ts/runner/NodeGeminiAcpBridge.run")(function* (
  config: GeminiAcpBridgeConfig
): Effect.fn.Return<RunningGeminiAcpBridge, LlmError, Scope.Scope> {
  const mcpServerUrl = `http://127.0.0.1:${config.port}/mcp`
  const session = yield* openGeminiAcpSession(
    config.executor,
    geminiAcpArgv(config.model),
    config.cwd,
    config.envVars ?? {}
  )
  const forkBackground = <A>(effect: Effect.Effect<A, LlmError>): Effect.Effect<void> =>
    Effect.sync(() => {
      Effect.runFork(effect)
    })
  const state = yield* makeBridgeState(session, config.cwd, mcpServerUrl, forkBackground)

  const requestListener = (request: IncomingMessage, response: ServerResponse): void => {
    const path = request.url ?? "/"
    if (request.method !== "POST" || (path !== "/v1/messages" && path !== "/mcp")) {
      writeJson(response, 404, { error: { message: "not found" } })
      return
    }

    const handled = Effect.gen(function* () {
      const raw = yield* readBody(request)
      const body = yield* parseJsonBody(raw)
      if (path === "/mcp") {
        const tools = yield* Ref.get(state.tools)
        const mcpTools = tools.map((tool) => anthropicToolToMcpTool(state, tool))
        const reply = yield* handleMcpRequest(body, mcpTools)
        return { status: 200, body: reply ?? {} }
      }
      const reply = yield* handleMessagesRequest(state, body)
      return { status: 200, body: reply }
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          status: errorStatus(error),
          body: { error: { message: error.message } }
        })
      )
    )

    Effect.runPromise(handled).then(
      ({ status, body }: { status: number; body: JsonValue }) => writeJson(response, status, body),
      (defect: unknown) => writeJson(response, 500, { error: { message: String(defect) } })
    )
  }

  const server = yield* acquireServer(config.port, requestListener)
  const address = server.address()
  const port = address !== null && typeof address !== "string" ? address.port : config.port
  return { port, baseUrl: `http://127.0.0.1:${port}` }
})
