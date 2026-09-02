import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { makeCliConnector, type CliConnectorShape } from "../Connector.ts"
import type { CliConnectorConfig } from "../ConnectorConfig.ts"
import {
  InvalidRequestError,
  ParseError,
  ProviderError,
  TurnLimitError,
  type LlmError
} from "../Errors.ts"
import type { StructuredResult } from "../LlmService.ts"
import {
  ConnectorIds,
  HealthStatus,
  LlmChunk,
  TokenUsage,
  type JsonSchema,
  type LlmConfig,
  type Message
} from "../Models.ts"
import { collect } from "../Streaming.ts"
import { jsonCandidates, parseFromText, withSchemaHint } from "../StructuredOutput.ts"
import {
  failClassifiedCliError,
  isLoopDetectedMessage,
  jsonField,
  jsonIntField,
  jsonObjectEntries,
  jsonStringField,
  jsonText,
  parseJsonLine,
  type JsonValue
} from "./CliSupport.ts"

export class GeminiCliLogLine extends Schema.TaggedClass<GeminiCliLogLine>()("LogLine", {
  line: Schema.String
}) {}

export class GeminiCliInit extends Schema.TaggedClass<GeminiCliInit>()("Init", {
  model: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(Schema.String)
}) {}

export class GeminiCliMessage extends Schema.TaggedClass<GeminiCliMessage>()("Message", {
  role: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  delta: Schema.Boolean
}) {}

export class GeminiCliToolUse extends Schema.TaggedClass<GeminiCliToolUse>()("ToolUse", {
  toolName: Schema.optionalKey(Schema.String),
  toolId: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.String)
}) {}

export class GeminiCliToolResult extends Schema.TaggedClass<GeminiCliToolResult>()("ToolResult", {
  toolId: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String)
}) {}

export class GeminiCliError extends Schema.TaggedClass<GeminiCliError>()("Error", {
  message: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.Int),
  errorType: Schema.optionalKey(Schema.String)
}) {}

export class GeminiStreamStats extends Schema.Class<GeminiStreamStats>("GeminiStreamStats")({
  totalTokens: Schema.optionalKey(Schema.Int),
  inputTokens: Schema.optionalKey(Schema.Int),
  outputTokens: Schema.optionalKey(Schema.Int),
  cached: Schema.optionalKey(Schema.Int)
}) {}

export class GeminiCliResult extends Schema.TaggedClass<GeminiCliResult>()("Result", {
  status: Schema.optionalKey(Schema.String),
  errorMessage: Schema.optionalKey(Schema.String),
  stats: Schema.optionalKey(GeminiStreamStats)
}) {}

export const GeminiCliStreamEvent = Schema.Union([
  GeminiCliLogLine,
  GeminiCliInit,
  GeminiCliMessage,
  GeminiCliToolUse,
  GeminiCliToolResult,
  GeminiCliError,
  GeminiCliResult
])
export type GeminiCliStreamEvent = typeof GeminiCliStreamEvent.Type

export const GeminiSandbox = Schema.Literals([
  "Docker",
  "Podman",
  "SeatbeltMacOS",
  "Runsc",
  "Lxc",
  "Default"
])
export type GeminiSandbox = typeof GeminiSandbox.Type

const emptyDirectories: ReadonlyArray<string> = Object.freeze([])

export class GeminiCliExecutionContext extends Schema.Class<GeminiCliExecutionContext>(
  "GeminiCliExecutionContext"
)({
  cwd: Schema.optionalKey(Schema.String),
  includeDirectories: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyDirectories))
  ),
  sandbox: Schema.optionalKey(GeminiSandbox),
  turnLimit: Schema.optionalKey(Schema.Int),
  readOnly: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false)))
}) {}

export const geminiCliExecutionContextFrom = (
  config: CliConnectorConfig
): GeminiCliExecutionContext =>
  GeminiCliExecutionContext.make({
    ...(config.workingDir === undefined ? {} : { cwd: config.workingDir }),
    ...(config.turnLimit === undefined ? {} : { turnLimit: config.turnLimit }),
    readOnly: config.readOnly,
    ...(config.sandbox === undefined
      ? {}
      : {
          sandbox: config.sandbox._tag
        })
  })

export interface GeminiCliExecutorShape {
  readonly checkGeminiInstalled: Effect.Effect<void, LlmError>
  readonly runGeminiProcess: (
    prompt: string,
    config: LlmConfig,
    context: GeminiCliExecutionContext
  ) => Effect.Effect<string, LlmError>
  readonly runGeminiProcessStream: (
    prompt: string,
    config: LlmConfig,
    context: GeminiCliExecutionContext
  ) => Stream.Stream<GeminiCliStreamEvent, LlmError>
}

export class GeminiCliExecutor extends Context.Service<GeminiCliExecutor, GeminiCliExecutorShape>()(
  "@llm4ts/core/providers/GeminiCliExecutor"
) {}

export const geminiSandboxEnvValue = (sandbox: GeminiSandbox): string | undefined => {
  switch (sandbox) {
    case "Docker":
      return "docker"
    case "Podman":
      return "podman"
    case "SeatbeltMacOS":
      return "sandbox-exec"
    case "Runsc":
      return "runsc"
    case "Lxc":
      return "lxc"
    case "Default":
      return undefined
  }
}

export const buildGeminiArgs = (
  config: LlmConfig,
  context: GeminiCliExecutionContext,
  outputFormat: string
): ReadonlyArray<string> => {
  const directories = [...new Set(context.includeDirectories)].flatMap((path) => [
    "--include-directories",
    path
  ])
  return [
    "-m",
    config.model,
    ...(context.readOnly ? ["--approval-mode", "plan"] : ["-y"]),
    "--output-format",
    outputFormat,
    ...directories,
    ...(context.sandbox === undefined ? [] : ["-s"])
  ]
}

export const geminiTurnLimitSettingsJson = (turns: number): string =>
  JSON.stringify({
    model: {
      maxSessionTurns: turns
    }
  })

export const geminiProcessEnv = (
  context: GeminiCliExecutionContext,
  turnLimitSettingsPath?: string
): Readonly<Record<string, string>> => {
  const sandbox = context.sandbox === undefined ? undefined : geminiSandboxEnvValue(context.sandbox)
  return {
    GEMINI_CLI_TRUST_WORKSPACE: "true",
    ...(sandbox === undefined ? {} : { GEMINI_SANDBOX: sandbox }),
    ...(turnLimitSettingsPath === undefined
      ? {}
      : {
          GEMINI_CLI_SYSTEM_DEFAULTS_PATH: turnLimitSettingsPath
        })
  }
}

export const geminiQuotaDiagnostic = (stderr: ReadonlyArray<string>): string | undefined =>
  stderr
    .find((line) => {
      const lower = line.toLowerCase()
      return (
        lower.includes("exhausted your capacity") ||
        lower.includes("quota") ||
        lower.includes("resource_exhausted") ||
        lower.includes("rate_limit") ||
        lower.includes("rate limit") ||
        lower.includes("429")
      )
    })
    ?.trim()

/**
 * The stderr line where Gemini CLI's loop breaker reports that it halted
 * the turn. Surfaced into the stream's error so the retry decorator sees a
 * loop, not an anonymous "[API Error: An unknown error occurred.]".
 */
export const geminiLoopDiagnostic = (stderr: ReadonlyArray<string>): string | undefined =>
  stderr.find((line) => isLoopDetectedMessage(line))?.trim()

export const withGeminiStderrDiagnostic = (
  event: GeminiCliStreamEvent,
  stderr: ReadonlyArray<string>
): GeminiCliStreamEvent => {
  const diagnostic = geminiQuotaDiagnostic(stderr) ?? geminiLoopDiagnostic(stderr)
  if (diagnostic === undefined) {
    return event
  }
  const merged = (base: string | undefined): string => {
    const normalized = base?.trim()
    if (
      normalized !== undefined &&
      (geminiQuotaDiagnostic([normalized]) !== undefined || isLoopDetectedMessage(normalized))
    ) {
      return normalized
    }
    return normalized === undefined || normalized.length === 0
      ? diagnostic
      : `${normalized} — ${diagnostic}`
  }

  switch (event._tag) {
    case "Error":
      return GeminiCliError.make({
        message: merged(event.message),
        ...(event.code === undefined ? {} : { code: event.code }),
        ...(event.errorType === undefined ? {} : { errorType: event.errorType })
      })
    case "Result":
      return event.status === "error"
        ? GeminiCliResult.make({
            status: event.status,
            errorMessage: merged(event.errorMessage),
            ...(event.stats === undefined ? {} : { stats: event.stats })
          })
        : event
    default:
      return event
  }
}

export const validateGeminiExitCode = (
  exitCode: number,
  stderr: string,
  turnLimit?: number
): Effect.Effect<void, LlmError> => {
  switch (exitCode) {
    case 0:
      return Effect.void
    case 42:
      return Effect.fail(InvalidRequestError.make({ message: stderr }))
    case 53:
      return Effect.fail(
        TurnLimitError.make({
          ...(turnLimit === undefined ? {} : { limit: turnLimit })
        })
      )
    default:
      return failClassifiedCliError("gemini", `Gemini CLI exited with code ${exitCode}`, stderr)
  }
}

export const validateGeminiStreamExit = (
  exitCode: number,
  stderr: ReadonlyArray<string>,
  sawAssistantText: boolean,
  turnLimit?: number
): Effect.Effect<void, LlmError> => {
  const diagnostic = geminiQuotaDiagnostic(stderr)
  const loop = geminiLoopDiagnostic(stderr)
  const stderrText = stderr.join("\n").trim()
  if (exitCode === 0) {
    if (sawAssistantText) {
      return Effect.void
    }
    if (diagnostic !== undefined) {
      return failClassifiedCliError("gemini", "Gemini CLI quota exhausted", diagnostic)
    }
    // The loop breaker halts the turn and the process still exits 0: without
    // this the flow would see an empty response and lose the reason.
    return loop === undefined
      ? Effect.void
      : Effect.fail(ProviderError.make({ message: `Gemini CLI halted the turn: ${loop}` }))
  }
  if (exitCode === 42 || exitCode === 53) {
    return validateGeminiExitCode(
      exitCode,
      stderrText.length === 0 ? `Gemini stream process exited with code ${exitCode}` : stderrText,
      turnLimit
    )
  }
  return diagnostic === undefined
    ? validateGeminiExitCode(
        exitCode,
        stderrText.length === 0 ? `Gemini stream process exited with code ${exitCode}` : stderrText,
        turnLimit
      )
    : failClassifiedCliError("gemini", "Gemini CLI quota exhausted", diagnostic)
}

class GeminiHeadlessError extends Schema.Class<GeminiHeadlessError>("GeminiHeadlessError")({
  type: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.Int)
}) {}

class GeminiHeadlessResponse extends Schema.Class<GeminiHeadlessResponse>("GeminiHeadlessResponse")(
  {
    response: Schema.optionalKey(Schema.NullOr(Schema.String)),
    error: Schema.optionalKey(Schema.NullOr(GeminiHeadlessError))
  }
) {}

export type GeminiResponseExtraction =
  | {
      readonly ok: true
      readonly value: string
    }
  | {
      readonly ok: false
      readonly error: string
    }

const preamblePatterns: ReadonlyArray<RegExp> = [
  /^Loaded cached .*/,
  /^Loading extension: .*/,
  /^Server '.+' supports tool updates.*/,
  /^Attempt \d+ failed: .*/,
  /^YOLO mode is enabled.*/
]

export const isGeminiPreambleLine = (line: string): boolean =>
  preamblePatterns.some((pattern) => pattern.test(line))

export const isKnownGeminiStderrNoise = (line: string): boolean => {
  const normalized = line.trim()
  return (
    normalized.length === 0 ||
    normalized.includes("256-color support not detected") ||
    normalized.includes("color support detected") ||
    normalized.includes("support not detected") ||
    normalized.includes("tmux") ||
    normalized.startsWith("set -g ") ||
    normalized.startsWith("set -ga ") ||
    normalized.startsWith("Ripgrep is not available") ||
    normalized.startsWith("YOLO mode is enabled") ||
    normalized.startsWith("Shell cwd was reset to") ||
    normalized.startsWith("Loaded cached") ||
    normalized.startsWith("Loading extension") ||
    normalized.includes("[IDEClient]")
  )
}

const decodeHeadless = (raw: string): GeminiResponseExtraction | undefined => {
  const response = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.fromJsonString(GeminiHeadlessResponse))(raw)
  )
  if (response === undefined) {
    return undefined
  }
  const message = response.error?.message?.trim()
  if (message !== undefined && message.length > 0) {
    const details = [
      response.error?.type === undefined ? undefined : `type=${response.error.type}`,
      response.error?.code === undefined ? undefined : `code=${response.error.code}`
    ].filter((detail) => detail !== undefined)
    return {
      ok: false,
      error:
        details.length === 0
          ? `Gemini CLI returned an error: ${message}`
          : `Gemini CLI returned an error (${details.join(", ")}): ${message}`
    }
  }
  const content = response.response?.trim()
  return content === undefined || content.length === 0
    ? {
        ok: false,
        error: "Gemini CLI JSON output did not contain a response"
      }
    : {
        ok: true,
        value: content
      }
}

export const extractGeminiCliResponse = (output: string): GeminiResponseExtraction => {
  const normalized = output.replaceAll("\r\n", "\n").trim()
  if (normalized.length === 0) {
    return {
      ok: false,
      error: "Gemini CLI returned empty output"
    }
  }

  for (const candidate of jsonCandidates(normalized)) {
    const decoded = decodeHeadless(candidate)
    if (decoded !== undefined) {
      return decoded
    }
  }

  const content = normalized
    .split("\n")
    .filter((line, index, lines) => {
      const previousAccepted = lines
        .slice(0, index)
        .some((prior) => !isGeminiPreambleLine(prior.trim()))
      return previousAccepted || !isGeminiPreambleLine(line.trim())
    })
    .join("\n")
    .trim()
  return content.length === 0
    ? {
        ok: false,
        error: "Failed to decode Gemini CLI JSON output: output did not contain a JSON envelope"
      }
    : {
        ok: true,
        value: content
      }
}

/**
 * Token counts from a `result` event's `stats`.
 *
 * The Gemini CLI reports per-model session metrics, not flat totals:
 * `stats.models["<model>"].tokens` carries `prompt`, `input` (prompt minus
 * cached), `candidates` (the answer), `thoughts` (thinking, billed as
 * output), `cached`, and `total`. Counts are summed across every model a run
 * touched, because one run can span models (a quota fallback from pro to
 * flash reports both). `prompt` maps to the UNCACHED input so it lines up
 * with the pricing table, which bills `cached` separately at its own rate.
 *
 * A flat `{total_tokens, input_tokens, output_tokens, cached}` shape is still
 * accepted: it is the contract this parser shipped with, and dropping it
 * would silently stop reporting usage for anything already emitting it.
 */
export const parseGeminiStreamStats = (
  stats: JsonValue | undefined
): GeminiStreamStats | undefined => {
  if (stats === undefined) {
    return undefined
  }

  let prompt = 0
  let completion = 0
  let total = 0
  let cached = 0
  let sawModelTokens = false
  for (const [, metrics] of jsonObjectEntries(jsonField(stats, "models"))) {
    const tokens = jsonField(metrics, "tokens")
    if (tokens === undefined) {
      continue
    }
    sawModelTokens = true
    const modelCached = jsonIntField(tokens, "cached") ?? 0
    const modelPrompt = jsonIntField(tokens, "prompt") ?? 0
    prompt += jsonIntField(tokens, "input") ?? Math.max(modelPrompt - modelCached, 0)
    completion +=
      (jsonIntField(tokens, "candidates") ?? 0) + (jsonIntField(tokens, "thoughts") ?? 0)
    total += jsonIntField(tokens, "total") ?? 0
    cached += modelCached
  }
  if (sawModelTokens) {
    return GeminiStreamStats.make({
      inputTokens: prompt,
      outputTokens: completion,
      totalTokens: total > 0 ? total : prompt + completion + cached,
      ...(cached === 0 ? {} : { cached })
    })
  }

  const flat = {
    totalTokens: jsonIntField(stats, "total_tokens"),
    inputTokens: jsonIntField(stats, "input_tokens"),
    outputTokens: jsonIntField(stats, "output_tokens"),
    cached: jsonIntField(stats, "cached")
  }
  return GeminiStreamStats.make({
    ...(flat.totalTokens === undefined ? {} : { totalTokens: flat.totalTokens }),
    ...(flat.inputTokens === undefined ? {} : { inputTokens: flat.inputTokens }),
    ...(flat.outputTokens === undefined ? {} : { outputTokens: flat.outputTokens }),
    ...(flat.cached === undefined ? {} : { cached: flat.cached })
  })
}

export const parseGeminiCliStreamEvent = (line: string): GeminiCliStreamEvent => {
  const trimmed = line.trim()
  const json = parseJsonLine(trimmed)
  if (json === undefined) {
    return GeminiCliLogLine.make({ line })
  }

  const nestedError = jsonField(json, "error")
  switch (jsonStringField(json, "type")) {
    case "init":
      return GeminiCliInit.make({
        ...(jsonStringField(json, "model") === undefined
          ? {}
          : { model: jsonStringField(json, "model") ?? "" }),
        ...(jsonStringField(json, "session_id") === undefined
          ? {}
          : { sessionId: jsonStringField(json, "session_id") ?? "" })
      })
    case "message":
      return GeminiCliMessage.make({
        ...(jsonStringField(json, "role") === undefined
          ? {}
          : { role: jsonStringField(json, "role") ?? "" }),
        ...(jsonStringField(json, "content") === undefined
          ? {}
          : { content: jsonStringField(json, "content") ?? "" }),
        delta: jsonField(json, "delta") === true
      })
    case "tool_use":
      return GeminiCliToolUse.make({
        ...(jsonStringField(json, "tool_name") === undefined
          ? {}
          : { toolName: jsonStringField(json, "tool_name") ?? "" }),
        ...(jsonStringField(json, "tool_id") === undefined
          ? {}
          : { toolId: jsonStringField(json, "tool_id") ?? "" }),
        ...(jsonField(json, "parameters") === undefined
          ? {}
          : { input: jsonText(jsonField(json, "parameters") ?? {}) })
      })
    case "tool_result":
      return GeminiCliToolResult.make({
        ...(jsonStringField(json, "tool_id") === undefined
          ? {}
          : { toolId: jsonStringField(json, "tool_id") ?? "" }),
        ...(jsonStringField(json, "status") === undefined
          ? {}
          : { status: jsonStringField(json, "status") ?? "" }),
        ...(jsonStringField(json, "output") === undefined
          ? {}
          : { content: jsonStringField(json, "output") ?? "" })
      })
    case "error": {
      const message =
        jsonStringField(json, "text")?.trim() ||
        jsonStringField(json, "message")?.trim() ||
        jsonStringField(nestedError, "message") ||
        trimmed
      return GeminiCliError.make({
        message,
        ...(jsonIntField(nestedError, "code") === undefined
          ? {}
          : { code: jsonIntField(nestedError, "code") ?? 0 }),
        ...(jsonStringField(nestedError, "type") === undefined
          ? {}
          : { errorType: jsonStringField(nestedError, "type") ?? "" })
      })
    }
    case "result": {
      const decodedStats = parseGeminiStreamStats(jsonField(json, "stats"))
      return GeminiCliResult.make({
        ...(jsonStringField(json, "status") === undefined
          ? {}
          : { status: jsonStringField(json, "status") ?? "" }),
        ...(jsonStringField(nestedError, "message") === undefined
          ? {}
          : {
              errorMessage: jsonStringField(nestedError, "message") ?? ""
            }),
        ...(decodedStats === undefined ? {} : { stats: decodedStats })
      })
    }
    default:
      return GeminiCliLogLine.make({ line })
  }
}

// Any reported count is worth surfacing: dropping partial stats is what
// leaves a run reporting "no usage reported" despite the CLI counting tokens.
const geminiUsage = (stats: GeminiStreamStats | undefined): TokenUsage | undefined => {
  if (
    stats === undefined ||
    (stats.inputTokens === undefined &&
      stats.outputTokens === undefined &&
      stats.totalTokens === undefined)
  ) {
    return undefined
  }
  const prompt = stats.inputTokens ?? 0
  const completion = stats.outputTokens ?? 0
  return TokenUsage.make({
    prompt,
    completion,
    total: stats.totalTokens ?? prompt + completion + (stats.cached ?? 0),
    ...(stats.cached === undefined ? {} : { cached: stats.cached })
  })
}

const formatGeminiHistory = (
  messages: ReadonlyArray<Message>
): Effect.Effect<string, InvalidRequestError> => {
  const system = messages.filter((message) => message.role === "System")
  const turns = messages.filter((message) => message.role !== "System")
  if (turns.length === 0) {
    return Effect.fail(
      InvalidRequestError.make({
        message: "History must contain at least one user or assistant message"
      })
    )
  }
  const systemBlock =
    system.length === 0
      ? ""
      : `[SYSTEM CONTEXT]\n${system.map((message) => message.content).join("\n")}\n---\n\n`
  const history = turns
    .map((message) => {
      const role =
        message.role === "User"
          ? "**User:**"
          : message.role === "Assistant"
            ? "**Assistant:**"
            : message.role
      return `${role} ${message.content}`
    })
    .join("\n\n")
  return Effect.succeed(systemBlock + history)
}

export const makeGeminiCliProvider = (
  config: LlmConfig,
  executor: GeminiCliExecutorShape,
  executionContext: GeminiCliExecutionContext = GeminiCliExecutionContext.make({})
): CliConnectorShape => {
  const healthy = HealthStatus.make({
    availability: "Healthy",
    authStatus: "Valid"
  })
  const unhealthy = HealthStatus.make({
    availability: "Unhealthy",
    authStatus: "Unknown"
  })
  const healthCheck = executor.checkGeminiInstalled.pipe(
    Effect.as(healthy),
    Effect.catch(() => Effect.succeed(unhealthy))
  )

  const executeStream = (prompt: string): Stream.Stream<LlmChunk, LlmError> =>
    Stream.concat(
      Stream.fromEffect(executor.checkGeminiInstalled).pipe(Stream.drain),
      Stream.unwrap(
        Effect.map(
          Ref.make<Readonly<Record<string, string>>>({
            provider: "gemini-cli",
            model: config.model
          }),
          (metadata) =>
            executor.runGeminiProcessStream(prompt, config, executionContext).pipe(
              Stream.flatMap((event) => {
                switch (event._tag) {
                  case "Init":
                    return Stream.fromEffect(
                      Ref.update(metadata, (current) => ({
                        ...current,
                        ...(event.model === undefined ? {} : { model: event.model }),
                        ...(event.sessionId === undefined
                          ? {}
                          : {
                              session_id: event.sessionId,
                              sessionId: event.sessionId
                            })
                      }))
                    ).pipe(Stream.drain)
                  case "Message":
                    return event.role?.toLowerCase() === "assistant" &&
                      event.content !== undefined &&
                      event.content.length > 0
                      ? Stream.fromEffect(
                          Effect.map(Ref.get(metadata), (current) =>
                            LlmChunk.make({
                              delta: event.content ?? "",
                              metadata: current
                            })
                          )
                        )
                      : Stream.empty
                  case "ToolUse":
                    return Stream.fromEffect(
                      Effect.map(Ref.get(metadata), (current) =>
                        LlmChunk.make({
                          delta: "",
                          metadata: {
                            ...current,
                            event: "tool_use",
                            tool_name: event.toolName ?? "",
                            tool_id: event.toolId ?? "",
                            tool_input: event.input ?? "",
                            toolName: event.toolName ?? "",
                            toolId: event.toolId ?? "",
                            toolInput: event.input ?? ""
                          }
                        })
                      )
                    )
                  case "ToolResult":
                    return Stream.fromEffect(
                      Effect.map(Ref.get(metadata), (current) =>
                        LlmChunk.make({
                          delta: "",
                          metadata: {
                            ...current,
                            event: "tool_result",
                            tool_id: event.toolId ?? "",
                            tool_status: event.status ?? "",
                            tool_content: event.content ?? "",
                            toolId: event.toolId ?? "",
                            toolStatus: event.status ?? "",
                            toolResult: event.content ?? ""
                          }
                        })
                      )
                    )
                  case "Error": {
                    const details = [
                      event.errorType === undefined ? undefined : `type=${event.errorType}`,
                      event.code === undefined ? undefined : `code=${event.code}`
                    ].filter((detail) => detail !== undefined)
                    const raw =
                      details.length === 0
                        ? `Gemini CLI stream error: ${event.message ?? "unknown error"}`
                        : `Gemini CLI stream error (${details.join(", ")}): ${event.message ?? "unknown error"}`
                    return Stream.fromEffect(
                      failClassifiedCliError("gemini", "Gemini CLI stream error", raw)
                    )
                  }
                  case "Result":
                    if (event.status === "error") {
                      return Stream.fromEffect(
                        failClassifiedCliError(
                          "gemini",
                          "Gemini CLI returned an error",
                          event.errorMessage ?? "Gemini CLI returned an error"
                        )
                      )
                    }
                    return Stream.fromEffect(
                      Effect.map(Ref.get(metadata), (current) => {
                        const usage = geminiUsage(event.stats)
                        return LlmChunk.make({
                          delta: "",
                          finishReason: "stop",
                          metadata: current,
                          ...(usage === undefined ? {} : { usage })
                        })
                      })
                    )
                  case "LogLine":
                    return Stream.empty
                }
              })
            )
        )
      )
    )

  const complete = Effect.fn("@llm4ts/core/providers/GeminiCliProvider.complete")(function* (
    prompt: string
  ) {
    const output = yield* executor.runGeminiProcess(prompt, config, executionContext)
    const extracted = extractGeminiCliResponse(output)
    return extracted.ok
      ? extracted.value
      : yield* ParseError.make({
          message: extracted.error,
          raw: output
        })
  })

  const base = makeCliConnector({
    id: ConnectorIds.GeminiCli,
    interactionSupport: "InteractiveStdin",
    buildArgv: (prompt, context) => [
      "gemini",
      "--yolo",
      ...(context.repoPath.length === 0 ? [] : ["--include-directories", context.repoPath]),
      "-p",
      prompt
    ],
    buildInteractiveArgv: (context) => [
      "gemini",
      "--yolo",
      ...(context.repoPath.length === 0 ? [] : ["--include-directories", context.repoPath])
    ],
    complete,
    completeStream: executeStream,
    healthCheck,
    isAvailable: Effect.map(healthCheck, (status) => status.availability === "Healthy")
  })

  const executeStructuredWithUsage = <A, E, RD, RE>(
    prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    jsonSchema: JsonSchema
  ): Effect.Effect<StructuredResult<A>, LlmError, RD> =>
    Effect.gen(function* () {
      const hinted = withSchemaHint(prompt, jsonSchema)
      const response = yield* collect(executeStream(hinted))
      const value = yield* parseFromText(response.content, schema, jsonSchema).pipe(
        Effect.mapError((error) => {
          if (error._tag !== "ProviderError" || !error.message.includes("empty response")) {
            return error
          }
          const model = response.metadata.model ?? config.model
          const usage =
            response.usage === undefined
              ? "no token usage reported"
              : `input_tokens=${response.usage.prompt}, output_tokens=${response.usage.completion}`
          return ProviderError.make({
            message: `${error.message} (model=${model}, prompt=${hinted.length} chars, ${usage})`,
            ...(error.cause === undefined ? {} : { cause: error.cause })
          })
        })
      )
      const result: StructuredResult<A> = [value, response.usage, response.metadata.model]
      return result
    })

  return {
    ...base,
    executeStream,
    executeStreamWithHistory: (messages) =>
      Stream.unwrap(Effect.map(formatGeminiHistory(messages), (history) => executeStream(history))),
    executeStructured: <A, E, RD, RE>(
      prompt: string,
      schema: Schema.ConstraintCodec<A, E, RD, RE>,
      jsonSchema: JsonSchema
    ): Effect.Effect<A, LlmError, RD> =>
      Effect.map(executeStructuredWithUsage(prompt, schema, jsonSchema), ([value]) => value),
    executeStructuredWithUsage
  }
}
