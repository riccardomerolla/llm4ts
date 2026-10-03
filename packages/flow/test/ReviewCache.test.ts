import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { ReviewIssue, ReviewResult } from "@llm4ts/flow/Review"
import { cachedReview, cachedValue, fingerprintOf } from "@llm4ts/flow/ReviewCache"
import { StoryVerdict } from "@llm4ts/flow/Stories"

describe("fingerprintOf", () => {
  it("is stable, and tells apart parts that only differ in their split", () => {
    assert.strictEqual(fingerprintOf(["a", "b"]), fingerprintOf(["a", "b"]))
    assert.notStrictEqual(fingerprintOf(["ab", ""]), fingerprintOf(["a", "b"]))
    assert.match(fingerprintOf(["x"]), /^[0-9a-f]{64}$/)
  })
})

describe("cachedValue", () => {
  const Verdict = Schema.Union([StoryVerdict, ReviewResult])
  const red = StoryVerdict.make({
    issues: [ReviewIssue.make({ severity: "Critical", title: "missing", description: "d" })],
    summary: "short",
    dimensions: [{ id: "provides", score: 1, max: 2 }]
  })

  it.effect("evaluates once per fingerprint and says when it reused the answer", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const calls = yield* Ref.make(0)
      const evaluate = Ref.update(calls, (n) => n + 1).pipe(Effect.as(red))
      const first = yield* cachedValue(memory.store, "/s/a.judge.json", Verdict, "f1", evaluate)
      assert.isFalse(first.reused)
      assert.isTrue(first.value instanceof StoryVerdict)
      const again = yield* cachedValue(memory.store, "/s/a.judge.json", Verdict, "f1", evaluate)
      assert.isTrue(again.reused)
      assert.isTrue(again.value instanceof StoryVerdict)
      if (again.value instanceof StoryVerdict) {
        assert.deepStrictEqual(again.value.dimensions, [{ id: "provides", score: 1, max: 2 }])
      }
      const changed = yield* cachedValue(memory.store, "/s/a.judge.json", Verdict, "f2", evaluate)
      assert.isFalse(changed.reused)
      assert.strictEqual(yield* Ref.get(calls), 2)
      // Told not to reuse, it asks and stores anyway.
      const forced = yield* cachedValue(memory.store, "/s/a.judge.json", Verdict, "f2", evaluate, {
        reuse: false
      })
      assert.isFalse(forced.reused)
      assert.strictEqual(yield* Ref.get(calls), 3)
    })
  )

  it.effect("cachedReview keeps its shape", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const clean = ReviewResult.make({ issues: [], summary: "ok" })
      const result = yield* cachedReview(memory.store, "/s/r.json", "f", Effect.succeed(clean))
      assert.isTrue(result.isClean)
    })
  )
})
