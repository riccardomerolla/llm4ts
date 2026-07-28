import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { AuthenticationError, InvalidRequestError } from "@llm4ts/core/Errors"
import type { LlmServiceShape, StructuredResult } from "@llm4ts/core/LlmService"
import { TokenUsage } from "@llm4ts/core/Models"
import { LlmPricing, meterLlmService } from "@llm4ts/core/observability/MeteredLlmService"
import {
  RequestLabels,
  RequestMetrics,
  makeMetricsCollector
} from "@llm4ts/core/observability/Metrics"
import { redactText, sanitizeFields } from "@llm4ts/core/observability/Redaction"
import {
  currentStreamRecorder,
  noopStreamRecorder,
  withStreamRecorder
} from "@llm4ts/core/observability/StreamRecorder"
import {
  makeStructuredLogger,
  type StructuredLogEvent
} from "@llm4ts/core/observability/StructuredLogger"
import { makeTracingService } from "@llm4ts/core/observability/Tracing"

const labels = RequestLabels.make({
  provider: "openai",
  model: "gpt-test",
  agent: "reviewer"
})

describe("metrics and metered LLM service", () => {
  it.effect("rolls completed requests into provider and dashboard snapshots", () =>
    Effect.gen(function* () {
      const collector = yield* makeMetricsCollector()
      yield* collector.markRequestStarted(labels)
      yield* collector.recordCompleted(
        RequestMetrics.make({
          labels,
          tokenUsage: TokenUsage.make({
            prompt: 10,
            completion: 5,
            total: 15
          }),
          latencyMs: 20,
          success: true,
          estimatedCostUsd: 0.01
        })
      )
      yield* collector.markRequestStarted(labels)
      yield* collector.recordCompleted(
        RequestMetrics.make({
          labels,
          latencyMs: 40,
          success: false,
          errorType: "ProviderError"
        })
      )

      const snapshot = yield* collector.snapshot
      const dashboard = yield* collector.dashboardSnapshot
      assert.strictEqual(snapshot.totalRequests, 2)
      assert.strictEqual(snapshot.totalErrors, 1)
      assert.strictEqual(snapshot.activeRequests, 0)
      assert.strictEqual(snapshot.totalTokens, 15)
      assert.strictEqual(snapshot.p50LatencyMs, 20)
      assert.strictEqual(snapshot.p95LatencyMs, 40)
      assert.strictEqual(snapshot.byProvider[0]?.successRate, 0.5)
      assert.strictEqual(snapshot.byAgentRequests.reviewer, 2)
      assert.strictEqual(dashboard.errorRate, 0.5)
    })
  )

  it.effect("records usage/cost and preserves the original typed failure", () =>
    Effect.gen(function* () {
      class Response extends Schema.Class<Response>("Response")({
        answer: Schema.String
      }) {}

      const collector = yield* makeMetricsCollector()
      const auth = AuthenticationError.make({ message: "missing" })
      const withUsage = <A>(value: A): StructuredResult<A> => [
        value,
        TokenUsage.make({
          prompt: 1_000,
          completion: 500,
          total: 1_500
        }),
        "gpt-test"
      ]
      const service: LlmServiceShape = {
        executeStream: (_prompt) => Stream.empty,
        executeStreamWithHistory: (_messages) => Stream.empty,
        executeWithTools: (_prompt, _tools) => Effect.fail(auth),
        executeStructured: (_prompt, _schema, _jsonSchema) =>
          Effect.fail(InvalidRequestError.make({ message: "unused" })),
        executeStructuredWithUsage: (_prompt, schema, _jsonSchema) =>
          Schema.decodeUnknownEffect(schema)({ answer: "ok" }).pipe(
            Effect.orDie,
            Effect.map(withUsage)
          ),
        isAvailable: Effect.succeed(true)
      }
      const metered = meterLlmService(service, collector, {
        labels,
        pricing: LlmPricing.make({
          inputUsdPer1k: 0.01,
          outputUsdPer1k: 0.02
        })
      })

      const response = yield* metered.executeStructuredWithUsage("prompt", Response, {})
      const failure = yield* Effect.flip(metered.executeWithTools("prompt", []))
      const snapshot = yield* collector.snapshot

      assert.strictEqual(response[0].answer, "ok")
      assert.strictEqual(failure, auth)
      assert.strictEqual(snapshot.totalRequests, 2)
      assert.strictEqual(snapshot.totalErrors, 1)
      assert.strictEqual(snapshot.totalTokens, 1_500)
      assert.strictEqual(snapshot.estimatedCostUsd, 0.02)
    })
  )
})

describe("tracing, logging, and redaction", () => {
  it.effect("correlates nested spans and preserves failures", () =>
    Effect.gen(function* () {
      const ids = yield* Ref.make(["trace", "outer", "inner"])
      const tracing = yield* makeTracingService({
        secrets: ["top-secret"],
        makeId: Ref.modify(ids, (remaining) => [remaining[0] ?? "fallback", remaining.slice(1)])
      })
      const failure = AuthenticationError.make({
        message: "top-secret"
      })
      const result = yield* Effect.result(
        tracing.withCorrelationId(
          "correlation-1",
          tracing.inSpan(
            "outer",
            { apiKey: "top-secret" },
            tracing.inSpan("inner", {}, Effect.fail(failure))
          )
        )
      )
      const spans = yield* tracing.recordedSpans
      const inner = spans.find((span) => span.name === "inner")
      const outer = spans.find((span) => span.name === "outer")

      assert.strictEqual(result._tag === "Failure" ? result.failure : undefined, failure)
      assert.strictEqual(inner?.correlationId, "correlation-1")
      assert.strictEqual(inner?.parentSpanId, outer?.spanId)
      assert.strictEqual(inner?.traceId, outer?.traceId)
      assert.strictEqual(inner?.status, "Error")
      assert.notMatch(JSON.stringify(spans), /top-secret/)
    })
  )

  it.effect("sanitizes structured log messages and nested fields", () =>
    Effect.gen(function* () {
      const tracing = yield* makeTracingService({
        makeId: Effect.succeed("generated")
      })
      const events = yield* Ref.make<ReadonlyArray<StructuredLogEvent>>([])
      const logger = makeStructuredLogger(tracing, {
        secrets: ["hunter2"],
        maxLength: 80,
        sink: (event) => Ref.update(events, (current) => [...current, event])
      })
      yield* tracing.withCorrelationId(
        "corr",
        logger.log("Info", "credential hunter2", {
          nested: { authorization: "Bearer abcdefghijklmnop" },
          password: "hunter2"
        })
      )
      const event = (yield* Ref.get(events))[0]

      assert.strictEqual(event?.correlationId, "corr")
      assert.notMatch(JSON.stringify(event), /hunter2|abcdefghijklmnop/)
      assert.match(JSON.stringify(event), /REDACTED/)
    })
  )

  it("redacts known and patterned secrets and bounds payloads", () => {
    assert.strictEqual(redactText("token=known", { secrets: ["known"] }), "token=[REDACTED]")
    assert.deepStrictEqual(
      sanitizeFields({
        apiKey: "secret",
        safe: { token: "secret", value: "ok" }
      }),
      {
        apiKey: "[REDACTED]",
        safe: { token: "[REDACTED]", value: "ok" }
      }
    )
    assert.match(redactText("123456", { maxLength: 3 }), /TRUNCATED/)
  })
})

describe("ambient stream recorder", () => {
  it.effect("defaults to noop and supports a fiber-local override", () =>
    Effect.gen(function* () {
      const before = yield* currentStreamRecorder
      const lines = yield* Ref.make<ReadonlyArray<string>>([])
      const recorder = {
        rawLine: (_provider: string, _model: string | undefined, line: string) =>
          Ref.update(lines, (current) => [...current, line]),
        streamError: (_provider: string, _model: string | undefined, message: string) =>
          Ref.update(lines, (current) => [...current, message])
      }

      yield* withStreamRecorder(recorder)(
        Effect.gen(function* () {
          const current = yield* currentStreamRecorder
          yield* current.rawLine("gemini-cli", "m", "raw")
          yield* current.streamError("gemini-cli", undefined, "boom")
        })
      )

      assert.strictEqual(before, noopStreamRecorder)
      assert.deepStrictEqual(yield* Ref.get(lines), ["raw", "boom"])
      assert.strictEqual(yield* currentStreamRecorder, noopStreamRecorder)
    })
  )
})
