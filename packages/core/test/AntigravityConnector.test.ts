import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { CliContext } from "@llm4ts/core/Connector"
import { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { InvalidRequestError, ProviderError, type LlmError } from "@llm4ts/core/Errors"
import { ConnectorIds } from "@llm4ts/core/Models"
import {
  ProcessResult,
  makeFakeProcessExecutor,
  makeProcessExecutor,
  processCommandKey
} from "@llm4ts/core/ProcessExecutor"
import { collect } from "@llm4ts/core/Streaming"
import {
  antigravityExtraArgs,
  antigravityReadOnlySettings,
  antigravityStreamArgv,
  buildAntigravityArgv,
  makeAntigravityConnector,
  parseAntigravityStreamLine
} from "@llm4ts/core/providers/AntigravityConnector"

const context = CliContext.make({
  worktreePath: "/workspace",
  repoPath: "/repo"
})

const base = CliConnectorConfig.make({ connectorId: ConnectorIds.AntigravityCli })

// Lines as agy 1.5.17 printed them under `--output-format stream-json`
// (2026-11-25), with the conversation id and the paths shortened.
const init =
  '{"event":"init","conversation_id":"c1","init":{"model":"gpt-oss-120b-medium","cwd":"/ws","tools":["run_command","view_file","write_to_file"],"permission_mode":"request-review"}}'
const userInput =
  '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":0,"state":"DONE","step_type":"user_input"}}'
const thought =
  '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":3.453129,"usage":{"input_tokens":5168,"output_tokens":238,"thinking_tokens":0,"cache_read_tokens":9664,"total_tokens":5406}}}'
const readStarted =
  '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"Path":"/ws/notes.txt"}}}}'
const readDone =
  '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":2,"state":"DONE","step_type":"tool","tool_name":"read_file","duration_seconds":0.424913,"tool_info":{"name":"read_file","parameters":{"Path":"/ws/notes.txt"},"output":"1 lines, 17 bytes"}}}'
const commandStarted =
  '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":7,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo shell > shell.txt"}}}}'
const commandDenied =
  '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":7,"state":"ERROR","step_type":"tool","tool_name":"run_command","duration_seconds":0.431613,"tool_info":{"name":"run_command","parameters":{"CommandLine":"echo shell > shell.txt"},"error":{"type":"TOOL_ERROR","message":"permission check failed: user denied permission to run command"}}}}'
const textOne =
  '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":8,"state":"ACTIVE","step_type":"agent_response","text_delta":"# Plan\\n\\n- one"}}'
const textTwo =
  '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":8,"state":"ACTIVE","step_type":"agent_response","text_delta":"\\n- two"}}'
const textEnd =
  '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":8,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":2.037213,"usage":{"input_tokens":433,"output_tokens":5,"thinking_tokens":0,"cache_read_tokens":14976,"total_tokens":438}}}'
const success =
  '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"# Plan\\n\\n- one\\n- two\\n","duration_seconds":11.293153,"num_turns":1,"usage":{"input_tokens":5601,"output_tokens":243,"thinking_tokens":0,"cache_read_tokens":24640,"total_tokens":5844}}}'
const quotaResult =
  '{"event":"result","result":{"conversation_id":"c1","status":"ERROR","response":"","error":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h39m18s.","duration_seconds":0,"num_turns":1,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},"finished_reason":"error"}}'
const deniedResult =
  '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"","duration_seconds":8.572421,"num_turns":1,"usage":{"input_tokens":17788,"output_tokens":574,"thinking_tokens":0,"cache_read_tokens":25216,"total_tokens":18362},"denied_actions":[{"action":"command","display_name":"Bash"}]}}'

const turn = [init, userInput, thought, readStarted, readDone, textOne, textTwo, textEnd, success]

const streaming = (lines: ReadonlyArray<string>, failure?: LlmError) =>
  makeProcessExecutor({
    run: () => Effect.succeed(ProcessResult.make({ stdout: ["1.5.17"], exitCode: 0 })),
    runStreaming: () =>
      failure === undefined
        ? Stream.fromIterable(lines)
        : Stream.concat(Stream.fromIterable(lines), Stream.fail(failure))
  })

const failureOf = (lines: ReadonlyArray<string>, failure?: LlmError) =>
  Effect.flip(
    Stream.runCollect(
      makeAntigravityConnector(base, streaming(lines, failure)).completeStream("go")
    )
  )

describe("AntigravityConnector", () => {
  it("builds deterministic workspace, model and passthrough arguments, and sends no effort", () => {
    const config = CliConnectorConfig.make({
      connectorId: ConnectorIds.AntigravityCli,
      model: "gemini-3.8-flash-low",
      workingDir: "/tmp/repo",
      effort: "max",
      flags: {
        sandbox: "",
        alpha: "one"
      }
    })

    assert.deepStrictEqual(antigravityExtraArgs(config), [
      "--add-dir",
      "/tmp/repo",
      "--model",
      "gemini-3.8-flash-low",
      "--alpha",
      "one",
      "--sandbox"
    ])
    assert.deepStrictEqual(buildAntigravityArgv(config, "do it").slice(-2), ["--print", "do it"])
    // agy names the effort in the model id and refuses a conflicting `--effort`.
    assert.strictEqual(
      makeAntigravityConnector(config, streaming([])).capabilities.effort,
      "ignored"
    )
  })

  it("a read-only seat is denied writes and commands and keeps no approval flag", () => {
    const config = CliConnectorConfig.make({
      connectorId: ConnectorIds.AntigravityCli,
      readOnly: true,
      flags: {
        mode: "accept-edits",
        "dangerously-skip-permissions": "",
        sandbox: ""
      }
    })

    // No `--mode plan`: it turns the task into a planning workflow.
    assert.deepStrictEqual(antigravityExtraArgs(config), [
      "--sandbox",
      "--settings",
      antigravityReadOnlySettings
    ])
    assert.deepStrictEqual(JSON.parse(antigravityReadOnlySettings), {
      permissions: { deny: ["command(*)", "write_file(*)"] }
    })

    // A `settings` flag the operator wrote is theirs.
    const own = CliConnectorConfig.make({ ...config, flags: { settings: "/etc/agy/judge.json" } })
    assert.deepStrictEqual(antigravityExtraArgs(own), ["--settings", "/etc/agy/judge.json"])

    assert.strictEqual(
      makeAntigravityConnector(config, streaming([])).capabilities.readOnlyEnforcement,
      "advisory"
    )
  })

  it.effect("sends the prompt on stdin, never in the arguments", () =>
    Effect.gen(function* () {
      const config = CliConnectorConfig.make({
        connectorId: ConnectorIds.AntigravityCli,
        workingDir: "/tmp/repo",
        envVars: {
          GOOGLE_API_KEY: "test"
        }
      })
      const argv = antigravityStreamArgv(config)
      const stdin: Array<string> = []
      const fake = yield* makeFakeProcessExecutor({
        streamResponses: new Map([[processCommandKey(argv), turn]])
      })
      const connector = makeAntigravityConnector(config, {
        ...fake.executor,
        runStreamingWithStdin: (command, cwd, envVars, input) => {
          stdin.push(input)
          return fake.executor.runStreaming(command, cwd, envVars)
        }
      })

      assert.strictEqual(yield* connector.complete("edit something"), "# Plan\n\n- one\n- two\n")
      const recorded = yield* fake.recorded
      assert.deepStrictEqual(recorded[0]?.argv, [
        "agy",
        "--add-dir",
        "/tmp/repo",
        "--output-format",
        "stream-json"
      ])
      assert.deepStrictEqual(stdin, ["edit something"])
      assert.strictEqual(recorded[0]?.cwd, "/tmp/repo")
      assert.deepStrictEqual(recorded[0]?.envVars, { GOOGLE_API_KEY: "test" })
      assert.deepStrictEqual(connector.buildInteractiveArgv(context), [
        "agy",
        "--add-dir",
        "/tmp/repo"
      ])
    })
  )

  it.effect("reads text with its line breaks, the turn's usage and the model that served it", () =>
    Effect.gen(function* () {
      const connector = makeAntigravityConnector(base, streaming(turn))
      const reply = yield* collect(connector.executeStream("go"))

      assert.strictEqual(reply.content, "# Plan\n\n- one\n- two\n")
      // Two model responses: the counts add up, as the result's own total does.
      assert.deepStrictEqual(
        { ...reply.usage },
        { prompt: 5601, completion: 243, total: 5844, cached: 24640 }
      )
      assert.strictEqual(reply.metadata.model, "gpt-oss-120b-medium")
      assert.isTrue(connector.capabilities.usageReporting)

      const chunks = yield* Stream.runCollect(connector.completeStream("go"))
      assert.strictEqual(chunks.at(-1)?.finishReason, "stop")
      assert.strictEqual(chunks.at(-1)?.usage, undefined)
    })
  )

  it("reports a tool call when it starts and when it ends", () => {
    const started = parseAntigravityStreamLine(readStarted)[0]
    assert.deepStrictEqual(started?.metadata, {
      event: "tool_use",
      tool_name: "read_file",
      tool_input: '{"Path":"/ws/notes.txt"}',
      tool_id: "2"
    })
    assert.deepStrictEqual(parseAntigravityStreamLine(readDone)[0]?.metadata, {
      event: "tool_result",
      tool_id: "2",
      tool_duration_ms: "425",
      tool_content: "1 lines, 17 bytes"
    })
    assert.strictEqual(
      parseAntigravityStreamLine(commandStarted)[0]?.metadata.tool_name,
      "run_command"
    )
    const denied = parseAntigravityStreamLine(commandDenied)[0]?.metadata
    assert.strictEqual(denied?.tool_failed, "true")
    assert.match(denied?.tool_content ?? "", /user denied permission/)

    assert.deepStrictEqual(parseAntigravityStreamLine(init), [])
    assert.deepStrictEqual(parseAntigravityStreamLine(userInput), [])
    assert.deepStrictEqual(parseAntigravityStreamLine("jetski: not json"), [])
  })

  it.effect("types an exhausted quota, with the time agy says it resets", () =>
    Effect.gen(function* () {
      // In the result event, before the process exits with code 3.
      const inResult = yield* failureOf(
        [init, userInput, quotaResult],
        ProviderError.make({ message: "agy failed: agy exited with code 3" })
      )
      assert.strictEqual(inResult._tag, "UsageLimitError")
      assert.isDefined(inResult._tag === "UsageLimitError" ? inResult.resetAt : undefined)

      // On stderr alone, which the executor folds into the failure's message.
      const onStderr = yield* failureOf(
        [],
        ProviderError.make({
          message:
            "agy failed: agy exited with code 3: error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 3h39m15s."
        })
      )
      assert.strictEqual(onStderr._tag, "UsageLimitError")
    })
  )

  it.effect("fails a turn agy ended without a reply because it denied a tool", () =>
    Effect.gen(function* () {
      const error = yield* failureOf([init, userInput, commandStarted, commandDenied, deniedResult])

      assert.strictEqual(error._tag, "ProviderError")
      assert.match(error.message, /agy denied Bash/)
      assert.match(error.message, /permissions\.allow/)
    })
  )

  it.effect("leaves every other failure as it was", () =>
    Effect.gen(function* () {
      const boom = ProviderError.make({ message: "agy failed: agy exited with code 2: boom" })
      assert.strictEqual(yield* failureOf([init], boom), boom)

      const invalid = InvalidRequestError.make({ message: "empty argv" })
      assert.strictEqual(yield* failureOf([], invalid), invalid)

      const reported = yield* failureOf([
        '{"event":"result","result":{"status":"ERROR","response":"","error":"model \\"nope\\" is not recognized"}}'
      ])
      assert.strictEqual(reported._tag, "ProviderError")
      assert.match(reported.message, /model "nope" is not recognized/)
    })
  )

  it.effect("is unhealthy when the version probe fails, and never claims a login", () =>
    Effect.gen(function* () {
      const version = ["agy", "--version"]
      const answering = (exitCode: number) =>
        makeFakeProcessExecutor({
          responses: new Map([
            [processCommandKey(version), ProcessResult.make({ stdout: ["1.5.17"], exitCode })]
          ])
        })
      const broken = makeAntigravityConnector(base, (yield* answering(127)).executor)
      const installed = makeAntigravityConnector(base, (yield* answering(0)).executor)
      const missing = makeAntigravityConnector(base, (yield* makeFakeProcessExecutor()).executor)

      assert.strictEqual((yield* broken.healthCheck).availability, "Unhealthy")
      assert.isFalse(yield* broken.isAvailable)
      assert.strictEqual((yield* missing.healthCheck).availability, "Unhealthy")
      assert.deepStrictEqual(
        { ...(yield* installed.healthCheck) },
        { availability: "Healthy", authStatus: "Unknown" }
      )
      assert.strictEqual(installed.interactionSupport, "InteractiveStdin")
      assert.isTrue(installed.capabilities.interactiveSessions)
    })
  )
})
