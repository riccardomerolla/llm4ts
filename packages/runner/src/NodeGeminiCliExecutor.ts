import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { ProviderError } from "@llm4ts/core/Errors"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import {
  GeminiCliExecutor,
  buildGeminiArgs,
  extractGeminiCliResponse,
  geminiProcessEnv,
  parseGeminiCliStreamEvent,
  validateGeminiExitCode,
  type GeminiCliExecutorShape
} from "@llm4ts/core/providers/GeminiCliProvider"
import { nodeProcessExecutor } from "./NodeProcessExecutor.ts"

const failure = (message: string): ProviderError => ProviderError.make({ message })

export const makeNodeGeminiCliExecutor = (
  executor: ProcessExecutorShape
): GeminiCliExecutorShape => ({
  checkGeminiInstalled: executor
    .run(["gemini", "--version"], process.cwd(), {})
    .pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.void
          : Effect.fail(failure(`Gemini CLI is unavailable: ${result.stderr.join("\n")}`))
      )
    ),
  runGeminiProcess: (prompt, config, context) =>
    Effect.gen(function* () {
      const result = yield* executor.runWithStdin(
        ["gemini", ...buildGeminiArgs(config, context, "json")],
        context.cwd ?? process.cwd(),
        geminiProcessEnv(context),
        prompt
      )
      yield* validateGeminiExitCode(result.exitCode, result.stderr.join("\n"), context.turnLimit)
      const extracted = extractGeminiCliResponse(result.stdout.join("\n"))
      return extracted.ok ? extracted.value : yield* failure(extracted.error)
    }),
  runGeminiProcessStream: (prompt, config, context) =>
    executor
      .runStreamingWithStdin(
        ["gemini", ...buildGeminiArgs(config, context, "stream-json")],
        context.cwd ?? process.cwd(),
        geminiProcessEnv(context),
        prompt
      )
      .pipe(Stream.map(parseGeminiCliStreamEvent))
})

export const nodeGeminiCliExecutor = makeNodeGeminiCliExecutor(nodeProcessExecutor)

export const NodeGeminiCliExecutorLive = Layer.succeed(GeminiCliExecutor, nodeGeminiCliExecutor)
