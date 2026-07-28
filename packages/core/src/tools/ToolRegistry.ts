import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import { allows, currentGrants, type Capability } from "../Capability.ts"
import { InvalidRequestError, ToolError } from "../Errors.ts"
import type { LlmError } from "../Errors.ts"
import type { ToolCall } from "../Models.ts"
import type { JsonValue } from "../providers/CliSupport.ts"
import {
  DuplicateToolName,
  validateToolParameters,
  type Tool,
  type ToolExecutionError
} from "./Tool.ts"

export class ToolSucceeded extends Schema.TaggedClass<ToolSucceeded>()("Succeeded", {
  value: Schema.Json
}) {}

export class ToolFailed extends Schema.TaggedClass<ToolFailed>()("Failed", {
  message: Schema.String
}) {}

export const ToolResultValue = Schema.Union([ToolSucceeded, ToolFailed])
export type ToolResultValue = typeof ToolResultValue.Type

export class ToolResult extends Schema.Class<ToolResult>("ToolResult")({
  toolCallId: Schema.String,
  result: ToolResultValue,
  denied: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false)))
}) {}

export interface ToolRegistryShape {
  readonly register: (tool: Tool) => Effect.Effect<void, ToolExecutionError>
  readonly registerAll: (tools: ReadonlyArray<Tool>) => Effect.Effect<void, ToolExecutionError>
  readonly get: (name: string) => Effect.Effect<Tool, LlmError>
  readonly list: Effect.Effect<ReadonlyArray<Tool>>
  readonly select: (prompt: string, limit?: number) => Effect.Effect<ReadonlyArray<Tool>>
  readonly validate: (
    call: ToolCall
  ) => Effect.Effect<readonly [tool: Tool, parameters: JsonValue], LlmError>
  readonly execute: (call: ToolCall) => Effect.Effect<ToolResult, LlmError>
  readonly executeAll: (
    calls: ReadonlyArray<ToolCall>,
    concurrency?: number
  ) => Effect.Effect<ReadonlyArray<ToolResult>, LlmError>
}

export class ToolRegistry extends Context.Service<ToolRegistry, ToolRegistryShape>()(
  "@llm4ts/core/tools/ToolRegistry"
) {}

const capabilityName = (capability: Capability): string =>
  capability._tag === "Exec" ? `Exec(${capability.command})` : capability._tag

const promptWords = (prompt: string): ReadonlySet<string> =>
  new Set(
    prompt
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((word) => word.length > 0)
  )

const toolScore = (tool: Tool, words: ReadonlySet<string>): number => {
  let score = 0
  for (const word of words) {
    score += tool.name.toLowerCase().includes(word) ? 5 : 0
    score += [...tool.tags].some((tag) => tag.toLowerCase() === word) ? 4 : 0
    score += tool.description.toLowerCase().includes(word) ? 2 : 0
  }
  return score
}

const parseArguments = (call: ToolCall): Effect.Effect<JsonValue, ToolError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(call.arguments).pipe(
    Effect.mapError((error) =>
      ToolError.make({
        toolName: call.name,
        detail: `Invalid arguments JSON: ${String(error)}`
      })
    )
  )

export const makeToolRegistry = Effect.fn("@llm4ts/core/tools/ToolRegistry.make")(
  function* (): Effect.fn.Return<ToolRegistryShape> {
    const state = yield* Ref.make<ReadonlyMap<string, Tool>>(new Map())

    const register = (tool: Tool): Effect.Effect<void, ToolExecutionError> =>
      Ref.modify(state, (current) => {
        if (current.has(tool.name)) {
          return [false, current] as const
        }
        const next = new Map(current)
        next.set(tool.name, tool)
        return [true, next] as const
      }).pipe(
        Effect.flatMap((registered) =>
          registered ? Effect.void : Effect.fail(DuplicateToolName.make({ name: tool.name }))
        )
      )

    const registerAll = (tools: ReadonlyArray<Tool>): Effect.Effect<void, ToolExecutionError> =>
      Effect.forEach(tools, register, {
        discard: true
      })

    const get = (name: string): Effect.Effect<Tool, LlmError> =>
      Effect.flatMap(Ref.get(state), (tools) => {
        const tool = tools.get(name)
        return tool === undefined
          ? Effect.fail(
              ToolError.make({
                toolName: name,
                detail: `Tool not found: ${name}`
              })
            )
          : Effect.succeed(tool)
      })

    const list = Ref.get(state).pipe(
      Effect.map((tools) =>
        [...tools.values()].sort((left, right) => left.name.localeCompare(right.name))
      )
    )

    const select = (prompt: string, limit = 8): Effect.Effect<ReadonlyArray<Tool>> =>
      Effect.map(list, (tools) =>
        tools
          .map((tool) => ({
            tool,
            score: toolScore(tool, promptWords(prompt))
          }))
          .filter(({ score }) => score > 0)
          .sort(
            (left, right) =>
              right.score - left.score || left.tool.name.localeCompare(right.tool.name)
          )
          .slice(0, Math.max(0, limit))
          .map(({ tool }) => tool)
      )

    const validate = Effect.fn("@llm4ts/core/tools/ToolRegistry.validate")(function* (
      call: ToolCall
    ): Effect.fn.Return<readonly [tool: Tool, parameters: JsonValue], LlmError> {
      const tool = yield* get(call.name)
      const parameters = yield* parseArguments(call)
      yield* validateToolParameters(tool.parameters, parameters).pipe(
        Effect.mapError((error) =>
          ToolError.make({
            toolName: tool.name,
            detail: error.message
          })
        )
      )
      return [tool, parameters]
    })

    const execute = Effect.fn("@llm4ts/core/tools/ToolRegistry.execute")(function* (
      call: ToolCall
    ): Effect.fn.Return<ToolResult, LlmError> {
      const [tool, parameters] = yield* validate(call)
      const grants = yield* currentGrants
      const missing = tool.requires
        .filter((capability) => !allows(grants, capability))
        .sort((left, right) => capabilityName(left).localeCompare(capabilityName(right)))
      if (missing.length > 0) {
        return ToolResult.make({
          toolCallId: call.id,
          denied: true,
          result: ToolFailed.make({
            message:
              `Tool '${tool.name}' requires ungranted capabilities: ` +
              missing.map(capabilityName).join(", ")
          })
        })
      }

      const result = yield* Effect.result(tool.execute(parameters))
      return ToolResult.make({
        toolCallId: call.id,
        result:
          result._tag === "Success"
            ? ToolSucceeded.make({ value: result.success })
            : ToolFailed.make({ message: result.failure.message })
      })
    })

    const executeAll = (
      calls: ReadonlyArray<ToolCall>,
      concurrency = 1
    ): Effect.Effect<ReadonlyArray<ToolResult>, LlmError> =>
      !Number.isInteger(concurrency) || concurrency <= 0
        ? Effect.fail(
            InvalidRequestError.make({
              message: `Tool execution concurrency must be a positive integer; received ${concurrency}`
            })
          )
        : Effect.forEach(calls, execute, {
            concurrency
          })

    return {
      register,
      registerAll,
      get,
      list,
      select,
      validate,
      execute,
      executeAll
    }
  }
)

export const ToolRegistryLive = Layer.effect(ToolRegistry, makeToolRegistry())

export const toolResultValue = (result: ToolResult): JsonValue =>
  result.result._tag === "Succeeded"
    ? result.result.value
    : {
        error: result.result.message
      }
