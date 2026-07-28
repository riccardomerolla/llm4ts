import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { LlmError } from "../Errors.ts"
import type { LlmServiceShape, StructuredResult } from "../LlmService.ts"
import type { LlmChunk, TokenUsage } from "../Models.ts"
import { RequestMetrics } from "./Metrics.ts"
import type { MetricsCollectorShape, RequestLabels } from "./Metrics.ts"

export class LlmPricing extends Schema.Class<LlmPricing>("LlmPricing")({
  inputUsdPer1k: Schema.Number,
  outputUsdPer1k: Schema.Number
}) {}

export interface MeteredLlmOptions {
  readonly labels: RequestLabels
  readonly pricing?: LlmPricing
}

const estimatedCost = (
  usage: TokenUsage | undefined,
  pricing: LlmPricing | undefined
): number | undefined =>
  usage === undefined || pricing === undefined
    ? undefined
    : (usage.prompt / 1_000) * pricing.inputUsdPer1k +
      (usage.completion / 1_000) * pricing.outputUsdPer1k

const complete = (
  collector: MetricsCollectorShape,
  options: MeteredLlmOptions,
  startedAt: number,
  endedAt: number,
  success: boolean,
  errorType: string | undefined,
  usage: TokenUsage | undefined
): Effect.Effect<void> => {
  const cost = estimatedCost(usage, options.pricing)
  return collector.recordCompleted(
    RequestMetrics.make({
      labels: options.labels,
      latencyMs: Math.max(0, endedAt - startedAt),
      success,
      ...(errorType === undefined ? {} : { errorType }),
      ...(usage === undefined ? {} : { tokenUsage: usage }),
      ...(cost === undefined ? {} : { estimatedCostUsd: cost })
    })
  )
}

const meterEffect = <A, R>(
  effect: Effect.Effect<A, LlmError, R>,
  collector: MetricsCollectorShape,
  options: MeteredLlmOptions,
  usageOf: (value: A) => TokenUsage | undefined
): Effect.Effect<A, LlmError, R> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    yield* collector.markRequestStarted(options.labels)
    const result = yield* Effect.result(effect)
    const endedAt = yield* Clock.currentTimeMillis
    yield* complete(
      collector,
      options,
      startedAt,
      endedAt,
      result._tag === "Success",
      result._tag === "Failure" ? result.failure._tag : undefined,
      result._tag === "Success" ? usageOf(result.success) : undefined
    )
    return yield* Effect.fromResult(result)
  })

interface StreamMeasurement {
  readonly success: boolean
  readonly errorType: string | undefined
  readonly usage: TokenUsage | undefined
}

const meterStream = (
  stream: Stream.Stream<LlmChunk, LlmError>,
  collector: MetricsCollectorShape,
  options: MeteredLlmOptions
): Stream.Stream<LlmChunk, LlmError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      yield* collector.markRequestStarted(options.labels)
      const measurement = yield* Ref.make<StreamMeasurement>({
        success: true,
        errorType: undefined,
        usage: undefined
      })
      return stream.pipe(
        Stream.tap((chunk) =>
          chunk.usage === undefined
            ? Effect.void
            : Ref.update(measurement, (current) => ({
                ...current,
                usage: chunk.usage
              }))
        ),
        Stream.tapError((error) =>
          Ref.update(measurement, (current) => ({
            ...current,
            success: false,
            errorType: error._tag
          }))
        ),
        Stream.ensuring(
          Effect.gen(function* () {
            const current = yield* Ref.get(measurement)
            const endedAt = yield* Clock.currentTimeMillis
            yield* complete(
              collector,
              options,
              startedAt,
              endedAt,
              current.success,
              current.errorType,
              current.usage
            )
          })
        )
      )
    })
  )

export const meterLlmService = (
  service: LlmServiceShape,
  collector: MetricsCollectorShape,
  options: MeteredLlmOptions
): LlmServiceShape => ({
  executeStream: (prompt) => meterStream(service.executeStream(prompt), collector, options),
  executeStreamWithHistory: (messages) =>
    meterStream(service.executeStreamWithHistory(messages), collector, options),
  executeWithTools: (prompt, tools) =>
    meterEffect(service.executeWithTools(prompt, tools), collector, options, () => undefined),
  executeStructured: (prompt, schema, jsonSchema) =>
    meterEffect(
      service.executeStructured(prompt, schema, jsonSchema),
      collector,
      options,
      () => undefined
    ),
  executeStructuredWithUsage: (prompt, schema, jsonSchema) =>
    meterEffect(
      service.executeStructuredWithUsage(prompt, schema, jsonSchema),
      collector,
      options,
      <A>(result: StructuredResult<A>) => result[1]
    ),
  isAvailable: service.isAvailable
})
