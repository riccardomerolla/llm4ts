import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { makeCliConnector, type CliConnectorShape } from "../Connector.ts"
import type { CliConnectorConfig } from "../ConnectorConfig.ts"
import { ProviderError } from "../Errors.ts"
import { ConnectorIds, HealthStatus, LlmChunk } from "../Models.ts"
import type { ProcessExecutorShape } from "../ProcessExecutor.ts"

const healthy = HealthStatus.make({
  availability: "Healthy",
  authStatus: "Valid"
})

const unhealthy = HealthStatus.make({
  availability: "Unhealthy",
  authStatus: "Unknown"
})

export const buildCopilotArgv = (prompt: string): ReadonlyArray<string> => [
  "gh",
  "copilot",
  "suggest",
  "-t",
  "shell",
  prompt
]

export const makeCopilotConnector = (
  config: CliConnectorConfig,
  executor: ProcessExecutorShape
): CliConnectorShape => {
  const healthCheck = executor.run(["gh", "copilot", "--version"], ".", {}).pipe(
    Effect.as(healthy),
    Effect.catch(() => Effect.succeed(unhealthy))
  )

  const complete = Effect.fn("@llm4ts/core/providers/CopilotConnector.complete")(function* (
    prompt: string
  ) {
    const argv = buildCopilotArgv(prompt)
    const result = yield* executor.run(argv, ".", config.envVars)
    if (result.exitCode !== 0) {
      return yield* ProviderError.make({
        message: `gh copilot exited with code ${result.exitCode}: ${result.stdout.join("\n")}`
      })
    }
    return result.stdout.join("\n")
  })

  return makeCliConnector({
    id: ConnectorIds.Copilot,
    interactionSupport: "ContinuationOnly",
    buildArgv: (prompt, _context) => buildCopilotArgv(prompt),
    buildInteractiveArgv: (_context) => ["gh", "copilot"],
    complete,
    completeStream: (prompt) =>
      Stream.fromEffect(complete(prompt)).pipe(
        Stream.map((text) => LlmChunk.make({ delta: text }))
      ),
    healthCheck,
    isAvailable: Effect.map(healthCheck, (status) => status.availability === "Healthy")
  })
}
