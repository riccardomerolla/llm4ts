import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type { JsonValue } from "../providers/CliSupport.ts"
import { redactText, sanitizeFields, type RedactionOptions } from "./Redaction.ts"

export const TraceStatus = Schema.Literals(["Ok", "Error"])
export type TraceStatus = typeof TraceStatus.Type

export class TraceSpan extends Schema.Class<TraceSpan>("TraceSpan")({
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optionalKey(Schema.String),
  correlationId: Schema.String,
  name: Schema.String,
  status: TraceStatus,
  startedAt: Schema.Number,
  endedAt: Schema.Number,
  attributes: Schema.Record(Schema.String, Schema.Json),
  errorMessage: Schema.optionalKey(Schema.String)
}) {}

interface TraceContext {
  readonly traceId: string
  readonly spanId: string
  readonly correlationId: string
}

const CurrentTraceContext = Context.Reference<TraceContext | undefined>(
  "@llm4ts/core/observability/CurrentTraceContext",
  { defaultValue: () => undefined }
)

export interface TracingServiceShape {
  readonly withCorrelationId: <A, E, R>(
    id: string,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>
  readonly correlationId: Effect.Effect<string>
  readonly inSpan: <A, E, R>(
    name: string,
    attributes: Readonly<Record<string, JsonValue>>,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>
  readonly recordedSpans: Effect.Effect<ReadonlyArray<TraceSpan>>
}

export class TracingService extends Context.Service<TracingService, TracingServiceShape>()(
  "@llm4ts/core/observability/TracingService"
) {}

export interface TracingOptions extends RedactionOptions {
  readonly makeId?: Effect.Effect<string>
}

const defaultId = Effect.sync(() => globalThis.crypto.randomUUID())

export const makeTracingService = Effect.fn("@llm4ts/core/observability/TracingService.make")(
  function* (options: TracingOptions = {}): Effect.fn.Return<TracingServiceShape> {
    const spans = yield* Ref.make<ReadonlyArray<TraceSpan>>([])
    const makeId = options.makeId ?? defaultId

    const correlationId = Effect.flatMap(CurrentTraceContext, (current) =>
      current === undefined ? makeId : Effect.succeed(current.correlationId)
    )

    const withCorrelationId = <A, E, R>(
      id: string,
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E, R> =>
      Effect.flatMap(CurrentTraceContext, (current) =>
        Effect.provideService(effect, CurrentTraceContext, {
          traceId: current?.traceId ?? id,
          spanId: current?.spanId ?? id,
          correlationId: id
        })
      )

    const inSpan = <A, E, R>(
      name: string,
      attributes: Readonly<Record<string, JsonValue>>,
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E, R> =>
      Effect.gen(function* () {
        const parent = yield* CurrentTraceContext
        const correlation = yield* correlationId
        const traceId = parent?.traceId ?? (yield* makeId)
        const spanId = yield* makeId
        const startedAt = yield* Clock.currentTimeMillis
        const next: TraceContext = {
          traceId,
          spanId,
          correlationId: correlation
        }
        return yield* Effect.provideService(
          effect.pipe(
            Effect.onExit((exit) =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((endedAt) =>
                  Ref.update(spans, (current) => [
                    ...current,
                    TraceSpan.make({
                      traceId,
                      spanId,
                      ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
                      correlationId: correlation,
                      name,
                      status: Exit.isSuccess(exit) ? "Ok" : "Error",
                      startedAt,
                      endedAt,
                      attributes: sanitizeFields(attributes, options),
                      ...(Exit.isFailure(exit)
                        ? {
                            errorMessage: redactText(String(exit.cause), options)
                          }
                        : {})
                    })
                  ])
                )
              )
            )
          ),
          CurrentTraceContext,
          next
        )
      })

    return {
      withCorrelationId,
      correlationId,
      inSpan,
      recordedSpans: Ref.get(spans)
    }
  }
)

export const TracingServiceLive = Layer.effect(TracingService, makeTracingService())
