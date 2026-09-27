import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { makeKey, type FactKey } from "@llm4ts/core/blackboard/Fact"
import { all, derive, type Rule } from "@llm4ts/core/blackboard/Rule"
import { makeRuleset, RulesetInvalid } from "@llm4ts/core/blackboard/Ruleset"
import { runRuleset } from "@llm4ts/core/blackboard/Run"

/** mulberry32: a small seeded generator so every seed is reproducible. */
const random = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Generated {
  readonly imports: ReadonlyArray<FactKey<number>>
  readonly exports: ReadonlyArray<FactKey<number>>
  readonly rules: ReadonlyArray<Rule>
  /** Whether the generator deliberately broke the ruleset, and how. */
  readonly broken: "none" | "UnproducedMatch" | "ManyProducers"
}

const sumOf = (values: ReadonlyArray<number>): number => values.reduce((a, b) => a + b, 0) + 1

/** A rule over one to three keys; `all` is typed by arity, so pick the overload by count. */
const reader = (
  name: string,
  reads: ReadonlyArray<FactKey<number>>,
  produced: FactKey<number>
): Rule => {
  const [a, b, c] = reads
  if (a !== undefined && b !== undefined && c !== undefined) {
    return derive({
      name,
      condition: all(a, b, c),
      produces: [produced],
      derive: (values) => [produced.of(sumOf(values))]
    })
  }
  if (a !== undefined && b !== undefined) {
    return derive({
      name,
      condition: all(a, b),
      produces: [produced],
      derive: (values) => [produced.of(sumOf(values))]
    })
  }
  if (a !== undefined) {
    return derive({
      name,
      condition: all(a),
      produces: [produced],
      derive: (values) => [produced.of(sumOf(values))]
    })
  }
  throw new Error("generator produced a rule with no reads")
}

/**
 * Layered, acyclic: layer 0 is the imports; each rule in layer n reads one
 * to three keys from layers < n and produces one new key. Exports are the
 * keys of the last layer. A third of the seeds get one deliberate defect.
 */
const generate = (seed: number): Generated => {
  const next = random(seed)
  const pick = (n: number): number => Math.floor(next() * n)
  const imports: Array<FactKey<number>> = []
  const importCount = 1 + pick(3)
  for (let i = 0; i < importCount; i++) imports.push(makeKey(`in${i}`, Schema.Number))
  const layers: Array<Array<FactKey<number>>> = [imports]
  const rules: Array<Rule> = []
  const layerCount = 1 + pick(4)
  for (let layer = 1; layer <= layerCount; layer++) {
    const below = layers.flat()
    const width = 1 + pick(3)
    const current: Array<FactKey<number>> = []
    for (let i = 0; i < width; i++) {
      const produced = makeKey(`l${layer}k${i}`, Schema.Number)
      const readCount = 1 + pick(Math.min(3, below.length))
      const reads = [
        ...new Set(Array.from({ length: readCount }, () => below[pick(below.length)]))
      ].flatMap((key) => (key === undefined ? [] : [key]))
      rules.push(reader(`r-l${layer}k${i}`, reads, produced))
      current.push(produced)
    }
    layers.push(current)
  }
  const exports = layers[layers.length - 1] ?? []
  const brokenKind = pick(3)
  if (brokenKind === 1) {
    const ghost = makeKey("ghost", Schema.Number)
    const target = exports[0]
    if (target !== undefined) {
      rules.push(reader("ghost-reader", [ghost], target))
      return { imports, exports, rules, broken: "ManyProducers" }
    }
  }
  if (brokenKind === 2) {
    const ghost = makeKey("ghost", Schema.Number)
    const extra = makeKey("extra", Schema.Number)
    rules.push(reader("ghost-reader", [ghost], extra))
    return { imports, exports: [...exports, extra], rules, broken: "UnproducedMatch" }
  }
  return { imports, exports, rules, broken: "none" }
}

describe("generated rulesets", () => {
  for (const seed of Array.from({ length: 60 }, (_, i) => i + 1)) {
    it.effect(`seed ${seed}: is refused with the planted problem or runs to every export`, () =>
      Effect.gen(function* () {
        const generated = generate(seed)
        const made = yield* Effect.result(
          makeRuleset({
            name: `g${seed}`,
            imports: generated.imports,
            exports: generated.exports,
            rules: generated.rules
          })
        )
        if (generated.broken !== "none") {
          assert.isTrue(Result.isFailure(made), "a planted defect must be refused")
          if (Result.isFailure(made)) {
            assert.instanceOf(made.failure, RulesetInvalid)
            assert.include(
              made.failure.problems.map((p) => p.kind),
              generated.broken
            )
          }
          return
        }
        assert.isTrue(Result.isSuccess(made))
        if (!Result.isSuccess(made)) return
        const result = yield* runRuleset(
          made.success,
          generated.imports.map((key, index) => key.of(index))
        )
        for (const key of generated.exports) {
          assert.isTrue(result.board.has(key.name), `export ${key.name} present`)
        }
        assert.strictEqual(result.failures.length, 0)
        assert.strictEqual(result.trace.length, made.success.rules.length)
      })
    )
  }
})
