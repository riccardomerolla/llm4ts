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

1. **A standalone primitive in core**: the `@llm4ts/core/blackboard/*`
   modules `Fact`, `Rule`, `Ruleset` and `Run`. Flows and kits consume it;
   runner and shell know nothing of it. No consumer is wired in by this ADR.
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
- Divergences from the spec text: keys are validated by name, so the spec's
  `DuplicateKeyName` problem is not raised; a same-named key with another
  schema is a decode defect at run time. `DuplicateRuleName` is validated
  instead, because two rules with one name break the trace. `all` is typed
  by overload up to eight keys (the repository forbids type assertions, and
  a mapped tuple type needs one). An import only pruned rules read counts
  as `UnusedImport`. `run` is the function `runRuleset(ruleset, facts)`,
  not a method, to keep `Ruleset.ts` and `Run.ts` free of an import cycle.
  A failed firing stays in the trace with `outcome: "failed"` and the
  default keys it posted, so paid judgment calls are counted whether or not
  they succeeded; `RuleFailure` carries `tag` and `message` because `Defect`
  encodes every error as a plain one; and `ExportsMissing` carries the
  trace, the failures and, per key, the producers that ran without posting
  it (`silentRules`), so a stall explains itself.
- Not in this ADR: retraction and superseding, a declarative rule
  language, persisting rulesets, a UI, a first consumer flow, and the
  coordination of modernization work through a board (a possible consumer
  an earlier draft proposed; it stays future work).

Superseded drafts: an earlier, uncommitted proposal titled "Modernization
work coordinated through a typed blackboard" (2026-09-26).
