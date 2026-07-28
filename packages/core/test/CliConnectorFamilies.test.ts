import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { CliContext } from "@llm4ts/core/Connector"
import { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { ConnectorIds } from "@llm4ts/core/Models"
import {
  ProcessResult,
  makeProcessExecutor,
  type ProcessExecutorShape
} from "@llm4ts/core/ProcessExecutor"
import {
  cursorExtraArgs,
  makeCursorConnector,
  parseCursorStreamLine
} from "@llm4ts/core/providers/CursorConnector"
import {
  grokCliExtraArgs,
  makeGrokCliConnector,
  parseGrokCliStreamLine
} from "@llm4ts/core/providers/GrokCliConnector"
import {
  makeOpenCodeCliConnector,
  openCodeCliExtraArgs,
  parseOpenCodeCliStreamLine
} from "@llm4ts/core/providers/OpenCodeCliConnector"
import { makePiConnector, parsePiStreamLine, piExtraArgs } from "@llm4ts/core/providers/PiConnector"

const context = CliContext.make({
  worktreePath: "/workspace",
  repoPath: "/repo"
})

const executorWithStream = (lines: ReadonlyArray<string>): ProcessExecutorShape =>
  makeProcessExecutor({
    run: () => Effect.succeed(ProcessResult.make({ stdout: ["captured"], exitCode: 0 })),
    runStreaming: () => Stream.fromIterable(lines)
  })

describe("PiConnector", () => {
  it("builds model, read-only tool, and deterministic flag arguments", () => {
    const config = CliConnectorConfig.make({
      connectorId: ConnectorIds.Pi,
      model: "lmstudio/foo",
      readOnly: true,
      flags: {
        zeta: "",
        alpha: "one"
      }
    })

    assert.deepStrictEqual(piExtraArgs(config), [
      "--model",
      "lmstudio/foo",
      "--tools",
      "read",
      "--alpha",
      "one",
      "--zeta"
    ])
  })

  it.effect("feeds streaming prompts through stdin and parses text, tools, and usage", () =>
    Effect.gen(function* () {
      const seenArgv = yield* Ref.make<ReadonlyArray<string>>([])
      const seenStdin = yield* Ref.make("")
      const lines = [
        '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Adding multiply."}}',
        '{"type":"tool_execution_start","toolName":"bash","args":{"command":"cargo build"}}',
        '{"type":"message_end","message":{"usage":{"input":900,"output":100}}}'
      ]
      const executor = makeProcessExecutor({
        run: () => Effect.succeed(ProcessResult.make({ stdout: ["captured"], exitCode: 0 })),
        runStreaming: () => Stream.empty,
        runStreamingWithStdin: (argv, _cwd, _envVars, stdin) =>
          Stream.concat(
            Stream.fromEffect(
              Ref.set(seenArgv, argv).pipe(Effect.andThen(Ref.set(seenStdin, stdin)))
            ).pipe(Stream.drain),
            Stream.fromIterable(lines)
          )
      })
      const connector = makePiConnector(
        CliConnectorConfig.make({ connectorId: ConnectorIds.Pi }),
        executor
      )
      const chunks = yield* Stream.runCollect(connector.completeStream("THE-PROMPT"))

      assert.deepStrictEqual(yield* Ref.get(seenArgv), ["pi", "-p", "--mode", "json"])
      assert.strictEqual(yield* Ref.get(seenStdin), "THE-PROMPT")
      assert.strictEqual(chunks[0]?.delta, "Adding multiply.")
      assert.strictEqual(chunks[1]?.metadata.tool_name, "bash")
      assert.strictEqual(chunks[2]?.usage?.total, 1000)
    })
  )

  it.effect("turns retry and extension error events into typed stream failures", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        parsePiStreamLine('{"type":"extension_error","error":"extension exploded"}')[0]?.metadata
          .piError,
        "extension exploded"
      )
      const connector = makePiConnector(
        CliConnectorConfig.make({ connectorId: ConnectorIds.Pi }),
        makeProcessExecutor({
          run: () => Effect.succeed(ProcessResult.make({ stdout: [], exitCode: 0 })),
          runStreaming: () => Stream.empty,
          runStreamingWithStdin: () =>
            Stream.make('{"type":"auto_retry_end","success":false,"finalError":"rate limited"}')
        })
      )
      const error = yield* Effect.flip(Stream.runCollect(connector.completeStream("go")))

      assert.strictEqual(error._tag, "ProviderError")
      assert.match(error.message, /rate limited/)
    })
  )
})

describe("OpenCodeCliConnector", () => {
  it("maps edit and read-only modes while keeping the prompt positional", () => {
    const edit = CliConnectorConfig.make({
      connectorId: ConnectorIds.OpenCode,
      model: "anthropic/claude-sonnet-5"
    })
    const readOnly = CliConnectorConfig.make({
      connectorId: ConnectorIds.OpenCode,
      readOnly: true
    })

    assert.deepStrictEqual(openCodeCliExtraArgs(edit), [
      "--model",
      "anthropic/claude-sonnet-5",
      "--auto"
    ])
    assert.deepStrictEqual(openCodeCliExtraArgs(readOnly), ["--agent", "plan"])
    const connector = makeOpenCodeCliConnector(edit, executorWithStream([]))
    assert.deepStrictEqual(connector.buildArgv("fix it", context).slice(-1), ["fix it"])
    assert.deepStrictEqual(connector.buildInteractiveArgv(context), ["opencode"])
  })

  it.effect("parses text, tools, and per-step cached usage", () =>
    Effect.gen(function* () {
      const lines = [
        '{"type":"tool_use","part":{"tool":"bash","state":{"input":{"command":"cargo build"}}}}',
        '{"type":"text","part":{"text":"Adding multiply."}}',
        '{"type":"step_finish","part":{"tokens":{"total":10208,"input":8401,"output":4,"cache":{"read":1792}}}}'
      ]
      const connector = makeOpenCodeCliConnector(
        CliConnectorConfig.make({ connectorId: ConnectorIds.OpenCode }),
        executorWithStream(lines)
      )
      const chunks = yield* Stream.runCollect(connector.completeStream("go"))

      assert.strictEqual(chunks[0]?.metadata.tool_name, "bash")
      assert.strictEqual(chunks[1]?.delta, "Adding multiply.")
      assert.strictEqual(chunks[2]?.usage?.prompt, 8401)
      assert.strictEqual(chunks[2]?.usage?.cached, 1792)
    })
  )

  it.effect("classifies quota events as usage limits", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        parseOpenCodeCliStreamLine('{"type":"error","error":"quota exhausted"}')[0]?.metadata
          .opencodeError,
        "quota exhausted"
      )
      const connector = makeOpenCodeCliConnector(
        CliConnectorConfig.make({ connectorId: ConnectorIds.OpenCode }),
        executorWithStream(['{"type":"error","error":"quota exhausted"}'])
      )
      const error = yield* Effect.flip(Stream.runCollect(connector.completeStream("go")))

      assert.strictEqual(error._tag, "UsageLimitError")
    })
  )
})

describe("GrokCliConnector", () => {
  it("maps model and permission modes", () => {
    const edit = CliConnectorConfig.make({
      connectorId: ConnectorIds.Grok
    })
    const readOnly = CliConnectorConfig.make({
      connectorId: ConnectorIds.Grok,
      model: "grok-4.5",
      readOnly: true
    })

    assert.deepStrictEqual(grokCliExtraArgs(edit), ["--always-approve"])
    assert.deepStrictEqual(grokCliExtraArgs(readOnly), [
      "--model",
      "grok-4.5",
      "--permission-mode",
      "plan"
    ])
  })

  it.effect("skips thoughts and emits text plus terminal model usage", () =>
    Effect.gen(function* () {
      const lines = [
        '{"type":"thought","data":"Thinking"}',
        '{"type":"text","data":"Adding "}',
        '{"type":"text","data":"multiply."}',
        '{"type":"end","usage":{"input_tokens":298,"cache_read_input_tokens":32256,"output_tokens":101,"total_tokens":32655},"modelUsage":{"grok-4.5":{}}}'
      ]
      const connector = makeGrokCliConnector(
        CliConnectorConfig.make({ connectorId: ConnectorIds.Grok }),
        executorWithStream(lines)
      )
      const chunks = yield* Stream.runCollect(connector.completeStream("go"))

      assert.deepStrictEqual(chunks.map((chunk) => chunk.delta).join(""), "Adding multiply.")
      assert.strictEqual(chunks[2]?.usage?.cached, 32256)
      assert.strictEqual(chunks[2]?.metadata.model, "grok-4.5")
      assert.deepStrictEqual(parseGrokCliStreamLine('{"type":"thought","data":"pondering"}'), [])
    })
  )

  it.effect("classifies quota stream events and leaves other errors as provider failures", () =>
    Effect.gen(function* () {
      const quota = makeGrokCliConnector(
        CliConnectorConfig.make({ connectorId: ConnectorIds.Grok }),
        executorWithStream([
          '{"type":"error","data":"429 Too Many Requests — rate limit exceeded"}'
        ])
      )
      const quotaError = yield* Effect.flip(Stream.runCollect(quota.completeStream("go")))
      assert.strictEqual(quotaError._tag, "UsageLimitError")

      const generic = makeGrokCliConnector(
        CliConnectorConfig.make({ connectorId: ConnectorIds.Grok }),
        executorWithStream(['{"type":"error","data":"boom"}'])
      )
      const genericError = yield* Effect.flip(Stream.runCollect(generic.completeStream("go")))
      assert.strictEqual(genericError._tag, "ProviderError")
    })
  )
})

describe("CursorConnector", () => {
  it("maps edit mode to --force and omits it for read-only work", () => {
    const edit = CliConnectorConfig.make({
      connectorId: ConnectorIds.Cursor
    })
    const readOnly = CliConnectorConfig.make({
      connectorId: ConnectorIds.Cursor,
      model: "composer-1",
      readOnly: true
    })

    assert.deepStrictEqual(cursorExtraArgs(edit), ["--force"])
    assert.deepStrictEqual(cursorExtraArgs(readOnly), ["--model", "composer-1"])
  })

  it.effect("parses assistant segments, started tools, and terminal success", () =>
    Effect.gen(function* () {
      const lines = [
        '{"type":"system","subtype":"init"}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Adding "},{"type":"text","text":"multiply."}]}}',
        '{"type":"tool_call","subtype":"started","tool_call":{"shellToolCall":{"args":{"command":"cargo build"}}}}',
        '{"type":"result","is_error":false,"result":"done"}'
      ]
      const connector = makeCursorConnector(
        CliConnectorConfig.make({ connectorId: ConnectorIds.Cursor }),
        executorWithStream(lines)
      )
      const chunks = yield* Stream.runCollect(connector.completeStream("go"))

      assert.strictEqual(chunks[0]?.delta, "Adding multiply.")
      assert.strictEqual(chunks[1]?.metadata.tool_name, "shellToolCall")
      assert.strictEqual(chunks[2]?.finishReason, "stop")
      assert.deepStrictEqual(parseCursorStreamLine(lines[0] ?? ""), [])
    })
  )

  it.effect("classifies usage-limit result errors", () =>
    Effect.gen(function* () {
      const connector = makeCursorConnector(
        CliConnectorConfig.make({ connectorId: ConnectorIds.Cursor }),
        executorWithStream([
          '{"type":"result","is_error":true,"result":"You have hit your usage limit."}'
        ])
      )
      const error = yield* Effect.flip(Stream.runCollect(connector.completeStream("go")))

      assert.strictEqual(error._tag, "UsageLimitError")
    })
  )
})
