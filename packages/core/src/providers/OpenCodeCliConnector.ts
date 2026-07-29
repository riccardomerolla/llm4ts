import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { makeCliConnector, type CliConnectorShape } from "../Connector.ts"
import type { CliConnectorConfig } from "../ConnectorConfig.ts"
import { ConnectorIds, LlmChunk, TokenUsage } from "../Models.ts"
import type { ProcessExecutorShape } from "../ProcessExecutor.ts"
import {
  failClassifiedCliError,
  jsonField,
  jsonIntField,
  jsonStringField,
  optionalModelArgs,
  parseJsonLine,
  sortedFlagArgs,
  toolEventChunk,
  usageEventChunk
} from "./CliSupport.ts"

export const openCodeCliExtraArgs = (config: CliConnectorConfig): ReadonlyArray<string> => [
  ...optionalModelArgs(config.model),
  ...(config.readOnly ? ["--agent", "plan"] : ["--auto"]),
  ...sortedFlagArgs(config.flags)
]

export const parseOpenCodeCliStreamLine = (line: string): ReadonlyArray<LlmChunk> => {
  const json = parseJsonLine(line)
  if (json === undefined) {
    return []
  }

  const part = jsonField(json, "part")
  switch (jsonStringField(json, "type")) {
    case "text": {
      const text = jsonStringField(part, "text")
      return text === undefined || text.length === 0 ? [] : [LlmChunk.make({ delta: text })]
    }
    case "tool_use":
      return part === undefined
        ? []
        : [
            toolEventChunk(
              jsonStringField(part, "tool") ?? "",
              jsonField(jsonField(part, "state"), "input")
            )
          ]
    case "step_finish": {
      const tokens = jsonField(part, "tokens")
      if (tokens === undefined) {
        return []
      }
      const prompt = jsonIntField(tokens, "input") ?? 0
      const completion = jsonIntField(tokens, "output") ?? 0
      const cached = jsonIntField(jsonField(tokens, "cache"), "read")
      return [
        usageEventChunk(
          undefined,
          TokenUsage.make({
            prompt,
            completion,
            total: jsonIntField(tokens, "total") ?? prompt + completion,
            ...(cached === undefined ? {} : { cached })
          })
        )
      ]
    }
    case "error":
      return [
        LlmChunk.make({
          delta: "",
          metadata: {
            opencodeError:
              jsonStringField(json, "error") ?? jsonStringField(json, "message") ?? "opencode error"
          }
        })
      ]
    default:
      return []
  }
}

export const makeOpenCodeCliConnector = (
  config: CliConnectorConfig,
  executor: ProcessExecutorShape
): CliConnectorShape => {
  const cwd = config.workingDir ?? "."
  const extraArgs = openCodeCliExtraArgs(config)
  const buildArgv = (prompt: string): ReadonlyArray<string> => [
    "opencode",
    "run",
    ...extraArgs,
    prompt
  ]

  const complete = Effect.fn("@llm4ts/core/providers/OpenCodeCliConnector.complete")(function* (
    prompt: string
  ) {
    const result = yield* executor.run(buildArgv(prompt), cwd, config.envVars)
    if (result.exitCode !== 0) {
      const raw = result.stdout.join("\n")
      return yield* failClassifiedCliError(
        "opencode",
        `opencode exited with code ${result.exitCode}`,
        raw
      )
    }
    return result.stdout.join("\n")
  })

  const completeStream = (prompt: string) =>
    executor
      .runStreaming(
        ["opencode", "run", "--format", "json", ...extraArgs, prompt],
        cwd,
        config.envVars
      )
      .pipe(
        Stream.flatMap((line) => Stream.fromIterable(parseOpenCodeCliStreamLine(line))),
        Stream.mapEffect((chunk) => {
          const message = chunk.metadata.opencodeError
          return message === undefined
            ? Effect.succeed(chunk)
            : failClassifiedCliError("opencode", "opencode error", message)
        })
      )

  return makeCliConnector({
    id: ConnectorIds.OpenCode,
    interactionSupport: "ContinuationOnly",
    buildArgv: (prompt, _context) => buildArgv(prompt),
    buildInteractiveArgv: (_context) => ["opencode"],
    complete,
    completeStream,
    versionProbe: { executor, binary: "opencode", cwd }
  })
}
