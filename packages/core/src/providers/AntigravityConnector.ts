import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { makeCliConnector, type CliConnectorShape } from "../Connector.ts"
import type { CliConnectorConfig } from "../ConnectorConfig.ts"
import { ProviderError } from "../Errors.ts"
import { ConnectorIds, HealthStatus, LlmChunk } from "../Models.ts"
import type { ProcessExecutorShape } from "../ProcessExecutor.ts"
import { optionalModelArgs, sortedFlagArgs } from "./CliSupport.ts"

const healthy = HealthStatus.make({
  availability: "Healthy",
  authStatus: "Valid"
})

const unhealthy = HealthStatus.make({
  availability: "Unhealthy",
  authStatus: "Unknown"
})

export const antigravityExtraArgs = (config: CliConnectorConfig): ReadonlyArray<string> => {
  const workspaceArgs = config.workingDir === undefined ? [] : ["--add-dir", config.workingDir]
  const effectiveFlags = config.readOnly
    ? {
        ...config.flags,
        mode: "plan"
      }
    : config.flags

  return [...workspaceArgs, ...optionalModelArgs(config.model), ...sortedFlagArgs(effectiveFlags)]
}

export const buildAntigravityArgv = (
  config: CliConnectorConfig,
  prompt: string
): ReadonlyArray<string> => ["agy", ...antigravityExtraArgs(config), "--print", prompt]

export const makeAntigravityConnector = (
  config: CliConnectorConfig,
  executor: ProcessExecutorShape
): CliConnectorShape => {
  const cwd = config.workingDir ?? "."
  const healthCheck = executor.run(["agy", "--version"], cwd, {}).pipe(
    Effect.map((result) => (result.exitCode === 0 ? healthy : unhealthy)),
    Effect.catch(() => Effect.succeed(unhealthy))
  )

  const complete = Effect.fn("@llm4ts/core/providers/AntigravityConnector.complete")(function* (
    prompt: string
  ) {
    const result = yield* executor.run(buildAntigravityArgv(config, prompt), cwd, config.envVars)
    if (result.exitCode !== 0) {
      const detail = [...result.stderr, ...result.stdout].join("\n")
      return yield* ProviderError.make({
        message: `agy exited with code ${result.exitCode}: ${detail}`
      })
    }
    return result.stdout.join("\n")
  })

  const completeStream = (prompt: string) =>
    Stream.concat(
      executor
        .runStreaming(buildAntigravityArgv(config, prompt), cwd, config.envVars)
        .pipe(Stream.map((line) => LlmChunk.make({ delta: line }))),
      Stream.make(LlmChunk.make({ delta: "", finishReason: "stop" }))
    )

  return makeCliConnector({
    id: ConnectorIds.AntigravityCli,
    interactionSupport: "InteractiveStdin",
    buildArgv: (prompt, _context) => buildAntigravityArgv(config, prompt),
    buildInteractiveArgv: (_context) => ["agy", ...antigravityExtraArgs(config)],
    complete,
    completeStream,
    healthCheck
  })
}
