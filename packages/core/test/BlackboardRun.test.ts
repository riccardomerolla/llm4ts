import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { DuplicateFact, makeKey } from "@llm4ts/core/blackboard/Fact"
import { all, derive, on, rule, when } from "@llm4ts/core/blackboard/Rule"
import { makeRuleset } from "@llm4ts/core/blackboard/Ruleset"
import {
  ExportsMissing,
  MissingImport,
  runRuleset,
  RunResult,
  UndeclaredFact
} from "@llm4ts/core/blackboard/Run"

const diff = makeKey("diff", Schema.String)
const rules = makeKey("rules", Schema.String)
const size = makeKey("size", Schema.Number)
const small = makeKey("small", Schema.Boolean)
const landable = makeKey("landable", Schema.Boolean)
const left = makeKey("left", Schema.Number)
const right = makeKey("right", Schema.Number)
const sum = makeKey("sum", Schema.Number)

const sizeOf = derive({
  name: "size",
  condition: on(diff),
  produces: [size],
  derive: (d) => [size.of(d.length)]
})
const smallOf = derive({
  name: "small",
  condition: on(size),
  produces: [small],
  derive: (n) => [small.of(n < 100)]
})
const landing = derive({
  name: "landing",
  condition: all(small, rules),
  produces: [landable],
  derive: ([isSmall, houseRules]) => [landable.of(isSmall && houseRules.length > 0)]
})

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

describe("running a ruleset", () => {
  it.effect("chains three rules to the export and records the trace in firing order", () =>
    Effect.gen(function* () {
      const ruleset = yield* makeRuleset({
        name: "landing",
        imports: [diff, rules],
        exports: [landable],
        rules: [landing, smallOf, sizeOf]
      })
      const result = yield* runRuleset(ruleset, [diff.of("+ one line"), rules.of("be kind")])
      assert.isTrue(yield* result.board.get(landable))
      assert.strictEqual(yield* result.board.get(size), 10)
      assert.deepStrictEqual(
        result.trace.map((f) => f.rule),
        ["size", "small", "landing"]
      )
      const first = result.trace[0]
      assert.deepStrictEqual(first?.readKeys, ["diff"])
      assert.deepStrictEqual(first?.postedKeys, ["size"])
      assert.strictEqual(first?.kind, "derive")
      assert.isAtLeast(first?.duration ?? -1, 0)
      assert.deepStrictEqual(result.failures, [])
      const json = yield* Schema.encodeEffect(RunResult)(result)
      const back = yield* Schema.decodeUnknownEffect(RunResult)(json)
      assert.deepStrictEqual(back.board.facts, result.board.facts)
    })
  )

  it.effect("a missing import fails before anything fires", () =>
    Effect.gen(function* () {
      const ruleset = yield* makeRuleset({
        name: "landing",
        imports: [diff, rules],
        exports: [landable],
        rules: [sizeOf, smallOf, landing]
      })
      const error = yield* Effect.flip(runRuleset(ruleset, [diff.of("x")]))
      assert.instanceOf(error, MissingImport)
      assert.deepStrictEqual(error.keys, ["rules"])
    })
  )

  it.effect("an initial fact that is not an import is undeclared", () =>
    Effect.gen(function* () {
      const ruleset = yield* makeRuleset({
        name: "s",
        imports: [diff],
        exports: [size],
        rules: [sizeOf]
      })
      const error = yield* Effect.flip(runRuleset(ruleset, [diff.of("x"), size.of(3)]))
      assert.instanceOf(error, UndeclaredFact)
      assert.strictEqual(error.rule, "(initial)")
      assert.strictEqual(error.key, "size")
    })
  )

  it.effect(
    "when blocks a firing, so a missing export names the waiting rule and its missing keys",
    () =>
      Effect.gen(function* () {
        const onlyBig = derive({
          name: "small",
          condition: when(on(size), (n) => n > 1000),
          produces: [small],
          derive: () => [small.of(false)]
        })
        const ruleset = yield* makeRuleset({
          name: "landing",
          imports: [diff, rules],
          exports: [landable],
          rules: [sizeOf, onlyBig, landing]
        })
        const error = yield* Effect.flip(runRuleset(ruleset, [diff.of("tiny"), rules.of("r")]))
        assert.instanceOf(error, ExportsMissing)
        assert.deepStrictEqual(
          error.missing.map((m) => m.key),
          ["landable"]
        )
        assert.deepStrictEqual(
          error.missing[0]?.waitingRules.map((w) => [w.rule, [...w.missingKeys]]),
          [["landing", ["small"]]]
        )
      })
  )

  it.effect(
    "a failing consequence is recorded and its defaults are posted; the run continues",
    () =>
      Effect.gen(function* () {
        const gate = rule({
          name: "small",
          condition: on(size),
          produces: [small],
          defaults: [small.of(false)],
          consequence: () => Effect.fail(new Refused())
        })
        const ruleset = yield* makeRuleset({
          name: "landing",
          imports: [diff, rules],
          exports: [landable],
          rules: [sizeOf, gate, landing]
        })
        const result = yield* runRuleset(ruleset, [diff.of("x"), rules.of("r")])
        assert.isFalse(yield* result.board.get(landable))
        assert.strictEqual(result.failures.length, 1)
        assert.strictEqual(result.failures[0]?.rule, "small")
        assert.instanceOf(result.failures[0]?.error, Refused)
        assert.deepStrictEqual(
          result.trace.map((f) => f.rule),
          ["size", "landing"]
        )
      })
  )

  it.effect("a defect in a consequence or a predicate fails the run", () =>
    Effect.gen(function* () {
      const boom = rule({
        name: "small",
        condition: on(size),
        produces: [small],
        consequence: () => Effect.die("boom")
      })
      const ruleset = yield* makeRuleset({
        name: "d",
        imports: [diff],
        exports: [small],
        rules: [sizeOf, boom]
      })
      const exit = yield* Effect.exit(runRuleset(ruleset, [diff.of("x")]))
      assert.isTrue(Exit.isFailure(exit))
      const throwing = derive({
        name: "small",
        condition: when(on(size), () => {
          throw new TypeError("bad predicate")
        }),
        produces: [small],
        derive: () => []
      })
      const ruleset2 = yield* makeRuleset({
        name: "d",
        imports: [diff],
        exports: [small],
        rules: [sizeOf, throwing]
      })
      const exit2 = yield* Effect.exit(runRuleset(ruleset2, [diff.of("x")]))
      assert.isTrue(Exit.isFailure(exit2))
    })
  )

  it.effect("posting a declared key twice with equal values is fine; a different value fails", () =>
    Effect.gen(function* () {
      const twice = derive({
        name: "small",
        condition: on(size),
        produces: [small],
        derive: () => [small.of(true), small.of(true)]
      })
      const ruleset = yield* makeRuleset({
        name: "t",
        imports: [diff],
        exports: [small],
        rules: [sizeOf, twice]
      })
      const result = yield* runRuleset(ruleset, [diff.of("x")])
      assert.isTrue(yield* result.board.get(small))
      const conflict = derive({
        name: "small",
        condition: on(size),
        produces: [small],
        derive: () => [small.of(true), small.of(false)]
      })
      const ruleset2 = yield* makeRuleset({
        name: "t",
        imports: [diff],
        exports: [small],
        rules: [sizeOf, conflict]
      })
      const error = yield* Effect.flip(runRuleset(ruleset2, [diff.of("x")]))
      assert.instanceOf(error, DuplicateFact)
      assert.strictEqual(error.key, "small")
    })
  )

  it.effect("a rule posting a key it did not declare fails the run", () =>
    Effect.gen(function* () {
      const sneaky = derive({
        name: "small",
        condition: on(size),
        produces: [small],
        derive: () => [small.of(true), landable.of(true)]
      })
      const ruleset = yield* makeRuleset({
        name: "u",
        imports: [diff],
        exports: [small],
        rules: [sizeOf, sneaky]
      })
      const error = yield* Effect.flip(runRuleset(ruleset, [diff.of("x")]))
      assert.instanceOf(error, UndeclaredFact)
      assert.deepStrictEqual([error.rule, error.key], ["small", "landable"])
    })
  )

  it.effect("independent rules fire concurrently within a round", () =>
    Effect.gen(function* () {
      const leftDone = yield* Deferred.make<void>()
      const rightDone = yield* Deferred.make<void>()
      // Each side waits for the other: only concurrent firing completes.
      const leftRule = rule({
        name: "left",
        condition: on(diff),
        produces: [left],
        consequence: () =>
          Deferred.succeed(leftDone, undefined).pipe(
            Effect.andThen(Deferred.await(rightDone)),
            Effect.as([left.of(1)])
          )
      })
      const rightRule = rule({
        name: "right",
        condition: on(diff),
        produces: [right],
        consequence: () =>
          Deferred.succeed(rightDone, undefined).pipe(
            Effect.andThen(Deferred.await(leftDone)),
            Effect.as([right.of(2)])
          )
      })
      const add = derive({
        name: "sum",
        condition: all(left, right),
        produces: [sum],
        derive: ([a, b]) => [sum.of(a + b)]
      })
      const ruleset = yield* makeRuleset({
        name: "par",
        imports: [diff],
        exports: [sum],
        rules: [leftRule, rightRule, add]
      })
      const result = yield* runRuleset(ruleset, [diff.of("x")]).pipe(
        Effect.timeout(Duration.seconds(2))
      )
      assert.strictEqual(yield* result.board.get(sum), 3)
      assert.deepStrictEqual(result.trace.map((f) => f.rule).sort(), ["left", "right", "sum"])
    })
  )
})
