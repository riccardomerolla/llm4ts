import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { makeKey } from "@llm4ts/core/blackboard/Fact"
import { all, derive, on } from "@llm4ts/core/blackboard/Rule"
import {
  isWarning,
  makeRuleset,
  RulesetInvalid,
  type Problem
} from "@llm4ts/core/blackboard/Ruleset"

const diff = makeKey("diff", Schema.String)
const rules = makeKey("rules", Schema.String)
const size = makeKey("size", Schema.Number)
const small = makeKey("small", Schema.Boolean)
const landable = makeKey("landable", Schema.Boolean)
const noise = makeKey("noise", Schema.String)

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

const kinds = (problems: ReadonlyArray<Problem>): ReadonlyArray<string> =>
  problems.map((p) => p.kind).sort()

describe("ruleset validation", () => {
  it.effect("a wired ruleset is accepted, keeps rule order and has no warnings", () =>
    Effect.gen(function* () {
      const ruleset = yield* makeRuleset({
        name: "landing",
        imports: [diff, rules],
        exports: [landable],
        rules: [sizeOf, smallOf, landing]
      })
      assert.deepStrictEqual(ruleset.imports, ["diff", "rules"])
      assert.deepStrictEqual(ruleset.exports, ["landable"])
      assert.deepStrictEqual(
        ruleset.rules.map((r) => r.name),
        ["size", "small", "landing"]
      )
      assert.deepStrictEqual(ruleset.warnings, [])
    })
  )

  it.effect("reports every problem at once, typed", () =>
    Effect.gen(function* () {
      const orphan = derive({
        name: "orphan",
        condition: on(noise),
        produces: [small],
        derive: () => []
      })
      const loop = derive({ name: "loop", condition: on(size), produces: [size], derive: () => [] })
      const error = yield* Effect.flip(
        makeRuleset({
          name: "broken",
          imports: [diff],
          exports: [landable, noise],
          rules: [sizeOf, smallOf, orphan, loop, landing]
        })
      )
      assert.instanceOf(error, RulesetInvalid)
      assert.strictEqual(error.name, "broken")
      assert.deepStrictEqual(kinds(error.problems), [
        "ManyProducers", // size: sizeOf and loop
        "ManyProducers", // small: smallOf and orphan
        "SelfMatch", // loop reads size
        "UnproducedExport", // noise
        "UnproducedMatch", // landing reads rules, not imported
        "UnproducedMatch" // orphan reads noise
      ])
    })
  )

  it.effect("an import that a rule also produces is ManyProducers", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        makeRuleset({
          name: "x",
          imports: [diff, size],
          exports: [small],
          rules: [sizeOf, smallOf]
        })
      )
      assert.deepStrictEqual(kinds(error.problems), ["ManyProducers"])
    })
  )

  it.effect("a constant rule and a duplicate rule name are refused", () =>
    Effect.gen(function* () {
      const constant = derive({
        name: "size",
        condition: { keys: [], evaluate: () => Effect.succeed(Option.none()) },
        produces: [small],
        derive: () => []
      })
      const error = yield* Effect.flip(
        makeRuleset({ name: "x", imports: [diff], exports: [small], rules: [sizeOf, constant] })
      )
      assert.deepStrictEqual(kinds(error.problems), ["DuplicateRuleName", "EmptyCondition"])
    })
  )

  it.effect("warnings do not fail: unused imports and unreachable rules, which are pruned", () =>
    Effect.gen(function* () {
      const aside = derive({
        name: "aside",
        condition: on(diff),
        produces: [noise],
        derive: (d) => [noise.of(d)]
      })
      const sideEffectOnly = derive({
        name: "log",
        condition: on(diff),
        produces: [],
        derive: () => []
      })
      const ruleset = yield* makeRuleset({
        name: "warn",
        imports: [diff, rules, size],
        exports: [small],
        rules: [smallOf, aside, sideEffectOnly]
      })
      assert.deepStrictEqual(
        ruleset.rules.map((r) => r.name),
        ["small"]
      )
      assert.deepStrictEqual(kinds(ruleset.warnings), [
        "Unreachable",
        "Unreachable",
        "UnusedImport",
        "UnusedImport"
      ])
      assert.isTrue(ruleset.warnings.every(isWarning))
      const unreachable = ruleset.warnings.flatMap((p) =>
        p.kind === "Unreachable" ? [p.rule] : []
      )
      assert.deepStrictEqual(unreachable.sort(), ["aside", "log"])
    })
  )

  it.effect("describe and mermaid render the dependency graph", () =>
    Effect.gen(function* () {
      const ruleset = yield* makeRuleset({
        name: "landing",
        imports: [diff, rules],
        exports: [landable],
        rules: [sizeOf, smallOf, landing]
      })
      const text = ruleset.describe()
      assert.include(text, "ruleset landing")
      assert.include(text, "imports: diff, rules")
      assert.include(text, "exports: landable")
      assert.include(text, "landing: small, rules -> landable")
      const mermaid = ruleset.mermaid()
      assert.include(mermaid, "flowchart LR")
      assert.include(mermaid, '["landing"]')
      const smallKey = /(k\d+)\(\["small"\]\)/.exec(mermaid)?.[1]
      const landingRule = /(r\d+)\["landing"\]/.exec(mermaid)?.[1]
      assert.include(mermaid, `${smallKey} --> ${landingRule}`)
    })
  )
})
