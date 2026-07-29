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
  jsonObjectEntries,
  jsonStringField,
  optionalModelArgs,
  parseJsonLine,
  sortedFlagArgs,
  usageEventChunk
} from "./CliSupport.ts"

export const grokCliExtraArgs = (config: CliConnectorConfig): ReadonlyArray<string> => [
  ...optionalModelArgs(config.model),
  ...(config.readOnly ? ["--permission-mode", "plan"] : ["--always-approve"]),
  ...sortedFlagArgs(config.flags)
]

export const parseGrokCliStreamLine = (line: string): ReadonlyArray<LlmChunk> => {
  const json = parseJsonLine(line)
  if (json === undefined) {
    return []
  }

  switch (jsonStringField(json, "type")) {
    case "text": {
      const text = jsonStringField(json, "data")
      return text === undefined || text.length === 0 ? [] : [LlmChunk.make({ delta: text })]
    }
    case "end": {
      const usage = jsonField(json, "usage")
      if (usage === undefined) {
        return []
      }
      const prompt = jsonIntField(usage, "input_tokens") ?? 0
      const completion = jsonIntField(usage, "output_tokens") ?? 0
      const cached = jsonIntField(usage, "cache_read_input_tokens")
      const model = jsonObjectEntries(jsonField(json, "modelUsage"))[0]?.[0]
      return [
        usageEventChunk(
          model,
          TokenUsage.make({
            prompt,
            completion,
            total: jsonIntField(usage, "total_tokens") ?? prompt + completion,
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
            grokError:
              jsonStringField(json, "data") ?? jsonStringField(json, "message") ?? "grok error"
          }
        })
      ]
    default:
      return []
  }
}

export const makeGrokCliConnector = (
  config: CliConnectorConfig,
  executor: ProcessExecutorShape
): CliConnectorShape => {
  const cwd = config.workingDir ?? "."
  const extraArgs = grokCliExtraArgs(config)
  const buildArgv = (prompt: string): ReadonlyArray<string> => ["grok", ...extraArgs, "-p", prompt]

  const complete = Effect.fn("@llm4ts/core/providers/GrokCliConnector.complete")(function* (
    prompt: string
  ) {
    const result = yield* executor.run(buildArgv(prompt), cwd, config.envVars)
    if (result.exitCode !== 0) {
      const raw = result.stdout.join("\n")
      return yield* failClassifiedCliError("grok", `grok exited with code ${result.exitCode}`, raw)
    }
    return result.stdout.join("\n")
  })

  const completeStream = (prompt: string) =>
    executor
      .runStreaming(
        ["grok", "--output-format", "streaming-json", ...extraArgs, "-p", prompt],
        cwd,
        config.envVars
      )
      .pipe(
        Stream.flatMap((line) => Stream.fromIterable(parseGrokCliStreamLine(line))),
        Stream.mapEffect((chunk) => {
          const message = chunk.metadata.grokError
          return message === undefined
            ? Effect.succeed(chunk)
            : failClassifiedCliError("grok", "grok error", message)
        })
      )

  return makeCliConnector({
    id: ConnectorIds.Grok,
    interactionSupport: "ContinuationOnly",
    buildArgv: (prompt, _context) => buildArgv(prompt),
    buildInteractiveArgv: (_context) => ["grok", ...extraArgs],
    complete,
    completeStream,
    versionProbe: { executor, binary: "grok", cwd }
  })
}
