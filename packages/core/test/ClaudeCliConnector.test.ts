import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { CliContext } from "@llm4ts/core/Connector"
import { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { ConnectorIds } from "@llm4ts/core/Models"
import { ProcessResult, makeProcessExecutor } from "@llm4ts/core/ProcessExecutor"
import {
  claudeSessionArgv,
  claudeUserMessageJson,
  openClaudeAgentSession,
  parseClaudeSessionLine
} from "@llm4ts/core/providers/ClaudeAgentSession"
import {
  claudeCliExtraArgs,
  makeClaudeCliConnector,
  parseClaudeCliStreamLine
} from "@llm4ts/core/providers/ClaudeCliConnector"

const streamLines = [
  '{"type":"system","subtype":"init","model":"claude-sonnet-4-6"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"{\\"lane\\":\\"Frontend\\",\\"rationale\\":\\"UI change\\"}"},{"type":"tool_use","name":"Edit","id":"tool-1","input":{"file_path":"src/lib.rs"}}]}}',
  '{"type":"result","result":"done","usage":{"input_tokens":1200,"output_tokens":40,"cache_read_input_tokens":1000}}'
]

const triageSchema = Schema.Struct({
  lane: Schema.String,
  rationale: Schema.String
})

const triageJsonSchema = {
  type: "object",
  properties: {
    lane: { type: "string" },
    rationale: { type: "string" }
  },
  required: ["lane", "rationale"]
}

describe("ClaudeCliConnector", () => {
  it("builds deterministic read-only arguments and advertises held-session capabilities", () => {
    const config = CliConnectorConfig.make({
      connectorId: ConnectorIds.ClaudeCli,
      model: "sonnet",
      readOnly: true,
      flags: {
        "permission-mode": "acceptEdits",
        zeta: ""
      }
    })
    const connector = makeClaudeCliConnector(
      config,
      makeProcessExecutor({
        run: () => Effect.succeed(ProcessResult.make({ stdout: [], exitCode: 0 })),
        runStreaming: () => Stream.empty
      })
    )

    assert.deepStrictEqual(claudeCliExtraArgs(config), [
      "--model",
      "sonnet",
      "--disallowed-tools",
      "Write,Edit,NotebookEdit",
      "--permission-mode",
      "default",
      "--zeta"
    ])
    assert.deepStrictEqual(
      connector
        .buildArgv("fix it", CliContext.make({ worktreePath: "/w", repoPath: "/r" }))
        .slice(-1),
      ["fix it"]
    )
    assert.isTrue(connector.capabilities.interactiveSessions)
    assert.isTrue(connector.capabilities.askUser)
    assert.isTrue(connector.capabilities.approval)
    assert.isTrue(connector.capabilities.resumableSessions)
  })

  it.effect("passes prompts through stdin and stamps served model onto usage", () =>
    Effect.gen(function* () {
      const seenArgv = yield* Ref.make<ReadonlyArray<string>>([])
      const seenStdin = yield* Ref.make("")
      const executor = makeProcessExecutor({
        run: () => Effect.succeed(ProcessResult.make({ stdout: [], exitCode: 0 })),
        runStreaming: () => Stream.empty,
        runStreamingWithStdin: (argv, _cwd, _envVars, stdin) =>
          Stream.concat(
            Stream.fromEffect(
              Ref.set(seenArgv, argv).pipe(Effect.andThen(Ref.set(seenStdin, stdin)))
            ).pipe(Stream.drain),
            Stream.fromIterable(streamLines)
          )
      })
      const connector = makeClaudeCliConnector(
        CliConnectorConfig.make({ connectorId: ConnectorIds.ClaudeCli }),
        executor
      )
      const chunks = yield* Stream.runCollect(connector.completeStream("THE-PROMPT"))

      assert.isFalse((yield* Ref.get(seenArgv)).includes("THE-PROMPT"))
      assert.strictEqual(yield* Ref.get(seenStdin), "THE-PROMPT")
      assert.strictEqual(chunks[0]?.delta.includes('"Frontend"'), true)
      assert.strictEqual(chunks[1]?.metadata.tool_name, "Edit")
      assert.strictEqual(chunks[2]?.usage?.prompt, 1200)
      assert.strictEqual(chunks[2]?.metadata.model, "claude-sonnet-4-6")
    })
  )

  it.effect("uses the stream path for structured output and returns usage/model", () =>
    Effect.gen(function* () {
      const connector = makeClaudeCliConnector(
        CliConnectorConfig.make({ connectorId: ConnectorIds.ClaudeCli }),
        makeProcessExecutor({
          run: () => Effect.succeed(ProcessResult.make({ stdout: [], exitCode: 0 })),
          runStreaming: () => Stream.empty,
          runStreamingWithStdin: () => Stream.fromIterable(streamLines)
        })
      )
      const [pick, usage, model] = yield* connector.executeStructuredWithUsage(
        "triage",
        triageSchema,
        triageJsonSchema
      )

      assert.deepStrictEqual(pick, {
        lane: "Frontend",
        rationale: "UI change"
      })
      assert.strictEqual(usage?.cached, 1000)
      assert.strictEqual(model, "claude-sonnet-4-6")
    })
  )

  it("parses assistant and result JSONL records", () => {
    const chunks = streamLines.flatMap(parseClaudeCliStreamLine)

    assert.strictEqual(chunks[0]?.delta.includes("Frontend"), true)
    assert.strictEqual(chunks[1]?.metadata.tool_input.includes("src/lib.rs"), true)
    assert.strictEqual(chunks[2]?.usage?.completion, 40)
  })
})

describe("ClaudeAgentSession", () => {
  it("frames argv and user turns as stream-json", () => {
    assert.deepStrictEqual(claudeSessionArgv("sonnet", ["--mcp-config", "x.json"]).slice(-4), [
      "--model",
      "sonnet",
      "--mcp-config",
      "x.json"
    ])
    assert.deepStrictEqual(JSON.parse(claudeUserMessageJson("do the thing")), {
      type: "user",
      message: {
        role: "user",
        content: "do the thing"
      }
    })
  })

  it("parses text, tools, usage, and completion events", () => {
    const events = streamLines.flatMap(parseClaudeSessionLine)

    assert.strictEqual(events[0]?._tag, "TextDelta")
    assert.strictEqual(events[1]?._tag, "ToolUse")
    assert.strictEqual(events[2]?._tag, "Usage")
    assert.strictEqual(events[3]?._tag, "Done")
  })

  it.effect("drives a scoped bidirectional process to a terminal result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stdin = yield* Queue.unbounded<string>()
        const executor = makeProcessExecutor({
          run: () => Effect.succeed(ProcessResult.make({ stdout: [], exitCode: 0 })),
          runStreaming: () => Stream.empty,
          runBidirectional: () => Effect.succeed([stdin, Stream.fromIterable(streamLines)])
        })
        const session = yield* openClaudeAgentSession(
          executor,
          claudeSessionArgv(undefined, []),
          "/repo"
        )
        const result = yield* session.awaitResult

        assert.strictEqual(result.text, "done")
        assert.strictEqual(result.usage?.total, 1240)
        assert.strictEqual(result.model, "claude-sonnet-4-6")
      })
    )
  )
})
