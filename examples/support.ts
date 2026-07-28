import * as Effect from "effect/Effect"
import type { ApiConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { collect } from "@llm4ts/core/Streaming"
import { FlowLlmError } from "@llm4ts/flow/FlowError"
import { AssistantMessage, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import {
  parseFlowArgs,
  readFlowPrompt,
  resolveFlowRepo,
  ScriptUsage
} from "@llm4ts/runner/FlowArgs"
import {
  anthropic,
  geminiApi,
  lmStudio,
  mock,
  ollama,
  openAI,
  withModel
} from "@llm4ts/runner/Connectors"

export interface ExampleInput {
  readonly prompt: string
  readonly workDir: string
  readonly workspace: string
}

export const resolveExampleInput = Effect.fn("@llm4ts/examples/resolveInput")(function* (
  defaultPrompt?: string,
  argv: ReadonlyArray<string> = process.argv.slice(2),
  workspace = process.cwd()
): Effect.fn.Return<ExampleInput, ScriptUsage> {
  const parsed = parseFlowArgs(argv)
  if (!parsed.ok) {
    return yield* parsed.error
  }
  const prompt = yield* readFlowPrompt(parsed.value, defaultPrompt)
  const workDir = yield* resolveFlowRepo(parsed.value, workspace)
  return { prompt, workDir, workspace }
})

export const apiConnectorFromEnvironment = Effect.fn(
  "@llm4ts/examples/apiConnectorFromEnvironment"
)(function* (
  environment: Readonly<Record<string, string | undefined>> = process.env
): Effect.fn.Return<ApiConnectorConfig, ScriptUsage> {
  const provider = environment.LLM4TS_PROVIDER?.trim().toLowerCase() ?? "mock"
  const preset = (() => {
    switch (provider) {
      case "mock":
        return mock
      case "openai":
        return openAI
      case "anthropic":
        return anthropic
      case "gemini":
      case "gemini-api":
        return geminiApi
      case "lm-studio":
      case "lmstudio":
        return lmStudio
      case "ollama":
        return ollama
      default:
        return undefined
    }
  })()
  if (preset === undefined) {
    return yield* ScriptUsage.make({
      message:
        `unknown LLM4TS_PROVIDER '${provider}'; expected ` +
        "mock|openai|anthropic|gemini|lm-studio|ollama"
    })
  }
  const model = environment.LLM4TS_MODEL?.trim()
  if (provider !== "mock" && (model === undefined || model.length === 0)) {
    return yield* ScriptUsage.make({
      message: `LLM4TS_MODEL is required for provider '${provider}'`
    })
  }
  return model === undefined || model.length === 0 ? preset : withModel(preset, model)
})

export const completeAndPublish = Effect.fn("@llm4ts/examples/completeAndPublish")(function* (
  service: LlmServiceShape,
  events: FlowEventsShape,
  prompt: string
): Effect.fn.Return<string, FlowLlmError> {
  const response = yield* collect(service.executeStream(prompt)).pipe(
    Effect.mapError((cause) => FlowLlmError.make({ message: cause.message, cause }))
  )
  yield* events.publish(AssistantMessage.make({ text: response.content }))
  return response.content
})

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : String(error)

export const runExampleMain = <E>(program: Effect.Effect<void, E>): void => {
  Effect.runFork(
    program.pipe(
      Effect.match({
        onFailure: (error) =>
          Effect.sync(() => {
            process.stderr.write(`${errorMessage(error)}\n`)
            process.exitCode = 1
          }),
        onSuccess: () => Effect.void
      }),
      Effect.flatten
    )
  )
}
