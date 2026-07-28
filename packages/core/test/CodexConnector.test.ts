import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { ConnectorIds, type JsonSchema } from "@llm4ts/core/Models"
import { ProcessResult, makeProcessExecutor } from "@llm4ts/core/ProcessExecutor"
import { makeFakeTemporaryFiles } from "@llm4ts/core/TemporaryFiles"
import {
  codexExtraArgs,
  codexSchemaEnforceable,
  codexStrictSchema,
  makeCodexConnector,
  parseCodexStreamLine
} from "@llm4ts/core/providers/CodexConnector"

const replySchema = Schema.Struct({
  summary: Schema.String
})

const replyJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    summary: {
      type: "string"
    }
  },
  required: ["summary"]
}

const streamLines = [
  '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"summary\\":\\"x\\"}"}}',
  '{"type":"item.completed","item":{"type":"command_execution","command":"cargo test"}}',
  '{"type":"turn.completed","usage":{"input_tokens":900,"output_tokens":30}}'
]

describe("CodexConnector", () => {
  it("builds deterministic model and read-only sandbox arguments", () => {
    const config = CliConnectorConfig.make({
      connectorId: ConnectorIds.Codex,
      model: "gpt-5.5",
      readOnly: true,
      flags: {
        sandbox: "workspace-write",
        "full-auto": ""
      }
    })

    assert.deepStrictEqual(codexExtraArgs(config), [
      "--model",
      "gpt-5.5",
      "--full-auto",
      "--sandbox",
      "read-only"
    ])
  })

  it("parses agent text, command tools, usage, and turn failures", () => {
    const chunks = streamLines.flatMap(parseCodexStreamLine)

    assert.strictEqual(chunks[0]?.delta, '{"summary":"x"}')
    assert.strictEqual(chunks[1]?.metadata.tool_name, "Bash")
    assert.strictEqual(chunks[1]?.metadata.tool_input, '{"command":"cargo test"}')
    assert.strictEqual(chunks[2]?.usage?.total, 930)
    assert.match(
      parseCodexStreamLine(
        '{"type":"turn.failed","error":{"message":"invalid_json_schema: boom"}}'
      )[0]?.metadata.codexError ?? "",
      /boom/
    )
  })

  it("makes strict object schemas recursive and detects enforceable roots", () => {
    const nested: JsonSchema = {
      type: "object",
      properties: {
        epicId: {
          type: "string"
        },
        task: {
          type: "object",
          properties: {
            title: {
              type: "string"
            }
          }
        }
      }
    }

    assert.isTrue(codexSchemaEnforceable(nested))
    assert.isFalse(codexSchemaEnforceable({ type: "object" }))
    assert.deepStrictEqual(codexStrictSchema(nested), {
      type: "object",
      properties: {
        epicId: {
          type: "string"
        },
        task: {
          type: "object",
          properties: {
            title: {
              type: "string"
            }
          },
          additionalProperties: false,
          required: ["title"]
        }
      },
      additionalProperties: false,
      required: ["epicId", "task"]
    })
  })

  it.effect("streams prompts through stdin and stamps configured model onto usage", () =>
    Effect.gen(function* () {
      const seenArgv = yield* Ref.make<ReadonlyArray<string>>([])
      const seenStdin = yield* Ref.make("")
      const temporary = yield* makeFakeTemporaryFiles()
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
      const connector = makeCodexConnector(
        CliConnectorConfig.make({
          connectorId: ConnectorIds.Codex,
          model: "gpt-5.5"
        }),
        executor,
        temporary.temporaryFiles
      )
      const chunks = yield* Stream.runCollect(connector.completeStream("THE-PROMPT"))

      assert.isFalse((yield* Ref.get(seenArgv)).includes("THE-PROMPT"))
      assert.strictEqual(yield* Ref.get(seenStdin), "THE-PROMPT")
      assert.strictEqual(chunks[2]?.metadata.model, "gpt-5.5")
    })
  )

  it.effect("uses a scoped strict-schema file and returns structured usage/model", () =>
    Effect.gen(function* () {
      const seenArgv = yield* Ref.make<ReadonlyArray<string>>([])
      const temporary = yield* makeFakeTemporaryFiles("/tmp/strict-schema.json")
      const executor = makeProcessExecutor({
        run: () => Effect.succeed(ProcessResult.make({ stdout: [], exitCode: 0 })),
        runStreaming: () => Stream.empty,
        runStreamingWithStdin: (argv) =>
          Stream.concat(
            Stream.fromEffect(Ref.set(seenArgv, argv)).pipe(Stream.drain),
            Stream.fromIterable(streamLines)
          )
      })
      const connector = makeCodexConnector(
        CliConnectorConfig.make({
          connectorId: ConnectorIds.Codex,
          model: "gpt-5.5"
        }),
        executor,
        temporary.temporaryFiles
      )
      const [value, usage, model] = yield* connector.executeStructuredWithUsage(
        "go",
        replySchema,
        replyJsonSchema
      )
      const files = yield* temporary.files
      const argv = yield* Ref.get(seenArgv)

      assert.deepStrictEqual(value, { summary: "x" })
      assert.strictEqual(usage?.prompt, 900)
      assert.strictEqual(model, "gpt-5.5")
      assert.deepStrictEqual(argv.slice(0, 5), [
        "codex",
        "exec",
        "--json",
        "--output-schema",
        "/tmp/strict-schema.json"
      ])
      assert.match(files[0]?.contents ?? "", /"additionalProperties":false/)
    })
  )

  it.effect("uses prompt-hint completion for permissive schemas", () =>
    Effect.gen(function* () {
      const temporary = yield* makeFakeTemporaryFiles()
      const connector = makeCodexConnector(
        CliConnectorConfig.make({ connectorId: ConnectorIds.Codex }),
        makeProcessExecutor({
          run: () =>
            Effect.succeed(
              ProcessResult.make({
                stdout: ['{"summary":"fallback"}'],
                exitCode: 0
              })
            ),
          runStreaming: () => Stream.empty
        }),
        temporary.temporaryFiles
      )
      const value = yield* connector.executeStructured("go", replySchema, { type: "object" })

      assert.deepStrictEqual(value, { summary: "fallback" })
      assert.deepStrictEqual(yield* temporary.files, [])
    })
  )
})
