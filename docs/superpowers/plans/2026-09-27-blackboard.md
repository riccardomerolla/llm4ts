# Typed Blackboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A typed blackboard primitive in `@llm4ts/core` where company-written deterministic rules and `Judgment`-backed rules post facts until a decision is produced.

**Architecture:** Four modules under `packages/core/src/blackboard/`: `Fact` (keys with schemas, the encoded Board), `Rule` (conditions, the `rule`/`derive`/`judge` constructors), `Ruleset` (build-time validation and pruning, description), `Run` (forward chaining in rounds to quiescence, trace, typed errors). The board stores facts in their _encoded_ JSON form; reading decodes through the key's schema, so no type assertions are needed and the board is trivially persistable. Rules fire in rounds: every satisfiable unfired rule fires concurrently, then the posted facts are applied sequentially with write-once checks.

**Tech Stack:** TypeScript, Effect 4 (`effect/Effect`, `effect/Schema`, `effect/Option`, `effect/Result`, `effect/Clock`), `@effect/vitest`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-27-blackboard-design.md`

## Global Constraints

- Effect 4 pinned at `4.0.0-rc.115`; consult `.repos/effect/packages/effect/src/*.ts` for any API you are unsure of (e.g. `Schema.ts`, `Effect.ts`).
- No `any`, no unchecked `as` assertions (eslint `consistent-type-assertions` is on), no namespaces, no unmanaged promises, no global `Error` as a domain error: all expected failures are `Schema.TaggedError`.
- Relative imports use `.ts` extensions; package imports use explicit subpaths (`@llm4ts/core/blackboard/Fact`), each listed in `packages/core/package.json` `exports`.
- Schemas at every persistence boundary: `Board`, `RunResult`, `Firing`, `RuleFailure`, `Problem` are all `Schema` types.
- Error messages name fact _keys_ and _rules_, never fact _values_.
- Core never decides: nothing in `packages/core/src/blackboard/` imports from `@llm4ts/flow`; thresholds stay in flow.
- Tests are deterministic, offline, with `@effect/vitest` (`it.effect`), under `packages/core/test/Blackboard*.test.ts`.
- Verification before every commit: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` (run `pnpm format` to fix formatting).

## Review Focus

Inputs the spec implies but no task's own tests would exercise; each has been pinned to a task below.

1. A rule posts the _same_ key twice in one firing with equal values → no-op, not `DuplicateFact` (Task 4).
2. A `when` predicate throws → the run dies with a defect rather than hanging (Task 4).
3. An import that is also declared as an export of a rule → `ManyProducers` (the import is a producer) (Task 3).
4. A rule with `produces: []` that is not `Unreachable` because it exists only for a side effect → still pruned, since it cannot reach an export; warning names it (Task 3).
5. `judge` when the `Judgment` backend answers only some questions (failures in `JudgmentResult.failures`) → `post` still runs with the partial result; the trace still records the backend identity (Task 5).

---

### Task 1: Fact keys and the Board

**Files:**

- Create: `packages/core/src/blackboard/Fact.ts`
- Test: `packages/core/test/BlackboardFact.test.ts`

**Interfaces:**

- Produces:
  - `interface Fact { readonly key: string; readonly encoded: Effect.Effect<Schema.Json> }`
  - `interface FactKey<A> { readonly name: string; of(value: A): Fact; readonly read: (encoded: unknown) => Effect.Effect<A> }`
  - `Fact.make = <A, I>(name: string, schema: Schema.Codec<A, I>) => FactKey<A>` (exported as `makeKey`)
  - `class Board` (Schema.Class) `{ facts: Record<string, Json> }` with `get<A>(key: FactKey<A>): Effect.Effect<A, MissingFact>`, `has(name: string): boolean`, `static empty: Board`
  - `class MissingFact` TaggedError `{ key: string }`
  - `class DuplicateFact` TaggedError `{ key: string }`
  - `sameJson(a: Json, b: Json): boolean`
  - `writeOnce(facts: ReadonlyMap<string, Json>, key: string, value: Json): Result.Result<ReadonlyMap<string, Json>, DuplicateFact>` — returns the same map when the value is equal, a new map when the key is new, `DuplicateFact` when different.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/BlackboardFact.test.ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/test/BlackboardFact.test.ts`
Expected: FAIL — cannot resolve `@llm4ts/core/blackboard/Fact`.

- [ ] **Step 3: Implement `Fact.ts`**

```ts
// packages/core/src/blackboard/Fact.ts
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

/**
 * Facts on a blackboard. A key names a fact and carries its schema; the
 * board holds facts in their encoded JSON form, so it persists as-is and a
 * read decodes through the key's schema instead of asserting a type. A key
 * is written once per run: an equal rewrite is a no-op, a different one is
 * a `DuplicateFact`.
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

export const writeOnce = (
  facts: ReadonlyMap<string, Schema.Json>,
  key: string,
  value: Schema.Json
): Result.Result<ReadonlyMap<string, Schema.Json>, DuplicateFact> => {
  const existing = facts.get(key)
  if (existing === undefined && !facts.has(key)) {
    return Result.succeed(new Map(facts).set(key, value))
  }
  return sameJson(existing ?? null, value)
    ? Result.succeed(facts)
    : Result.fail(DuplicateFact.make({ key }))
}
```

Note: `Schema.Json`'s `Type` includes `null`, so `existing ?? null` is only for the map's `undefined`; `facts.has` distinguishes a stored `null`.

- [ ] **Step 4: Add the export and run the tests**

In `packages/core/package.json` `exports`, before `"./Capability"`, add:

```json
    "./blackboard/Fact": "./dist/blackboard/Fact.js",
```

Run: `pnpm vitest run packages/core/test/BlackboardFact.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`
Expected: clean (run `pnpm format` first if the check fails).

```bash
git add packages/core/src/blackboard/Fact.ts packages/core/test/BlackboardFact.test.ts packages/core/package.json
git commit -m "blackboard: fact keys with schemas and the encoded board

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Conditions and rules

**Files:**

- Create: `packages/core/src/blackboard/Rule.ts`
- Test: `packages/core/test/BlackboardRule.test.ts`

**Interfaces:**

- Consumes: `Fact`, `FactKey<A>`, `makeKey` from Task 1.
- Produces:
  - `type Facts = ReadonlyMap<string, Schema.Json>` (a board snapshot)
  - `interface Condition<A> { readonly keys: ReadonlyArray<string>; readonly evaluate: (facts: Facts) => Effect.Effect<Option.Option<A>> }`
  - `on<A>(key: FactKey<A>): Condition<A>`
  - `all<const Ks extends ReadonlyArray<FactKey<unknown>>>(...keys: Ks): Condition<ValuesOf<Ks>>`
  - `when<A>(condition: Condition<A>, predicate: (value: A) => boolean): Condition<A>`
  - `interface Posted { readonly facts: ReadonlyArray<Fact>; readonly judgment?: JudgmentNote }`, `interface JudgmentNote { readonly backend: string; readonly identity: string }`
  - `type RuleKind = "derive" | "judge" | "rule"`
  - `interface Rule<E = never, R = never> { readonly name: string; readonly kind: RuleKind; readonly reads: ReadonlyArray<string>; readonly produces: ReadonlyArray<string>; readonly defaults: ReadonlyArray<Fact>; readonly prepare: (facts: Facts) => Effect.Effect<Option.Option<Effect.Effect<Posted, E, R>>> }`
  - `rule<A, E, R>(options: RuleOptions<A, E, R>): Rule<E, R>` with `RuleOptions = { name; condition: Condition<A>; produces: ReadonlyArray<FactKey<unknown>>; consequence: (value: A) => Effect.Effect<ReadonlyArray<Fact>, E, R>; defaults?: ReadonlyArray<Fact>; kind?: RuleKind }`
  - `derive<A>(options: { name; condition: Condition<A>; produces; derive: (value: A) => ReadonlyArray<Fact> }): Rule`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/BlackboardRule.test.ts
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
        assert.strictEqual(posted.facts[0]?.key, "large")
        assert.strictEqual(yield* posted.facts[0]!.encoded, true)
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/test/BlackboardRule.test.ts`
Expected: FAIL — cannot resolve `@llm4ts/core/blackboard/Rule`.

- [ ] **Step 3: Implement `Rule.ts`**

```ts
// packages/core/src/blackboard/Rule.ts
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type { Fact, FactKey } from "./Fact.ts"

/**
 * Rules of a blackboard. A condition names the keys it reads (what
 * validation and pruning reason on) and evaluates to the typed value a
 * consequence receives; a rule pairs a condition with a consequence that
 * posts facts. Facts are write-once, so a rule fires at most once per run.
 */

/** A snapshot of the board: encoded facts by key. */
export type Facts = ReadonlyMap<string, Schema.Json>

export interface Condition<A> {
  readonly keys: ReadonlyArray<string>
  /** None while a key is missing or a `when` predicate rejects the value. */
  readonly evaluate: (facts: Facts) => Effect.Effect<Option.Option<A>>
}

export const on = <A>(key: FactKey<A>): Condition<A> => ({
  keys: [key.name],
  evaluate: (facts) =>
    facts.has(key.name)
      ? Effect.map(key.read(facts.get(key.name)), Option.some)
      : Effect.succeed(Option.none())
})

export type ValuesOf<Ks extends ReadonlyArray<FactKey<unknown>>> = {
  readonly [K in keyof Ks]: Ks[K] extends FactKey<infer A> ? A : never
}

/** Satisfied once every key is present; the value is the tuple of decoded values, in order. */
export const all = <const Ks extends ReadonlyArray<FactKey<unknown>>>(
  ...keys: Ks
): Condition<ValuesOf<Ks>> => ({
  keys: keys.map((key) => key.name),
  evaluate: (facts) =>
    keys.every((key) => facts.has(key.name))
      ? Effect.map(
          Effect.forEach(keys, (key) => key.read(facts.get(key.name))),
          (values) => Option.some(values as ValuesOf<Ks>)
        )
      : Effect.succeed(Option.none())
})

export const when = <A>(
  condition: Condition<A>,
  predicate: (value: A) => boolean
): Condition<A> => ({
  keys: condition.keys,
  evaluate: (facts) =>
    Effect.map(condition.evaluate(facts), (value) =>
      Option.isSome(value) && predicate(value.value) ? value : Option.none()
    )
})

export interface JudgmentNote {
  readonly backend: string
  readonly identity: string
}

export interface Posted {
  readonly facts: ReadonlyArray<Fact>
  /** Set by `judge`: which backend and checkpoint answered, for the trace. */
  readonly judgment?: JudgmentNote
}

export type RuleKind = "derive" | "judge" | "rule"

export interface Rule<E = never, R = never> {
  readonly name: string
  readonly kind: RuleKind
  readonly reads: ReadonlyArray<string>
  /** The keys this rule may post; posting another is an `UndeclaredFact`. */
  readonly produces: ReadonlyArray<string>
  /** Posted instead when the consequence fails. */
  readonly defaults: ReadonlyArray<Fact>
  /** Some(firing) when the condition is satisfied against the snapshot. */
  readonly prepare: (facts: Facts) => Effect.Effect<Option.Option<Effect.Effect<Posted, E, R>>>
}

export interface RuleOptions<A, E, R> {
  readonly name: string
  readonly condition: Condition<A>
  readonly produces: ReadonlyArray<FactKey<unknown>>
  readonly consequence: (value: A) => Effect.Effect<ReadonlyArray<Fact>, E, R>
  readonly defaults?: ReadonlyArray<Fact>
  readonly kind?: RuleKind
}

export const rule = <A, E, R>(options: RuleOptions<A, E, R>): Rule<E, R> =>
  makeRule(options, (value) => Effect.map(options.consequence(value), (facts) => ({ facts })))

/** The general constructor other constructors build on: the firing may annotate the trace. */
export const makeRule = <A, E, R>(
  options: Omit<RuleOptions<A, E, R>, "consequence">,
  fire: (value: A) => Effect.Effect<Posted, E, R>
): Rule<E, R> => ({
  name: options.name,
  kind: options.kind ?? "rule",
  reads: options.condition.keys,
  produces: options.produces.map((key) => key.name),
  defaults: options.defaults ?? [],
  prepare: (facts) =>
    Effect.map(options.condition.evaluate(facts), (value) =>
      Option.isSome(value) ? Option.some(fire(value.value)) : Option.none()
    )
})

export interface DeriveOptions<A> {
  readonly name: string
  readonly condition: Condition<A>
  readonly produces: ReadonlyArray<FactKey<unknown>>
  readonly derive: (value: A) => ReadonlyArray<Fact>
}

/** A pure, deterministic rule. */
export const derive = <A>(options: DeriveOptions<A>): Rule =>
  makeRule({ ...options, kind: "derive" }, (value) =>
    Effect.succeed({ facts: options.derive(value) })
  )
```

The one assertion, `values as ValuesOf<Ks>` in `all`, converts a `ReadonlyArray<unknown>` into the mapped tuple type the compiler cannot infer from `Effect.forEach`. It is checked by the tests above; leave a one-line comment: `// forEach loses the tuple shape; each element was decoded by its own key`. If eslint's `consistent-type-assertions` rejects it, replace with a small typed helper that reads the keys pairwise (`Effect.all` over a tuple of effects, which does preserve tuple types).

- [ ] **Step 4: Add the export and run the tests**

In `packages/core/package.json` `exports`, after `"./blackboard/Fact"`, add:

```json
    "./blackboard/Rule": "./dist/blackboard/Rule.js",
```

Run: `pnpm vitest run packages/core/test/BlackboardRule.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`

```bash
git add packages/core/src/blackboard/Rule.ts packages/core/test/BlackboardRule.test.ts packages/core/package.json
git commit -m "blackboard: conditions and the rule/derive constructors

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Ruleset validation, pruning and description

**Files:**

- Create: `packages/core/src/blackboard/Ruleset.ts`
- Test: `packages/core/test/BlackboardRuleset.test.ts`

**Interfaces:**

- Consumes: `FactKey`, `makeKey` (Task 1); `Rule`, `derive`, `on`, `all` (Task 2).
- Produces:
  - `Problem` = `Schema.Union` of structs, each `{ kind: Literal, ...fields }`: `UnproducedMatch {rule, key}`, `UnproducedExport {key}`, `ManyProducers {key, rules: string[]}`, `EmptyCondition {rule}`, `SelfMatch {rule, key}`, `DuplicateRuleName {rule}`, `UnusedImport {key}` (warning), `Unreachable {rule}` (warning). `type Problem`.
  - `isWarning(problem: Problem): boolean`
  - `class RulesetInvalid` TaggedError `{ name: string; problems: Array<Problem> }`
  - `interface RulesetOptions<E, R> { name: string; imports: ReadonlyArray<FactKey<unknown>>; exports: ReadonlyArray<FactKey<unknown>>; rules: ReadonlyArray<Rule<E, R>> }`
  - `interface Ruleset<E = never, R = never> { name; imports: ReadonlyArray<string>; exports: ReadonlyArray<string>; rules: ReadonlyArray<Rule<E, R>> /* pruned */; warnings: ReadonlyArray<Problem>; describe(): string; mermaid(): string }`
  - `makeRuleset<E, R>(options: RulesetOptions<E, R>): Effect.Effect<Ruleset<E, R>, RulesetInvalid>`

Note on `DuplicateKeyName` from the spec: keys are values (`FactKey`), and two keys with the same name are indistinguishable on the board; the checks below treat keys by name, so a same-name key with another schema would be caught at run time as a decode defect. Instead this task validates `DuplicateRuleName` (two rules with one name break the trace). Record this in the ADR (Task 8).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/BlackboardRuleset.test.ts
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
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
        condition: { keys: [], evaluate: () => Effect.succeed({ _tag: "None" } as never) },
        produces: [small],
        derive: () => []
      })
      const error = yield* Effect.flip(
        makeRuleset({ name: "x", imports: [diff], exports: [small], rules: [sizeOf, constant] })
      )
      assert.deepStrictEqual(kinds(error.problems), [
        "DuplicateRuleName",
        "EmptyCondition",
        "ManyProducers"
      ])
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
      const unreachable = ruleset.warnings
        .filter((p) => p.kind === "Unreachable")
        .map((p) => (p.kind === "Unreachable" ? p.rule : ""))
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
      assert.match(mermaid, /small.*-->.*landing/)
    })
  )
})
```

The `constant` rule in the fourth test builds a `Condition` by hand with an empty `keys` list. Its `evaluate` result is never used by validation, so the `as never` there is confined to the test. If lint rejects it in tests too, use `evaluate: () => Effect.succeed(Option.none())` with `import * as Option from "effect/Option"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/test/BlackboardRuleset.test.ts`
Expected: FAIL — cannot resolve `@llm4ts/core/blackboard/Ruleset`.

- [ ] **Step 3: Implement `Ruleset.ts`**

```ts
// packages/core/src/blackboard/Ruleset.ts
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { FactKey } from "./Fact.ts"
import type { Rule } from "./Rule.ts"

/**
 * A ruleset is validated when it is built, not when it runs: every read is
 * imported or produced, every export is produced, one producer per key, no
 * constant or self-matching rule. Rules that cannot reach an export are
 * pruned with a warning, so a company's ruleset never pays for a judgment
 * nothing depends on. A valid ruleset is a value that runs many times.
 */

const problem = <K extends string, F extends Schema.Struct.Fields>(kind: K, fields: F) =>
  Schema.Struct({ kind: Schema.Literal(kind), ...fields })

export const Problem = Schema.Union([
  problem("UnproducedMatch", { rule: Schema.String, key: Schema.String }),
  problem("UnproducedExport", { key: Schema.String }),
  problem("ManyProducers", { key: Schema.String, rules: Schema.Array(Schema.String) }),
  problem("EmptyCondition", { rule: Schema.String }),
  problem("SelfMatch", { rule: Schema.String, key: Schema.String }),
  problem("DuplicateRuleName", { rule: Schema.String }),
  problem("UnusedImport", { key: Schema.String }),
  problem("Unreachable", { rule: Schema.String })
])
export type Problem = typeof Problem.Type

const warningKinds: ReadonlySet<Problem["kind"]> = new Set(["UnusedImport", "Unreachable"])

export const isWarning = (problem: Problem): boolean => warningKinds.has(problem.kind)

export class RulesetInvalid extends Schema.TaggedError<RulesetInvalid>()("RulesetInvalid", {
  name: Schema.String,
  problems: Schema.Array(Problem)
}) {
  get message(): string {
    return `ruleset "${this.name}" is invalid: ${this.problems.map(renderProblem).join("; ")}`
  }
}

export const renderProblem = (problem: Problem): string => {
  switch (problem.kind) {
    case "UnproducedMatch":
      return `rule ${problem.rule} reads "${problem.key}", which nothing imports or produces`
    case "UnproducedExport":
      return `export "${problem.key}" is produced by no rule`
    case "ManyProducers":
      return `"${problem.key}" has several producers: ${problem.rules.join(", ")}`
    case "EmptyCondition":
      return `rule ${problem.rule} reads nothing`
    case "SelfMatch":
      return `rule ${problem.rule} reads "${problem.key}", which it produces`
    case "DuplicateRuleName":
      return `two rules are named ${problem.rule}`
    case "UnusedImport":
      return `import "${problem.key}" is read by no rule`
    case "Unreachable":
      return `rule ${problem.rule} reaches no export and is not run`
  }
}

export interface RulesetOptions<E, R> {
  readonly name: string
  readonly imports: ReadonlyArray<FactKey<unknown>>
  readonly exports: ReadonlyArray<FactKey<unknown>>
  readonly rules: ReadonlyArray<Rule<E, R>>
}

export interface Ruleset<E = never, R = never> {
  readonly name: string
  readonly imports: ReadonlyArray<string>
  readonly exports: ReadonlyArray<string>
  /** The rules that can reach an export, in the order given. */
  readonly rules: ReadonlyArray<Rule<E, R>>
  readonly warnings: ReadonlyArray<Problem>
  /** One line per rule: `name: reads -> produces`. */
  describe(): string
  /** A Mermaid `flowchart LR` of keys and rules. */
  mermaid(): string
}

const producersByKey = <E, R>(
  imports: ReadonlyArray<string>,
  rules: ReadonlyArray<Rule<E, R>>
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const producers = new Map<string, Array<string>>()
  for (const key of imports) producers.set(key, ["(import)"])
  for (const rule of rules) {
    for (const key of rule.produces) {
      producers.set(key, [...(producers.get(key) ?? []), rule.name])
    }
  }
  return producers
}

/** Rules whose products can reach an export, following reads backwards from the exports. */
const reachable = <E, R>(
  exports: ReadonlyArray<string>,
  rules: ReadonlyArray<Rule<E, R>>
): ReadonlySet<string> => {
  const needed = new Set(exports)
  const kept = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const rule of rules) {
      if (kept.has(rule.name) || !rule.produces.some((key) => needed.has(key))) continue
      kept.add(rule.name)
      for (const key of rule.reads) needed.add(key)
      grew = true
    }
  }
  return kept
}

export const makeRuleset = <E, R>(
  options: RulesetOptions<E, R>
): Effect.Effect<Ruleset<E, R>, RulesetInvalid> => {
  const imports = options.imports.map((key) => key.name)
  const exports = options.exports.map((key) => key.name)
  const problems: Array<Problem> = []
  const seen = new Set<string>()
  for (const rule of options.rules) {
    if (seen.has(rule.name)) problems.push({ kind: "DuplicateRuleName", rule: rule.name })
    seen.add(rule.name)
    if (rule.reads.length === 0) problems.push({ kind: "EmptyCondition", rule: rule.name })
    for (const key of rule.reads) {
      if (rule.produces.includes(key)) problems.push({ kind: "SelfMatch", rule: rule.name, key })
    }
  }
  const producers = producersByKey(imports, options.rules)
  for (const [key, names] of producers) {
    if (names.length > 1) problems.push({ kind: "ManyProducers", key, rules: names })
  }
  for (const rule of options.rules) {
    for (const key of rule.reads) {
      if (!producers.has(key)) problems.push({ kind: "UnproducedMatch", rule: rule.name, key })
    }
  }
  for (const key of exports) {
    if (!producers.has(key)) problems.push({ kind: "UnproducedExport", key })
  }
  if (problems.length > 0) {
    return Effect.fail(RulesetInvalid.make({ name: options.name, problems }))
  }
  const warnings: Array<Problem> = []
  const read = new Set(options.rules.flatMap((rule) => rule.reads))
  for (const key of imports) {
    if (!read.has(key)) warnings.push({ kind: "UnusedImport", key })
  }
  const kept = reachable(exports, options.rules)
  for (const rule of options.rules) {
    if (!kept.has(rule.name)) warnings.push({ kind: "Unreachable", rule: rule.name })
  }
  const rules = options.rules.filter((rule) => kept.has(rule.name))
  return Effect.succeed({
    name: options.name,
    imports,
    exports,
    rules,
    warnings,
    describe: () =>
      [
        `ruleset ${options.name}`,
        `imports: ${imports.join(", ")}`,
        `exports: ${exports.join(", ")}`,
        ...rules.map(
          (rule) => `${rule.name}: ${rule.reads.join(", ")} -> ${rule.produces.join(", ")}`
        ),
        ...warnings.map((warning) => `warning: ${renderProblem(warning)}`)
      ].join("\n"),
    mermaid: () => renderMermaid(options.name, rules)
  })
}

const escapeLabel = (label: string): string => label.replaceAll('"', "'")

const renderMermaid = <E, R>(name: string, rules: ReadonlyArray<Rule<E, R>>): string => {
  const keys = [...new Set(rules.flatMap((rule) => [...rule.reads, ...rule.produces]))]
  const keyId = new Map(keys.map((key, index) => [key, `k${index}`]))
  const ruleId = new Map(rules.map((rule, index) => [rule.name, `r${index}`]))
  const nodes = [
    ...keys.map((key) => `  ${keyId.get(key)}(["${escapeLabel(key)}"])`),
    ...rules.map((rule) => `  ${ruleId.get(rule.name)}["${escapeLabel(rule.name)}"]`)
  ]
  const edges = rules.flatMap((rule) => [
    ...rule.reads.map((key) => `  ${keyId.get(key)} --> ${ruleId.get(rule.name)}`),
    ...rule.produces.map((key) => `  ${ruleId.get(rule.name)} --> ${keyId.get(key)}`)
  ])
  return [`flowchart LR`, `  %% ${escapeLabel(name)}`, ...nodes, ...edges].join("\n")
}
```

- [ ] **Step 4: Add the export and run the tests**

In `packages/core/package.json` `exports`, after `"./blackboard/Rule"`, add:

```json
    "./blackboard/Ruleset": "./dist/blackboard/Ruleset.js",
```

Run: `pnpm vitest run packages/core/test/BlackboardRuleset.test.ts`
Expected: PASS (6 tests). If the `kinds` ordering in the second test differs from what the implementation emits, keep the implementation's natural order but keep the _multiset_ of kinds the same — the assertion sorts.

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`

```bash
git add packages/core/src/blackboard/Ruleset.ts packages/core/test/BlackboardRuleset.test.ts packages/core/package.json
git commit -m "blackboard: ruleset validation, pruning and description

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Running to quiescence

**Files:**

- Create: `packages/core/src/blackboard/Run.ts`
- Test: `packages/core/test/BlackboardRun.test.ts`

**Interfaces:**

- Consumes: `Board`, `DuplicateFact`, `Fact`, `writeOnce` (Task 1); `Rule`, `Posted`, `Facts` (Task 2); `Ruleset` (Task 3).
- Produces:
  - `class Firing` (Schema.Class) `{ rule, kind: RuleKind literal union, readKeys: Array<String>, postedKeys: Array<String>, startedAt: Number, duration: Number, judgment: optionalKey(Struct{backend, identity}) }`
  - `class RuleFailure` (Schema.Class) `{ rule: String, error: Schema.Defect() }`
  - `class RunResult` (Schema.Class) `{ board: Board, trace: Array<Firing>, failures: Array<RuleFailure> }`
  - `class UndeclaredFact` TaggedError `{ rule, key }`
  - `class MissingImport` TaggedError `{ keys: Array<String> }`
  - `class WaitingRule` (Schema.Class) `{ rule, missingKeys: Array<String> }`
  - `class ExportsMissing` TaggedError `{ missing: Array<Struct{ key, waitingRules: Array<WaitingRule> }> }`
  - `RunError = Schema.Union([DuplicateFact, UndeclaredFact, MissingImport, ExportsMissing])`, `type RunError`
  - `runRuleset<E, R>(ruleset: Ruleset<E, R>, initial: ReadonlyArray<Fact>): Effect.Effect<RunResult, RunError, R>`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/BlackboardRun.test.ts
import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
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
      const first = result.trace[0]!
      assert.deepStrictEqual(first.readKeys, ["diff"])
      assert.deepStrictEqual(first.postedKeys, ["size"])
      assert.strictEqual(first.kind, "derive")
      assert.isAtLeast(first.duration, 0)
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
      const result = yield* runRuleset(ruleset, [diff.of("x")]).pipe(Effect.timeout("2 seconds"))
      assert.strictEqual(yield* result.board.get(sum), 3)
      assert.deepStrictEqual(result.trace.map((f) => f.rule).sort(), ["left", "right", "sum"])
    })
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/test/BlackboardRun.test.ts`
Expected: FAIL — cannot resolve `@llm4ts/core/blackboard/Run`.

- [ ] **Step 3: Implement `Run.ts`**

```ts
// packages/core/src/blackboard/Run.ts
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { Board, DuplicateFact, writeOnce, type Fact } from "./Fact.ts"
import type { Facts, Posted, Rule } from "./Rule.ts"
import type { Ruleset } from "./Ruleset.ts"

/**
 * Forward chaining in rounds. A round fires, concurrently, every rule whose
 * condition is satisfied by the current snapshot; the facts they post are
 * then applied one by one, write-once. The run ends when a round fires
 * nothing, and it succeeds only if every export is on the board. A rule's
 * failure is recorded and its defaults posted; a defect fails the run.
 */

const JudgmentNote = Schema.Struct({ backend: Schema.String, identity: Schema.String })

export class Firing extends Schema.Class<Firing>("Firing")({
  rule: Schema.String,
  kind: Schema.Literals(["derive", "judge", "rule"]),
  readKeys: Schema.Array(Schema.String),
  postedKeys: Schema.Array(Schema.String),
  /** Epoch milliseconds. */
  startedAt: Schema.Number,
  /** Milliseconds. */
  duration: Schema.Number,
  judgment: Schema.optionalKey(JudgmentNote)
}) {}

export class RuleFailure extends Schema.Class<RuleFailure>("RuleFailure")({
  rule: Schema.String,
  error: Schema.Defect()
}) {}

export class RunResult extends Schema.Class<RunResult>("RunResult")({
  board: Board,
  trace: Schema.Array(Firing),
  failures: Schema.Array(RuleFailure)
}) {}

export class UndeclaredFact extends Schema.TaggedError<UndeclaredFact>()("UndeclaredFact", {
  rule: Schema.String,
  key: Schema.String
}) {
  get message(): string {
    return `rule ${this.rule} posted "${this.key}", which it does not declare`
  }
}

export class MissingImport extends Schema.TaggedError<MissingImport>()("MissingImport", {
  keys: Schema.Array(Schema.String)
}) {
  get message(): string {
    return `initial facts miss the imports: ${this.keys.join(", ")}`
  }
}

export class WaitingRule extends Schema.Class<WaitingRule>("WaitingRule")({
  rule: Schema.String,
  missingKeys: Schema.Array(Schema.String)
}) {}

export class ExportsMissing extends Schema.TaggedError<ExportsMissing>()("ExportsMissing", {
  missing: Schema.Array(
    Schema.Struct({ key: Schema.String, waitingRules: Schema.Array(WaitingRule) })
  )
}) {
  get message(): string {
    return `the run ended without: ${this.missing
      .map(
        (entry) =>
          `"${entry.key}" (${entry.waitingRules
            .map((waiting) => `${waiting.rule} waits for ${waiting.missingKeys.join(", ")}`)
            .join("; ")})`
      )
      .join(", ")}`
  }
}

export const RunError = Schema.Union([DuplicateFact, UndeclaredFact, MissingImport, ExportsMissing])
export type RunError = typeof RunError.Type

interface Outcome<E> {
  readonly rule: Rule<E, never>
  readonly startedAt: number
  readonly duration: number
  readonly result: Result.Result<Posted, E>
}

const post = (
  facts: Facts,
  rule: string,
  allowed: ReadonlyArray<string>,
  posted: ReadonlyArray<Fact>
): Effect.Effect<[Facts, ReadonlyArray<string>], DuplicateFact | UndeclaredFact> =>
  Effect.gen(function* () {
    let current = facts
    const keys: Array<string> = []
    for (const fact of posted) {
      if (!allowed.includes(fact.key)) {
        return yield* Effect.fail(UndeclaredFact.make({ rule, key: fact.key }))
      }
      const written = writeOnce(current, fact.key, yield* fact.encoded)
      if (Result.isFailure(written)) return yield* Effect.fail(written.failure)
      current = written.success
      if (!keys.includes(fact.key)) keys.push(fact.key)
    }
    return [current, keys]
  })

const fireAll = <E, R>(
  ready: ReadonlyArray<{ readonly rule: Rule<E, R>; readonly firing: Effect.Effect<Posted, E, R> }>
): Effect.Effect<ReadonlyArray<Outcome<E>>, never, R> =>
  Effect.forEach(
    ready,
    ({ rule, firing }) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const result = yield* Effect.result(firing)
        const finishedAt = yield* Clock.currentTimeMillis
        // The rule's R was provided by this firing; only its name and declarations are kept.
        const declared: Rule<E, never> = { ...rule, prepare: () => Effect.succeed(Option.none()) }
        return { rule: declared, startedAt, duration: finishedAt - startedAt, result }
      }),
    { concurrency: "unbounded" }
  )

export const runRuleset = <E, R>(
  ruleset: Ruleset<E, R>,
  initial: ReadonlyArray<Fact>
): Effect.Effect<RunResult, RunError, R> =>
  Effect.gen(function* () {
    const initialKeys = initial.map((fact) => fact.key)
    const missingImports = ruleset.imports.filter((key) => !initialKeys.includes(key))
    if (missingImports.length > 0) {
      return yield* Effect.fail(MissingImport.make({ keys: missingImports }))
    }
    let [facts] = yield* post(new Map(), "(initial)", ruleset.imports, initial)
    const pending = new Map(ruleset.rules.map((rule) => [rule.name, rule]))
    const trace: Array<Firing> = []
    const failures: Array<RuleFailure> = []
    for (;;) {
      const ready: Array<{ rule: Rule<E, R>; firing: Effect.Effect<Posted, E, R> }> = []
      for (const rule of pending.values()) {
        if (!rule.reads.every((key) => facts.has(key))) continue
        const prepared = yield* rule.prepare(facts)
        // Every read is present and facts never change, so a None now is a No forever.
        pending.delete(rule.name)
        if (Option.isSome(prepared)) ready.push({ rule, firing: prepared.value })
      }
      if (ready.length === 0) break
      const outcomes = yield* fireAll(ready)
      for (const outcome of outcomes) {
        if (Result.isFailure(outcome.result)) {
          failures.push(
            RuleFailure.make({ rule: outcome.rule.name, error: outcome.result.failure })
          )
          ;[facts] = yield* post(
            facts,
            outcome.rule.name,
            outcome.rule.produces,
            outcome.rule.defaults
          )
          continue
        }
        const posted = outcome.result.success
        const [next, postedKeys] = yield* post(
          facts,
          outcome.rule.name,
          outcome.rule.produces,
          posted.facts
        )
        facts = next
        trace.push(
          Firing.make({
            rule: outcome.rule.name,
            kind: outcome.rule.kind,
            readKeys: outcome.rule.reads,
            postedKeys,
            startedAt: outcome.startedAt,
            duration: outcome.duration,
            ...(posted.judgment === undefined ? {} : { judgment: posted.judgment })
          })
        )
      }
    }
    const missing = ruleset.exports.filter((key) => !facts.has(key))
    if (missing.length > 0) {
      return yield* Effect.fail(
        ExportsMissing.make({
          missing: missing.map((key) => ({
            key,
            waitingRules: [...pending.values()]
              .filter((rule) => rule.produces.includes(key))
              .map((rule) =>
                WaitingRule.make({
                  rule: rule.name,
                  missingKeys: rule.reads.filter((read) => !facts.has(read))
                })
              )
          }))
        })
      )
    }
    return RunResult.make({
      board: Board.make({ facts: Object.fromEntries(facts) }),
      trace,
      failures
    })
  })
```

Implementation notes:

- `Effect.result` (Effect 4) turns the typed failure into a `Result` while defects keep propagating, which is what "a defect fails the run" needs. A predicate that throws inside `when` becomes a defect in `evaluate`; nothing catches it.
- Rounds give the concurrency the spec asks for: independent rules satisfied by the same snapshot fire together. The concurrency test proves it with two rules that each wait for the other.
- `Board.make({ facts: Object.fromEntries(facts) })`: `Object.fromEntries` on a `Map<string, Json>` yields `{ [k: string]: Json }`, which matches the schema's `Type` without an assertion.
- If `Effect.timeout("2 seconds")` in the concurrency test needs a `Duration` rather than a string in this Effect version, use `Duration.seconds(2)` from `effect/Duration`.

- [ ] **Step 4: Add the export and run the tests**

In `packages/core/package.json` `exports`, after `"./blackboard/Ruleset"`, add:

```json
    "./blackboard/Run": "./dist/blackboard/Run.js",
```

Run: `pnpm vitest run packages/core/test/BlackboardRun.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`

```bash
git add packages/core/src/blackboard/Run.ts packages/core/test/BlackboardRun.test.ts packages/core/package.json
git commit -m "blackboard: run a ruleset to quiescence with a trace and typed errors

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The `judge` rule

**Files:**

- Modify: `packages/core/src/blackboard/Rule.ts` (append)
- Test: `packages/core/test/BlackboardJudge.test.ts`

**Interfaces:**

- Consumes: `Judgment`, `JudgmentInput`, `JudgmentBackendError` from `@llm4ts/core/judgment/Judgment`; `JudgmentResult` from `@llm4ts/core/judgment/Schemas`; `makeRule` (Task 2); `FakeJudgmentLive`, `makeFakeJudgment` from `@llm4ts/core/judgment/FakeJudgment` (tests).
- Produces:
  - `interface JudgeOptions<A> { name; condition: Condition<A>; produces; ask: (value: A) => JudgmentInput; post: (result: JudgmentResult, value: A) => ReadonlyArray<Fact>; defaults?: ReadonlyArray<Fact> }`
  - `judge<A>(options: JudgeOptions<A>): Rule<JudgmentBackendError, Judgment>`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/test/BlackboardJudge.test.ts
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { makeKey } from "@llm4ts/core/blackboard/Fact"
import { derive, judge, on } from "@llm4ts/core/blackboard/Rule"
import { makeRuleset } from "@llm4ts/core/blackboard/Ruleset"
import { runRuleset } from "@llm4ts/core/blackboard/Run"
import { FakeJudgmentLive, makeFakeJudgment } from "@llm4ts/core/judgment/FakeJudgment"
import { Judgment, JudgmentBackendError } from "@llm4ts/core/judgment/Judgment"
import { truth, TruthAnswer, truthAnswer, origins } from "@llm4ts/core/judgment/Schemas"

const summary = makeKey("review.summary", Schema.String)
const blocking = makeKey("review.blocking", TruthAnswer)
const landable = makeKey("story.landable", Schema.Boolean)

const blockingRule = judge({
  name: "blocking",
  condition: on(summary),
  produces: [blocking],
  ask: (text) => ({
    state: text,
    questions: { blocking: truth("The review reports a blocking defect.") }
  }),
  post: (result) => {
    const answer = result.answers.blocking
    return answer?.type === "truth" ? [blocking.of(answer)] : []
  }
})

const landing = derive({
  name: "landing",
  condition: on(blocking),
  produces: [landable],
  derive: (answer) => [landable.of(answer.truth < 0.5)]
})

describe("judge rules", () => {
  it.effect(
    "asks the Judgment service and posts the typed answer with its origin; the trace names the backend",
    () =>
      Effect.gen(function* () {
        const ruleset = yield* makeRuleset({
          name: "landing",
          imports: [summary],
          exports: [landable],
          rules: [blockingRule, landing]
        })
        const result = yield* runRuleset(ruleset, [summary.of("Two nits, nothing blocking.")])
        const answer = yield* result.board.get(blocking)
        assert.strictEqual(answer.truth, 0.1)
        assert.strictEqual(answer.origin.backend, "fake")
        assert.isTrue(yield* result.board.get(landable))
        const firing = result.trace.find((f) => f.rule === "blocking")
        assert.strictEqual(firing?.kind, "judge")
        assert.deepStrictEqual(firing?.judgment, { backend: "fake", identity: "fake" })
      }).pipe(
        Effect.provide(
          FakeJudgmentLive({ answers: { blocking: truthAnswer(0.1, origins.fake()) } })
        )
      )
  )

  it.effect("a question the backend could not answer still reaches post, as a failure", () =>
    Effect.gen(function* () {
      const cautious = judge({
        name: "blocking",
        condition: on(summary),
        produces: [landable],
        ask: (text) => ({ state: text, questions: { blocking: truth("blocking?") } }),
        post: (result) => [landable.of(result.failures.length === 0)]
      })
      const ruleset = yield* makeRuleset({
        name: "l",
        imports: [summary],
        exports: [landable],
        rules: [cautious]
      })
      const result = yield* runRuleset(ruleset, [summary.of("x")])
      assert.isFalse(yield* result.board.get(landable))
      assert.deepStrictEqual(result.trace[0]?.judgment, { backend: "fake", identity: "fake" })
    }).pipe(Effect.provide(FakeJudgmentLive({ failures: { blocking: "no logprobs" } })))
  )

  it.effect("an unreachable backend is a RuleFailure and the defaults are posted", () =>
    Effect.gen(function* () {
      const down = Layer.succeed(Judgment, {
        backend: "llm",
        identity: "llm:down",
        judge: () =>
          Effect.fail(JudgmentBackendError.make({ backend: "llm", message: "connection refused" }))
      })
      const guarded = judge({
        name: "blocking",
        condition: on(summary),
        produces: [landable],
        defaults: [landable.of(false)],
        ask: (text) => ({ state: text, questions: { blocking: truth("blocking?") } }),
        post: () => [landable.of(true)]
      })
      const ruleset = yield* makeRuleset({
        name: "l",
        imports: [summary],
        exports: [landable],
        rules: [guarded]
      })
      const result = yield* runRuleset(ruleset, [summary.of("x")]).pipe(Effect.provide(down))
      assert.isFalse(yield* result.board.get(landable))
      assert.strictEqual(result.failures[0]?.rule, "blocking")
      assert.instanceOf(result.failures[0]?.error, JudgmentBackendError)
    })
  )

  it.effect("the state and questions reach the backend exactly as asked", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeJudgment()
      const ruleset = yield* makeRuleset({
        name: "landing",
        imports: [summary],
        exports: [landable],
        rules: [blockingRule, landing]
      })
      yield* runRuleset(ruleset, [summary.of("text")]).pipe(
        Effect.provide(Layer.succeed(Judgment, fake.judgment))
      )
      const recorded = yield* fake.recorded
      assert.strictEqual(recorded.length, 1)
      assert.strictEqual(recorded[0]?.state, "text")
      assert.deepStrictEqual(Object.keys(recorded[0]?.questions ?? {}), ["blocking"])
    })
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/test/BlackboardJudge.test.ts`
Expected: FAIL — `judge` is not exported from `@llm4ts/core/blackboard/Rule`.

- [ ] **Step 3: Append `judge` to `Rule.ts`**

Add these imports at the top of `packages/core/src/blackboard/Rule.ts`:

```ts
import { Judgment, type JudgmentBackendError, type JudgmentInput } from "../judgment/Judgment.ts"
import type { JudgmentResult } from "../judgment/Schemas.ts"
```

Append at the end of the file:

```ts
export interface JudgeOptions<A> {
  readonly name: string
  readonly condition: Condition<A>
  readonly produces: ReadonlyArray<FactKey<unknown>>
  /** The State and Questions for this firing; `state` is data, never instructions. */
  readonly ask: (value: A) => JudgmentInput
  /**
   * Facts from the typed result. Post the `Answer` itself (probability,
   * support, origin), not a boolean read off it: deciding is another rule's
   * job. Unanswered questions arrive in `result.failures`.
   */
  readonly post: (result: JudgmentResult, value: A) => ReadonlyArray<Fact>
  /** Posted when the backend itself is unreachable or rejects the request. */
  readonly defaults?: ReadonlyArray<Fact>
}

/** A rule that asks the Judgment service; its firing notes the backend and checkpoint for the trace. */
export const judge = <A>(options: JudgeOptions<A>): Rule<JudgmentBackendError, Judgment> =>
  makeRule({ ...options, kind: "judge" }, (value) =>
    Effect.gen(function* () {
      const judgment = yield* Judgment
      const result = yield* judgment.judge(options.ask(value))
      return {
        facts: options.post(result, value),
        judgment: { backend: judgment.backend, identity: judgment.identity }
      }
    })
  )
```

`Judgment` is a `Context.Service` class; `yield* Judgment` resolves the service the same way `packages/flow/src/Judgment.ts` and the eval code do (check an existing `yield* Judgment` or `Effect.service(Judgment)` usage in `packages/` and match it).

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/core/test/BlackboardJudge.test.ts packages/core/test/BlackboardRule.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`

```bash
git add packages/core/src/blackboard/Rule.ts packages/core/test/BlackboardJudge.test.ts
git commit -m "blackboard: the judge rule posts typed answers as facts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Property-style test over generated rulesets

**Files:**

- Test: `packages/core/test/BlackboardProperty.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 1–4.

- [ ] **Step 1: Write the test**

```ts
// packages/core/test/BlackboardProperty.test.ts
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
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

/**
 * Layered, acyclic: layer 0 is the imports; each rule in layer n reads one
 * to three keys from layers < n and produces one new key. Exports are the
 * keys of the last layer. A third of the seeds get one deliberate defect.
 */
const generate = (seed: number): Generated => {
  const next = random(seed)
  const pick = (n: number): number => Math.floor(next() * n)
  const layers: Array<Array<FactKey<number>>> = [[]]
  const importCount = 1 + pick(3)
  for (let i = 0; i < importCount; i++) layers[0]!.push(makeKey(`in${i}`, Schema.Number))
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
        ...new Set(Array.from({ length: readCount }, () => below[pick(below.length)]!))
      ]
      rules.push(
        derive({
          name: `r-l${layer}k${i}`,
          condition: all(...reads),
          produces: [produced],
          derive: (values) => [produced.of(values.reduce((a, b) => a + b, 0) + 1)]
        })
      )
      current.push(produced)
    }
    layers.push(current)
  }
  const exports = layers[layers.length - 1]!
  const brokenKind = pick(3)
  if (brokenKind === 1) {
    const ghost = makeKey("ghost", Schema.Number)
    const target = exports[0]!
    rules.push(
      derive({ name: "ghost-reader", condition: all(ghost), produces: [target], derive: () => [] })
    )
    return { imports: layers[0]!, exports, rules, broken: "ManyProducers" }
  }
  if (brokenKind === 2) {
    const ghost = makeKey("ghost", Schema.Number)
    const extra = makeKey("extra", Schema.Number)
    rules.push(
      derive({ name: "ghost-reader", condition: all(ghost), produces: [extra], derive: () => [] })
    )
    return { imports: layers[0]!, exports: [...exports, extra], rules, broken: "UnproducedMatch" }
  }
  return { imports: layers[0]!, exports, rules, broken: "none" }
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
          assert.isTrue(made._tag === "Failure", "a planted defect must be refused")
          if (made._tag === "Failure") {
            assert.instanceOf(made.failure, RulesetInvalid)
            assert.include(
              made.failure.problems.map((p) => p.kind),
              generated.broken
            )
          }
          return
        }
        assert.isTrue(made._tag === "Success")
        if (made._tag !== "Success") return
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
```

Note: the "ManyProducers" plant also reads `ghost`, which is unproduced, so `UnproducedMatch` is reported too; the assertion checks inclusion, not equality. `Result` values are checked through `_tag` here to avoid importing `effect/Result`; use `Result.isSuccess`/`isFailure` if `_tag` is not a public discriminant in this Effect version.

- [ ] **Step 2: Run the test**

Run: `pnpm vitest run packages/core/test/BlackboardProperty.test.ts`
Expected: PASS (60 tests). If a seed fails, it has found a real engine bug: fix it in `Ruleset.ts`/`Run.ts`, do not change the generator to avoid it.

- [ ] **Step 3: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`

```bash
git add packages/core/test/BlackboardProperty.test.ts
git commit -m "blackboard: property-style test over generated rulesets

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Published surface: build, pack smoke, full verification

**Files:**

- Modify: `scripts/pack-smoke.mjs:68-95` (imports and assertions block)

**Interfaces:**

- Consumes: the four `@llm4ts/core/blackboard/*` exports.

- [ ] **Step 1: Extend the pack smoke**

After the line `import { makeFakeJudgment } from "@llm4ts/core/judgment/FakeJudgment"` in the template inside `scripts/pack-smoke.mjs`, add:

```js
import { makeKey } from "@llm4ts/core/blackboard/Fact"
import { derive, on } from "@llm4ts/core/blackboard/Rule"
import { makeRuleset } from "@llm4ts/core/blackboard/Ruleset"
import { runRuleset } from "@llm4ts/core/blackboard/Run"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
```

Check first whether `Effect`/`Schema` are already imported in that template; if so, do not import them twice. After `assert.equal(truth("s").type, "truth")`, add:

```js
const size = makeKey("size", Schema.Number)
const big = makeKey("big", Schema.Boolean)
const bigRule = derive({
  name: "big",
  condition: on(size),
  produces: [big],
  derive: (n) => [big.of(n > 1)]
})
const ruleset = await Effect.runPromise(
  makeRuleset({ name: "smoke", imports: [size], exports: [big], rules: [bigRule] })
)
const run = await Effect.runPromise(runRuleset(ruleset, [size.of(2)]))
assert.equal(run.board.facts.big, true)
assert.equal(run.trace.length, 1)
```

- [ ] **Step 2: Build and run the smoke**

Run: `pnpm build && node scripts/pack-smoke.mjs`
Expected: the existing three `pack smoke:` lines, no assertion error.

- [ ] **Step 3: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: all green; the test count grows by 5 + 5 + 6 + 9 + 4 + 60 = 89 over the current 1191.

- [ ] **Step 4: Commit**

```bash
git add scripts/pack-smoke.mjs
git commit -m "pack smoke: build and run a blackboard ruleset from the published packages

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: ADR, vocabulary and changelog

**Files:**

- Create: `docs/adr/0020-typed-blackboard.md`
- Modify: `CONTEXT.md` (add a `### Blackboard` section after `### Judgment`'s terms, before `### Existing evaluation terms`)
- Modify: `CHANGELOG.md` (new top entry)
- Modify: `docs/superpowers/specs/2026-09-27-blackboard-design.md` (the "ADR 0020" bullet under "Interaction with existing seams")

- [ ] **Step 1: Write the ADR**

```markdown
# ADR 0020: A Typed Blackboard For Company Rules And Judgments

Status: Accepted · Date: 2026-09-27

## Context

A company running llm4ts wants to own the policy behind a decision the
engine makes (a story can land, an operation is read-only, a design draft
is accepted). The policy mixes deterministic rules with questions only a
model can answer. Today each flow hard-wires both: it asks the model, parses
or judges, and branches in code a company cannot edit.

The `Judgment` service (ADR 0017) already separates asking from deciding:
typed questions over one State, typed answers with probabilities and
origin, thresholds kept in flow. What is missing is the place where a
company's rules and those answers meet.

The owned `zio-blackboard` engine (Scala/ZIO) is the model: typed facts
posted to a board, rules whose conditions match facts and whose
consequences post more, a run that ends when nothing more fires, and a
ruleset validated statically (every match produced, one producer per fact,
every export produced). Design spec:
`docs/superpowers/specs/2026-09-27-blackboard-design.md`.

## Decision

1. **A standalone primitive in core**: `@llm4ts/core/blackboard/{Fact,
Rule, Ruleset, Run}`. Flows and kits consume it; runner and shell know
   nothing of it. No consumer is wired in by this ADR.
2. **Rules are TypeScript values**, built with `on`/`all`/`when` and
   `derive`/`rule`/`judge`. There is no expression language, no external
   JSON rule model and no interpreter. Facts and the board are
   schema-encodable, so a declarative rule layer can be added later on the
   same engine.
3. **Forward chaining in rounds.** Every rule satisfied by the current
   board fires, concurrently; posted facts are applied write-once; the run
   ends at quiescence and succeeds only when every export is present.
   Rules that cannot reach an export are pruned at build time with a
   warning, and companies gate expensive rules behind cheap facts.
4. **Core never decides.** `judge` posts the `Answer` (probability,
   support, origin) as a fact. Turning it into `act | caution | hold` is a
   flow-level rule over `JudgmentPolicy`.
5. **Facts are write-once per run.** An equal rewrite is a no-op; a
   different one is `DuplicateFact`. Superseding is a new run.
6. **Producers are declared, never inferred**: every rule lists the keys
   it may post; posting another is `UndeclaredFact`.

## Consequences

- A decision policy becomes a value a company can read (`describe()`,
  `mermaid()`), test with `FakeJudgment`, and run many times. A stalled
  policy fails with `ExportsMissing`, naming the waiting rules and the keys
  they lack.
- Divergence from the spec text: keys are validated by name, so the spec's
  `DuplicateKeyName` problem is not raised; a same-named key with another
  schema is a decode defect at run time. `DuplicateRuleName` is validated
  instead, because two rules with one name break the trace.
- Not in this ADR: retraction and superseding, a declarative rule
  language, persisting rulesets, a UI, a first consumer flow, and the
  coordination of modernization work through a board (a possible consumer
  the earlier draft of this ADR proposed; it stays future work).

Superseded drafts: an earlier, uncommitted proposal titled "Modernization
work coordinated through a typed blackboard" (2026-09-26).
```

- [ ] **Step 2: Add the vocabulary to `CONTEXT.md`**

Insert before `### Existing evaluation terms (kept distinct from Judgment)`:

```markdown
### Blackboard

**Blackboard**:
A run-time on which typed Facts are posted and Rules fire when the facts
they match are present, until nothing more fires. The engine decides; a
model only contributes facts through a judge Rule.
_Avoid_: rule engine, workflow, agent memory, chat history

**Fact**:
One named, schema-typed value on a Blackboard, written once per run. Held
in its encoded JSON form; read through its key's schema.
_Avoid_: variable, slot, message

**Rule**:
A condition over Facts and a consequence that posts Facts. Kinds: `derive`
(pure), `judge` (asks the Judgment service and posts the Answer), `rule`
(any effect). It declares what it produces.
_Avoid_: step, task, node, handler

**Ruleset**:
Named imports, exports and Rules, validated when built: every read
produced, one producer per key, every export produced; unreachable Rules
pruned. A value that runs many times.
_Avoid_: pipeline, flow, module
```

- [ ] **Step 3: Add the changelog entry**

At the top of `CHANGELOG.md`, below `# Changelog`, add:

```markdown
## Unreleased

- New primitive `@llm4ts/core/blackboard/*` (ADR 0020): a typed blackboard
  where company-written rules and `Judgment`-backed rules post facts until
  a decision is produced. `makeKey`, `on`/`all`/`when`, `derive`/`rule`/
  `judge`, `makeRuleset` (validated when built, unreachable rules pruned),
  `runRuleset` (forward chaining to quiescence, a firing trace, typed
  errors that name the waiting rules). No flow uses it yet.
```

- [ ] **Step 4: Fix the spec's stale bullet**

In `docs/superpowers/specs/2026-09-27-blackboard-design.md`, replace the bullet beginning `- ADR 0020 (proposed by Codex, uncommitted)` with:

```markdown
- ADR 0020 (`docs/adr/0020-typed-blackboard.md`) records the decisions in
  this spec. Coordinating modernization work through a board, the framing
  of an earlier uncommitted draft, is one possible consumer and stays
  future work.
```

- [ ] **Step 5: Format, verify and commit**

Run: `pnpm format && pnpm format:check && pnpm typecheck && pnpm lint && pnpm test`

```bash
git add docs/adr/0020-typed-blackboard.md CONTEXT.md CHANGELOG.md docs/superpowers/specs/2026-09-27-blackboard-design.md
git commit -m "docs: ADR 0020 typed blackboard, vocabulary and changelog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: Facts (T1), conditions and constructors (T2, T5), validation table (T3; `DuplicateKeyName` replaced by `DuplicateRuleName`, recorded in the ADR), pruning and `describe` (T3), running, trace, `ExportsMissing` with waiting rules, rule failures with defaults, defects (T4), judge with `FakeJudgment` (T5), property-style test (T6), package exports and pack smoke (T7), ADR/vocabulary/changelog (T8). `ruleset.run(...)` from the spec is `runRuleset(ruleset, ...)` here to avoid an import cycle between `Ruleset.ts` and `Run.ts`.
- Names used consistently across tasks: `makeKey`, `FactKey<A>`, `Fact`, `Board`, `writeOnce`, `sameJson`, `Facts`, `Condition<A>`, `on`, `all`, `when`, `Rule<E, R>`, `Posted`, `makeRule`, `rule`, `derive`, `judge`, `Problem`, `isWarning`, `RulesetInvalid`, `makeRuleset`, `Ruleset<E, R>`, `Firing`, `RuleFailure`, `RunResult`, `UndeclaredFact`, `MissingImport`, `WaitingRule`, `ExportsMissing`, `RunError`, `runRuleset`.
- Review Focus items 1–5 are pinned in T4 (equal double post; throwing predicate), T3 (import that is also produced; side-effect-only rule pruned), T5 (partial answers still reach `post`).
