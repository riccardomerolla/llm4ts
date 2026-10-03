import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { ProcessResult, makeFakeProcessExecutor } from "@llm4ts/core/ProcessExecutor"
import { makeFakeTemporaryFiles } from "@llm4ts/core/TemporaryFiles"
import { LlmConfig } from "@llm4ts/core/Models"
import { GeminiCliExecutionContext } from "@llm4ts/core/providers/GeminiCliProvider"
import { makeNodeGeminiCliExecutor } from "@llm4ts/runner/NodeGeminiCliExecutor"

const config = LlmConfig.make({ provider: "GeminiCli", model: "gemini-2.5-flash" })

const responses = new Map<string, ProcessResult>([
  [
    JSON.stringify(["gemini", "--version"]),
    ProcessResult.make({ exitCode: 0, stdout: ["0.47.0"], stderr: [] })
  ]
])

describe("NodeGeminiCliExecutor", () => {
  it.effect("reports the installed CLI's version from the probe", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeProcessExecutor({ responses })
      const temporary = yield* makeFakeTemporaryFiles("/tmp/gemini-settings.json")
      const executor = makeNodeGeminiCliExecutor(fake.executor, temporary.temporaryFiles)
      assert.strictEqual(yield* executor.checkGeminiInstalled, "0.47.0")
    })
  )

  it.effect("applies a turn limit through a settings file and passes the seat's env", () =>
    Effect.gen(function* () {
      const argv = [
        "gemini",
        "-m",
        "gemini-2.5-flash",
        "--approval-mode",
        "default",
        "--output-format",
        "json"
      ]
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          ...responses,
          [
            JSON.stringify(argv),
            ProcessResult.make({ exitCode: 0, stdout: ['{"response":"ok"}'], stderr: [] })
          ]
        ])
      })
      const temporary = yield* makeFakeTemporaryFiles("/tmp/gemini-settings.json")
      const executor = makeNodeGeminiCliExecutor(fake.executor, temporary.temporaryFiles)
      const reply = yield* executor.runGeminiProcess(
        "judge",
        config,
        GeminiCliExecutionContext.make({
          cwd: "/repo",
          readOnly: true,
          turnLimit: 12,
          envVars: { GEMINI_API_KEY: "k" }
        })
      )
      assert.strictEqual(reply, "ok")
      const written = yield* temporary.files
      assert.deepStrictEqual(written, [
        { path: "/tmp/gemini-settings.json", contents: '{"model":{"maxSessionTurns":12}}' }
      ])
      const run = (yield* fake.recorded).find((invocation) => invocation.argv[1] === "-m")
      assert.strictEqual(run?.cwd, "/repo")
      assert.deepStrictEqual(run?.envVars, {
        GEMINI_API_KEY: "k",
        GEMINI_CLI_TRUST_WORKSPACE: "true",
        GEMINI_CLI_SYSTEM_DEFAULTS_PATH: "/tmp/gemini-settings.json"
      })
    })
  )

  it.effect("writes no settings file for a seat without a turn limit", () =>
    Effect.gen(function* () {
      const argv = ["gemini", "-m", "gemini-2.5-flash", "-y", "--output-format", "json"]
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            JSON.stringify(argv),
            ProcessResult.make({ exitCode: 0, stdout: ['{"response":"ok"}'], stderr: [] })
          ]
        ])
      })
      const temporary = yield* makeFakeTemporaryFiles("/tmp/gemini-settings.json")
      const executor = makeNodeGeminiCliExecutor(fake.executor, temporary.temporaryFiles)
      yield* executor.runGeminiProcess(
        "code",
        config,
        GeminiCliExecutionContext.make({ cwd: "/repo" })
      )
      assert.deepStrictEqual(yield* temporary.files, [])
      const run = (yield* fake.recorded)[0]
      assert.deepStrictEqual(run?.envVars, { GEMINI_CLI_TRUST_WORKSPACE: "true" })
    })
  )
})
