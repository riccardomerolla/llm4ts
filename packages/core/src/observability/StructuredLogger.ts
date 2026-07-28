import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type { JsonValue } from "../providers/CliSupport.ts"
import { redactText, sanitizeFields, type RedactionOptions } from "./Redaction.ts"
import type { TracingServiceShape } from "./Tracing.ts"

export const LogLevel = Schema.Literals(["Debug", "Info", "Warning", "Error"])
export type LogLevel = typeof LogLevel.Type

export class StructuredLogEvent extends Schema.Class<StructuredLogEvent>("StructuredLogEvent")({
  level: LogLevel,
  message: Schema.String,
  correlationId: Schema.String,
  timestamp: Schema.Number,
  fields: Schema.Record(Schema.String, Schema.Json)
}) {}

export interface StructuredLoggerShape {
  readonly log: (
    level: LogLevel,
    message: string,
    fields?: Readonly<Record<string, JsonValue>>
  ) => Effect.Effect<void>
}

export class StructuredLogger extends Context.Service<StructuredLogger, StructuredLoggerShape>()(
  "@llm4ts/core/observability/StructuredLogger"
) {}

export interface StructuredLoggerOptions extends RedactionOptions {
  readonly sink: (event: StructuredLogEvent) => Effect.Effect<void>
}

export const makeStructuredLogger = (
  tracing: TracingServiceShape,
  options: StructuredLoggerOptions
): StructuredLoggerShape => ({
  log: Effect.fn("@llm4ts/core/observability/StructuredLogger.log")(function* (
    level: LogLevel,
    message: string,
    fields: Readonly<Record<string, JsonValue>> = {}
  ) {
    const correlationId = yield* tracing.correlationId
    const timestamp = yield* Clock.currentTimeMillis
    yield* options.sink(
      StructuredLogEvent.make({
        level,
        message: redactText(message, options),
        correlationId,
        timestamp,
        fields: sanitizeFields(fields, options)
      })
    )
  })
})

export const StructuredLoggerNoop = Layer.succeed(StructuredLogger)({
  log: (_level, _message, _fields) => Effect.void
})
