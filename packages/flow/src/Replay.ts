import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError, ParseError, ProviderError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { LlmChunk, TokenUsage } from "@llm4ts/core/Models"
import { collect } from "@llm4ts/core/Streaming"
import { PlanParseError, UnsupportedSchemaVersion, type FlowError } from "./FlowError.ts"
import { TraceLine } from "./FlowRecorder.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"

export const CurrentTraceSchema = 1

export class ReplaySuccess extends Schema.TaggedClass<ReplaySuccess>()("Success", {
  text: Schema.String,
  usage: Schema.optionalKey(TokenUsage),
  model: Schema.optionalKey(Schema.String)
}) {}

export class ReplayFailure extends Schema.TaggedClass<ReplayFailure>()("Failure", {
  message: Schema.String,
  model: Schema.optionalKey(Schema.String)
}) {}

export const ReplayTurn = Schema.Union([ReplaySuccess, ReplayFailure])
export type ReplayTurn = typeof ReplayTurn.Type

const stringField = (
  fields: Readonly<Record<string, unknown>>,
  key: string
): string | undefined => {
  const value = fields[key]
  return typeof value === "string" ? value : undefined
}

const integerField = (
  fields: Readonly<Record<string, unknown>>,
  key: string
): number | undefined => {
  const value = stringField(fields, key)
  if (value === undefined || !/^-?\d+$/.test(value)) {
    return undefined
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

const isSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value)

const flowEventFields = (line: TraceLine): Readonly<Record<string, unknown>> => {
  const event = line.fields.event
  if (typeof event !== "string") {
    return line.fields
  }
  try {
    const decoded: unknown = JSON.parse(event)
    if (typeof decoded !== "object" || decoded === null) {
      return line.fields
    }
    return Object.fromEntries(
      Object.keys(decoded).map((key): readonly [string, unknown] => [
        key,
        Reflect.get(decoded, key)
      ])
    )
  } catch {
    return line.fields
  }
}

export const segmentReplayTurns = (lines: ReadonlyArray<TraceLine>): ReadonlyArray<ReplayTurn> => {
  let pendingUsage: TokenUsage | undefined
  let pendingModel: string | undefined
  const turns: Array<ReplayTurn> = []

  for (const line of [...lines].sort((left, right) => left.seq - right.seq)) {
    const fields = flowEventFields(line)
    switch (line.kind) {
      case "TokensUsed": {
        const usageValue =
          typeof fields.usage === "object" && fields.usage !== null
            ? {
                prompt: Reflect.get(fields.usage, "prompt"),
                completion: Reflect.get(fields.usage, "completion"),
                total: Reflect.get(fields.usage, "total"),
                cached: Reflect.get(fields.usage, "cached")
              }
            : fields
        const prompt =
          typeof usageValue.prompt === "number" ? usageValue.prompt : integerField(fields, "prompt")
        const completion =
          typeof usageValue.completion === "number"
            ? usageValue.completion
            : integerField(fields, "completion")
        const total =
          typeof usageValue.total === "number" ? usageValue.total : integerField(fields, "total")
        const cached = typeof usageValue.cached === "number" ? usageValue.cached : undefined
        if (isSafeInteger(prompt) && isSafeInteger(completion) && isSafeInteger(total)) {
          pendingUsage = TokenUsage.make({
            prompt,
            completion,
            total,
            ...(cached === undefined ? {} : { cached })
          })
        }
        pendingModel = stringField(fields, "model") ?? pendingModel
        break
      }
      case "AssistantMessage":
        turns.push(
          ReplaySuccess.make({
            text: stringField(fields, "text") ?? "",
            ...(pendingUsage === undefined ? {} : { usage: pendingUsage }),
            ...(pendingModel === undefined ? {} : { model: pendingModel })
          })
        )
        pendingUsage = undefined
        pendingModel = undefined
        break
      case "StreamError": {
        const model = stringField(fields, "model")
        turns.push(
          ReplayFailure.make({
            message: stringField(fields, "message") ?? "",
            ...(model === undefined ? {} : { model })
          })
        )
        pendingUsage = undefined
        pendingModel = undefined
        break
      }
    }
  }
  return turns
}

const traceCodec = Schema.fromJsonString(TraceLine)

export const readTrace = Effect.fn("@llm4ts/flow/Replay.readTrace")(function* (
  files: PlainFileStoreShape,
  path: string
): Effect.fn.Return<ReadonlyArray<TraceLine>, FlowError> {
  const contents = yield* files.read(path)
  if (contents === undefined) {
    return yield* PlanParseError.make({
      message: `trace does not exist: ${path}`
    })
  }
  const lines = contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const decoded = yield* Effect.forEach(
    lines,
    (line, index) =>
      Schema.decodeUnknownEffect(traceCodec)(line).pipe(
        Effect.mapError((error) =>
          PlanParseError.make({
            message: `malformed trace at ${path}:${index + 1}: ${String(error)}`
          })
        )
      ),
    { concurrency: 1 }
  )
  for (const line of decoded) {
    const actual = line.schemaVersion ?? 1
    if (actual !== CurrentTraceSchema) {
      return yield* UnsupportedSchemaVersion.make({
        path,
        expected: CurrentTraceSchema,
        actual
      })
    }
  }
  return [...decoded].sort((left, right) => left.seq - right.seq)
})

export const makeReplayConnector = Effect.fn("@llm4ts/flow/Replay.makeConnector")(function* (
  turns: ReadonlyArray<ReplayTurn>
): Effect.fn.Return<LlmServiceShape> {
  const cursor = yield* Ref.make(0)

  const next = Stream.unwrap(
    Ref.getAndUpdate(cursor, (index) => index + 1).pipe(
      Effect.map((index) => {
        const turn = turns[index]
        if (turn === undefined) {
          return Stream.fail(
            ProviderError.make({
              message: `replay trace exhausted at turn ${index}`
            })
          )
        }
        if (turn._tag === "Failure") {
          return Stream.fail(ProviderError.make({ message: turn.message }))
        }
        return Stream.succeed(
          LlmChunk.make({
            delta: turn.text,
            finishReason: "stop",
            ...(turn.usage === undefined ? {} : { usage: turn.usage }),
            metadata: {
              provider: "replay",
              ...(turn.model === undefined ? {} : { model: turn.model })
            }
          })
        )
      })
    )
  )

  return {
    executeStream: (_prompt) => next,
    executeStreamWithHistory: (_messages) => next,
    executeWithTools: (_prompt, _tools) =>
      Effect.fail(
        InvalidRequestError.make({
          message: "replay does not support tool calling"
        })
      ),
    executeStructured: <A, E, RD, RE>(
      _prompt: string,
      schema: Schema.ConstraintCodec<A, E, RD, RE>
    ) =>
      collect(next).pipe(
        Effect.flatMap((response) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(response.content)
        ),
        Effect.mapError((error) =>
          ParseError.make({
            message: `replay structured parse error: ${String(error)}`,
            raw: error instanceof ParseError ? error.raw : ""
          })
        )
      ),
    executeStructuredWithUsage: <A, E, RD, RE>(
      _prompt: string,
      schema: Schema.ConstraintCodec<A, E, RD, RE>
    ) =>
      collect(next).pipe(
        Effect.flatMap((response) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(response.content).pipe(
            Effect.map((value) => [value, response.usage, response.metadata.model] as const)
          )
        ),
        Effect.mapError((error) =>
          ParseError.make({
            message: `replay structured parse error: ${String(error)}`,
            raw: ""
          })
        )
      ),
    isAvailable: Effect.succeed(true)
  }
})

export const replayFromTrace = Effect.fn("@llm4ts/flow/Replay.fromTrace")(function* (
  files: PlainFileStoreShape,
  path: string
): Effect.fn.Return<LlmServiceShape, FlowError> {
  const lines = yield* readTrace(files, path)
  return yield* makeReplayConnector(segmentReplayTurns(lines))
})
