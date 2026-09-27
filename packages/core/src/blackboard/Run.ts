import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { Board, DuplicateFact, writeOnce, type Fact } from "./Fact.ts"
import type { Facts, Posted, Rule } from "./Rule.ts"
import type { Ruleset } from "./Ruleset.ts"

/**
 * Forward chaining in rounds (ADR 0020). A round fires, concurrently, every
 * rule whose condition is satisfied by the current snapshot; the facts they
 * post are then applied one by one, write-once. The run ends when a round
 * fires nothing, and it succeeds only if every export is on the board. A
 * rule's failure is recorded and its defaults posted; a defect fails the run.
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
  /** `failed`: the consequence failed and `postedKeys` are the rule's defaults. */
  outcome: Schema.Literals(["posted", "failed"]),
  judgment: Schema.optionalKey(JudgmentNote)
}) {}

/**
 * A rule's typed failure. `error` is the value itself while the result is in
 * memory; `tag` and `message` are what survive encoding, since `Defect`
 * encodes any error as a plain one.
 */
export class RuleFailure extends Schema.Class<RuleFailure>("RuleFailure")({
  rule: Schema.String,
  tag: Schema.String,
  message: Schema.String,
  error: Schema.Defect()
}) {}

const isTagged = (error: unknown): error is { readonly _tag: string } =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"

const ruleFailure = (rule: string, error: unknown): RuleFailure =>
  RuleFailure.make({
    rule,
    tag: isTagged(error) ? error._tag : error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    error
  })

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

/** Why an export is missing: who still waits, and who ran and did not post it. */
export class MissingExport extends Schema.Class<MissingExport>("MissingExport")({
  key: Schema.String,
  waitingRules: Schema.Array(WaitingRule),
  /** Producers that fired, failed or were vetoed by `when` without posting the key. */
  silentRules: Schema.Array(Schema.String)
}) {}

export class ExportsMissing extends Schema.TaggedError<ExportsMissing>()("ExportsMissing", {
  missing: Schema.Array(MissingExport),
  /** What did run, so a stall can be explained. */
  trace: Schema.Array(Firing),
  failures: Schema.Array(RuleFailure)
}) {
  get message(): string {
    const reasons = this.missing.map((entry) => {
      const waiting = entry.waitingRules.map(
        (rule) => `${rule.rule} waits for ${rule.missingKeys.join(", ")}`
      )
      const silent = entry.silentRules.map((rule) => `${rule} fired without posting it`)
      return `"${entry.key}" (${[...waiting, ...silent].join("; ")})`
    })
    const failed =
      this.failures.length === 0
        ? ""
        : `; failed: ${this.failures.map((f) => `${f.rule} (${f.tag})`).join(", ")}`
    return `the run ended without: ${reasons.join(", ")}${failed}`
  }
}

export const RunError = Schema.Union([DuplicateFact, UndeclaredFact, MissingImport, ExportsMissing])
export type RunError = typeof RunError.Type

interface Ready<E, R> {
  readonly rule: Rule<E, R>
  readonly firing: Effect.Effect<Posted, E, R>
}

interface Outcome<E, R> {
  readonly rule: Rule<E, R>
  readonly startedAt: number
  readonly duration: number
  readonly result: Result.Result<Posted, E>
}

/** Apply posted facts write-once; the keys actually written, in first-seen order. */
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
  ready: ReadonlyArray<Ready<E, R>>
): Effect.Effect<ReadonlyArray<Outcome<E, R>>, never, R> =>
  Effect.forEach(
    ready,
    ({ rule, firing }) =>
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis
        const result = yield* Effect.result(firing)
        const finishedAt = yield* Clock.currentTimeMillis
        return { rule, startedAt, duration: finishedAt - startedAt, result }
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
      const ready: Array<Ready<E, R>> = []
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
        const failed = Result.isFailure(outcome.result)
        if (Result.isFailure(outcome.result)) {
          failures.push(ruleFailure(outcome.rule.name, outcome.result.failure))
        }
        const posted: Posted = Result.isSuccess(outcome.result)
          ? outcome.result.success
          : { facts: outcome.rule.defaults }
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
            outcome: failed ? "failed" : "posted",
            ...(posted.judgment === undefined ? {} : { judgment: posted.judgment })
          })
        )
      }
    }
    const missing = ruleset.exports.filter((key) => !facts.has(key))
    if (missing.length > 0) {
      return yield* Effect.fail(
        ExportsMissing.make({
          missing: missing.map((key) =>
            MissingExport.make({
              key,
              waitingRules: [...pending.values()]
                .filter((rule) => rule.produces.includes(key))
                .map((rule) =>
                  WaitingRule.make({
                    rule: rule.name,
                    missingKeys: rule.reads.filter((read) => !facts.has(read))
                  })
                ),
              silentRules: ruleset.rules
                .filter((rule) => rule.produces.includes(key) && !pending.has(rule.name))
                .map((rule) => rule.name)
            })
          ),
          trace,
          failures
        })
      )
    }
    return RunResult.make({
      board: Board.make({ facts: Object.fromEntries(facts) }),
      trace,
      failures
    })
  })
