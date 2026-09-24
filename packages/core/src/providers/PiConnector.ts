import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { makeCliConnector, type CliConnectorShape } from "../Connector.ts"
import type { CliConnectorConfig } from "../ConnectorConfig.ts"
import { ProviderError } from "../Errors.ts"
import { ConnectorCapabilities, ConnectorIds, LlmChunk, TokenUsage } from "../Models.ts"
import type { ProcessExecutorShape } from "../ProcessExecutor.ts"
import {
  failClassifiedCliError,
  jsonBooleanField,
  jsonField,
  jsonIntField,
  jsonStringField,
  optionalModelArgs,
  parseJsonLine,
  sortedFlagArgs,
  toolEventChunk,
  usageEventChunk
} from "./CliSupport.ts"

export const piExtraArgs = (config: CliConnectorConfig): ReadonlyArray<string> => [
  ...optionalModelArgs(config.model),
  // `noTools` takes precedence over `readOnly`: `--no-tools` disables tool
  // offering entirely (pi's own flag for it), while `--tools read` still
  // offers a read tool the model can invoke — fine for an interactive
  // session, unsafe for a one-shot complete() call with no tool-loop
  // continuation (see the field's doc comment on CliConnectorConfig).
  ...(config.noTools ? ["--no-tools"] : config.readOnly ? ["--tools", "read"] : []),
  ...sortedFlagArgs(config.flags)
]

export const parsePiStreamLine = (line: string): ReadonlyArray<LlmChunk> => {
  const json = parseJsonLine(line)
  if (json === undefined) {
    return []
  }

  switch (jsonStringField(json, "type")) {
    case "message_update": {
      const event = jsonField(json, "assistantMessageEvent")
      const delta =
        jsonStringField(event, "type") === "text_delta"
          ? jsonStringField(event, "delta")
          : undefined
      return delta === undefined || delta.length === 0 ? [] : [LlmChunk.make({ delta })]
    }
    case "tool_execution_start":
      return [toolEventChunk(jsonStringField(json, "toolName") ?? "", jsonField(json, "args"))]
    case "message_end":
    case "agent_end": {
      const message = jsonField(json, "message")
      // pi reports a provider refusal (a usage limit, an auth failure) as an
      // assistant message that stopped with an error and exits 0; without
      // this it reads as an empty, successful reply.
      if (jsonStringField(message, "stopReason") === "error") {
        return [
          LlmChunk.make({
            delta: "",
            metadata: {
              piError: jsonStringField(message, "errorMessage") ?? "pi stopped with an error"
            }
          })
        ]
      }
      const usage = jsonField(message, "usage")
      if (usage === undefined) {
        return []
      }
      const prompt = jsonIntField(usage, "input") ?? 0
      const completion = jsonIntField(usage, "output") ?? 0
      return [
        usageEventChunk(
          undefined,
          TokenUsage.make({
            prompt,
            completion,
            total: prompt + completion
          })
        )
      ]
    }
    case "auto_retry_end":
      return jsonBooleanField(json, "success") === false
        ? [
            LlmChunk.make({
              delta: "",
              metadata: {
                piError: jsonStringField(json, "finalError") ?? "pi retry failed"
              }
            })
          ]
        : []
    case "extension_error":
      return [
        LlmChunk.make({
          delta: "",
          metadata: {
            piError: jsonStringField(json, "error") ?? "pi extension error"
          }
        })
      ]
    default:
      return []
  }
}

export const makePiConnector = (
  config: CliConnectorConfig,
  executor: ProcessExecutorShape
): CliConnectorShape => {
  const cwd = config.workingDir ?? "."
  const extraArgs = piExtraArgs(config)

  const complete = Effect.fn("@llm4ts/core/providers/PiConnector.complete")(function* (
    prompt: string
  ) {
    const result = yield* executor.runWithStdin(
      ["pi", "-p", ...extraArgs],
      cwd,
      config.envVars,
      prompt
    )
    if (result.exitCode !== 0) {
      // pi explains a refusal on stderr (a usage error, a missing model, an
      // auth failure); stdout is empty then, so both streams are reported.
      const detail = [...result.stdout, ...result.stderr].join("\n").trim()
      if (detail.length === 0) {
        return yield* ProviderError.make({ message: `pi exited with code ${result.exitCode}` })
      }
      // A usage limit is typed, so a roster can take pi out of the round (ADR 0019).
      return yield* failClassifiedCliError("pi", `pi exited with code ${result.exitCode}`, detail)
    }
    return result.stdout.join("\n")
  })

  const completeStream = (prompt: string) =>
    executor
      .runStreamingWithStdin(
        ["pi", "-p", "--mode", "json", ...extraArgs],
        cwd,
        config.envVars,
        prompt
      )
      .pipe(
        Stream.flatMap((line) => Stream.fromIterable(parsePiStreamLine(line))),
        Stream.mapEffect((chunk) => {
          const message = chunk.metadata.piError
          return message === undefined
            ? Effect.succeed(chunk)
            : failClassifiedCliError("pi", "pi error", message)
        })
      )

  return makeCliConnector({
    id: ConnectorIds.Pi,
    interactionSupport: "InteractiveStdin",
    // `--tools read` is pi's documented comma-separated ALLOWLIST of tool
    // names: only `read` is enabled, so bash/edit/write are absent — a real
    // capability removal, the same mechanism class as claude's `--tools`.
    capabilities: ConnectorCapabilities.make({
      interactiveSessions: true,
      readOnlyEnforcement: "enforced"
    }),
    buildArgv: (prompt, _context) => ["pi", "-p", ...extraArgs, prompt],
    buildInteractiveArgv: (_context) => ["pi", ...extraArgs],
    complete,
    completeStream,
    versionProbe: { executor, binary: "pi", cwd }
  })
}
