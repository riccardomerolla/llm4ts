import * as Context from "effect/Context"
import * as Effect from "effect/Effect"

export interface StreamRecorder {
  readonly rawLine: (
    provider: string,
    model: string | undefined,
    line: string
  ) => Effect.Effect<void>
  readonly streamError: (
    provider: string,
    model: string | undefined,
    message: string
  ) => Effect.Effect<void>
}

export const noopStreamRecorder: StreamRecorder = {
  rawLine: (_provider, _model, _line) => Effect.void,
  streamError: (_provider, _model, _message) => Effect.void
}

const CurrentStreamRecorder = Context.Reference<StreamRecorder>(
  "@llm4ts/core/observability/CurrentStreamRecorder",
  { defaultValue: () => noopStreamRecorder }
)

export const currentStreamRecorder: Effect.Effect<StreamRecorder> = CurrentStreamRecorder

export const withStreamRecorder =
  (recorder: StreamRecorder) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, CurrentStreamRecorder, recorder)
