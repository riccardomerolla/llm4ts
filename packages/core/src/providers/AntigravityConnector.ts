import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { makeCliConnector, type CliConnectorShape } from "../Connector.ts"
import type { CliConnectorConfig } from "../ConnectorConfig.ts"
import {
  ConnectorCapabilities,
  ConnectorIds,
  LlmChunk,
  TokenUsage,
  cliExecutable
} from "../Models.ts"
import type { ProcessExecutorShape } from "../ProcessExecutor.ts"
import { collect } from "../Streaming.ts"
import {
  cumulativeUsage,
  failClassifiedCliError,
  jsonArray,
  jsonField,
  jsonIntField,
  jsonNumberField,
  jsonStringField,
  optionalModelArgs,
  parseJsonLine,
  sortedFlagArgs,
  toolEventChunk,
  toolResultChunk,
  usageEventChunk,
  type JsonValue
} from "./CliSupport.ts"

const executable = cliExecutable("AntigravityCli")

/**
 * What a read-only seat passes as `--settings` (session only, never saved):
 * deny rules, which agy applies as a hard block before a tool runs. Observed
 * on agy 1.5.17: a file write and a shell command both fail with "Matches
 * user-configured deny rule" and the model answers in its own voice.
 *
 * `--mode plan` is not used: it removes no tool from the advertised list and
 * replaces the task with a planning workflow (write a plan, ask for
 * approval), so a judge asked for JSON answers with a plan instead.
 */
export const antigravityReadOnlySettings = JSON.stringify({
  permissions: { deny: ["command(*)", "write_file(*)"] }
})

// What a read-only seat must not carry over from a coder's flags: `mode`
// (see above) and the flag that approves every permission request.
const notForReadOnly: ReadonlySet<string> = new Set(["mode", "dangerously-skip-permissions"])

const readOnlyFlags = (
  flags: Readonly<Record<string, string>>
): Readonly<Record<string, string>> => ({
  // A `settings` flag the operator wrote wins, as `flags.tools` does on claude.
  settings: antigravityReadOnlySettings,
  ...Object.fromEntries(Object.entries(flags).filter(([key]) => !notForReadOnly.has(key)))
})

/**
 * `config.effort` reaches no argument. agy names the effort in the model id
 * (`gemini-3.8-flash-high`), and `--effort` fails the turn when the id names
 * another level ("conflicts with --effort=low") or the model has no such
 * level ("gpt-oss-120b has no "max" effort"): a roster's effort knob would
 * break the seat. An operator who wants one passes it as a flag.
 */
export const antigravityExtraArgs = (config: CliConnectorConfig): ReadonlyArray<string> => {
  const workspaceArgs = config.workingDir === undefined ? [] : ["--add-dir", config.workingDir]
  const effectiveFlags = config.readOnly ? readOnlyFlags(config.flags) : config.flags

  return [...workspaceArgs, ...optionalModelArgs(config.model), ...sortedFlagArgs(effectiveFlags)]
}

/** The one-shot command with the prompt as an argument, for a caller that has no stdin to give. */
export const buildAntigravityArgv = (
  config: CliConnectorConfig,
  prompt: string
): ReadonlyArray<string> => [executable, ...antigravityExtraArgs(config), "--print", prompt]

/**
 * The command a turn runs. The prompt is not in it: with an output format
 * and no `--print`, agy reads the prompt from stdin, so a long prompt meets
 * no argument-size limit and does not show in the process list.
 */
export const antigravityStreamArgv = (config: CliConnectorConfig): ReadonlyArray<string> => [
  executable,
  ...antigravityExtraArgs(config),
  "--output-format",
  "stream-json"
]

/** The model agy says it is running, from the `init` event that opens a turn. */
export const antigravityInitModel = (line: string): string | undefined => {
  const json = parseJsonLine(line)
  return json !== undefined && jsonStringField(json, "event") === "init"
    ? jsonStringField(jsonField(json, "init"), "model")
    : undefined
}

const usageOf = (usage: JsonValue | undefined): TokenUsage | undefined => {
  const prompt = jsonIntField(usage, "input_tokens")
  const completion = jsonIntField(usage, "output_tokens")
  if (prompt === undefined || completion === undefined) {
    return undefined
  }
  // `input_tokens` leaves the cache reads out; they are reported beside it.
  const cached = jsonIntField(usage, "cache_read_tokens")
  return TokenUsage.make({
    prompt,
    completion,
    total: jsonIntField(usage, "total_tokens") ?? prompt + completion,
    ...(cached === undefined || cached === 0 ? {} : { cached })
  })
}

const errorChunk = (message: string): LlmChunk =>
  LlmChunk.make({ delta: "", metadata: { antigravityError: message } })

const toolChunks = (update: JsonValue | undefined): ReadonlyArray<LlmChunk> => {
  const index = jsonIntField(update, "step_index")
  const id = index === undefined ? undefined : String(index)
  const info = jsonField(update, "tool_info")
  switch (jsonStringField(update, "state")) {
    case "ACTIVE":
      return [
        toolEventChunk(
          jsonStringField(update, "tool_name") ?? jsonStringField(info, "name") ?? "tool",
          jsonField(info, "parameters"),
          id
        )
      ]
    case "DONE":
    case "ERROR": {
      const failed = jsonStringField(update, "state") === "ERROR"
      const output = failed
        ? jsonStringField(jsonField(info, "error"), "message")
        : jsonStringField(info, "output")
      const seconds = jsonNumberField(update, "duration_seconds")
      return [
        toolResultChunk(id, {
          failed,
          ...(output === undefined ? {} : { output }),
          ...(seconds === undefined ? {} : { durationMs: seconds * 1_000 })
        })
      ]
    }
    default:
      return []
  }
}

const resultChunks = (result: JsonValue | undefined): ReadonlyArray<LlmChunk> => {
  const error = jsonStringField(result, "error")
  if (jsonStringField(result, "status") === "ERROR" || (error !== undefined && error.length > 0)) {
    return [errorChunk(error === undefined || error.length === 0 ? "agy reported an error" : error)]
  }
  // A tool that needs a permission ends a headless turn "SUCCESS" with no
  // reply: nobody is there to ask. That is a failed turn, not an empty answer.
  const denied = jsonArray(jsonField(result, "denied_actions")).map(
    (action) =>
      jsonStringField(action, "display_name") ?? jsonStringField(action, "action") ?? "a tool"
  )
  if (denied.length > 0 && (jsonStringField(result, "response") ?? "").trim().length === 0) {
    return [
      errorChunk(
        `agy denied ${denied.join(", ")} and ended the turn without a reply: a headless run ` +
          "cannot be asked for a permission. Allow it under permissions.allow in agy's " +
          "settings.json, or run the seat without a `mode` flag"
      )
    ]
  }
  return [LlmChunk.make({ delta: "", finishReason: "stop" })]
}

/**
 * One line of `agy --output-format stream-json` (1.5.17): `init`, then a
 * `step_update` per step state, then one `result`. Text arrives as
 * `text_delta` on `agent_response` steps, usage on the update that ends one.
 * The `result` repeats the turn's total usage, which is not read: the steps
 * already carried it.
 */
export const parseAntigravityStreamLine = (line: string): ReadonlyArray<LlmChunk> => {
  const json = parseJsonLine(line)
  if (json === undefined) {
    return []
  }

  switch (jsonStringField(json, "event")) {
    case "step_update": {
      const update = jsonField(json, "step_update")
      switch (jsonStringField(update, "step_type")) {
        case "agent_response": {
          const text = jsonStringField(update, "text_delta")
          const usage = usageOf(jsonField(update, "usage"))
          return [
            ...(text === undefined || text.length === 0 ? [] : [LlmChunk.make({ delta: text })]),
            ...(usage === undefined ? [] : [usageEventChunk(undefined, usage)])
          ]
        }
        case "tool":
          return toolChunks(update)
        default:
          return []
      }
    }
    case "result":
      return resultChunks(jsonField(json, "result"))
    default:
      return []
  }
}

export const makeAntigravityConnector = (
  config: CliConnectorConfig,
  executor: ProcessExecutorShape
): CliConnectorShape => {
  const cwd = config.workingDir ?? "."
  const argv = antigravityStreamArgv(config)

  const completeStream = (prompt: string) =>
    Stream.unwrap(
      Effect.map(Ref.make<string | undefined>(config.model), (model) =>
        executor.runStreamingWithStdin(argv, cwd, config.envVars, prompt).pipe(
          // A turn that fails before its `result` (a refused flag, a crash)
          // says why on stderr, which the executor puts in the failure's
          // message: an exhausted quota there is typed like one in a result.
          // Anything else fails as it did.
          Stream.catch((error) =>
            Stream.fromEffect(
              failClassifiedCliError("antigravity", "agy failed", error.message).pipe(
                Effect.catchTag("ProviderError", () => Effect.fail(error))
              )
            )
          ),
          Stream.tap((line) => {
            const served = antigravityInitModel(line)
            return served === undefined ? Effect.void : Ref.set(model, served)
          }),
          Stream.flatMap((line) => Stream.fromIterable(parseAntigravityStreamLine(line))),
          // agy reports usage per model response; a turn is all of them.
          cumulativeUsage,
          Stream.mapEffect((chunk) => {
            const message = chunk.metadata.antigravityError
            if (message !== undefined) {
              return failClassifiedCliError("antigravity", "agy error", message)
            }
            return chunk.usage === undefined
              ? Effect.succeed(chunk)
              : Effect.map(Ref.get(model), (served) =>
                  served === undefined
                    ? chunk
                    : LlmChunk.make({ ...chunk, metadata: { ...chunk.metadata, model: served } })
                )
          })
        )
      )
    )

  const complete = Effect.fn("@llm4ts/core/providers/AntigravityConnector.complete")(function* (
    prompt: string
  ) {
    const reply = yield* collect(completeStream(prompt))
    return reply.content
  })

  return makeCliConnector({
    id: ConnectorIds.AntigravityCli,
    interactionSupport: "InteractiveStdin",
    // Read-only is a pair of deny rules, a hard block seen on a file write
    // and a shell command. It stays `advisory` (the default): the browser,
    // MCP, notebook and subagent tools were not each observed under it.
    capabilities: ConnectorCapabilities.make({ interactiveSessions: true }),
    buildArgv: (prompt, _context) => buildAntigravityArgv(config, prompt),
    buildInteractiveArgv: (_context) => [executable, ...antigravityExtraArgs(config)],
    complete,
    completeStream,
    // No auth probe: agy 1.5.17 has no login-status subcommand; Unknown.
    versionProbe: { executor, binary: executable, cwd }
  })
}
