import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type {
  ApiConnectorConfig,
  CliConnectorConfig,
  ConnectorConfig,
  FallbackChain
} from "./ConnectorConfig.ts"
import {
  ApiConnectorConfig as ApiConfig,
  CliConnectorConfig as CliConfig
} from "./ConnectorConfig.ts"
import type { ApiConnectorShape, CliConnectorShape, ConnectorShape } from "./Connector.ts"
import { ConfigError, type LlmError } from "./Errors.ts"
import { HealthStatus, type ConnectorId, type ConnectorKind } from "./Models.ts"

export interface ConnectorFactory {
  readonly connectorId: ConnectorId
  readonly kind: ConnectorKind
  readonly create: (config: ConnectorConfig) => Effect.Effect<ConnectorShape, LlmError>
}

export interface ConnectorRegistryShape {
  readonly resolve: (config: ConnectorConfig) => Effect.Effect<ConnectorShape, LlmError>
  readonly resolveApi: (config: ApiConnectorConfig) => Effect.Effect<ApiConnectorShape, LlmError>
  readonly resolveCli: (config: CliConnectorConfig) => Effect.Effect<CliConnectorShape, LlmError>
  readonly resolveFallback: (chain: FallbackChain) => Effect.Effect<ConnectorShape, LlmError>
  readonly available: Effect.Effect<ReadonlyArray<ConnectorId>>
  readonly healthCheckAll: Effect.Effect<ReadonlyMap<ConnectorId, HealthStatus>>
}

export class ConnectorRegistry extends Context.Service<ConnectorRegistry, ConnectorRegistryShape>()(
  "@llm4ts/core/ConnectorRegistry"
) {}

const unknownHealth = (): HealthStatus =>
  HealthStatus.make({
    availability: "Unknown",
    authStatus: "Unknown"
  })

const isApiConnector = (connector: ConnectorShape): connector is ApiConnectorShape =>
  connector.kind === "Api"

const isCliConnector = (connector: ConnectorShape): connector is CliConnectorShape =>
  connector.kind === "Cli" &&
  "interactionSupport" in connector &&
  "buildArgv" in connector &&
  "buildInteractiveArgv" in connector &&
  "complete" in connector &&
  "completeStream" in connector

const healthEntry = (
  id: ConnectorId,
  status: HealthStatus
): readonly [ConnectorId, HealthStatus] => [id, status]

export const makeConnectorRegistry = (
  factories: Iterable<ConnectorFactory>
): ConnectorRegistryShape => {
  const byId = new Map<string, ConnectorFactory>()
  for (const factory of factories) {
    byId.set(factory.connectorId.value, factory)
  }

  const resolve = (config: ConnectorConfig): Effect.Effect<ConnectorShape, LlmError> => {
    const factory = byId.get(config.connectorId.value)
    return factory === undefined
      ? Effect.fail(
          ConfigError.make({
            message: `Unknown connector: ${config.connectorId.value}`
          })
        )
      : factory.create(config)
  }

  const resolveApi = (config: ApiConnectorConfig): Effect.Effect<ApiConnectorShape, LlmError> =>
    Effect.flatMap(resolve(config), (connector) =>
      isApiConnector(connector)
        ? Effect.succeed(connector)
        : Effect.fail(
            ConfigError.make({
              message: `Expected ApiConnector, got ${connector.kind}`
            })
          )
    )

  const resolveCli = (config: CliConnectorConfig): Effect.Effect<CliConnectorShape, LlmError> =>
    Effect.flatMap(resolve(config), (connector) =>
      isCliConnector(connector)
        ? Effect.succeed(connector)
        : Effect.fail(
            ConfigError.make({
              message: `Expected CliConnector, got ${connector.kind}`
            })
          )
    )

  const resolveFallback = (chain: FallbackChain): Effect.Effect<ConnectorShape, LlmError> => {
    const loop = (
      remaining: ReadonlyArray<ConnectorConfig>,
      failures: ReadonlyArray<string>
    ): Effect.Effect<ConnectorShape, LlmError> => {
      const [config, ...tail] = remaining
      if (config === undefined) {
        return Effect.fail(
          ConfigError.make({
            message:
              failures.length === 0
                ? "Fallback chain is empty"
                : `No fallback connector is available: ${failures.join("; ")}`
          })
        )
      }

      return Effect.result(
        Effect.flatMap(resolve(config), (connector) =>
          Effect.map(connector.isAvailable, (available) => ({
            connector,
            available
          }))
        )
      ).pipe(
        Effect.flatMap((result) => {
          if (result._tag === "Success" && result.success.available) {
            return Effect.succeed(result.success.connector)
          }

          const reason =
            result._tag === "Failure"
              ? `${config.connectorId.value}: ${result.failure.message}`
              : `${config.connectorId.value}: unavailable`
          return Effect.suspend(() => loop(tail, [...failures, reason]))
        })
      )
    }

    return loop(chain.connectors, [])
  }

  const available = Effect.sync(() => Array.from(byId.values(), (factory) => factory.connectorId))

  const healthCheckAll = Effect.forEach(Array.from(byId.values()), (factory) => {
    const defaultConfig: ConnectorConfig =
      factory.kind === "Api"
        ? ApiConfig.make({ connectorId: factory.connectorId })
        : CliConfig.make({ connectorId: factory.connectorId })

    return Effect.result(
      Effect.flatMap(factory.create(defaultConfig), (connector) => connector.healthCheck)
    ).pipe(
      Effect.map((result) =>
        healthEntry(
          factory.connectorId,
          result._tag === "Success" ? result.success : unknownHealth()
        )
      )
    )
  }).pipe(Effect.map((entries) => new Map<ConnectorId, HealthStatus>(entries)))

  return {
    resolve,
    resolveApi,
    resolveCli,
    resolveFallback,
    available,
    healthCheckAll
  }
}

export const resolveConnector = (
  config: ConnectorConfig
): Effect.Effect<ConnectorShape, LlmError, ConnectorRegistry> =>
  Effect.flatMap(ConnectorRegistry, (registry) => registry.resolve(config))

export const resolveApiConnector = (
  config: ApiConnectorConfig
): Effect.Effect<ApiConnectorShape, LlmError, ConnectorRegistry> =>
  Effect.flatMap(ConnectorRegistry, (registry) => registry.resolveApi(config))

export const resolveCliConnector = (
  config: CliConnectorConfig
): Effect.Effect<CliConnectorShape, LlmError, ConnectorRegistry> =>
  Effect.flatMap(ConnectorRegistry, (registry) => registry.resolveCli(config))
