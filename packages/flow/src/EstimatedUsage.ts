import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import type { LlmError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { LlmChunk, TokenUsage, type Message } from "@llm4ts/core/Models"
import { estimateCostUsd } from "./PriceList.ts"

// ESTIMATED token accounting for connectors that report none (every CLI
// connector: `makeCliConnector` returns no usage at all). The decorator
// counts characters on both sides of each request and, when the backend
// reported nothing, appends a synthetic final chunk carrying the estimate —
// so `collect`, `Chat`, `CostTracker`, and the cost summary all see it
// through the normal event path, labelled `estimated:<model>` so no report
// can mistake it for measured usage (ADR 0012; the PoC decision of
// 2026-08-30 is estimates-only, no CLI usage parsing).

export interface EstimatedUsageOptions {
  /** Pricing reference for the estimate — a `PriceList` model prefix. */
  readonly referenceModel: string
  /** Characters per token for the estimate. Default 4. */
  readonly charsPerToken?: number
}

export const defaultReferenceModel = "claude-sonnet-4"

export const estimatedUsageOptionsFromEnv = (
  environment: Readonly<Record<string, string | undefined>>
): EstimatedUsageOptions => {
  const parsed = Number.parseInt(environment.LLM4TS_ESTIMATE_CHARS_PER_TOKEN ?? "", 10)
  return {
    referenceModel: environment.LLM4TS_ESTIMATE_MODEL?.trim() || defaultReferenceModel,
    ...(Number.isFinite(parsed) && parsed > 0 ? { charsPerToken: parsed } : {})
  }
}

/** The model label estimates are published under — never a real model id. */
export const estimatedModelLabel = (referenceModel: string): string => `estimated:${referenceModel}`

export const isEstimatedModel = (model: string | undefined): boolean =>
  model !== undefined && model.startsWith("estimated:")

const tokensFor = (chars: number, charsPerToken: number): number =>
  Math.ceil(Math.max(0, chars) / charsPerToken)

export const estimateUsage = (
  promptChars: number,
  completionChars: number,
  options: EstimatedUsageOptions
): TokenUsage => {
  const charsPerToken = options.charsPerToken ?? 4
  const prompt = tokensFor(promptChars, charsPerToken)
  const completion = tokensFor(completionChars, charsPerToken)
  const base = TokenUsage.make({ prompt, completion, total: prompt + completion })
  const costUsd = estimateCostUsd(options.referenceModel, base)
  return costUsd === undefined ? base : TokenUsage.make({ ...base, costUsd })
}

const messagesChars = (messages: ReadonlyArray<Message>): number =>
  messages.reduce((sum, message) => sum + message.content.length, 0)

const mergeTotals = (previous: TokenUsage | undefined, usage: TokenUsage): TokenUsage => {
  const cached = [previous?.cached, usage.cached].flatMap((value) =>
    value === undefined ? [] : [value]
  )
  const cost = [previous?.costUsd, usage.costUsd].flatMap((value) =>
    value === undefined ? [] : [value]
  )
  return TokenUsage.make({
    prompt: (previous?.prompt ?? 0) + usage.prompt,
    completion: (previous?.completion ?? 0) + usage.completion,
    total: (previous?.total ?? 0) + usage.total,
    ...(cached.length === 0 ? {} : { cached: cached.reduce((sum, value) => sum + value, 0) }),
    ...(cost.length === 0 ? {} : { costUsd: cost.reduce((sum, value) => sum + value, 0) })
  })
}

export interface EstimatedUsageMeter {
  /** The decorated service — use this in place of the raw connector. */
  readonly service: LlmServiceShape
  /** Cumulative usage seen so far: backend-reported where present, estimated otherwise. */
  readonly totals: Effect.Effect<TokenUsage | undefined>
}

const estimatedStream = (
  stream: Stream.Stream<LlmChunk, LlmError>,
  promptChars: number,
  options: EstimatedUsageOptions,
  record: (usage: TokenUsage) => Effect.Effect<void>
): Stream.Stream<LlmChunk, LlmError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const sawUsage = yield* Ref.make(false)
      const completionChars = yield* Ref.make(0)
      const tapped = stream.pipe(
        Stream.tap((chunk) =>
          Effect.gen(function* () {
            yield* Ref.update(completionChars, (count) => count + chunk.delta.length)
            if (chunk.usage !== undefined) {
              yield* Ref.set(sawUsage, true)
              yield* record(chunk.usage)
            }
          })
        )
      )
      // Appended only after a SUCCESSFUL stream that reported nothing: a
      // failed request estimates nothing, and a backend that reported real
      // usage is never double-counted.
      const tail: Stream.Stream<LlmChunk, LlmError> = Stream.unwrap(
        Effect.gen(function* () {
          if (yield* Ref.get(sawUsage)) {
            return Stream.empty
          }
          const usage = estimateUsage(promptChars, yield* Ref.get(completionChars), options)
          yield* record(usage)
          return Stream.succeed(
            LlmChunk.make({
              delta: "",
              usage,
              metadata: { model: estimatedModelLabel(options.referenceModel) }
            })
          )
        })
      )
      return Stream.concat(tapped, tail)
    })
  )

/**
 * Decorates a service so every request yields usage — real when the backend
 * reported it, estimated (and labelled so) when it did not — and exposes the
 * running totals for per-run reports.
 */
export const makeEstimatedUsageMeter = Effect.fn("@llm4ts/flow/EstimatedUsage.make")(function* (
  service: LlmServiceShape,
  options: EstimatedUsageOptions
): Effect.fn.Return<EstimatedUsageMeter> {
  const totals = yield* Ref.make<TokenUsage | undefined>(undefined)
  const record = (usage: TokenUsage): Effect.Effect<void> =>
    Ref.update(totals, (previous) => mergeTotals(previous, usage))

  const decorated: LlmServiceShape = {
    executeStream: (prompt) =>
      estimatedStream(service.executeStream(prompt), prompt.length, options, record),
    executeStreamWithHistory: (messages) =>
      estimatedStream(
        service.executeStreamWithHistory(messages),
        messagesChars(messages),
        options,
        record
      ),
    executeWithTools: (prompt, tools) => service.executeWithTools(prompt, tools),
    executeStructured: (prompt, schema, jsonSchema) =>
      service
        .executeStructured(prompt, schema, jsonSchema)
        .pipe(
          Effect.tap((value) =>
            record(estimateUsage(prompt.length, (JSON.stringify(value) ?? "").length, options))
          )
        ),
    executeStructuredWithUsage: (prompt, schema, jsonSchema) =>
      service.executeStructuredWithUsage(prompt, schema, jsonSchema).pipe(
        Effect.flatMap(([value, usage, model]) => {
          if (usage !== undefined) {
            return record(usage).pipe(Effect.as([value, usage, model] as const))
          }
          const estimated = estimateUsage(
            prompt.length,
            (JSON.stringify(value) ?? "").length,
            options
          )
          return record(estimated).pipe(
            Effect.as([value, estimated, estimatedModelLabel(options.referenceModel)] as const)
          )
        })
      ),
    isAvailable: service.isAvailable
  }
  return { service: decorated, totals: Ref.get(totals) }
})
