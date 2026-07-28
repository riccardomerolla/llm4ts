import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { Capabilities, noneGrants, restricted } from "@llm4ts/core/Capability"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { ToolCall, ToolCallResponse } from "@llm4ts/core/Models"
import {
  isJsonRecord,
  jsonArray,
  jsonField,
  jsonStringField
} from "@llm4ts/core/providers/CliSupport"
import { ToolLoopConfig, runToolCallingLoop } from "@llm4ts/core/tools/ToolCallingExecutor"
import {
  InvalidToolParameters,
  ToolExecutionFailed,
  makeTool,
  schemaFromMethodSignature,
  toolsToProviderFormat,
  validateToolParameters,
  type Tool
} from "@llm4ts/core/tools/Tool"
import { makeToolRegistry } from "@llm4ts/core/tools/ToolRegistry"

const addParameters = {
  type: "object",
  properties: {
    a: { type: "integer" },
    b: { type: "integer" }
  },
  required: ["a", "b"],
  additionalProperties: false
}

const addTool = (ran?: Ref.Ref<number>): Tool =>
  makeTool({
    name: "add",
    description: "Add two integers",
    parameters: addParameters,
    tags: ["math", "sum"],
    execute: (parameters) => {
      if (!isJsonRecord(parameters)) {
        return Effect.fail(
          InvalidToolParameters.make({
            message: "arguments must be an object"
          })
        )
      }
      const a = parameters.a
      const b = parameters.b
      if (typeof a !== "number" || typeof b !== "number") {
        return Effect.fail(
          InvalidToolParameters.make({
            message: "a and b are required integers"
          })
        )
      }
      const result: Effect.Effect<void> =
        ran === undefined ? Effect.void : Ref.update(ran, (count) => count + 1)
      return result.pipe(Effect.as(a + b))
    }
  })

const unused = InvalidRequestError.make({ message: "unused" })

const toolService = (executeWithTools: LlmServiceShape["executeWithTools"]): LlmServiceShape => ({
  executeStream: (_prompt) => Stream.empty,
  executeStreamWithHistory: (_messages) => Stream.empty,
  executeWithTools,
  executeStructured: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  isAvailable: Effect.succeed(true)
})

describe("Tool schema and provider mappings", () => {
  it.effect(
    "generates required and optional parameters from Scala/TypeScript-like signatures",
    () =>
      Effect.gen(function* () {
        const schema = yield* schemaFromMethodSignature(
          "def transform(code: String, retries: Int, dryRun: Boolean = false): String"
        )
        const properties = jsonField(schema, "properties")

        assert.strictEqual(jsonStringField(jsonField(properties, "code"), "type"), "string")
        assert.strictEqual(jsonStringField(jsonField(properties, "retries"), "type"), "integer")
        assert.deepStrictEqual(jsonArray(jsonField(schema, "required")), ["code", "retries"])

        const typescript = yield* schemaFromMethodSignature(
          "function search(paths: ReadonlyArray<string>, limit?: number): void"
        )
        assert.deepStrictEqual(jsonArray(jsonField(typescript, "required")), ["paths"])
      })
  )

  it.effect("rejects invalid signatures and validates required/types before execution", () =>
    Effect.gen(function* () {
      const signatureError = yield* Effect.flip(schemaFromMethodSignature("const notAMethod = 1"))
      assert.strictEqual(signatureError._tag, "SchemaGenerationFailed")

      const missing = yield* Effect.flip(validateToolParameters(addParameters, { a: 1 }))
      assert.strictEqual(missing._tag, "InvalidParameters")
      assert.match(missing.message, /b/)

      const wrongType = yield* Effect.flip(validateToolParameters(addParameters, { a: "1", b: 2 }))
      assert.match(wrongType.message, /Expected: integer/)
    })
  )

  it("maps tool definitions to native provider envelopes", () => {
    const tool = addTool()
    const openAI = toolsToProviderFormat("OpenAI", [tool])
    const anthropic = toolsToProviderFormat("Anthropic", [tool])
    const gemini = toolsToProviderFormat("GeminiApi", [tool])

    assert.strictEqual(jsonStringField(jsonArray(openAI)[0], "type"), "function")
    assert.strictEqual(jsonStringField(jsonArray(anthropic)[0], "name"), "add")
    assert.isTrue(Array.isArray(jsonField(gemini, "functionDeclarations")))
    assert.deepStrictEqual(toolsToProviderFormat("Mock", [tool]), [])
  })
})

describe("ToolRegistry", () => {
  it.effect("registers, sorts, selects, and rejects duplicate names", () =>
    Effect.gen(function* () {
      const registry = yield* makeToolRegistry()
      const readFile = makeTool({
        name: "read_file",
        description: "Read content from a workspace file",
        parameters: { type: "object" },
        tags: ["file", "read"],
        execute: (_parameters) => Effect.succeed("ok")
      })
      yield* registry.register(addTool())
      yield* registry.register(readFile)

      assert.deepStrictEqual(
        (yield* registry.list).map((tool) => tool.name),
        ["add", "read_file"]
      )
      assert.strictEqual(
        (yield* registry.select("please read file and summarize"))[0]?.name,
        "read_file"
      )
      const duplicate = yield* Effect.flip(registry.register(addTool()))
      assert.strictEqual(duplicate._tag, "DuplicateToolName")
    })
  )

  it.effect("parses/validates calls and never runs a body with invalid arguments", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(0)
      const registry = yield* makeToolRegistry()
      yield* registry.register(addTool(ran))

      const result = yield* registry.execute(
        ToolCall.make({
          id: "call-1",
          name: "add",
          arguments: '{"a":1,"b":2}'
        })
      )
      assert.strictEqual(result.result._tag === "Succeeded" ? result.result.value : undefined, 3)
      assert.strictEqual(yield* Ref.get(ran), 1)

      const error = yield* Effect.flip(
        registry.execute(
          ToolCall.make({
            id: "call-2",
            name: "add",
            arguments: '{"a":1}'
          })
        )
      )
      assert.strictEqual(error._tag, "ToolError")
      assert.strictEqual(yield* Ref.get(ran), 1)
    })
  )

  it.effect("keeps tool-body failures in the result value channel", () =>
    Effect.gen(function* () {
      const registry = yield* makeToolRegistry()
      yield* registry.register(
        makeTool({
          name: "fail",
          description: "Always fails",
          parameters: { type: "object" },
          execute: (_parameters) =>
            Effect.fail(
              ToolExecutionFailed.make({
                message: "expected body failure"
              })
            )
        })
      )

      const result = yield* registry.execute(
        ToolCall.make({
          id: "call-1",
          name: "fail",
          arguments: "{}"
        })
      )
      assert.strictEqual(result.result._tag, "Failed")
      assert.match(
        result.result._tag === "Failed" ? result.result.message : "",
        /expected body failure/
      )
    })
  )

  it.effect("returns capability denials without running the tool body", () =>
    Effect.gen(function* () {
      const ran = yield* Ref.make(0)
      const registry = yield* makeToolRegistry()
      yield* registry.register(
        makeTool({
          name: "push",
          description: "Push git changes",
          parameters: { type: "object" },
          requires: [Capabilities.GitPush],
          execute: (_parameters) => Ref.update(ran, (count) => count + 1).pipe(Effect.as("done"))
        })
      )
      const result = yield* restricted(noneGrants)(
        registry.execute(
          ToolCall.make({
            id: "call-1",
            name: "push",
            arguments: "{}"
          })
        )
      )

      assert.isTrue(result.denied)
      assert.strictEqual(result.result._tag, "Failed")
      assert.match(result.result._tag === "Failed" ? result.result.message : "", /GitPush/)
      assert.strictEqual(yield* Ref.get(ran), 0)
    })
  )

  it.effect("validates bounded executeAll concurrency", () =>
    Effect.gen(function* () {
      const registry = yield* makeToolRegistry()
      const error = yield* Effect.flip(registry.executeAll([], 0))

      assert.strictEqual(error._tag, "InvalidRequestError")
      assert.match(error.message, /positive integer/)
    })
  )
})

describe("ToolCallingExecutor", () => {
  const echo = makeTool({
    name: "echo",
    description: "Echo input",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string" }
      },
      required: ["message"]
    },
    execute: (parameters) => Effect.succeed(parameters)
  })

  it.effect("feeds tool results back until the model returns final text", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const prompts = yield* Ref.make<ReadonlyArray<string>>([])
      const registry = yield* makeToolRegistry()
      yield* registry.register(echo)
      const service = toolService((prompt, tools) =>
        Ref.getAndUpdate(calls, (count) => count + 1).pipe(
          Effect.andThen(Ref.update(prompts, (current) => [...current, prompt])),
          Effect.flatMap(() => Ref.get(calls)),
          Effect.map((count) =>
            count === 1
              ? ToolCallResponse.make({
                  toolCalls: [
                    ToolCall.make({
                      id: "call-1",
                      name: "echo",
                      arguments: '{"message":"hello"}'
                    })
                  ],
                  finishReason: "tool_calls"
                })
              : ToolCallResponse.make({
                  content: "final answer",
                  finishReason: "stop"
                })
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              assert.strictEqual(tools[0]?.name, "echo")
            })
          )
        )
      )

      const response = yield* runToolCallingLoop("say hello", [echo], service, registry)
      const seenPrompts = yield* Ref.get(prompts)

      assert.strictEqual(response.content, "final answer")
      assert.strictEqual(response.metadata.tool_iterations, "1")
      assert.match(seenPrompts[1] ?? "", /tool_call_id=call-1/)
      assert.match(seenPrompts[1] ?? "", /"message":"hello"/)
    })
  )

  it.effect("enforces iteration and capability-denial budgets", () =>
    Effect.gen(function* () {
      const registry = yield* makeToolRegistry()
      const denied = makeTool({
        name: "push",
        description: "Push",
        parameters: { type: "object" },
        requires: [Capabilities.GitPush],
        execute: (_parameters) => Effect.succeed("never")
      })
      yield* registry.register(denied)
      const probing = toolService((_prompt, _tools) =>
        Effect.succeed(
          ToolCallResponse.make({
            toolCalls: [
              ToolCall.make({
                id: "call-1",
                name: "push",
                arguments: "{}"
              })
            ],
            finishReason: "tool_calls"
          })
        )
      )

      const denial = yield* Effect.flip(
        restricted(noneGrants)(
          runToolCallingLoop(
            "go",
            [denied],
            probing,
            registry,
            ToolLoopConfig.make({
              maxIterations: 10,
              maxDenials: 2
            })
          )
        )
      )
      assert.match(denial.message, /denial budget/)

      const iteration = yield* Effect.flip(
        runToolCallingLoop(
          "go",
          [denied],
          probing,
          registry,
          ToolLoopConfig.make({
            maxIterations: 1
          })
        )
      )
      assert.match(iteration.message, /max iterations/)
    })
  )
})
