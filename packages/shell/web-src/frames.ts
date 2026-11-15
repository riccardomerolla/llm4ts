import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import {
  WebFrameJson,
  WebTranscriptJson,
  type WebFrame,
  type WebRun,
  type WebTranscript
} from "../src/WebFrame.ts"

/**
 * Where the `watch --web` page gets its data (ADR 0051), with no DOM in
 * sight: the page wires a browser `FrameSource` over `fetch` and
 * `EventSource`, and the tests wire a fake one. Every frame that arrives is
 * decoded through the shared `WebFrame` schema.
 */

/** A response the page could not use: a failed request, or a body the schema refused. */
export class PageError extends Schema.TaggedError<PageError>()("PageError", {
  message: Schema.String
}) {}

export interface FrameSource {
  readonly run: Effect.Effect<WebRun, PageError>
  /** The frame after `count` steps; the live frame when `count` is omitted. */
  readonly frame: (count?: number) => Effect.Effect<WebFrame, PageError>
  /** Frames as the server sends them: a replay from `count` at `speed`, or the live run. */
  readonly stream: (
    replay: { readonly count: number; readonly speed: number } | undefined
  ) => Stream.Stream<WebFrame, PageError>
  /** A tail's answer from `/api/transcript?…` (views.ts `transcriptPath`). */
  readonly transcript: (path: string) => Effect.Effect<WebTranscript, PageError>
}

const decodeFrameJson = Schema.decodeUnknownResult(WebFrameJson)

/** One streamed or fetched frame's JSON, through the schema. */
export const decodeFrame = (json: unknown): Result.Result<WebFrame, PageError> =>
  Result.mapError(
    decodeFrameJson(json),
    (error) => new PageError({ message: `a frame did not decode: ${error.message}` })
  )

const decodeTranscriptJson = Schema.decodeUnknownResult(WebTranscriptJson)

/** A tail's JSON, through the schema. */
export const decodeTranscript = (json: unknown): Result.Result<WebTranscript, PageError> =>
  Result.mapError(
    decodeTranscriptJson(json),
    (error) => new PageError({ message: `a transcript did not decode: ${error.message}` })
  )

/** What the page needs of an `EventSource`; the browser's satisfies it. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void
  close(): void
}

/**
 * Server-sent frames as a stream: each `frame` event decoded in arrival
 * order, `end` ends it, and a frame the schema refuses fails it. `error`
 * ends a replay's stream, as the server closing it means it is over; a live
 * stream leaves it to the browser, which reconnects by itself. The source is
 * closed when the stream ends, fails or is interrupted.
 */
export const sseFrames = (
  open: () => EventSourceLike,
  options: { readonly endOnError: boolean }
): Stream.Stream<WebFrame, PageError> =>
  Stream.callback<WebFrame, PageError>((queue) =>
    Effect.gen(function* () {
      const source = yield* Effect.acquireRelease(Effect.sync(open), (opened) =>
        Effect.sync(() => opened.close())
      )
      source.addEventListener("frame", (event) => {
        const decoded = decodeFrame(event.data)
        if (Result.isSuccess(decoded)) {
          Queue.offerUnsafe(queue, decoded.success)
        } else {
          Queue.failCauseUnsafe(queue, Cause.fail(decoded.failure))
        }
      })
      source.addEventListener("end", () => {
        Queue.endUnsafe(queue)
      })
      if (options.endOnError) {
        source.addEventListener("error", () => {
          Queue.endUnsafe(queue)
        })
      }
    })
  )
