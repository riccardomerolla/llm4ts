import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { makeApiConnector, type ApiConnectorPrimitives } from "@llm4ts/core/Connector"
import type { StructuredResult } from "@llm4ts/core/LlmService"
import {
  ConnectorCapabilities,
  ConnectorIds,
  ToolCallResponse,
  TokenUsage,
  type JsonSchema
} from "@llm4ts/core/Models"
import { parseFromText } from "@llm4ts/core/StructuredOutput"

const answerSchema = Schema.Struct({
  answer: Schema.Int
})

const answerJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    answer: {
      type: "integer"
    }
  },
  required: ["answer"]
}

const primitives: ApiConnectorPrimitives = {
  id: ConnectorIds.Mock,
  executeStream: () => Stream.empty,
  executeStreamWithHistory: () => Stream.empty,
  executeWithTools: () => Effect.succeed(ToolCallResponse.make({ finishReason: "stop" })),
  executeStructuredWithUsage: (_prompt, schema, jsonSchema) =>
    Effect.map(
      parseFromText(JSON.stringify({ answer: 42 }), schema, jsonSchema),
      (value): StructuredResult<typeof value> => [value, undefined, undefined]
    ),
  isAvailable: Effect.succeed(true)
}

describe("makeApiConnector", () => {
  it("derives the Api kind", () => {
    const connector = makeApiConnector(primitives)

    assert.strictEqual(connector.kind, "Api")
  })

  it("falls back to the default ConnectorCapabilities when primitives omit capabilities", () => {
    const connector = makeApiConnector(primitives)

    assert.deepStrictEqual(connector.capabilities, {
      streaming: true,
      resumableSessions: false,
      interactiveSessions: false,
      askUser: false,
      approval: false,
      structuredOutput: true,
      usageReporting: true
    })
  })

  it("passes through primitives-supplied capabilities unchanged", () => {
    const capabilities = ConnectorCapabilities.make({ streaming: false, usageReporting: false })
    const connector = makeApiConnector({ ...primitives, capabilities })

    assert.strictEqual(connector.capabilities, capabilities)
  })

  it.effect("reports a healthy status when isAvailable resolves true", () =>
    Effect.gen(function* () {
      const connector = makeApiConnector({ ...primitives, isAvailable: Effect.succeed(true) })
      const health = yield* connector.healthCheck

      assert.strictEqual(health.availability, "Healthy")
      assert.strictEqual(health.authStatus, "Valid")
    })
  )

  it.effect("reports an unhealthy status when isAvailable resolves false", () =>
    Effect.gen(function* () {
      const connector = makeApiConnector({ ...primitives, isAvailable: Effect.succeed(false) })
      const health = yield* connector.healthCheck

      assert.strictEqual(health.availability, "Unhealthy")
      assert.strictEqual(health.authStatus, "Invalid")
    })
  )

  it.effect("unwraps the value from executeStructuredWithUsage's tuple", () =>
    Effect.gen(function* () {
      const usage = TokenUsage.make({ prompt: 10, completion: 5, total: 15 })
      const connector = makeApiConnector({
        ...primitives,
        executeStructuredWithUsage: (_prompt, schema, jsonSchema) =>
          Effect.map(
            parseFromText(JSON.stringify({ answer: 7 }), schema, jsonSchema),
            (value): StructuredResult<typeof value> => [value, usage, "mock-model"]
          )
      })

      const result = yield* connector.executeStructured("answer", answerSchema, answerJsonSchema)

      assert.deepStrictEqual(result, { answer: 7 })
    })
  )
})
