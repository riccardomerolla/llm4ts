import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { CliContext } from "@llm4ts/core/Connector"
import { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { ProviderError } from "@llm4ts/core/Errors"
import { ConnectorIds } from "@llm4ts/core/Models"
import {
  ProcessResult,
  makeFakeProcessExecutor,
  makeProcessExecutor,
  processCommandKey
} from "@llm4ts/core/ProcessExecutor"
import {
  antigravityExtraArgs,
  buildAntigravityArgv,
  makeAntigravityConnector
} from "@llm4ts/core/providers/AntigravityConnector"

const context = CliContext.make({
  worktreePath: "/workspace",
  repoPath: "/repo"
})

describe("AntigravityConnector", () => {
  it("builds deterministic workspace, model, read-only, and passthrough arguments", () => {
    const config = CliConnectorConfig.make({
      connectorId: ConnectorIds.AntigravityCli,
      model: "Gemini 3.5 Flash (Low)",
      workingDir: "/tmp/repo",
      readOnly: true,
      flags: {
        sandbox: "",
        mode: "accept-edits",
        alpha: "one"
      }
    })

    assert.deepStrictEqual(antigravityExtraArgs(config), [
      "--add-dir",
      "/tmp/repo",
      "--model",
      "Gemini 3.5 Flash (Low)",
      "--alpha",
      "one",
      "--mode",
      "plan",
      "--sandbox"
    ])
    assert.deepStrictEqual(buildAntigravityArgv(config, "do it").slice(-2), ["--print", "do it"])
  })

  it.effect("runs in the configured directory and includes it as an agy workspace", () =>
    Effect.gen(function* () {
      const config = CliConnectorConfig.make({
        connectorId: ConnectorIds.AntigravityCli,
        workingDir: "/tmp/repo",
        envVars: {
          GOOGLE_API_KEY: "test"
        }
      })
      const argv = buildAntigravityArgv(config, "edit something")
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [processCommandKey(argv), ProcessResult.make({ stdout: ["ok"], exitCode: 0 })]
        ])
      })
      const connector = makeAntigravityConnector(config, fake.executor)

      assert.strictEqual(yield* connector.complete("edit something"), "ok")
      const recorded = yield* fake.recorded
      assert.strictEqual(recorded[0]?.cwd, "/tmp/repo")
      assert.deepStrictEqual(recorded[0]?.envVars, { GOOGLE_API_KEY: "test" })
      assert.deepStrictEqual(connector.buildInteractiveArgv(context), [
        "agy",
        "--add-dir",
        "/tmp/repo"
      ])
    })
  )

  it.effect("includes stderr and stdout in non-zero captured failures", () =>
    Effect.gen(function* () {
      const config = CliConnectorConfig.make({
        connectorId: ConnectorIds.AntigravityCli
      })
      const argv = buildAntigravityArgv(config, "hello")
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(argv),
            ProcessResult.make({
              stdout: ["usage"],
              stderr: ['model "nope" is not recognized'],
              exitCode: 1
            })
          ]
        ])
      })
      const connector = makeAntigravityConnector(config, fake.executor)
      const error = yield* Effect.flip(connector.complete("hello"))

      assert.strictEqual(error._tag, "ProviderError")
      assert.match(error.message, /model "nope" is not recognized\nusage/)
    })
  )

  it.effect("streams plain lines, emits a terminal stop, and preserves stream failures", () =>
    Effect.gen(function* () {
      const config = CliConnectorConfig.make({
        connectorId: ConnectorIds.AntigravityCli
      })
      const argv = buildAntigravityArgv(config, "go")
      const fake = yield* makeFakeProcessExecutor({
        streamResponses: new Map([[processCommandKey(argv), ["line one", "line two"]]])
      })
      const connector = makeAntigravityConnector(config, fake.executor)
      const chunks = yield* Stream.runCollect(connector.completeStream("go"))

      assert.deepStrictEqual(
        chunks.map((chunk) => chunk.delta),
        ["line one", "line two", ""]
      )
      assert.strictEqual(chunks[2]?.finishReason, "stop")

      const failing = makeAntigravityConnector(
        config,
        makeProcessExecutor({
          run: () => Effect.succeed(ProcessResult.make({ stdout: [], exitCode: 0 })),
          runStreaming: () =>
            Stream.fail(ProviderError.make({ message: "agy exited with code 1: boom" }))
        })
      )
      const error = yield* Effect.flip(Stream.runCollect(failing.completeStream("go")))
      assert.match(error.message, /boom/)
    })
  )

  it.effect("classifies version exit codes and process failures as unhealthy", () =>
    Effect.gen(function* () {
      const config = CliConnectorConfig.make({
        connectorId: ConnectorIds.AntigravityCli
      })
      const version = ["agy", "--version"]
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [processCommandKey(version), ProcessResult.make({ stdout: [], exitCode: 127 })]
        ])
      })
      const connector = makeAntigravityConnector(config, fake.executor)

      assert.strictEqual((yield* connector.healthCheck).availability, "Unhealthy")
      assert.isFalse(yield* connector.isAvailable)
      assert.strictEqual(connector.interactionSupport, "InteractiveStdin")
      assert.isTrue(connector.capabilities.interactiveSessions)
    })
  )
})
