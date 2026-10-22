import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as Stream from "effect/Stream"
import { CliSandbox } from "./ConnectorConfig.ts"
import { InvalidRequestError, type LlmError } from "./Errors.ts"
import { verbalizedScoreLabels } from "./LabelScoring.ts"
import type { LlmServiceShape, StructuredResult } from "./LlmService.ts"
import {
  ConnectorCapabilities,
  HealthStatus,
  type AuthStatus,
  type ConnectorId,
  type ConnectorKind,
  type InteractionSupport,
  type JsonSchema,
  type LlmChunk,
  type Message,
  type ToolCallResponse,
  type ToolDefinition
} from "./Models.ts"
import type { ProcessExecutorShape, ProcessResult } from "./ProcessExecutor.ts"
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
  /** Native label scoring (log-probabilities); derived from structured output when absent. */
  readonly scoreLabels?: LlmServiceShape["scoreLabels"]
  /** Native shared-prefix sequence scoring; the judgment layer derives one when absent. */
  readonly scoreLabelSequence?: LlmServiceShape["scoreLabelSequence"]
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

  const { scoreLabelSequence, ...rest } = primitives
  return {
    ...rest,
    ...(scoreLabelSequence === undefined ? {} : { scoreLabelSequence }),
    kind: "Api",
    capabilities: primitives.capabilities ?? apiConnectorCapabilities(),
    healthCheck: timedHealthCheck(primitives.isAvailable),
    executeStructured,
    scoreLabels:
      primitives.scoreLabels ?? verbalizedScoreLabels(primitives.executeStructuredWithUsage)
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

/**
 * How a CLI reports its own login without a model call: a subcommand such as
 * `claude auth status --json` or `codex login status`, run right after the
 * version probe, and how its answer maps to an `AuthStatus`. The probe must be
 * cheap and offline-safe — it reads the CLI's credential store, it never
 * refreshes a token or bills a request. `interpret` answers "Unknown" for
 * output it does not recognise (an older CLI without the subcommand).
 */
export interface CliAuthProbe {
  /** Arguments after the binary. */
  readonly args: ReadonlyArray<string>
  readonly interpret: (result: ProcessResult) => AuthStatus
}

export interface CliVersionProbe {
  readonly executor: ProcessExecutorShape
  readonly binary: string
  readonly versionArgs?: ReadonlyArray<string>
  readonly cwd?: string
  /**
   * The CLI's own login check, when it offers a cheap one. Without it the
   * health check reports `authStatus: "Unknown"`: a version answer proves the
   * binary is installed, not that its session is alive.
   */
  readonly authProbe?: CliAuthProbe
}

const cliProbeUnhealthy = HealthStatus.make({ availability: "Unhealthy", authStatus: "Unknown" })

/**
 * Availability from `<binary> --version`, authentication from the CLI's own
 * login check. A version probe alone never yields "Valid": on 2026-10-21
 * doctor called a `claude` healthy whose OAuth session had expired, and the
 * flow died five seconds later on the first turn.
 */
export const cliVersionProbeHealthCheck = (
  probe: CliVersionProbe
): Effect.Effect<HealthStatus, LlmError> => {
  const cwd = probe.cwd ?? "."
  const authStatus: Effect.Effect<AuthStatus> =
    probe.authProbe === undefined
      ? Effect.succeed("Unknown")
      : probe.executor.run([probe.binary, ...probe.authProbe.args], cwd, {}).pipe(
          Effect.map(probe.authProbe.interpret),
          Effect.catch(() => Effect.succeed<AuthStatus>("Unknown"))
        )
  return probe.executor.run([probe.binary, ...(probe.versionArgs ?? ["--version"])], cwd, {}).pipe(
    Effect.andThen(authStatus),
    Effect.map((auth) => HealthStatus.make({ availability: "Healthy", authStatus: auth })),
    Effect.catch(() => Effect.succeed(cliProbeUnhealthy))
  )
}

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
    executeStructuredWithUsage,
    scoreLabels: verbalizedScoreLabels(executeStructuredWithUsage)
  }
}
