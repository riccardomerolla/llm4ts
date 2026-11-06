import * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { TimeoutError, type LlmError } from "./Errors.ts"
import type { LlmChunk } from "./Models.ts"
import { LlmResponse, StreamProgress } from "./Models.ts"

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

/** `collect` for a stream whose failures are not only `LlmError`s (a flow-level guard on it). */
export const collectAny = <E, R>(
  stream: Stream.Stream<LlmChunk, E, R>
): Effect.Effect<LlmResponse, E, R> =>
  Stream.runFold(stream, () => LlmResponse.make({ content: "" }), appendChunk)

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
