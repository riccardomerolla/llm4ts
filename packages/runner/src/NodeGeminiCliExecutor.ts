import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { ProviderError } from "@llm4ts/core/Errors"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import type { TemporaryFilesShape } from "@llm4ts/core/TemporaryFiles"
import {
  GeminiCliExecutor,
  buildGeminiArgs,
  extractGeminiCliResponse,
  geminiHarnessPolicyToml,
  geminiProcessEnv,
  geminiSupportsAdminPolicy,
  geminiTurnLimitSettingsJson,
  parseGeminiCliStreamEvent,
  validateGeminiExitCode,
  type GeminiCliExecutionContext,
  type GeminiCliExecutorShape
} from "@llm4ts/core/providers/GeminiCliProvider"
import { nodeProcessExecutor } from "./NodeProcessExecutor.ts"
import { nodeTemporaryFiles } from "./NodeTemporaryFiles.ts"

const failure = (message: string): ProviderError => ProviderError.make({ message })

export const makeNodeGeminiCliExecutor = (
  executor: ProcessExecutorShape,
  temporaryFiles: TemporaryFilesShape
): GeminiCliExecutorShape => {
  // A turn limit reaches the CLI as `model.maxSessionTurns` in a settings
  // file the process is pointed at; the file lives as long as the turn.
  const environmentFor = (context: GeminiCliExecutionContext) =>
    context.turnLimit === undefined
      ? Effect.succeed(geminiProcessEnv(context))
      : Effect.map(
          temporaryFiles.write(
            "gemini-settings-",
            ".json",
            geminiTurnLimitSettingsJson(context.turnLimit)
          ),
          (path) => geminiProcessEnv(context, path)
        )
  // The harness policy (`geminiHarnessPolicyToml`) goes in with
  // `--admin-policy` on a CLI that lists the flag: `gemini --help` is asked
  // once, and an older CLI simply runs without it — an unknown flag would
  // fail every turn.
  let adminPolicy: boolean | undefined
  const supportsAdminPolicy: Effect.Effect<boolean> = Effect.suspend(() =>
    adminPolicy !== undefined
      ? Effect.succeed(adminPolicy)
      : executor.run(["gemini", "--help"], process.cwd(), {}).pipe(
          Effect.map((result) =>
            geminiSupportsAdminPolicy([...result.stdout, ...result.stderr].join("\n"))
          ),
          Effect.catch(() => Effect.succeed(false)),
          Effect.tap((supported) =>
            Effect.sync(() => {
              adminPolicy = supported
            })
          )
        )
  )
  /** The turn's arguments: the policy file, written for the turn, when the CLI takes it. */
  const argsFor = (
    config: Parameters<typeof buildGeminiArgs>[0],
    context: GeminiCliExecutionContext,
    outputFormat: string
  ) =>
    Effect.flatMap(supportsAdminPolicy, (supported) =>
      supported
        ? Effect.map(
            temporaryFiles.write("gemini-policy-", ".toml", geminiHarnessPolicyToml),
            (path) => buildGeminiArgs(config, context, outputFormat, path)
          )
        : Effect.succeed(buildGeminiArgs(config, context, outputFormat))
    )
  return {
    checkGeminiInstalled: executor
      .run(["gemini", "--version"], process.cwd(), {})
      .pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout.join("\n").trim())
            : Effect.fail(failure(`Gemini CLI is unavailable: ${result.stderr.join("\n")}`))
        )
      ),
    runGeminiProcess: (prompt, config, context) =>
      Effect.scoped(
        Effect.gen(function* () {
          const environment = yield* environmentFor(context)
          const args = yield* argsFor(config, context, "json")
          const result = yield* executor.runWithStdin(
            ["gemini", ...args],
            context.cwd ?? process.cwd(),
            environment,
            prompt
          )
          yield* validateGeminiExitCode(
            result.exitCode,
            result.stderr.join("\n"),
            context.turnLimit
          )
          const extracted = extractGeminiCliResponse(result.stdout.join("\n"))
          return extracted.ok ? extracted.value : yield* failure(extracted.error)
        })
      ),
    runGeminiProcessStream: (prompt, config, context) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.map(
            Effect.all([environmentFor(context), argsFor(config, context, "stream-json")]),
            ([environment, args]) =>
              executor
                .runStreamingWithStdin(
                  ["gemini", ...args],
                  context.cwd ?? process.cwd(),
                  environment,
                  prompt
                )
                .pipe(Stream.map(parseGeminiCliStreamEvent))
          )
        )
      )
  }
}

export const nodeGeminiCliExecutor = makeNodeGeminiCliExecutor(
  nodeProcessExecutor,
  nodeTemporaryFiles
)

export const NodeGeminiCliExecutorLive = Layer.succeed(GeminiCliExecutor, nodeGeminiCliExecutor)
