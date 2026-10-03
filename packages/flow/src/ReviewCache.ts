import { createHash } from "node:crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { PersistenceError, type FlowError } from "./FlowError.ts"
import type { PlainFileStoreShape } from "./Persistence.ts"
import { ReviewResult } from "./Review.ts"

/** A stable key over parts, length-prefixed so a split never collides with another. */
export const fingerprintOf = (parts: ReadonlyArray<string>): string => {
  const hash = createHash("sha256")
  for (const part of parts) {
    hash.update(`${part.length}:`)
    hash.update(part)
  }
  return hash.digest("hex")
}

export interface CachedValue<A> {
  readonly value: A
  /** True when the answer came from disk, for an unchanged fingerprint. */
  readonly reused: boolean
}

export interface CachedValueOptions {
  /** False evaluates regardless and only stores the answer (default true). */
  readonly reuse?: boolean
}

/**
 * An answer persisted beside its fingerprint: a rerun re-evaluates only
 * when the fingerprint changes, and says when it did not have to.
 */
export const cachedValue = Effect.fn("@llm4ts/flow/ReviewCache.cachedValue")(function* <
  A,
  E,
  RD,
  RE,
  R
>(
  files: PlainFileStoreShape,
  path: string,
  schema: Schema.Codec<A, E, RD, RE>,
  fingerprint: string,
  evaluate: Effect.Effect<A, FlowError, R>,
  options: CachedValueOptions = {}
): Effect.fn.Return<CachedValue<A>, FlowError, R | RD | RE> {
  const Entry = Schema.fromJsonString(Schema.Struct({ fingerprint: Schema.String, result: schema }))
  const contents =
    options.reuse === false
      ? undefined
      : yield* files.read(path).pipe(Effect.catch(() => Effect.succeed(undefined)))
  const entry =
    contents === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(Entry)(contents).pipe(
          Effect.option,
          Effect.map((option) => (option._tag === "Some" ? option.value : undefined))
        )
  if (entry?.fingerprint === fingerprint) {
    return { value: entry.result, reused: true }
  }
  const result = yield* evaluate
  const encoded = yield* Schema.encodeEffect(Entry)({ fingerprint, result }).pipe(
    Effect.mapError((error) =>
      PersistenceError.make({
        message: `failed to encode cache entry: ${String(error)}`,
        cause: error
      })
    )
  )
  yield* files.writeAtomic(path, encoded)
  return { value: result, reused: false }
})

export const cachedReview = <R>(
  files: PlainFileStoreShape,
  path: string,
  fingerprint: string,
  evaluate: Effect.Effect<ReviewResult, FlowError, R>
): Effect.Effect<ReviewResult, FlowError, R> =>
  Effect.map(
    cachedValue(files, path, ReviewResult, fingerprint, evaluate),
    (cached) => cached.value
  )
