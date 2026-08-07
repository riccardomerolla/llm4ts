import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { ApiConnectorConfig, CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { makeHttpClient } from "@llm4ts/core/HttpClient"
import { ConnectorIds } from "@llm4ts/core/Models"
import { ProcessResult, makeProcessExecutor } from "@llm4ts/core/ProcessExecutor"
import { makeFakeTemporaryFiles } from "@llm4ts/core/TemporaryFiles"
import { createConnectorRegistry } from "@llm4ts/core/providers/ConnectorFactories"
import type { GeminiCliExecutorShape } from "@llm4ts/core/providers/GeminiCliProvider"

const geminiCli: GeminiCliExecutorShape = {
  checkGeminiInstalled: Effect.void,
  runGeminiProcess: () => Effect.succeed('{"response":"ok"}'),
  runGeminiProcessStream: () => Stream.empty
}

describe("ConnectorFactories", () => {
  it.effect("registers every source connector and keeps opencode bound to CLI", () =>
    Effect.gen(function* () {
      const temporary = yield* makeFakeTemporaryFiles()
      const registry = createConnectorRegistry({
        http: makeHttpClient({
          postJson: () => Effect.succeed("{}")
        }),
        process: makeProcessExecutor({
          run: () => Effect.succeed(ProcessResult.make({ stdout: ["ok"], exitCode: 0 })),
          runStreaming: () => Stream.empty
        }),
        temporaryFiles: temporary.temporaryFiles,
        geminiCli
      })

      const ids = yield* registry.available
      const opencode = yield* registry.resolveCli(
        CliConnectorConfig.make({
          connectorId: ConnectorIds.OpenCode
        })
      )
      const mock = yield* registry.resolveApi(
        ApiConnectorConfig.make({
          connectorId: ConnectorIds.Mock,
          model: "mock"
        })
      )

      assert.strictEqual(ids.length, 15)
      assert.deepStrictEqual(
        new Set(ids.map((id) => id.value)),
        new Set([
          "openai",
          "anthropic",
          "gemini-api",
          "lm-studio",
          "ollama",
          "claude-cli",
          "opencode",
          "gemini-cli",
          "codex",
          "copilot",
          "pi",
          "antigravity-cli",
          "grok",
          "cursor",
          "mock"
        ])
      )
      assert.strictEqual(opencode.kind, "Cli")
      assert.strictEqual(mock.kind, "Api")
    })
  )

  it.effect("declares the source capability matrix", () =>
    Effect.gen(function* () {
      const temporary = yield* makeFakeTemporaryFiles()
      const process = makeProcessExecutor({
        run: () => Effect.succeed(ProcessResult.make({ stdout: [], exitCode: 0 })),
        runStreaming: () => Stream.empty
      })
      const registry = createConnectorRegistry({
        http: makeHttpClient({
          postJson: () => Effect.succeed("{}")
        }),
        process,
        temporaryFiles: temporary.temporaryFiles,
        geminiCli
      })
      const claude = yield* registry.resolveCli(
        CliConnectorConfig.make({ connectorId: ConnectorIds.ClaudeCli })
      )
      const gemini = yield* registry.resolveCli(
        CliConnectorConfig.make({ connectorId: ConnectorIds.GeminiCli })
      )
      const antigravity = yield* registry.resolveCli(
        CliConnectorConfig.make({
          connectorId: ConnectorIds.AntigravityCli
        })
      )
      const copilot = yield* registry.resolveCli(
        CliConnectorConfig.make({ connectorId: ConnectorIds.Copilot })
      )
      const mock = yield* registry.resolveApi(
        ApiConnectorConfig.make({
          connectorId: ConnectorIds.Mock,
          model: "mock"
        })
      )

      assert.isTrue(claude.capabilities.interactiveSessions)
      assert.isTrue(claude.capabilities.askUser)
      assert.isTrue(claude.capabilities.approval)
      assert.isTrue(claude.capabilities.resumableSessions)
      assert.isTrue(gemini.capabilities.interactiveSessions)
      assert.isFalse(gemini.capabilities.askUser)
      assert.isTrue(antigravity.capabilities.interactiveSessions)
      assert.isFalse(antigravity.capabilities.approval)
      assert.isFalse(copilot.capabilities.interactiveSessions)
      assert.isTrue(mock.capabilities.streaming)
      assert.isTrue(mock.capabilities.structuredOutput)
      assert.isTrue(mock.capabilities.usageReporting)

      // Read-only enforcement grades (ADR 0010): claude's --tools allowlist
      // is a real removal; gemini/antigravity lean on unverified plan modes;
      // copilot ignores the flag; API providers execute no tools at all.
      assert.strictEqual(claude.capabilities.readOnlyEnforcement, "enforced")
      assert.strictEqual(gemini.capabilities.readOnlyEnforcement, "advisory")
      assert.strictEqual(antigravity.capabilities.readOnlyEnforcement, "advisory")
      assert.strictEqual(copilot.capabilities.readOnlyEnforcement, "ignored")
      assert.strictEqual(mock.capabilities.readOnlyEnforcement, "enforced")
    })
  )
})
