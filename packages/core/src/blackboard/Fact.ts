import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

/**
 * Facts on a blackboard (ADR 0020). A key names a fact and carries its
 * schema; the board holds facts in their encoded JSON form, so it persists
 * as-is and a read decodes through the key's schema instead of asserting a
 * type. A key is written once per run: an equal rewrite is a no-op, a
 * different one is a `DuplicateFact`.
 */

export interface Fact {
  readonly key: string
  /** The value in the key's encoded form; a value typed `A` cannot fail to encode. */
  readonly encoded: Effect.Effect<Schema.Json>
}

export interface FactKey<A> {
  readonly name: string
  of(value: A): Fact
  /** Decode a stored value; the board only holds what a key encoded, so a failure is a defect. */
  readonly read: (encoded: unknown) => Effect.Effect<A>
}

export const makeKey = <A, I>(name: string, schema: Schema.Codec<A, I>): FactKey<A> => {
  const encode = Schema.encodeEffect(schema)
  const decode = Schema.decodeUnknownEffect(schema)
  const json = Schema.decodeUnknownEffect(Schema.Json)
  return {
    name,
    of: (value) => ({
      key: name,
      encoded: encode(value).pipe(Effect.flatMap(json), Effect.orDie)
    }),
    read: (encoded) => decode(encoded).pipe(Effect.orDie)
  }
}

export class MissingFact extends Schema.TaggedError<MissingFact>()("MissingFact", {
  key: Schema.String
}) {
  get message(): string {
    return `fact "${this.key}" is not on the board`
  }
}

export class DuplicateFact extends Schema.TaggedError<DuplicateFact>()("DuplicateFact", {
  key: Schema.String
}) {
  get message(): string {
    return `fact "${this.key}" was posted twice with different values`
  }
}

export class Board extends Schema.Class<Board>("Board")({
  facts: Schema.Record(Schema.String, Schema.Json)
}) {
  static readonly empty: Board = Board.make({ facts: {} })

  has(name: string): boolean {
    return Object.hasOwn(this.facts, name)
  }

  get<A>(key: FactKey<A>): Effect.Effect<A, MissingFact> {
    return this.has(key.name)
      ? key.read(this.facts[key.name])
      : Effect.fail(MissingFact.make({ key: key.name }))
  }
}

const isObject = (value: Schema.Json): value is { readonly [key: string]: Schema.Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Structural JSON equality: arrays ordered, object keys not. */
export const sameJson = (a: Schema.Json, b: Schema.Json): boolean => {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameJson(item, b[index] ?? null))
  }
  if (isObject(a) && isObject(b)) {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    return (
      keysA.length === keysB.length &&
      keysA.every((key) => Object.hasOwn(b, key) && sameJson(a[key] ?? null, b[key] ?? null))
    )
  }
  return false
}

/** The board after a write: unchanged for an equal rewrite, extended for a new key. */
export const writeOnce = (
  facts: ReadonlyMap<string, Schema.Json>,
  key: string,
  value: Schema.Json
): Result.Result<ReadonlyMap<string, Schema.Json>, DuplicateFact> => {
  if (!facts.has(key)) {
    return Result.succeed(new Map(facts).set(key, value))
  }
  return sameJson(facts.get(key) ?? null, value)
    ? Result.succeed(facts)
    : Result.fail(DuplicateFact.make({ key }))
}
