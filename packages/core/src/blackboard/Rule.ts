import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type { Fact, FactKey } from "./Fact.ts"

/**
 * Rules of a blackboard (ADR 0020). A condition names the keys it reads
 * (what validation and pruning reason on) and evaluates to the typed value
 * a consequence receives; a rule pairs a condition with a consequence that
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

/**
 * Satisfied once every key is present; the value is the tuple of decoded
 * values, in order. Typed by overload up to eight keys: one implementation
 * over a loose tuple, so no assertion is needed to give each call its shape.
 */
export function all<A>(k1: FactKey<A>): Condition<readonly [A]>
export function all<A, B>(k1: FactKey<A>, k2: FactKey<B>): Condition<readonly [A, B]>
export function all<A, B, C>(
  k1: FactKey<A>,
  k2: FactKey<B>,
  k3: FactKey<C>
): Condition<readonly [A, B, C]>
export function all<A, B, C, D>(
  k1: FactKey<A>,
  k2: FactKey<B>,
  k3: FactKey<C>,
  k4: FactKey<D>
): Condition<readonly [A, B, C, D]>
export function all<A, B, C, D, E>(
  k1: FactKey<A>,
  k2: FactKey<B>,
  k3: FactKey<C>,
  k4: FactKey<D>,
  k5: FactKey<E>
): Condition<readonly [A, B, C, D, E]>
export function all<A, B, C, D, E, F>(
  k1: FactKey<A>,
  k2: FactKey<B>,
  k3: FactKey<C>,
  k4: FactKey<D>,
  k5: FactKey<E>,
  k6: FactKey<F>
): Condition<readonly [A, B, C, D, E, F]>
export function all<A, B, C, D, E, F, G>(
  k1: FactKey<A>,
  k2: FactKey<B>,
  k3: FactKey<C>,
  k4: FactKey<D>,
  k5: FactKey<E>,
  k6: FactKey<F>,
  k7: FactKey<G>
): Condition<readonly [A, B, C, D, E, F, G]>
export function all<A, B, C, D, E, F, G, H>(
  k1: FactKey<A>,
  k2: FactKey<B>,
  k3: FactKey<C>,
  k4: FactKey<D>,
  k5: FactKey<E>,
  k6: FactKey<F>,
  k7: FactKey<G>,
  k8: FactKey<H>
): Condition<readonly [A, B, C, D, E, F, G, H]>
export function all(...keys: ReadonlyArray<FactKey<unknown>>): Condition<ReadonlyArray<unknown>> {
  return {
    keys: keys.map((key) => key.name),
    evaluate: (facts) =>
      keys.every((key) => facts.has(key.name))
        ? Effect.map(
            Effect.forEach(keys, (key) => key.read(facts.get(key.name))),
            (values) => Option.some(values)
          )
        : Effect.succeed(Option.none())
  }
}

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
