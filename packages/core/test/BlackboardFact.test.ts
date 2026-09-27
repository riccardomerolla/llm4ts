import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import {
  Board,
  DuplicateFact,
  makeKey,
  MissingFact,
  sameJson,
  writeOnce
} from "@llm4ts/core/blackboard/Fact"

class Review extends Schema.Class<Review>("Review")({
  blocking: Schema.Number,
  notes: Schema.Array(Schema.String)
}) {}

const landable = makeKey("story.landable", Schema.Boolean)
const review = makeKey("story.review", Review)

describe("blackboard facts", () => {
  it.effect("a key encodes a value to JSON and reads it back typed", () =>
    Effect.gen(function* () {
      const fact = review.of(Review.make({ blocking: 0, notes: ["ok"] }))
      assert.strictEqual(fact.key, "story.review")
      const encoded = yield* fact.encoded
      assert.deepStrictEqual(encoded, { blocking: 0, notes: ["ok"] })
      const back = yield* review.read(encoded)
      assert.instanceOf(back, Review)
      assert.strictEqual(back.blocking, 0)
    })
  )

  it.effect("the board reads a present fact and fails typed on a missing one", () =>
    Effect.gen(function* () {
      const board = Board.make({ facts: { "story.landable": true } })
      assert.isTrue(yield* board.get(landable))
      assert.isTrue(board.has("story.landable"))
      assert.isFalse(board.has("story.review"))
      const missing = yield* Effect.flip(board.get(review))
      assert.instanceOf(missing, MissingFact)
      assert.strictEqual(missing.key, "story.review")
    })
  )

  it.effect("the board round-trips through its schema", () =>
    Effect.gen(function* () {
      const board = Board.make({ facts: { a: 1, b: { c: [true, null] } } })
      const json = yield* Schema.encodeEffect(Board)(board)
      const back = yield* Schema.decodeUnknownEffect(Board)(json)
      assert.deepStrictEqual(back.facts, board.facts)
    })
  )

  it("sameJson compares structurally, order-insensitive for objects", () => {
    assert.isTrue(sameJson({ a: 1, b: [1, "x"] }, { b: [1, "x"], a: 1 }))
    assert.isFalse(sameJson({ a: 1 }, { a: 2 }))
    assert.isFalse(sameJson([1, 2], [2, 1]))
    assert.isFalse(sameJson(null, 0))
  })

  it("writeOnce keeps the first value, ignores an equal rewrite, refuses a different one", () => {
    const empty: ReadonlyMap<string, Schema.Json> = new Map()
    const first = writeOnce(empty, "k", { v: 1 })
    assert.isTrue(Result.isSuccess(first))
    if (!Result.isSuccess(first)) return
    assert.deepStrictEqual(first.success.get("k"), { v: 1 })
    const same = writeOnce(first.success, "k", { v: 1 })
    assert.isTrue(Result.isSuccess(same))
    if (!Result.isSuccess(same)) return
    assert.strictEqual(same.success, first.success)
    const different = writeOnce(first.success, "k", { v: 2 })
    assert.isTrue(Result.isFailure(different))
    if (!Result.isFailure(different)) return
    assert.instanceOf(different.failure, DuplicateFact)
    assert.strictEqual(different.failure.key, "k")
  })
})
