import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { ConfigError, ParseError, TimeoutError, type LlmError } from "./Errors.ts"
import { LlmChunk, LlmResponse, StreamProgress } from "./Models.ts"

const appendChunk = (response: LlmResponse, chunk: LlmChunk): LlmResponse => {
  const usage = chunk.usage ?? response.usage

  return LlmResponse.make({
    content: response.content + chunk.delta,
    metadata: {
      ...response.metadata,
      ...chunk.metadata
    },
    ...(usage === undefined ? {} : { usage })
  })
}

export const collect = Effect.fn("@llm4ts/core/Streaming.collect")(
  <R>(stream: Stream.Stream<LlmChunk, LlmError, R>) =>
    Stream.runFold(stream, () => LlmResponse.make({ content: "" }), appendChunk)
)

const estimateTokens = (text: string): number => Math.max(1, Math.floor(text.length / 4))

export const trackProgress = <R, R2>(
  stream: Stream.Stream<LlmChunk, LlmError, R>,
  onProgress: (progress: StreamProgress) => Effect.Effect<void, never, R2>
): Stream.Stream<LlmChunk, LlmError, R | R2> =>
  Stream.unwrap(
    Effect.map(Clock.currentTimeMillis, (startTime) =>
      stream.pipe(
        Stream.mapAccumEffect(
          () => 0,
          (tokensProcessed, chunk) =>
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis
              const elapsedMs = now - startTime
              const nextTokensProcessed = tokensProcessed + estimateTokens(chunk.delta)
              const elapsedSeconds = elapsedMs / 1_000
              const tokensPerSecond = elapsedSeconds > 0 ? nextTokensProcessed / elapsedSeconds : 0

              yield* onProgress(
                StreamProgress.make({
                  tokensProcessed: nextTokensProcessed,
                  tokensPerSecond,
                  elapsedMs
                })
              )

              return [nextTokensProcessed, [chunk]] as const
            })
        )
      )
    )
  )

export const parsePartialJson = <A, E, RD, RE, R>(
  stream: Stream.Stream<string, LlmError, R>,
  schema: Schema.ConstraintCodec<A, E, RD, RE>
): Stream.Stream<A, LlmError, R | RD> =>
  stream.pipe(
    Stream.mapAccumEffect(
      () => "",
      (accumulated, chunk) => {
        const next = accumulated + chunk
        return Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(next).pipe(
          Effect.match({
            onFailure: () => [next, []] as const,
            onSuccess: (value) => [next, [value]] as const
          })
        )
      }
    )
  )

export const retryStream = <A, E, R, X, E2, R2>(
  stream: Stream.Stream<A, E, R>,
  policy: Schedule.Schedule<X, E, E2, R2>
): Stream.Stream<A, E | E2, R | R2> => Stream.retry(stream, policy)

export const buffered = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  capacity: number
): Stream.Stream<A, E, R> =>
  Stream.buffer(stream, {
    capacity,
    strategy: "suspend"
  })

export interface BatchOptions {
  readonly maxSize?: number
  readonly maxDuration?: Duration.Input
}

export const batch = <R>(
  stream: Stream.Stream<LlmChunk, LlmError, R>,
  options: BatchOptions = {}
): Stream.Stream<Array<LlmChunk>, LlmError, R> =>
  Stream.groupedWithin(stream, options.maxSize ?? 10, options.maxDuration ?? "100 millis")

const timeoutError = (duration: Duration.Input): TimeoutError =>
  TimeoutError.make({ duration: Duration.fromInputUnsafe(duration) })

export const withTimeout = <R>(
  stream: Stream.Stream<LlmChunk, LlmError, R>,
  duration: Duration.Input
): Stream.Stream<LlmChunk, LlmError, R> =>
  Stream.timeoutOrElse(stream, {
    duration,
    orElse: () => Stream.fail(timeoutError(duration))
  })

export const mergeAll = <R>(
  streams: Iterable<Stream.Stream<LlmChunk, LlmError, R>>
): Stream.Stream<LlmChunk, LlmError, R> =>
  Stream.mergeAll(streams, {
    concurrency: "unbounded"
  })

export const cancellable = <R>(
  stream: Stream.Stream<LlmChunk, LlmError, R>
): Effect.Effect<
  readonly [stream: Stream.Stream<LlmChunk, LlmError, R>, cancel: Effect.Effect<void>]
> =>
  Effect.map(Deferred.make<void>(), (deferred) => [
    Stream.interruptWhen(stream, Deferred.await(deferred)),
    Deferred.succeed(deferred, undefined).pipe(Effect.asVoid)
  ])

export const withSnapshots = <R>(
  stream: Stream.Stream<LlmChunk, LlmError, R>,
  snapshotInterval: Duration.Input = "500 millis"
): Stream.Stream<string, LlmError, R> =>
  stream.pipe(
    Stream.scan("", (content, chunk) => content + chunk.delta),
    Stream.debounce(snapshotInterval)
  )

export const withFallback = <R, R2>(
  stream: Stream.Stream<LlmChunk, LlmError, R>,
  fallback: () => Stream.Stream<LlmChunk, LlmError, R2>
): Stream.Stream<LlmChunk, LlmError, R | R2> => Stream.catchIf(stream, () => true, fallback)

export const rateLimit = <R>(
  stream: Stream.Stream<LlmChunk, LlmError, R>,
  maxPerSecond: number
): Stream.Stream<LlmChunk, LlmError, R> => {
  if (!Number.isInteger(maxPerSecond) || maxPerSecond <= 0) {
    return Stream.fail(
      ConfigError.make({
        message: `maxPerSecond must be a positive integer; received ${maxPerSecond}`
      })
    )
  }

  return Stream.schedule(stream, Schedule.fixed(1_000 / maxPerSecond))
}

const chunkJson = Schema.fromJsonString(Schema.toCodecJson(LlmChunk))

export const toSSE = <R>(
  stream: Stream.Stream<LlmChunk, LlmError, R>
): Stream.Stream<string, LlmError, R> =>
  Stream.mapEffect(stream, (chunk) =>
    Schema.encodeEffect(chunkJson)(chunk).pipe(
      Effect.map((encoded) => `data: ${encoded}\n\n`),
      Effect.mapError((error) =>
        ParseError.make({
          message: `Failed to encode SSE chunk: ${String(error)}`,
          raw: chunk.delta
        })
      )
    )
  )

export const fromSSE = <R>(
  stream: Stream.Stream<string, LlmError, R>
): Stream.Stream<LlmChunk, LlmError, R> =>
  stream.pipe(
    Stream.filter((line) => line.startsWith("data: ")),
    Stream.map((line) => line.slice("data: ".length).trim()),
    Stream.filter((payload) => payload.length > 0 && payload !== "[DONE]"),
    Stream.mapEffect((payload) =>
      Schema.decodeUnknownEffect(chunkJson)(payload).pipe(
        Effect.mapError((error) =>
          ParseError.make({
            message: `Failed to parse SSE chunk: ${String(error)}`,
            raw: payload
          })
        )
      )
    )
  )

export const withHeartbeat = <R>(
  stream: Stream.Stream<LlmChunk, LlmError, R>,
  heartbeatTimeout: Duration.Input
): Stream.Stream<LlmChunk, LlmError, R> =>
  withTimeout(stream, heartbeatTimeout).pipe(Stream.rechunk(1))

export const parallelStream = <A, B, R>(
  inputs: Iterable<A>,
  parallelism: number,
  f: (input: A) => Stream.Stream<B, LlmError, R>
): Stream.Stream<B, LlmError, R> =>
  Stream.fromIterable(inputs).pipe(
    Stream.mapEffect((input) => Stream.runCollect(f(input)), {
      concurrency: parallelism
    }),
    Stream.flatMap(Stream.fromIterable)
  )
