import { existsSync, readdirSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { InvalidRequestError, ProviderError, type LlmError } from "@llm4ts/core/Errors"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import type { TemporaryFilesShape } from "@llm4ts/core/TemporaryFiles"
import type { JsonValue } from "@llm4ts/core/providers/CliSupport"
import { parseGeminiCliStreamEvent } from "@llm4ts/core/providers/GeminiCliProvider"
import {
  chatRequestFrom,
  completionChunks,
  completionJson,
  correctionTranscript,
  denyAllToolsPolicyToml,
  modelModeSettingsJson,
  openAiUsage,
  parseModelReply,
  systemFileFor,
  transcriptFor,
  type GeminiTokens,
  type ModelReply,
  type OpenAiUsage
} from "@llm4ts/core/providers/GeminiModelBridge"
import {
  acquireServer,
  errorStatus,
  parseJsonBody,
  readBody,
  requestPath,
  writeJson
} from "./NodeGeminiAcpBridge.ts"

/**
 * The bridge's model route (ADR 0037): `/v1/chat/completions` in OpenAI's
 * shape, for pi's `"api": "openai-completions"` custom provider. Each
 * request is one `gemini` call with Gemini CLI's own agent switched off —
 * pi's system prompt in place of Gemini's (`GEMINI_SYSTEM_MD`), every tool
 * denied by an admin policy, sub-agents off in the system settings — so
 * Gemini answers as a plain model and pi runs its own tools. Only Gemini
 * CLI talks to Google, under its own login; this module never reads or
 * forwards a credential.
 */

export interface GeminiModelCallConfig {
  readonly executor: ProcessExecutorShape
  readonly temporaryFiles: TemporaryFilesShape
  /** Where `gemini` runs: an empty directory, so no project GEMINI.md is read. */
  readonly cwd: string
  /** The Gemini model, overriding the one pi's request names (`LLM4TS_GEMINI_MODEL`). */
  readonly model?: string
  readonly envVars?: Readonly<Record<string, string>>
}

export interface GeminiModelBridgeConfig extends GeminiModelCallConfig {
  readonly port: number
  /**
   * `.toml` files in Gemini CLI's standard system policy directory: with
   * any, the CLI ignores `--admin-policy`, so the tools would stay in view.
   * Default: what is on this machine (`systemAdminPolicies`).
   */
  readonly systemPolicies?: ReadonlyArray<string>
}

export interface RunningGeminiModelBridge {
  readonly port: number
  readonly baseUrl: string
}

/** The standard directories Gemini CLI reads system (admin) policies from. */
export const systemPolicyDirectories: ReadonlyArray<string> = [
  "/etc/gemini-cli/policies",
  "/Library/Application Support/GeminiCli/policies",
  "C:\\ProgramData\\gemini-cli\\policies"
]

/** The admin policy files on this machine that would make Gemini CLI ignore `--admin-policy`. */
export const systemAdminPolicies = (): ReadonlyArray<string> =>
  systemPolicyDirectories.flatMap((directory) => {
    try {
      return existsSync(directory)
        ? readdirSync(directory)
            .filter((file) => file.endsWith(".toml"))
            .map((file) => join(directory, file))
        : []
    } catch {
      return []
    }
  })

export const systemPolicyProblem = (policies: ReadonlyArray<string>): string =>
  [
    `Gemini CLI has system admin policies (${policies.join(", ")}), so it ignores the`,
    "--admin-policy the model bridge relies on to take every tool out of the model's view.",
    "The bridge will not run Gemini with its tools still in reach (ADR 0037); use",
    "LLM4TS_GEMINI_BRIDGE_MODE=acp, or ask the administrator to allow this policy."
  ].join(" ")

interface GeminiTurn {
  readonly text: string
  readonly tokens: GeminiTokens | undefined
}

/** One `gemini` call over `transcript`, its system file and lock-down written for the call. */
const geminiTurn = (
  config: GeminiModelCallConfig,
  model: string,
  system: string,
  transcript: string
): Effect.Effect<GeminiTurn, LlmError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const systemFile = yield* config.temporaryFiles.write("gemini-system-", ".md", system)
      const settings = yield* config.temporaryFiles.write(
        "gemini-settings-",
        ".json",
        modelModeSettingsJson
      )
      const policy = yield* config.temporaryFiles.write(
        "gemini-deny-all-",
        ".toml",
        denyAllToolsPolicyToml
      )
      const events = yield* Stream.runCollect(
        config.executor
          .runStreamingWithStdin(
            [
              "gemini",
              // Bound to its flag, so it can never read as a flag of its own.
              `--model=${model}`,
              "--output-format",
              "stream-json",
              "-e",
              "none",
              "--admin-policy",
              policy
            ],
            config.cwd,
            {
              ...config.envVars,
              GEMINI_CLI_TRUST_WORKSPACE: "true",
              GEMINI_SYSTEM_MD: systemFile,
              GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings
            },
            transcript
          )
          .pipe(Stream.map(parseGeminiCliStreamEvent))
      )
      let text = ""
      let tokens: GeminiTokens | undefined
      for (const event of events) {
        switch (event._tag) {
          case "Message":
            if (event.role === "assistant" && event.content !== undefined) {
              text += event.content
            }
            break
          case "Error":
            return yield* ProviderError.make({
              message: `gemini: ${event.message ?? "error"}`
            })
          case "Result":
            if (event.status === "error") {
              return yield* ProviderError.make({
                message: `gemini: ${event.errorMessage ?? "the call failed"}`
              })
            }
            tokens =
              event.stats === undefined
                ? undefined
                : {
                    ...(event.stats.inputTokens === undefined
                      ? {}
                      : { inputTokens: event.stats.inputTokens }),
                    ...(event.stats.outputTokens === undefined
                      ? {}
                      : { outputTokens: event.stats.outputTokens }),
                    ...(event.stats.cached === undefined ? {} : { cached: event.stats.cached })
                  }
            break
          default:
            break
        }
      }
      return { text, tokens }
    })
  )

const addTokens = (
  left: GeminiTokens | undefined,
  right: GeminiTokens | undefined
): GeminiTokens => ({
  inputTokens: (left?.inputTokens ?? 0) + (right?.inputTokens ?? 0),
  outputTokens: (left?.outputTokens ?? 0) + (right?.outputTokens ?? 0),
  cached: (left?.cached ?? 0) + (right?.cached ?? 0)
})

/** The largest request the bridge reads: a long conversation, not an unbounded upload. */
const maxRequestBytes = 32 * 1024 * 1024

/** What a Gemini model id looks like: `gemini-3.8-flash`, `gemini-2.5-pro-001`. */
const modelName = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u

export interface ChatCompletionOutcome {
  readonly model: string
  readonly reply: ModelReply
  readonly usage: OpenAiUsage
}

/**
 * One chat completion: a `gemini` call, and a second one only when the
 * first reply holds a tool call that cannot be used — the model then sees
 * its reply and why. A second bad reply goes back to pi as text.
 */
export const handleChatCompletion = Effect.fn("@llm4ts/runner/NodeGeminiModelBridge.handle")(
  function* (
    config: GeminiModelCallConfig,
    body: JsonValue
  ): Effect.fn.Return<ChatCompletionOutcome, LlmError | InvalidRequestError> {
    const request = chatRequestFrom(body)
    if (request._tag === "Invalid") {
      return yield* InvalidRequestError.make({ message: request.reason })
    }
    const model = config.model ?? request.model
    // The model reaches Gemini CLI's arguments: a name only, never a flag.
    if (!modelName.test(model)) {
      return yield* InvalidRequestError.make({
        message: `"${model}" is not a model name (letters, digits, . _ : -, starting with a letter or digit)`
      })
    }
    const system = systemFileFor(request)
    const transcript = transcriptFor(request.messages)
    const toolNames = request.tools.map((tool) => tool.name)
    const first = yield* geminiTurn(config, model, system, transcript)
    const reply = parseModelReply(first.text, toolNames)
    if (reply._tag !== "Malformed") {
      return { model, reply, usage: openAiUsage(first.tokens) }
    }
    const second = yield* geminiTurn(
      config,
      model,
      system,
      correctionTranscript(transcript, first.text, reply.error)
    )
    return {
      model,
      reply: parseModelReply(second.text, toolNames),
      usage: openAiUsage(addTokens(first.tokens, second.tokens))
    }
  }
)

let completions = 0
const nextIds = (): { readonly id: string; readonly callId: string } => {
  completions += 1
  return { id: `chatcmpl-llm4ts-${completions}`, callId: `call_llm4ts_${completions}` }
}

const writeChunks = (response: ServerResponse, chunks: ReadonlyArray<JsonValue>): void => {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  })
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  response.write("data: [DONE]\n\n")
  response.end()
}

const streamWanted = (body: JsonValue): boolean => {
  const request = chatRequestFrom(body)
  return request._tag === "Request" && request.stream
}

export const runGeminiModelBridge = Effect.fn("@llm4ts/runner/NodeGeminiModelBridge.run")(
  function* (
    config: GeminiModelBridgeConfig
  ): Effect.fn.Return<RunningGeminiModelBridge, LlmError, Scope.Scope> {
    const policies = config.systemPolicies ?? systemAdminPolicies()
    if (policies.length > 0) {
      return yield* ProviderError.make({ message: systemPolicyProblem(policies) })
    }

    const listener = (request: IncomingMessage, response: ServerResponse): void => {
      if (request.method !== "POST" || requestPath(request.url) !== "/v1/chat/completions") {
        writeJson(response, 404, { error: { message: "not found" } })
        return
      }
      // pi posts JSON from Node, with no Origin. A browser page posting to
      // this loopback port (a cross-site form needs no preflight as
      // text/plain) is refused before anything runs.
      const contentType = request.headers["content-type"] ?? ""
      // A DNS name rebound to 127.0.0.1 still sends its own Host.
      const host = (request.headers.host ?? "").replace(/:\d+$/u, "")
      if (
        request.headers.origin !== undefined ||
        !contentType.includes("application/json") ||
        !["127.0.0.1", "localhost", "[::1]"].includes(host)
      ) {
        writeJson(response, 403, {
          error: { message: "the bridge answers JSON requests from local tools only" }
        })
        return
      }
      const handled = Effect.gen(function* () {
        const body = yield* parseJsonBody(yield* readBody(request, maxRequestBytes))
        const outcome = yield* handleChatCompletion(config, body)
        const { id, callId } = nextIds()
        const created = Math.floor(Date.now() / 1000)
        if (streamWanted(body)) {
          return yield* Effect.sync(() =>
            writeChunks(
              response,
              completionChunks(id, outcome.model, outcome.reply, outcome.usage, created, callId)
            )
          )
        }
        return yield* Effect.sync(() =>
          writeJson(
            response,
            200,
            completionJson(id, outcome.model, outcome.reply, outcome.usage, created, callId)
          )
        )
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            if (!response.headersSent) {
              writeJson(response, errorStatus(error), { error: { message: error.message } })
            }
          })
        )
      )
      Effect.runPromise(handled).catch((defect: unknown) => {
        if (!response.headersSent) {
          writeJson(response, 500, { error: { message: String(defect) } })
        }
      })
    }

    const server = yield* acquireServer(config.port, listener)
    const address = server.address()
    const port = address !== null && typeof address !== "string" ? address.port : config.port
    return { port, baseUrl: `http://127.0.0.1:${port}` }
  }
)
