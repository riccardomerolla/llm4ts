import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { CliContext } from "@llm4ts/core/Connector"
import { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { ConnectorIds } from "@llm4ts/core/Models"
import {
  ProcessResult,
  makeFakeProcessExecutor,
  makeProcessExecutor,
  processCommandKey
} from "@llm4ts/core/ProcessExecutor"
import { buildCopilotArgv, makeCopilotConnector } from "@llm4ts/core/providers/CopilotConnector"

const config = CliConnectorConfig.make({
  connectorId: ConnectorIds.Copilot,
  envVars: {
    GH_TOKEN: "test-token"
  }
})

describe("CopilotConnector", () => {
  it("builds continuation and interactive argv", () => {
    const context = CliContext.make({
      worktreePath: "/workspace",
      repoPath: "/repo"
    })
    assert.deepStrictEqual(buildCopilotArgv("fix the bug"), [
      "gh",
      "copilot",
      "suggest",
      "-t",
      "shell",
      "fix the bug"
    ])
    assert.deepStrictEqual(
      makeCopilotConnector(
        config,
        makeProcessExecutor({
          run: () => Effect.succeed(ProcessResult.make({ stdout: [], exitCode: 0 })),
          runStreaming: () => Stream.empty
        })
      ).buildInteractiveArgv(context),
      ["gh", "copilot"]
    )
  })

  it.effect("returns joined stdout and records the configured environment", () =>
    Effect.gen(function* () {
      const argv = buildCopilotArgv("hello")
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(argv),
            ProcessResult.make({ stdout: ["line one", "line two"], exitCode: 0 })
          ]
        ])
      })
      const connector = makeCopilotConnector(config, fake.executor)

      const result = yield* connector.complete("hello")
      const chunks = yield* Stream.runCollect(connector.completeStream("hello"))
      const recorded = yield* fake.recorded

      assert.strictEqual(result, "line one\nline two")
      assert.strictEqual(chunks[0]?.delta, "line one\nline two")
      assert.deepStrictEqual(recorded[0]?.envVars, { GH_TOKEN: "test-token" })
    })
  )

  it.effect("reports a typed provider error for a non-zero suggestion", () =>
    Effect.gen(function* () {
      const argv = buildCopilotArgv("hello")
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(argv),
            ProcessResult.make({ stdout: ["not authenticated"], exitCode: 1 })
          ]
        ])
      })
      const connector = makeCopilotConnector(config, fake.executor)
      const error = yield* Effect.flip(connector.complete("hello"))

      assert.strictEqual(error._tag, "ProviderError")
      assert.match(error.message, /not authenticated/)
    })
  )

  it.effect("preserves source health semantics when the command can be captured", () =>
    Effect.gen(function* () {
      const version = ["gh", "copilot", "--version"]
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [processCommandKey(version), ProcessResult.make({ stdout: [], exitCode: 9 })]
        ])
      })
      const connector = makeCopilotConnector(config, fake.executor)
      const health = yield* connector.healthCheck

      assert.strictEqual(connector.id.value, "copilot")
      assert.strictEqual(connector.kind, "Cli")
      assert.strictEqual(connector.interactionSupport, "ContinuationOnly")
      assert.strictEqual(health.availability, "Healthy")
    })
  )
})
