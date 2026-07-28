import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import {
  apiConnectorCapabilities,
  flattenHistory,
  makeCliConnector,
  type ApiConnectorShape,
  type ConnectorShape
} from "@llm4ts/core/Connector"
import { ApiConnectorConfig, CliConnectorConfig, FallbackChain } from "@llm4ts/core/ConnectorConfig"
import { makeConnectorRegistry, type ConnectorFactory } from "@llm4ts/core/ConnectorRegistry"
import { InvalidRequestError, ProviderError } from "@llm4ts/core/Errors"
import { ConnectorId, ConnectorIds, HealthStatus, LlmChunk, Message } from "@llm4ts/core/Models"

const healthy = HealthStatus.make({
  availability: "Healthy",
  authStatus: "Valid",
  latency: Duration.millis(1)
})

const apiConnector = (
  id: ConnectorId,
  available = true,
  healthCheck: Effect.Effect<HealthStatus, ProviderError> = Effect.succeed(healthy)
): ApiConnectorShape => ({
  id,
  kind: "Api",
  capabilities: apiConnectorCapabilities(),
  healthCheck,
  isAvailable: Effect.succeed(available),
  executeStream: (_prompt) => Stream.empty,
  executeStreamWithHistory: (_messages) => Stream.empty,
  executeWithTools: (_prompt, _tools) =>
    Effect.fail(InvalidRequestError.make({ message: "not implemented" })),
  executeStructured: (_prompt, _schema, _jsonSchema) =>
    Effect.fail(InvalidRequestError.make({ message: "not implemented" })),
  executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) =>
    Effect.fail(InvalidRequestError.make({ message: "not implemented" }))
})

const factory = (
  id: ConnectorId,
  connector: ConnectorShape,
  kind: "Api" | "Cli" = connector.kind
): ConnectorFactory => ({
  connectorId: id,
  kind,
  create: (_config) => Effect.succeed(connector)
})

describe("Connector", () => {
  it("flattens CLI history into source-compatible labelled blocks", () => {
    const prompt = flattenHistory([
      Message.make({ role: "System", content: "Follow the rules." }),
      Message.make({ role: "User", content: "Hello" }),
      Message.make({ role: "Assistant", content: "Hi" }),
      Message.make({ role: "Tool", content: "result" })
    ])

    assert.strictEqual(
      prompt,
      "Follow the rules.\n\n" + "**User:** Hello\n\n" + "**Assistant:** Hi\n\n" + "**Tool:** result"
    )
  })

  it.effect("derives LlmService defaults for CLI connector primitives", () =>
    Effect.gen(function* () {
      const connector = makeCliConnector({
        id: ConnectorIds.ClaudeCli,
        interactionSupport: "InteractiveStdin",
        buildArgv: (prompt, _context) => ["claude", "--print", prompt],
        buildInteractiveArgv: (_context) => ["claude"],
        complete: (_prompt) => Effect.succeed('diagnostic\n```json\n{"value":42}\n```'),
        completeStream: (prompt) => Stream.make(LlmChunk.make({ delta: prompt })),
        healthCheck: Effect.succeed(healthy),
        isAvailable: Effect.succeed(true)
      })

      const history = yield* Stream.runCollect(
        connector.executeStreamWithHistory([
          Message.make({ role: "User", content: "Hello" }),
          Message.make({ role: "Assistant", content: "Hi" })
        ])
      )
      const structured = yield* connector.executeStructured(
        "return value",
        Schema.Struct({ value: Schema.Number }),
        {}
      )
      const toolError = yield* Effect.flip(connector.executeWithTools("hello", []))

      assert.strictEqual(connector.kind, "Cli")
      assert.isTrue(connector.capabilities.interactiveSessions)
      assert.strictEqual(history[0]?.delta, "**User:** Hello\n\n**Assistant:** Hi")
      assert.deepStrictEqual(structured, { value: 42 })
      assert.strictEqual(toolError._tag, "InvalidRequestError")
    })
  )
})

describe("ConnectorRegistry", () => {
  it.effect("resolves a connector by stable identifier value", () =>
    Effect.gen(function* () {
      const connector = apiConnector(ConnectorIds.Mock)
      const registry = makeConnectorRegistry([factory(ConnectorIds.Mock, connector)])
      const resolved = yield* registry.resolve(
        ApiConnectorConfig.make({
          connectorId: ConnectorId.make({ value: "mock" }),
          model: "mock-model"
        })
      )

      assert.strictEqual(resolved.id.value, "mock")
    })
  )

  it.effect("fails unknown connector identifiers as configuration errors", () =>
    Effect.gen(function* () {
      const registry = makeConnectorRegistry([])
      const error = yield* Effect.flip(
        registry.resolve(
          ApiConnectorConfig.make({
            connectorId: ConnectorId.make({ value: "unknown" })
          })
        )
      )

      assert.strictEqual(error._tag, "ConfigError")
      assert.match(error.message, /Unknown connector/)
    })
  )

  it.effect("enforces API and CLI kind expectations", () =>
    Effect.gen(function* () {
      const cli = makeCliConnector({
        id: ConnectorIds.ClaudeCli,
        interactionSupport: "ContinuationOnly",
        buildArgv: (_prompt, _context) => ["claude"],
        buildInteractiveArgv: (_context) => ["claude"],
        complete: (_prompt) => Effect.succeed("ok"),
        completeStream: (_prompt) => Stream.empty,
        healthCheck: Effect.succeed(healthy),
        isAvailable: Effect.succeed(true)
      })
      const registry = makeConnectorRegistry([factory(ConnectorIds.ClaudeCli, cli)])
      const error = yield* Effect.flip(
        registry.resolveApi(
          ApiConnectorConfig.make({
            connectorId: ConnectorIds.ClaudeCli
          })
        )
      )
      const resolved = yield* registry.resolveCli(
        CliConnectorConfig.make({
          connectorId: ConnectorIds.ClaudeCli
        })
      )

      assert.strictEqual(error._tag, "ConfigError")
      assert.strictEqual(resolved.kind, "Cli")
    })
  )

  it.effect("lists registered identifiers in factory order", () =>
    Effect.gen(function* () {
      const registry = makeConnectorRegistry([
        factory(ConnectorIds.OpenAI, apiConnector(ConnectorIds.OpenAI)),
        factory(ConnectorIds.Anthropic, apiConnector(ConnectorIds.Anthropic))
      ])
      const ids = yield* registry.available

      assert.deepStrictEqual(
        ids.map((id) => id.value),
        ["openai", "anthropic"]
      )
    })
  )

  it.effect("preserves fallback order and chooses the first available connector", () =>
    Effect.gen(function* () {
      const registry = makeConnectorRegistry([
        factory(ConnectorIds.OpenAI, apiConnector(ConnectorIds.OpenAI, false)),
        factory(ConnectorIds.Anthropic, apiConnector(ConnectorIds.Anthropic, true))
      ])
      const selected = yield* registry.resolveFallback(
        FallbackChain.make({
          connectors: [
            ApiConnectorConfig.make({
              connectorId: ConnectorIds.OpenAI
            }),
            ApiConnectorConfig.make({
              connectorId: ConnectorIds.Anthropic
            })
          ]
        })
      )

      assert.strictEqual(selected.id.value, "anthropic")
    })
  )

  it.effect("fails an empty fallback chain explicitly", () =>
    Effect.gen(function* () {
      const registry = makeConnectorRegistry([])
      const error = yield* Effect.flip(registry.resolveFallback(FallbackChain.make({})))

      assert.strictEqual(error._tag, "ConfigError")
      assert.match(error.message, /empty/)
    })
  )

  it.effect("maps factory and health failures to Unknown in aggregate health", () =>
    Effect.gen(function* () {
      const failingHealth = apiConnector(
        ConnectorIds.OpenAI,
        true,
        Effect.fail(ProviderError.make({ message: "offline" }))
      )
      const registry = makeConnectorRegistry([
        factory(ConnectorIds.OpenAI, failingHealth),
        factory(ConnectorIds.Mock, apiConnector(ConnectorIds.Mock))
      ])
      const health = yield* registry.healthCheckAll
      const byId = new Map(Array.from(health, ([id, status]) => [id.value, status]))

      assert.strictEqual(byId.get("openai")?.availability, "Unknown")
      assert.strictEqual(byId.get("mock")?.availability, "Healthy")
    })
  )
})
