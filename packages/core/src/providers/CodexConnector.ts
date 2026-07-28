import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { makeCliConnector, type CliConnectorShape } from "../Connector.ts"
import type { CliConnectorConfig } from "../ConnectorConfig.ts"
import { ProviderError, type LlmError } from "../Errors.ts"
import type { StructuredResult } from "../LlmService.ts"
import { ConnectorIds, HealthStatus, LlmChunk, TokenUsage, type JsonSchema } from "../Models.ts"
import type { ProcessExecutorShape } from "../ProcessExecutor.ts"
import { collect } from "../Streaming.ts"
import type { TemporaryFilesShape } from "../TemporaryFiles.ts"
import { parseFromText, withSchemaHint } from "../StructuredOutput.ts"
import {
  failClassifiedCliError,
  isJsonRecord,
  jsonField,
  jsonIntField,
  jsonStringField,
  jsonText,
  optionalModelArgs,
  parseJsonLine,
  sortedFlagArgs,
  toolEventChunk,
  usageEventChunk,
  type JsonValue
} from "./CliSupport.ts"

const healthy = HealthStatus.make({ availability: "Healthy", authStatus: "Valid" })
const unhealthy = HealthStatus.make({
  availability: "Unhealthy",
  authStatus: "Unknown"
})

export const codexExtraArgs = (config: CliConnectorConfig): ReadonlyArray<string> => {
  const effectiveFlags = config.readOnly
    ? {
        ...config.flags,
        sandbox: "read-only"
      }
    : config.flags
  return [...optionalModelArgs(config.model), ...sortedFlagArgs(effectiveFlags)]
}

export const codexSchemaEnforceable = (schema: JsonSchema): boolean => {
  const properties = schema.properties
  return properties !== undefined && isJsonRecord(properties) && Object.keys(properties).length > 0
}

export const codexStrictSchema = (json: JsonValue): JsonValue => {
  if (Array.isArray(json)) {
    return json.map(codexStrictSchema)
  }
  if (!isJsonRecord(json)) {
    return json
  }

  const recursed: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(json)) {
    recursed[key] = codexStrictSchema(value)
  }
  const properties = recursed.properties
  if (properties === undefined || !isJsonRecord(properties)) {
    return recursed
  }

  const strict: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(recursed)) {
    if (key !== "additionalProperties" && key !== "required") {
      strict[key] = value
    }
  }
  strict.additionalProperties = false
  strict.required = Object.keys(properties)
  return strict
}

export const parseCodexStreamLine = (line: string): ReadonlyArray<LlmChunk> => {
  const json = parseJsonLine(line)
  if (json === undefined) {
    return []
  }

  switch (jsonStringField(json, "type")) {
    case "item.completed": {
      const item = jsonField(json, "item")
      switch (jsonStringField(item, "type")) {
        case "agent_message": {
          const text = jsonStringField(item, "text")
          return text === undefined || text.length === 0 ? [] : [LlmChunk.make({ delta: text })]
        }
        case "command_execution":
          return [
            toolEventChunk("Bash", {
              command: jsonStringField(item, "command") ?? ""
            })
          ]
        default:
          return []
      }
    }
    case "turn.completed": {
      const usage = jsonField(json, "usage")
      if (usage === undefined) {
        return []
      }
      const prompt = jsonIntField(usage, "input_tokens") ?? 0
      const completion = jsonIntField(usage, "output_tokens") ?? 0
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
    case "error":
      return [
        LlmChunk.make({
          delta: "",
          metadata: {
            codexError: jsonStringField(json, "message") ?? "codex error"
          }
        })
      ]
    case "turn.failed":
      return [
        LlmChunk.make({
          delta: "",
          metadata: {
            codexError: jsonStringField(jsonField(json, "error"), "message") ?? "turn failed"
          }
        })
      ]
    default:
      return []
  }
}

export const makeCodexConnector = (
  config: CliConnectorConfig,
  executor: ProcessExecutorShape,
  temporaryFiles: TemporaryFilesShape
): CliConnectorShape => {
  const cwd = config.workingDir ?? "."
  const extraArgs = codexExtraArgs(config)
  const healthCheck = executor.run(["codex", "--version"], cwd, {}).pipe(
    Effect.as(healthy),
    Effect.catch(() => Effect.succeed(unhealthy))
  )

  const stampModel = (chunk: LlmChunk): LlmChunk =>
    chunk.usage === undefined || chunk.metadata.model !== undefined || config.model === undefined
      ? chunk
      : LlmChunk.make({
          ...chunk,
          metadata: {
            ...chunk.metadata,
            model: config.model
          }
        })

  const rawStream = (
    argv: ReadonlyArray<string>,
    prompt: string
  ): Stream.Stream<LlmChunk, LlmError> =>
    executor.runStreamingWithStdin(argv, cwd, config.envVars, prompt).pipe(
      Stream.flatMap((line) => Stream.fromIterable(parseCodexStreamLine(line))),
      Stream.map(stampModel)
    )

  const failCodexChunk = (chunk: LlmChunk): Effect.Effect<LlmChunk, LlmError> => {
    const message = chunk.metadata.codexError
    return message === undefined
      ? Effect.succeed(chunk)
      : failClassifiedCliError("codex", "codex error", message)
  }

  const complete = Effect.fn("@llm4ts/core/providers/CodexConnector.complete")(function* (
    prompt: string
  ) {
    const result = yield* executor.runWithStdin(
      ["codex", "exec", ...extraArgs],
      cwd,
      config.envVars,
      prompt
    )
    if (result.exitCode !== 0) {
      return yield* ProviderError.make({
        message: `codex exited with code ${result.exitCode}: ${result.stdout.join("\n")}`
      })
    }
    return result.stdout.join("\n")
  })

  const completeStream = (prompt: string) =>
    rawStream(["codex", "exec", "--json", ...extraArgs], prompt).pipe(
      Stream.mapEffect(failCodexChunk)
    )

  const base = makeCliConnector({
    id: ConnectorIds.Codex,
    interactionSupport: "InteractiveStdin",
    buildArgv: (prompt, _context) => ["codex", "exec", ...extraArgs, prompt],
    buildInteractiveArgv: (_context) => ["codex", ...extraArgs],
    complete,
    completeStream,
    healthCheck,
    isAvailable: Effect.map(healthCheck, (status) => status.availability === "Healthy")
  })

  const executeStructuredWithUsage = <A, E, RD, RE>(
    prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    jsonSchema: JsonSchema
  ): Effect.Effect<StructuredResult<A>, LlmError, RD> => {
    if (!codexSchemaEnforceable(jsonSchema)) {
      return Effect.gen(function* () {
        const text = yield* complete(withSchemaHint(prompt, jsonSchema))
        const value = yield* parseFromText(text, schema, jsonSchema)
        const result: StructuredResult<A> = [value, undefined, config.model]
        return result
      })
    }

    return Effect.scoped(
      Effect.gen(function* () {
        const path = yield* temporaryFiles.write(
          "codex-schema-",
          ".json",
          jsonText(codexStrictSchema(jsonSchema))
        )
        const reply = yield* collect(
          rawStream(["codex", "exec", "--json", "--output-schema", path, ...extraArgs], prompt)
        )
        if (reply.metadata.codexError !== undefined) {
          return yield* failClassifiedCliError("codex", "codex error", reply.metadata.codexError)
        }
        const value = yield* parseFromText(reply.content, schema, jsonSchema)
        const result: StructuredResult<A> = [
          value,
          reply.usage,
          reply.metadata.model ?? config.model
        ]
        return result
      })
    )
  }

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
