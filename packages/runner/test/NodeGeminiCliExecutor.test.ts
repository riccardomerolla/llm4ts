import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { ProcessResult, makeFakeProcessExecutor } from "@llm4ts/core/ProcessExecutor"
import { makeFakeTemporaryFiles } from "@llm4ts/core/TemporaryFiles"
import { LlmConfig } from "@llm4ts/core/Models"
import {
  GeminiCliExecutionContext,
  geminiHarnessPolicyToml
} from "@llm4ts/core/providers/GeminiCliProvider"
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
      const run = (yield* fake.recorded).find((invocation) => invocation.argv[1] === "-m")
      assert.deepStrictEqual(run?.envVars, { GEMINI_CLI_TRUST_WORKSPACE: "true" })
    })
  )

  it.effect("a CLI that takes --admin-policy runs every turn under the harness policy", () =>
    Effect.gen(function* () {
      const argv = [
        "gemini",
        "-m",
        "gemini-2.5-flash",
        "-y",
        "--output-format",
        "json",
        "--admin-policy",
        "/tmp/gemini-policy.toml"
      ]
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            JSON.stringify(["gemini", "--help"]),
            ProcessResult.make({
              exitCode: 0,
              stdout: ["  --admin-policy  Additional admin policy files or directories"],
              stderr: []
            })
          ],
          [
            JSON.stringify(argv),
            ProcessResult.make({ exitCode: 0, stdout: ['{"response":"ok"}'], stderr: [] })
          ]
        ])
      })
      const temporary = yield* makeFakeTemporaryFiles("/tmp/gemini-policy.toml")
      const executor = makeNodeGeminiCliExecutor(fake.executor, temporary.temporaryFiles)
      const context = GeminiCliExecutionContext.make({ cwd: "/repo" })
      assert.strictEqual(yield* executor.runGeminiProcess("code", config, context), "ok")
      assert.strictEqual(yield* executor.runGeminiProcess("again", config, context), "ok")
      assert.deepStrictEqual(yield* temporary.files, [
        { path: "/tmp/gemini-policy.toml", contents: geminiHarnessPolicyToml },
        { path: "/tmp/gemini-policy.toml", contents: geminiHarnessPolicyToml }
      ])
      // `--help` is asked once, not before every turn.
      const helps = (yield* fake.recorded).filter((run) => run.argv[1] === "--help")
      assert.strictEqual(helps.length, 1)
    })
  )
})

describe("the harness policy", () => {
  const argsPattern = (): RegExp => {
    const line = geminiHarnessPolicyToml.split("\n").find((text) => text.startsWith("argsPattern"))
    const literal = /'([^']*)'/u.exec(line ?? "")?.[1]
    if (literal === undefined) {
      throw new Error("no argsPattern")
    }
    return new RegExp(literal, "u")
  }

  it("denies an argument naming llm4ts's installed packages, and nothing of the repository", () => {
    const pattern = argsPattern()
    const args = (value: Record<string, string>): string => JSON.stringify(value)
    assert.isTrue(
      pattern.test(
        args({
          command:
            "sed -n '800,840p' /root/.nvm/versions/node/v24.15.0/lib/node_modules/@llm4ts/shell/node_modules/@llm4ts/flow/src/Review.ts"
        })
      )
    )
    assert.isTrue(
      pattern.test(
        args({ file_path: "C:\\Users\\me\\node_modules\\@llm4ts\\flow\\src\\Review.ts" })
      )
    )
    assert.isFalse(pattern.test(args({ command: "pnpm test" })))
    assert.isFalse(pattern.test(args({ file_path: "/repo/src/review/Review.ts" })))
    assert.isFalse(pattern.test(args({ file_path: "/repo/.llm4ts/epics/e/stories/a.findings.md" })))
  })

  it("is an admin-tier deny for every tool, with a message for the model", () => {
    assert.include(geminiHarnessPolicyToml, 'toolName = "*"')
    assert.include(geminiHarnessPolicyToml, 'decision = "deny"')
    assert.include(geminiHarnessPolicyToml, "denyMessage")
  })
})
