import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as Stream from "effect/Stream"
import { CliSandbox } from "./ConnectorConfig.ts"
import { InvalidRequestError, type LlmError } from "./Errors.ts"
import type { LlmServiceShape, StructuredResult } from "./LlmService.ts"
import {
  ConnectorCapabilities,
  type ConnectorId,
  type ConnectorKind,
  type HealthStatus,
  type InteractionSupport,
  type JsonSchema,
  type LlmChunk,
  type Message,
  type ToolCallResponse,
  type ToolDefinition
} from "./Models.ts"
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

export const apiConnectorCapabilities = (): ConnectorCapabilities => ConnectorCapabilities.make({})

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

export interface CliConnectorPrimitives {
  readonly id: ConnectorId
  readonly interactionSupport: InteractionSupport
  readonly buildArgv: (prompt: string, context: CliContext) => ReadonlyArray<string>
  readonly buildInteractiveArgv: (context: CliContext) => ReadonlyArray<string>
  readonly complete: (prompt: string) => Effect.Effect<string, LlmError>
  readonly completeStream: (prompt: string) => Stream.Stream<LlmChunk, LlmError>
  readonly healthCheck: Effect.Effect<HealthStatus, LlmError>
  readonly isAvailable: Effect.Effect<boolean>
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

  return {
    ...primitives,
    kind: "Cli",
    capabilities:
      primitives.capabilities ?? cliConnectorCapabilities(primitives.interactionSupport),
    executeStream: primitives.completeStream,
    executeStreamWithHistory: (messages) => primitives.completeStream(flattenHistory(messages)),
    executeWithTools: (prompt, tools) => unsupportedTools(primitives.id, prompt, tools),
    executeStructured,
    executeStructuredWithUsage
  }
}
