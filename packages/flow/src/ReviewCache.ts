import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PersistenceError, type FlowError } from "./FlowError.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"
import { ReviewResult } from "./Review.ts"

class ReviewCacheEntry extends Schema.Class<ReviewCacheEntry>("ReviewCacheEntry")({
  fingerprint: Schema.String,
  result: ReviewResult
}) {}

const decodeEntry = (contents: string): Effect.Effect<ReviewCacheEntry | undefined> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewCacheEntry))(contents).pipe(
    Effect.option,
    Effect.map((option) => (option._tag === "Some" ? option.value : undefined))
  )

export const cachedReview = Effect.fn("@llm4ts/flow/ReviewCache.cached")(function* <R>(
  files: PlainFileStoreShape,
  path: string,
  fingerprint: string,
  evaluate: Effect.Effect<ReviewResult, FlowError, R>
): Effect.fn.Return<ReviewResult, FlowError, R> {
  const contents = yield* files.read(path).pipe(Effect.catch(() => Effect.succeed(undefined)))
  const entry = contents === undefined ? undefined : yield* decodeEntry(contents)
  if (entry?.fingerprint === fingerprint) {
    return entry.result
  }
  const result = yield* evaluate
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(ReviewCacheEntry))(
    ReviewCacheEntry.make({
      fingerprint,
      result
    })
  ).pipe(
    Effect.mapError((error) =>
      PersistenceError.make({
        message: `failed to encode review cache: ${String(error)}`,
        cause: error
      })
    )
  )
  yield* files.writeAtomic(path, encoded)
  return result
})
