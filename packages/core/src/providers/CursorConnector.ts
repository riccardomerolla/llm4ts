import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { makeCliConnector, type CliConnectorShape } from "../Connector.ts"
import type { CliConnectorConfig } from "../ConnectorConfig.ts"
import { ConnectorCapabilities, ConnectorIds, LlmChunk } from "../Models.ts"
import type { ProcessExecutorShape } from "../ProcessExecutor.ts"
import {
  failClassifiedCliError,
  jsonArray,
  jsonBooleanField,
  jsonField,
  jsonObjectEntries,
  jsonStringField,
  optionalModelArgs,
  parseJsonLine,
  sortedFlagArgs,
  toolEventChunk,
  type JsonValue
} from "./CliSupport.ts"

export const cursorExtraArgs = (config: CliConnectorConfig): ReadonlyArray<string> => [
  ...optionalModelArgs(config.model),
  ...(config.readOnly ? [] : ["--force"]),
  ...sortedFlagArgs(config.flags)
]

const cursorMessageText = (message: JsonValue) =>
  jsonArray(jsonField(message, "content"))
    .map((block) => jsonStringField(block, "text") ?? "")
    .join("")

export const parseCursorStreamLine = (line: string): ReadonlyArray<LlmChunk> => {
  const json = parseJsonLine(line)
  if (json === undefined) {
    return []
  }

  switch (jsonStringField(json, "type")) {
    case "assistant": {
      const message = jsonField(json, "message")
      const text = message === undefined ? "" : cursorMessageText(message)
      return text.length === 0 ? [] : [LlmChunk.make({ delta: text })]
    }
    case "tool_call": {
      if (jsonStringField(json, "subtype") !== "started") {
        return []
      }
      const entry = jsonObjectEntries(jsonField(json, "tool_call"))[0]
      return entry === undefined ? [] : [toolEventChunk(entry[0], jsonField(entry[1], "args"))]
    }
    case "result":
      return jsonBooleanField(json, "is_error") === true
        ? [
            LlmChunk.make({
              delta: "",
              metadata: {
                cursorError: jsonStringField(json, "result") ?? "cursor error"
              }
            })
          ]
        : [LlmChunk.make({ delta: "", finishReason: "stop" })]
    default:
      return []
  }
}

export const makeCursorConnector = (
  config: CliConnectorConfig,
  executor: ProcessExecutorShape
): CliConnectorShape => {
  const cwd = config.workingDir ?? "."
  const extraArgs = cursorExtraArgs(config)
  const buildArgv = (prompt: string): ReadonlyArray<string> => [
    "cursor-agent",
    ...extraArgs,
    "-p",
    prompt
  ]
  const complete = Effect.fn("@llm4ts/core/providers/CursorConnector.complete")(function* (
    prompt: string
  ) {
    const result = yield* executor.run(buildArgv(prompt), cwd, config.envVars)
    if (result.exitCode !== 0) {
      const raw = result.stdout.join("\n")
      return yield* failClassifiedCliError(
        "cursor",
        `cursor-agent exited with code ${result.exitCode}`,
        raw
      )
    }
    return result.stdout.join("\n")
  })

  const completeStream = (prompt: string) =>
    executor
      .runStreaming(
        ["cursor-agent", "--output-format", "stream-json", ...extraArgs, "-p", prompt],
        cwd,
        config.envVars
      )
      .pipe(
        Stream.flatMap((line) => Stream.fromIterable(parseCursorStreamLine(line))),
        Stream.mapEffect((chunk) => {
          const message = chunk.metadata.cursorError
          return message === undefined
            ? Effect.succeed(chunk)
            : failClassifiedCliError("cursor", "cursor error", message)
        })
      )

  return makeCliConnector({
    id: ConnectorIds.Cursor,
    interactionSupport: "ContinuationOnly",
    // This CLI does not surface token usage, so TokensUsed events (and
    // therefore cost summaries and budgets) cannot include it.
    capabilities: ConnectorCapabilities.make({ usageReporting: false }),
    buildArgv: (prompt, _context) => buildArgv(prompt),
    buildInteractiveArgv: (_context) => ["cursor-agent", ...extraArgs],
    complete,
    completeStream,
    versionProbe: { executor, binary: "cursor-agent", cwd }
  })
}
