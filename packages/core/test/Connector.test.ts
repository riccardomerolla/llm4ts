import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { TestClock } from "effect/testing"
import {
  apiConnectorCapabilities,
  flattenHistory,
  makeApiConnector,
  makeCliConnector,
  timedHealthCheck,
  type ApiConnectorPrimitives
} from "@llm4ts/core/Connector"
import type { LlmError } from "@llm4ts/core/Errors"
import type { StructuredResult } from "@llm4ts/core/LlmService"
import {
  ConnectorCapabilities,
  ConnectorIds,
  HealthStatus,
  LlmChunk,
  Message,
  ToolCallResponse,
  TokenUsage,
  type JsonSchema
} from "@llm4ts/core/Models"
import {
  ProcessResult,
  makeFakeProcessExecutor,
  processCommandKey
} from "@llm4ts/core/ProcessExecutor"
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
  executeStructuredWithUsage: <A, E, RD, RE>(
    _prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    jsonSchema: JsonSchema
  ): Effect.Effect<StructuredResult<A>, LlmError, RD> =>
    Effect.map(parseFromText(JSON.stringify({ answer: 42 }), schema, jsonSchema), (value) => {
      const result: StructuredResult<A> = [value, undefined, undefined]
      return result
    }),
  isAvailable: Effect.succeed(true)
}

describe("makeApiConnector", () => {
  it("derives the Api kind", () => {
    const connector = makeApiConnector(primitives)

    assert.strictEqual(connector.kind, "Api")
  })

  it("falls back to the default ConnectorCapabilities when primitives omit capabilities", () => {
    const connector = makeApiConnector(primitives)

    assert.deepStrictEqual(connector.capabilities, apiConnectorCapabilities())
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
        executeStructuredWithUsage: <A, E, RD, RE>(
          _prompt: string,
          schema: Schema.ConstraintCodec<A, E, RD, RE>,
          jsonSchema: JsonSchema
        ): Effect.Effect<StructuredResult<A>, LlmError, RD> =>
          Effect.map(parseFromText(JSON.stringify({ answer: 7 }), schema, jsonSchema), (value) => {
            const result: StructuredResult<A> = [value, usage, "mock-model"]
            return result
          })
      })

      const result = yield* connector.executeStructured("answer", answerSchema, answerJsonSchema)

      assert.deepStrictEqual(result, { answer: 7 })
    })
  )
})

describe("timedHealthCheck", () => {
  it.effect("measures latency with the test clock", () =>
    Effect.gen(function* () {
      const slowProbe = Effect.delay(Effect.succeed(true), "2 seconds")
      const fiber = yield* Effect.forkChild(timedHealthCheck(slowProbe))
      yield* Effect.yieldNow
      yield* TestClock.adjust("2 seconds")
      const health = yield* Fiber.join(fiber)

      assert.strictEqual(health.availability, "Healthy")
      assert.strictEqual(health.authStatus, "Valid")
      assert.strictEqual(
        health.latency === undefined ? -1 : Duration.toMillis(health.latency),
        2000
      )
    })
  )

  it.effect("maps an unavailable probe to Unhealthy/Invalid with measured latency", () =>
    Effect.gen(function* () {
      const slowProbe = Effect.delay(Effect.succeed(false), "500 millis")
      const fiber = yield* Effect.forkChild(timedHealthCheck(slowProbe))
      yield* Effect.yieldNow
      yield* TestClock.adjust("500 millis")
      const health = yield* Fiber.join(fiber)

      assert.strictEqual(health.availability, "Unhealthy")
      assert.strictEqual(health.authStatus, "Invalid")
      assert.strictEqual(health.latency === undefined ? -1 : Duration.toMillis(health.latency), 500)
    })
  )
})

describe("makeCliConnector", () => {
  const cliPrimitives = {
    id: ConnectorIds.Cursor,
    interactionSupport: "ContinuationOnly" as const,
    buildArgv: (prompt: string): ReadonlyArray<string> => ["fake-cli", prompt],
    buildInteractiveArgv: (): ReadonlyArray<string> => ["fake-cli"],
    complete: (prompt: string) => Effect.succeed(`echo:${prompt}`),
    completeStream: (prompt: string) =>
      Stream.make(LlmChunk.make({ delta: `echo:${prompt}`, finishReason: "stop" }))
  }

  it.effect("derives Healthy/Valid from a successful version probe", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["fake-cli", "--version"]),
            ProcessResult.make({ stdout: ["1.0.0"], exitCode: 0 })
          ]
        ])
      })
      const connector = makeCliConnector({
        ...cliPrimitives,
        versionProbe: { executor: fake.executor, binary: "fake-cli" }
      })
      const health = yield* connector.healthCheck
      const available = yield* connector.isAvailable
      const recorded = yield* fake.recorded

      assert.strictEqual(health.availability, "Healthy")
      assert.strictEqual(health.authStatus, "Valid")
      assert.isTrue(available)
      assert.deepStrictEqual(recorded[0]?.argv, ["fake-cli", "--version"])
    })
  )

  it.effect("derives Unhealthy/Unknown when the probe fails, with custom versionArgs", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeProcessExecutor()
      const connector = makeCliConnector({
        ...cliPrimitives,
        versionProbe: {
          executor: fake.executor,
          binary: "fake-cli",
          versionArgs: ["version", "--json"]
        }
      })
      const health = yield* connector.healthCheck
      const available = yield* connector.isAvailable
      const recorded = yield* fake.recorded

      assert.strictEqual(health.availability, "Unhealthy")
      assert.strictEqual(health.authStatus, "Unknown")
      assert.isFalse(available)
      assert.deepStrictEqual(recorded[0]?.argv, ["fake-cli", "version", "--json"])
    })
  )

  it.effect("lets explicit healthCheck and isAvailable win over the probe", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeProcessExecutor()
      const connector = makeCliConnector({
        ...cliPrimitives,
        versionProbe: { executor: fake.executor, binary: "fake-cli" },
        healthCheck: Effect.succeed(
          HealthStatus.make({ availability: "Degraded", authStatus: "Missing" })
        ),
        isAvailable: Effect.succeed(true)
      })
      const health = yield* connector.healthCheck
      const available = yield* connector.isAvailable
      const recorded = yield* fake.recorded

      assert.strictEqual(health.availability, "Degraded")
      assert.strictEqual(health.authStatus, "Missing")
      assert.isTrue(available)
      assert.strictEqual(recorded.length, 0)
    })
  )

  it.effect("defaults to Unknown/Unknown without a probe or explicit health", () =>
    Effect.gen(function* () {
      const connector = makeCliConnector(cliPrimitives)
      const health = yield* connector.healthCheck
      const available = yield* connector.isAvailable

      assert.strictEqual(health.availability, "Unknown")
      assert.strictEqual(health.authStatus, "Unknown")
      assert.isFalse(available)
    })
  )

  it.effect("flattens history into a system block and role-labelled turns", () =>
    Effect.gen(function* () {
      const prompts = yield* Ref.make<ReadonlyArray<string>>([])
      const connector = makeCliConnector({
        ...cliPrimitives,
        completeStream: (prompt: string) =>
          Stream.fromEffect(
            Ref.update(prompts, (current) => [...current, prompt]).pipe(
              Effect.as(LlmChunk.make({ delta: "ok", finishReason: "stop" }))
            )
          )
      })
      yield* Stream.runCollect(
        connector.executeStreamWithHistory([
          Message.make({ role: "System", content: "be brief" }),
          Message.make({ role: "User", content: "hi" }),
          Message.make({ role: "Assistant", content: "hello" })
        ])
      )
      const seen = yield* Ref.get(prompts)

      assert.strictEqual(seen[0], "be brief\n\n**User:** hi\n\n**Assistant:** hello")
      assert.strictEqual(
        flattenHistory([Message.make({ role: "User", content: "solo" })]),
        "**User:** solo"
      )
    })
  )

  it.effect("hints the schema into the prompt and parses structured output", () =>
    Effect.gen(function* () {
      const prompts = yield* Ref.make<ReadonlyArray<string>>([])
      const connector = makeCliConnector({
        ...cliPrimitives,
        complete: (prompt: string) =>
          Ref.update(prompts, (current) => [...current, prompt]).pipe(Effect.as('{"answer": 7}'))
      })
      const value = yield* connector.executeStructured("compute", answerSchema, answerJsonSchema)
      const seen = yield* Ref.get(prompts)

      assert.deepStrictEqual(value, { answer: 7 })
      assert.match(seen[0] ?? "", /^compute\n\nReturn JSON matching this schema:/)
      assert.include(seen[0] ?? "", '"answer"')
    })
  )

  it.effect("fails typed when structured output cannot be parsed", () =>
    Effect.gen(function* () {
      const connector = makeCliConnector({
        ...cliPrimitives,
        complete: (_prompt: string) => Effect.succeed("not json at all")
      })
      const error = yield* Effect.flip(
        connector.executeStructured("compute", answerSchema, answerJsonSchema)
      )

      assert.strictEqual(error._tag, "ParseError")
    })
  )

  it.effect("rejects tool calling with a typed error naming the connector", () =>
    Effect.gen(function* () {
      const connector = makeCliConnector(cliPrimitives)
      const error = yield* Effect.flip(connector.executeWithTools("prompt", []))

      assert.strictEqual(error._tag, "InvalidRequestError")
      assert.include(error.message, "cursor")
      assert.include(error.message, "does not support tool calling")
    })
  )
})
