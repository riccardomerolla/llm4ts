import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as Stream from "effect/Stream"
import { CliSandbox } from "./ConnectorConfig.ts"
import { InvalidRequestError, type LlmError } from "./Errors.ts"
import type { LlmServiceShape, StructuredResult } from "./LlmService.ts"
import {
  ConnectorCapabilities,
  HealthStatus,
  type ConnectorId,
  type ConnectorKind,
  type InteractionSupport,
  type JsonSchema,
  type LlmChunk,
  type Message,
  type ToolCallResponse,
  type ToolDefinition
} from "./Models.ts"
import type { ProcessExecutorShape } from "./ProcessExecutor.ts"
import { parseFromText, withSchemaHint } from "./StructuredOutput.ts"

export interface ConnectorShape extends LlmServiceShape {
  readonly id: ConnectorId
  readonly kind: ConnectorKind
  readonly healthCheck: Effect.Effect<HealthStatus, LlmError>
  readonly capabilities: ConnectorCapabilities
}

export interface ApiConnectorShape extends ConnectorShape {
  readonly kind: "Api"
}

export class CliContext extends Schema.Class<CliContext>("CliContext")({
  worktreePath: Schema.String,
  repoPath: Schema.String,
  envVars: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(Object.freeze({})))
  ),
  sandbox: Schema.optionalKey(CliSandbox),
  turnLimit: Schema.optionalKey(Schema.Int)
}) {}

export interface CliConnectorShape extends ConnectorShape {
  readonly kind: "Cli"
  readonly interactionSupport: InteractionSupport
  readonly buildArgv: (prompt: string, context: CliContext) => ReadonlyArray<string>
  readonly buildInteractiveArgv: (context: CliContext) => ReadonlyArray<string>
  readonly complete: (prompt: string) => Effect.Effect<string, LlmError>
  readonly completeStream: (prompt: string) => Stream.Stream<LlmChunk, LlmError>
}

// API providers execute no tools at all, so read-only holds vacuously.
export const apiConnectorCapabilities = (): ConnectorCapabilities =>
  ConnectorCapabilities.make({ readOnlyEnforcement: "enforced" })

export const timedHealthCheck = (
  isAvailable: Effect.Effect<boolean>
): Effect.Effect<HealthStatus, LlmError> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeNanos
    const available = yield* isAvailable
    const completedAt = yield* Clock.currentTimeNanos
    return HealthStatus.make({
      availability: available ? "Healthy" : "Unhealthy",
      authStatus: available ? "Valid" : "Invalid",
      latency: Duration.nanos(completedAt - startedAt)
    })
  })

export interface ApiConnectorPrimitives {
  readonly id: ConnectorId
  readonly executeStream: (prompt: string) => Stream.Stream<LlmChunk, LlmError>
  readonly executeStreamWithHistory: (
    messages: ReadonlyArray<Message>
  ) => Stream.Stream<LlmChunk, LlmError>
  readonly executeWithTools: (
    prompt: string,
    tools: ReadonlyArray<ToolDefinition>
  ) => Effect.Effect<ToolCallResponse, LlmError>
  readonly executeStructuredWithUsage: <A, E, RD, RE>(
    prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    jsonSchema: JsonSchema
  ) => Effect.Effect<StructuredResult<A>, LlmError, RD>
  readonly isAvailable: Effect.Effect<boolean>
  readonly capabilities?: ConnectorCapabilities
}

export const makeApiConnector = (primitives: ApiConnectorPrimitives): ApiConnectorShape => {
  const executeStructured = <A, E, RD, RE>(
    prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    jsonSchema: JsonSchema
  ): Effect.Effect<A, LlmError, RD> =>
    Effect.map(
      primitives.executeStructuredWithUsage(prompt, schema, jsonSchema),
      ([value]) => value
    )

  return {
    ...primitives,
    kind: "Api",
    capabilities: primitives.capabilities ?? apiConnectorCapabilities(),
    healthCheck: timedHealthCheck(primitives.isAvailable),
    executeStructured
  }
}

export const cliConnectorCapabilities = (
  interactionSupport: InteractionSupport
): ConnectorCapabilities =>
  ConnectorCapabilities.make({
    interactiveSessions: interactionSupport === "InteractiveStdin"
  })

export const flattenHistory = (messages: ReadonlyArray<Message>): string => {
  const systemBlock = messages
    .filter((message) => message.role === "System" && message.content.length > 0)
    .map((message) => message.content)
    .join("\n\n")
  const turns = messages
    .filter((message) => message.role !== "System")
    .map((message) => `**${message.role}:** ${message.content}`)
    .join("\n\n")

  return `${systemBlock.length === 0 ? "" : `${systemBlock}\n\n`}${turns}`
}

export interface CliVersionProbe {
  readonly executor: ProcessExecutorShape
  readonly binary: string
  readonly versionArgs?: ReadonlyArray<string>
  readonly cwd?: string
}

const cliProbeHealthy = HealthStatus.make({ availability: "Healthy", authStatus: "Valid" })
const cliProbeUnhealthy = HealthStatus.make({ availability: "Unhealthy", authStatus: "Unknown" })

export const cliVersionProbeHealthCheck = (
  probe: CliVersionProbe
): Effect.Effect<HealthStatus, LlmError> =>
  probe.executor
    .run([probe.binary, ...(probe.versionArgs ?? ["--version"])], probe.cwd ?? ".", {})
    .pipe(
      Effect.as(cliProbeHealthy),
      Effect.catch(() => Effect.succeed(cliProbeUnhealthy))
    )

export interface CliConnectorPrimitives {
  readonly id: ConnectorId
  readonly interactionSupport: InteractionSupport
  readonly buildArgv: (prompt: string, context: CliContext) => ReadonlyArray<string>
  readonly buildInteractiveArgv: (context: CliContext) => ReadonlyArray<string>
  readonly complete: (prompt: string) => Effect.Effect<string, LlmError>
  readonly completeStream: (prompt: string) => Stream.Stream<LlmChunk, LlmError>
  readonly versionProbe?: CliVersionProbe
  readonly healthCheck?: Effect.Effect<HealthStatus, LlmError>
  readonly isAvailable?: Effect.Effect<boolean>
  readonly capabilities?: ConnectorCapabilities
}

const unsupportedTools = (
  id: ConnectorId,
  _prompt: string,
  _tools: ReadonlyArray<ToolDefinition>
): Effect.Effect<ToolCallResponse, LlmError> =>
  Effect.fail(
    InvalidRequestError.make({
      message: `CLI connector ${id.value} does not support tool calling`
    })
  )

export const makeCliConnector = (primitives: CliConnectorPrimitives): CliConnectorShape => {
  const executeStructured = <A, E, RD, RE>(
    prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    jsonSchema: JsonSchema
  ): Effect.Effect<A, LlmError, RD> =>
    Effect.flatMap(primitives.complete(withSchemaHint(prompt, jsonSchema)), (text) =>
      parseFromText(text, schema, jsonSchema)
    )

  const executeStructuredWithUsage = <A, E, RD, RE>(
    prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    jsonSchema: JsonSchema
  ): Effect.Effect<StructuredResult<A>, LlmError, RD> =>
    Effect.map(executeStructured(prompt, schema, jsonSchema), (value) => [
      value,
      undefined,
      undefined
    ])

  const healthCheck =
    primitives.healthCheck ??
    (primitives.versionProbe === undefined
      ? Effect.succeed(HealthStatus.make({ availability: "Unknown", authStatus: "Unknown" }))
      : cliVersionProbeHealthCheck(primitives.versionProbe))

  const isAvailable =
    primitives.isAvailable ??
    healthCheck.pipe(
      Effect.map((status) => status.availability === "Healthy"),
      Effect.catch(() => Effect.succeed(false))
    )

  return {
    ...primitives,
    kind: "Cli",
    capabilities:
      primitives.capabilities ?? cliConnectorCapabilities(primitives.interactionSupport),
    healthCheck,
    isAvailable,
    executeStream: primitives.completeStream,
    executeStreamWithHistory: (messages) => primitives.completeStream(flattenHistory(messages)),
    executeWithTools: (prompt, tools) => unsupportedTools(primitives.id, prompt, tools),
    executeStructured,
    executeStructuredWithUsage
  }
}
