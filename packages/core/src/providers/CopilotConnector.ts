import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { makeCliConnector, type CliConnectorShape } from "../Connector.ts"
import type { CliConnectorConfig } from "../ConnectorConfig.ts"
import { ProviderError } from "../Errors.ts"
import { ConnectorCapabilities, ConnectorIds, LlmChunk } from "../Models.ts"
import type { ProcessExecutorShape } from "../ProcessExecutor.ts"

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
    // This CLI does not surface token usage, so TokensUsed events (and
    // therefore cost summaries and budgets) cannot include it.
    capabilities: ConnectorCapabilities.make({ usageReporting: false }),
    buildArgv: (prompt, _context) => buildCopilotArgv(prompt),
    buildInteractiveArgv: (_context) => ["gh", "copilot"],
    complete,
    completeStream: (prompt) =>
      Stream.fromEffect(complete(prompt)).pipe(
        Stream.map((text) => LlmChunk.make({ delta: text }))
      ),
    versionProbe: { executor, binary: "gh", versionArgs: ["copilot", "--version"], cwd: "." }
  })
}
