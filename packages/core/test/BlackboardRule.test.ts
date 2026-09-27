import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { makeKey } from "@llm4ts/core/blackboard/Fact"
import { all, derive, on, rule, when, type Facts } from "@llm4ts/core/blackboard/Rule"

const amount = makeKey("amount", Schema.Number)
const currency = makeKey("currency", Schema.String)
const large = makeKey("large", Schema.Boolean)

const facts = (entries: Record<string, Schema.Json>): Facts => new Map(Object.entries(entries))

describe("blackboard conditions", () => {
  it.effect("on: absent is None, present is the decoded value", () =>
    Effect.gen(function* () {
      const condition = on(amount)
      assert.deepStrictEqual(condition.keys, ["amount"])
      assert.isTrue(Option.isNone(yield* condition.evaluate(facts({}))))
      const present = yield* condition.evaluate(facts({ amount: 12 }))
      assert.deepStrictEqual(present, Option.some(12))
    })
  )

  it.effect("all: waits for every key and yields a typed tuple", () =>
    Effect.gen(function* () {
      const condition = all(amount, currency)
      assert.deepStrictEqual(condition.keys, ["amount", "currency"])
      assert.isTrue(Option.isNone(yield* condition.evaluate(facts({ amount: 1 }))))
      const both = yield* condition.evaluate(facts({ amount: 1, currency: "EUR" }))
      assert.deepStrictEqual(both, Option.some([1, "EUR"] as const))
      if (Option.isSome(both)) {
        const [a, c] = both.value
        assert.strictEqual(a + 1, 2)
        assert.strictEqual(c.toLowerCase(), "eur")
      }
    })
  )

  it.effect("when: the predicate can veto a satisfied condition", () =>
    Effect.gen(function* () {
      const condition = when(on(amount), (value) => value > 100)
      assert.deepStrictEqual(condition.keys, ["amount"])
      assert.isTrue(Option.isNone(yield* condition.evaluate(facts({ amount: 5 }))))
      assert.deepStrictEqual(yield* condition.evaluate(facts({ amount: 500 })), Option.some(500))
    })
  )
})

describe("blackboard rules", () => {
  it.effect("derive: pure, declares what it reads and produces, fires once prepared", () =>
    Effect.gen(function* () {
      const isLarge = derive({
        name: "is-large",
        condition: on(amount),
        produces: [large],
        derive: (value) => [large.of(value > 1000)]
      })
      assert.strictEqual(isLarge.kind, "derive")
      assert.deepStrictEqual(isLarge.reads, ["amount"])
      assert.deepStrictEqual(isLarge.produces, ["large"])
      assert.deepStrictEqual(isLarge.defaults, [])
      assert.isTrue(Option.isNone(yield* isLarge.prepare(facts({}))))
      const prepared = yield* isLarge.prepare(facts({ amount: 5000 }))
      assert.isTrue(Option.isSome(prepared))
      if (Option.isSome(prepared)) {
        const posted = yield* prepared.value
        assert.strictEqual(posted.facts.length, 1)
        const fact = posted.facts[0]
        assert.strictEqual(fact?.key, "large")
        assert.strictEqual(fact === undefined ? undefined : yield* fact.encoded, true)
      }
    })
  )

  it.effect("rule: an effectful consequence with defaults and a typed error channel", () =>
    Effect.gen(function* () {
      class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}
      const gate = rule({
        name: "gate",
        condition: all(amount, currency),
        produces: [large],
        defaults: [large.of(false)],
        consequence: ([value, code]) =>
          code === "EUR" ? Effect.succeed([large.of(value > 100)]) : Effect.fail(new Refused())
      })
      assert.strictEqual(gate.kind, "rule")
      assert.deepStrictEqual(
        gate.defaults.map((fact) => fact.key),
        ["large"]
      )
      const prepared = yield* gate.prepare(facts({ amount: 200, currency: "USD" }))
      assert.isTrue(Option.isSome(prepared))
      if (Option.isSome(prepared)) {
        const error = yield* Effect.flip(prepared.value)
        assert.instanceOf(error, Refused)
      }
    })
  )
})
