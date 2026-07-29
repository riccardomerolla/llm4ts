import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import type * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { makeCliConnector, type CliConnectorShape } from "../Connector.ts"
import type { CliConnectorConfig } from "../ConnectorConfig.ts"
import type { LlmError } from "../Errors.ts"
import type { StructuredResult } from "../LlmService.ts"
import {
  ConnectorCapabilities,
  ConnectorIds,
  LlmChunk,
  TokenUsage,
  type JsonSchema
} from "../Models.ts"
import type { ProcessExecutorShape } from "../ProcessExecutor.ts"
import { collect } from "../Streaming.ts"
import { parseFromText, withSchemaHint } from "../StructuredOutput.ts"
import {
  failClassifiedCliError,
  jsonArray,
  jsonField,
  jsonIntField,
  jsonStringField,
  optionalModelArgs,
  parseJsonLine,
  sortedFlagArgs,
  toolEventChunk,
  usageEventChunk
} from "./CliSupport.ts"

export const claudeCliExtraArgs = (config: CliConnectorConfig): ReadonlyArray<string> => {
  const effectiveFlags = config.readOnly
    ? {
        ...config.flags,
        "permission-mode": "default",
        "disallowed-tools": "Write,Edit,NotebookEdit"
      }
    : config.flags
  return [...optionalModelArgs(config.model), ...sortedFlagArgs(effectiveFlags)]
}

export const claudeCliInitModel = (line: string): string | undefined => {
  const json = parseJsonLine(line)
  return json !== undefined && jsonStringField(json, "type") === "system"
    ? jsonStringField(json, "model")
    : undefined
}

export const parseClaudeCliStreamLine = (line: string): ReadonlyArray<LlmChunk> => {
  const json = parseJsonLine(line)
  if (json === undefined) {
    return []
  }

  switch (jsonStringField(json, "type")) {
    case "assistant":
      return jsonArray(jsonField(jsonField(json, "message"), "content")).flatMap(
        (block): ReadonlyArray<LlmChunk> => {
          switch (jsonStringField(block, "type")) {
            case "text": {
              const text = jsonStringField(block, "text")
              return text === undefined || text.length === 0 ? [] : [LlmChunk.make({ delta: text })]
            }
            case "tool_use":
              return [
                toolEventChunk(jsonStringField(block, "name") ?? "", jsonField(block, "input"))
              ]
            default:
              return []
          }
        }
      )
    case "result": {
      const usage = jsonField(json, "usage")
      if (usage === undefined) {
        return []
      }
      const prompt = jsonIntField(usage, "input_tokens") ?? 0
      const completion = jsonIntField(usage, "output_tokens") ?? 0
      const cached = jsonIntField(usage, "cache_read_input_tokens")
      return [
        usageEventChunk(
          undefined,
          TokenUsage.make({
            prompt,
            completion,
            total: prompt + completion,
            ...(cached === undefined ? {} : { cached })
          })
        )
      ]
    }
    default:
      return []
  }
}

export const makeClaudeCliConnector = (
  config: CliConnectorConfig,
  executor: ProcessExecutorShape
): CliConnectorShape => {
  const cwd = config.workingDir ?? "."
  const extraArgs = claudeCliExtraArgs(config)

  const complete = Effect.fn("@llm4ts/core/providers/ClaudeCliConnector.complete")(function* (
    prompt: string
  ) {
    const result = yield* executor.runWithStdin(
      ["claude", "--print", ...extraArgs],
      cwd,
      config.envVars,
      prompt
    )
    if (result.exitCode !== 0) {
      const raw = result.stdout.join("\n")
      return yield* failClassifiedCliError(
        "claude",
        `claude exited with code ${result.exitCode}`,
        raw
      )
    }
    return result.stdout.join("\n")
  })

  const completeStream = (prompt: string) =>
    Stream.unwrap(
      Effect.map(Ref.make<string | undefined>(undefined), (model) =>
        executor
          .runStreamingWithStdin(
            ["claude", "--print", "--output-format", "stream-json", "--verbose", ...extraArgs],
            cwd,
            config.envVars,
            prompt
          )
          .pipe(
            Stream.mapEffect((line) => {
              const initializedModel = claudeCliInitModel(line)
              return initializedModel === undefined
                ? Effect.succeed(line)
                : Ref.set(model, initializedModel).pipe(Effect.as(line))
            }),
            Stream.flatMap((line) => Stream.fromIterable(parseClaudeCliStreamLine(line))),
            Stream.mapEffect((chunk) =>
              chunk.usage === undefined
                ? Effect.succeed(chunk)
                : Effect.map(Ref.get(model), (servedModel) =>
                    servedModel === undefined
                      ? chunk
                      : LlmChunk.make({
                          ...chunk,
                          metadata: {
                            ...chunk.metadata,
                            model: servedModel
                          }
                        })
                  )
            )
          )
      )
    )

  const base = makeCliConnector({
    id: ConnectorIds.ClaudeCli,
    interactionSupport: "InteractiveStdin",
    capabilities: ConnectorCapabilities.make({
      interactiveSessions: true,
      askUser: true,
      approval: true,
      resumableSessions: true
    }),
    buildArgv: (prompt, _context) => ["claude", "--print", ...extraArgs, prompt],
    buildInteractiveArgv: (_context) => ["claude", ...extraArgs],
    complete,
    completeStream,
    versionProbe: { executor, binary: "claude", cwd }
  })

  const executeStructuredWithUsage = <A, E, RD, RE>(
    prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    jsonSchema: JsonSchema
  ): Effect.Effect<StructuredResult<A>, LlmError, RD> =>
    Effect.gen(function* () {
      const reply = yield* collect(completeStream(withSchemaHint(prompt, jsonSchema)))
      const value = yield* parseFromText(reply.content, schema, jsonSchema)
      const result: StructuredResult<A> = [value, reply.usage, reply.metadata.model]
      return result
    })

  return {
    ...base,
    executeStructured: <A, E, RD, RE>(
      prompt: string,
      schema: Schema.ConstraintCodec<A, E, RD, RE>,
      jsonSchema: JsonSchema
    ): Effect.Effect<A, LlmError, RD> =>
      Effect.map(executeStructuredWithUsage(prompt, schema, jsonSchema), ([value]) => value),
    executeStructuredWithUsage
  }
}
