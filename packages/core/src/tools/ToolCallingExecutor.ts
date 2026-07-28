import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { InvalidRequestError, type LlmError } from "../Errors.ts"
import type { LlmServiceShape } from "../LlmService.ts"
import { LlmResponse, type ToolCallResponse } from "../Models.ts"
import { jsonText } from "../providers/CliSupport.ts"
import { toolDefinition, type Tool } from "./Tool.ts"
import { toolResultValue, type ToolRegistryShape, type ToolResult } from "./ToolRegistry.ts"

export class ToolLoopConfig extends Schema.Class<ToolLoopConfig>("ToolLoopConfig")({
  maxIterations: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(8))),
  maxDenials: Schema.optionalKey(Schema.Int),
  maxConcurrency: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(1)))
}) {}

export const buildToolFollowUpPrompt = (
  previousPrompt: string,
  response: ToolCallResponse,
  results: ReadonlyArray<ToolResult>
): string => {
  const renderedResults = results
    .map(
      (result) => `tool_call_id=${result.toolCallId} result=${jsonText(toolResultValue(result))}`
    )
    .join("\n")
  return (
    `${previousPrompt}\n\n` +
    `Assistant requested tool execution with finishReason='${response.finishReason}'.\n` +
    `Tool results:\n${renderedResults}\n\n` +
    "Continue the task. If no further tools are needed, respond with final user-facing content.\n"
  )
}

export const runToolCallingLoop = Effect.fn("@llm4ts/core/tools/ToolCallingExecutor.run")(
  function* (
    prompt: string,
    tools: ReadonlyArray<Tool>,
    llmService: LlmServiceShape,
    registry: ToolRegistryShape,
    config: ToolLoopConfig = ToolLoopConfig.make({})
  ): Effect.fn.Return<LlmResponse, LlmError> {
    if (config.maxIterations < 0) {
      return yield* InvalidRequestError.make({
        message: `Tool loop maxIterations must be non-negative; received ${config.maxIterations}`
      })
    }
    if (config.maxDenials !== undefined && config.maxDenials < 0) {
      return yield* InvalidRequestError.make({
        message: `Tool loop maxDenials must be non-negative; received ${config.maxDenials}`
      })
    }

    const definitions = tools.map(toolDefinition)
    const loop = (
      currentPrompt: string,
      iteration: number,
      denials: number
    ): Effect.Effect<LlmResponse, LlmError> => {
      if (iteration >= config.maxIterations) {
        return Effect.fail(
          InvalidRequestError.make({
            message: `Tool call loop reached max iterations (${config.maxIterations})`
          })
        )
      }

      return Effect.flatMap(llmService.executeWithTools(currentPrompt, definitions), (response) => {
        if (response.toolCalls.length === 0) {
          return Effect.succeed(
            LlmResponse.make({
              content: response.content ?? "",
              metadata: {
                finish_reason: response.finishReason,
                tool_iterations: String(iteration)
              }
            })
          )
        }

        return Effect.flatMap(
          registry.executeAll(response.toolCalls, config.maxConcurrency),
          (results) => {
            const totalDenials = denials + results.filter((result) => result.denied).length
            if (config.maxDenials !== undefined && totalDenials >= config.maxDenials) {
              return Effect.fail(
                InvalidRequestError.make({
                  message:
                    "Tool loop exceeded the capability-denial budget " + `(${config.maxDenials})`
                })
              )
            }
            return Effect.suspend(() =>
              loop(
                buildToolFollowUpPrompt(currentPrompt, response, results),
                iteration + 1,
                totalDenials
              )
            )
          }
        )
      })
    }

    return yield* loop(prompt, 0, 0)
  }
)
