import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import type { LlmError } from "@llm4ts/core/Errors"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import type { TemporaryFilesShape } from "@llm4ts/core/TemporaryFiles"
import { runGeminiAcpBridge } from "./NodeGeminiAcpBridge.ts"
import { runGeminiModelBridge, systemAdminPolicies } from "./NodeGeminiModelBridge.ts"

/**
 * `llm4ts gemini-bridge`: the Gemini bridge on its own, outside any flow
 * run, so `pi` (or any OpenAI-compatible client) can use the Gemini CLI
 * subscription directly. ADR 0016 deferred this entry point; ADR 0037's
 * model mode makes it an OpenAI-compatible server like LM Studio's. The
 * bridge's code is the flow runner's; only the caller changes.
 */

export interface GeminiBridgeOptions {
  readonly port: number
  /** `model` (OpenAI chat completions, ADR 0037) or `acp` (Anthropic Messages, ADR 0016). */
  readonly mode: "model" | "acp"
  /** The Gemini model every request runs on, whatever the client names. */
  readonly model?: string
}

export interface GeminiBridgeDependencies {
  readonly executor: ProcessExecutorShape
  readonly temporaryFiles: TemporaryFilesShape
  /** Gemini CLI's system admin policy files; this machine's by default. */
  readonly systemPolicies?: ReadonlyArray<string>
  readonly log: (line: string) => Effect.Effect<void>
  /** Runs while the bridge serves; the bridge stops when it ends (Ctrl-C in the CLI). */
  readonly until: (baseUrl: string) => Effect.Effect<void>
}

/** The model id the printed pi config names when `--model` names none. */
export const defaultBridgeModelId = "gemini-3.8-flash"

/** pi's provider entry for `~/.pi/agent/models.json`, for this mode and port. */
export const piProviderSnippet = (mode: "model" | "acp", port: number, model: string): string =>
  JSON.stringify(
    {
      providers: {
        "gemini-bridge": {
          baseUrl: mode === "model" ? `http://127.0.0.1:${port}/v1` : `http://127.0.0.1:${port}`,
          api: mode === "model" ? "openai-completions" : "anthropic-messages",
          apiKey: "bridge-unused",
          models: [{ id: model }]
        }
      }
    },
    null,
    2
  )

export const makeGeminiBridgeProgram = (
  options: GeminiBridgeOptions,
  dependencies: GeminiBridgeDependencies
): Effect.Effect<void, LlmError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const model = options.model === undefined ? {} : { model: options.model }
      const running =
        options.mode === "model"
          ? yield* Effect.flatMap(
              // An empty directory, so no project GEMINI.md reaches the model.
              Effect.acquireRelease(
                Effect.sync(() => mkdtempSync(join(tmpdir(), "llm4ts-gemini-model-"))),
                (directory) =>
                  Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
              ),
              (scratch) =>
                runGeminiModelBridge({
                  port: options.port,
                  cwd: scratch,
                  executor: dependencies.executor,
                  temporaryFiles: dependencies.temporaryFiles,
                  systemPolicies: dependencies.systemPolicies ?? systemAdminPolicies(),
                  ...model
                })
            )
          : yield* runGeminiAcpBridge({
              port: options.port,
              cwd: process.cwd(),
              executor: dependencies.executor,
              ...model
            })
      const id = options.model ?? defaultBridgeModelId
      const url = options.mode === "model" ? `${running.baseUrl}/v1` : running.baseUrl
      yield* Effect.forEach(
        [
          `gemini bridge (${options.mode === "model" ? "model mode: OpenAI chat completions" : "ACP mode: Anthropic Messages"}) listening on ${url}`,
          "",
          "pi provider for ~/.pi/agent/models.json:",
          piProviderSnippet(options.mode, running.port, id),
          "",
          `then: pi --model gemini-bridge/${id}`,
          ...(options.mode === "model"
            ? [
                "",
                "Only Gemini CLI talks to Google, under its own login. Its terms forbid direct",
                "third-party access to its services; confirm with Google before relying on this",
                "(`LLM4TS_GEMINI_BRIDGE=1 LLM4TS_GEMINI_BRIDGE_MODE=model llm4ts doctor` quotes them)."
              ]
            : []),
          "",
          "Ctrl-C stops it."
        ],
        dependencies.log,
        { discard: true }
      )
      yield* dependencies.until(running.baseUrl)
    })
  )
