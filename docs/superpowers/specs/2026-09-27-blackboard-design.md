# Typed blackboard: company rules that decide, judgments as facts

Date: 2026-09-27 · Status: design agreed in conversation, spec for review

## Purpose

A company that runs llm4ts wants to own the policy behind a decision the
engine makes ("this story can land", "this operation is read-only", "this
design draft is accepted") instead of finding it hard-wired in a flow. The
policy has deterministic parts (a company rule) and parts only a model can
answer (a judgment). Today the model's answer and the rule live in the same
ad-hoc code, one flow at a time.

This spec adds a **typed blackboard** to `@llm4ts/core`: a run-time on which
facts are posted, rules fire when the facts they match are present, and the
run ends when nothing more fires. A judgment is one kind of rule. It matches
facts, asks the `Judgment` service typed questions and posts the typed
answers as facts. Deterministic rules consume those facts and post the
decision. The engine decides; the model only contributes facts.

Success: a flow or kit expresses a decision as a ruleset a company can read,
edit and test, with the model calls visible in the trace and bounded by the
rules that gate them.

Origin: the blackboard pattern in the owned `zio-blackboard` engine
(Scala/ZIO). This spec takes its shape (typed facts, conditions, run to
quiescence, static validation of a ruleset) and leaves its expression
language, external JSON model and interpreter out.

## Decisions taken

1. **Standalone primitive in core.** No first consumer is wired in. Flows
   and kits consume it; the runner and shell know nothing of it.
2. **Rules are TypeScript values.** A ruleset is a `.ts` file, checked by the
   compiler. No declarative model, no interpreter. Facts and the board are
   schema-encodable from day one so a declarative rule layer can be added
   later without changing them (option kept open, not built).
3. **Forward chaining**, as in zio-blackboard, not demand-driven. Model calls
   are bounded by static pruning (rules that cannot reach an export are not
   wired in) and by the company gating expensive rules behind cheap facts.
4. **Core never decides.** Thresholds (`JudgmentPolicy`, `decide`) stay in
   flow; a flow-level rule applies them to an `Answer` fact.

## Module layout

```text
packages/core/src/blackboard/
  Fact.ts        Fact keys with schemas; the Board; encode/decode
  Rule.ts        Conditions, rules, the two constructors (derive, judge)
  Ruleset.ts     Ruleset.make: validation, pruning; the valid ruleset value
  Run.ts         run to quiescence; the trace; errors
```

Exported as `@llm4ts/core/blackboard/Fact`, `/Rule`, `/Ruleset`, `/Run`
(explicit subpath exports, as for `judgment/*`). Depends on
`@llm4ts/core/judgment/*` and Effect. Nothing above core.

## Facts

```ts
const landable = Fact.make("story.landable", Schema.Boolean)
const review = Fact.make("story.review", ReviewSummary) // a Schema.Class
```

- A `FactKey<A>` is a name plus a schema. Names are unique within a
  ruleset; declaring the same name twice with different schemas is a
  `Ruleset.make` error.
- A fact is `{ key, value }` with `value: A`. A run keeps one value per key:
  the first write wins, a later write with an _equal_ value (by the schema's
  equivalence) is a no-op, and a later write with a _different_ value
  fails the run with `DuplicateFact { key, kept, rejected }`. There is no
  retraction; superseding is a new run with new initial facts.
- The **Board** is the immutable map of facts at the end of a run. It is
  encodable (`Board.encode`/`decode`) with each fact encoded by its key's
  schema, so it can go into traces, ledgers and reports.

## Rules

A rule is `{ name, condition, consequence }`.

**Conditions** (a small closed set, each with a static list of the keys it
reads, which is what validation and pruning use):

| Condition                    | Fires                                          |
| ---------------------------- | ---------------------------------------------- |
| `on(key)`                    | when `key` is posted; value `A`                |
| `all(k1, k2, …)`             | once every key is present; value `[A1, A2, …]` |
| `when(condition, predicate)` | as `condition`, only if the predicate holds    |

A rule fires at most once per run (facts are write-once, so a condition is
satisfied at most once). No `Join` arity ladder: `all` is variadic and
typed with a tuple.

**Consequence**: `(value) => Effect<ReadonlyArray<Fact>, E, R>`. `R` is any
service the rule needs; the ruleset's `run` requires the union. A failure
`E` is recorded as a `RuleFailure { rule, error }` on the result and the
run continues with the rule's optional `default` facts (as in
zio-blackboard's `default`). A defect fails the run.

**Constructors**:

- `derive(name, condition, (value) => facts)` — pure and deterministic.
- `judge(name, condition, ask, post)` — `ask: (value) => { state: State,
questions: Record<string, Question> }` and `post: (answers) => facts`.
  Calls `Judgment.judge` once with all questions, then `post` with the typed
  `JudgmentResult`. The posted facts carry the `Answer` (probability,
  support, origin), never a stripped-down boolean; turning an answer into a
  decision is another rule.
- `rule(name, condition, consequence, default?)` — the general form, for a
  human approval, a gate command or any other service, written where those
  services live (flow).

## Ruleset

```ts
const ruleset = Ruleset.make({
  name: "landing",
  imports: [storyDiff, houseRules],
  exports: [landable],
  rules: [reviewQuestions, landableFromReview, …]
})
```

`Ruleset.make` returns `Effect<Ruleset<R>, RulesetInvalid>` where
`RulesetInvalid` carries **all** problems found, each typed:

| Problem                  | Meaning                                             |
| ------------------------ | --------------------------------------------------- |
| `UnproducedMatch`        | a rule reads a key nobody imports or produces       |
| `UnproducedExport`       | an export no rule produces                          |
| `ManyProducers`          | two rules may post the same key                     |
| `EmptyCondition`         | a rule that reads nothing (constant rule)           |
| `SelfMatch`              | a rule reads a key it produces                      |
| `DuplicateKeyName`       | one name declared with two schemas                  |
| `UnusedImport` (warning) | an import no rule reads                             |
| `Unreachable` (warning)  | a rule whose products reach no export; it is pruned |

Producers are declared, never inferred: every constructor takes
`produces: [key, …]`, the keys the rule may post. Validation reasons on
that list, and the engine checks at run time that a rule posts only
declared keys (`UndeclaredFact`, a run failure).

A valid `Ruleset` is a value: immutable, runnable many times, and
describable (`ruleset.describe()` renders the dependency graph as text and
Mermaid, the same way flows render plans).

## Running

```ts
const result = yield * ruleset.run([storyDiff.of(diff), houseRules.of(rules)])
```

- Initial facts must cover the imports (`MissingImport` otherwise).
- Facts are posted; every rule whose condition is satisfied fires. Rules
  fire concurrently where independent (an Effect fiber per firing, within
  a bounded scope) and the board is updated atomically per fact.
- Quiescence: no fiber running and no rule newly satisfiable.
- Then every export must be present, or the run fails with
  `ExportsMissing { missing: [{ key, waitingRules: [{ rule, missingKeys }] }] }`,
  which is the message a company reads when its policy stalls.
- Result: `RunResult { board, trace, failures }` where `trace` is a list of
  `Firing { rule, readKeys, postedKeys, startedAt, duration, judgment?: {
backend, identity } }` in firing order, and `failures` the recorded
  `RuleFailure`s. The whole result is schema-encodable.

Errors are `Schema.TaggedError`s under one union `BlackboardError`; no
global `Error`, no secrets in messages (fact values are never printed in
an error message, only key names).

## Interaction with existing seams

- `Judgment` (ADR 0017) is used as is; the `judge` constructor is its
  only caller inside the blackboard. `FakeJudgment` drives the tests.
- Flow gets nothing new in this spec. A follow-up may add a flow-level
  helper (`decideRule(key, policy)`) that turns an `Answer` fact into an
  `act | caution | hold` fact with `decide`, and a `FlowRecorder` hook that
  writes `RunResult` into the trace directory. Both are consumers, not
  part of the primitive.
- ADR 0020 (proposed by Codex, uncommitted) frames the blackboard as
  modernization coordination. That is one possible consumer. The ADR should
  be rewritten to record the decisions in this spec (core primitive, TS
  rules, forward chaining, core never decides) and list coordination as
  future work; that rewrite is part of the implementation plan.

## Testing

`packages/core/test/blackboard/*.test.ts` with `@effect/vitest`, no
network:

- Facts: write-once, equal rewrite is a no-op, different rewrite fails;
  Board encode/decode round trip.
- Validation: one test per problem kind; a ruleset with several problems
  reports all of them; warnings do not fail `make`.
- Running: chaining across three rules; `all` waits for every key;
  `when` blocks a firing; a rule failure records and continues with
  defaults; a defect fails the run; a missing export names the waiting
  rules and their missing keys; concurrent independent rules both fire;
  trace order and content.
- Judgment rule: with `FakeJudgment`, the posted fact carries the
  answer's probability and origin; a backend failure is a `RuleFailure`.
- Property-style: a generated acyclic ruleset either fails `make` with the
  expected problem or runs to completion with every export present.

## Out of scope (first version)

Retraction and superseding facts; a declarative rule language and its
interpreter; persisting rulesets; a UI; a first consumer flow; the
modernization coordination of ADR 0020.
