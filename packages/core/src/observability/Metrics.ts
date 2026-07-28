import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import { TokenUsage } from "../Models.ts"

export class RequestLabels extends Schema.Class<RequestLabels>("RequestLabels")({
  provider: Schema.String,
  model: Schema.String,
  agent: Schema.optionalKey(Schema.String),
  runId: Schema.optionalKey(Schema.String),
  workflowStep: Schema.optionalKey(Schema.String)
}) {}

export class RequestMetrics extends Schema.Class<RequestMetrics>("RequestMetrics")({
  labels: RequestLabels,
  tokenUsage: Schema.optionalKey(TokenUsage),
  latencyMs: Schema.Number,
  success: Schema.Boolean,
  errorType: Schema.optionalKey(Schema.String),
  estimatedCostUsd: Schema.optionalKey(Schema.Number)
}) {}

export class ProviderHealth extends Schema.Class<ProviderHealth>("ProviderHealth")({
  provider: Schema.String,
  requestCount: Schema.Int,
  successRate: Schema.Number,
  avgLatencyMs: Schema.Number,
  p95LatencyMs: Schema.Number,
  estimatedCostUsd: Schema.Number
}) {}

export class ObservabilitySnapshot extends Schema.Class<ObservabilitySnapshot>(
  "ObservabilitySnapshot"
)({
  totalRequests: Schema.Int,
  totalErrors: Schema.Int,
  activeRequests: Schema.Int,
  promptTokens: Schema.Int,
  completionTokens: Schema.Int,
  totalTokens: Schema.Int,
  estimatedCostUsd: Schema.Number,
  p50LatencyMs: Schema.Number,
  p95LatencyMs: Schema.Number,
  byProvider: Schema.Array(ProviderHealth),
  byAgentRequests: Schema.Record(Schema.String, Schema.Int)
}) {}

export class DashboardMetricsSnapshot extends Schema.Class<DashboardMetricsSnapshot>(
  "DashboardMetricsSnapshot"
)({
  providerHealth: Schema.Array(ProviderHealth),
  totalTokens: Schema.Int,
  totalCostUsd: Schema.Number,
  totalRequests: Schema.Int,
  errorRate: Schema.Number
}) {}

export interface MetricsCollectorShape {
  readonly markRequestStarted: (labels: RequestLabels) => Effect.Effect<void>
  readonly recordCompleted: (metrics: RequestMetrics) => Effect.Effect<void>
  readonly snapshot: Effect.Effect<ObservabilitySnapshot>
  readonly dashboardSnapshot: Effect.Effect<DashboardMetricsSnapshot>
}

export class MetricsCollector extends Context.Service<MetricsCollector, MetricsCollectorShape>()(
  "@llm4ts/core/observability/MetricsCollector"
) {}

interface MetricsState {
  readonly totalRequests: number
  readonly activeRequests: number
  readonly completed: ReadonlyArray<RequestMetrics>
  readonly byAgentRequests: ReadonlyMap<string, number>
}

const percentile = (values: ReadonlyArray<number>, quantile: number): number => {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1)
  return sorted[index] ?? 0
}

const providerHealth = (
  completed: ReadonlyArray<RequestMetrics>
): ReadonlyArray<ProviderHealth> => {
  const providers = new Map<string, Array<RequestMetrics>>()
  for (const metric of completed) {
    const current = providers.get(metric.labels.provider) ?? []
    current.push(metric)
    providers.set(metric.labels.provider, current)
  }
  return [...providers.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, metrics]) => {
      const latencies = metrics.map((metric) => metric.latencyMs)
      const successes = metrics.filter((metric) => metric.success).length
      return ProviderHealth.make({
        provider,
        requestCount: metrics.length,
        successRate: metrics.length === 0 ? 1 : successes / metrics.length,
        avgLatencyMs:
          metrics.length === 0
            ? 0
            : latencies.reduce((sum, latency) => sum + latency, 0) / metrics.length,
        p95LatencyMs: percentile(latencies, 0.95),
        estimatedCostUsd: metrics.reduce((sum, metric) => sum + (metric.estimatedCostUsd ?? 0), 0)
      })
    })
}

const toSnapshot = (state: MetricsState): ObservabilitySnapshot => {
  const completed = state.completed
  const promptTokens = completed.reduce((sum, metric) => sum + (metric.tokenUsage?.prompt ?? 0), 0)
  const completionTokens = completed.reduce(
    (sum, metric) => sum + (metric.tokenUsage?.completion ?? 0),
    0
  )
  return ObservabilitySnapshot.make({
    totalRequests: state.totalRequests,
    totalErrors: completed.filter((metric) => !metric.success).length,
    activeRequests: state.activeRequests,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimatedCostUsd: completed.reduce((sum, metric) => sum + (metric.estimatedCostUsd ?? 0), 0),
    p50LatencyMs: percentile(
      completed.map((metric) => metric.latencyMs),
      0.5
    ),
    p95LatencyMs: percentile(
      completed.map((metric) => metric.latencyMs),
      0.95
    ),
    byProvider: providerHealth(completed),
    byAgentRequests: Object.fromEntries(state.byAgentRequests)
  })
}

export const makeMetricsCollector = Effect.fn("@llm4ts/core/observability/MetricsCollector.make")(
  function* (): Effect.fn.Return<MetricsCollectorShape> {
    const state = yield* Ref.make<MetricsState>({
      totalRequests: 0,
      activeRequests: 0,
      completed: [],
      byAgentRequests: new Map()
    })

    const markRequestStarted = (labels: RequestLabels): Effect.Effect<void> =>
      Ref.update(state, (current) => {
        const agents = new Map(current.byAgentRequests)
        if (labels.agent !== undefined) {
          agents.set(labels.agent, (agents.get(labels.agent) ?? 0) + 1)
        }
        return {
          totalRequests: current.totalRequests + 1,
          activeRequests: current.activeRequests + 1,
          completed: current.completed,
          byAgentRequests: agents
        }
      })

    const recordCompleted = (metrics: RequestMetrics): Effect.Effect<void> =>
      Ref.update(state, (current) => ({
        ...current,
        activeRequests: Math.max(0, current.activeRequests - 1),
        completed: [...current.completed, metrics]
      }))

    const snapshot = Ref.get(state).pipe(Effect.map(toSnapshot))
    const dashboardSnapshot = snapshot.pipe(
      Effect.map((current) =>
        DashboardMetricsSnapshot.make({
          providerHealth: current.byProvider,
          totalTokens: current.totalTokens,
          totalCostUsd: current.estimatedCostUsd,
          totalRequests: current.totalRequests,
          errorRate: current.totalRequests === 0 ? 0 : current.totalErrors / current.totalRequests
        })
      )
    )

    return {
      markRequestStarted,
      recordCompleted,
      snapshot,
      dashboardSnapshot
    }
  }
)

export const MetricsCollectorLive = Layer.effect(MetricsCollector, makeMetricsCollector())
