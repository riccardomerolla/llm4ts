# ADR 0028: A Work Queue Primitive And The Port Flow Family

Status: Accepted · Date: 2026-10-06
Research: `docs/research/rewrite-grade-loops-plan.md` (phase 3) and
`docs/research/bun-zig-to-rust-rewrite.md`.
Specs: `specs/pending/work-queue-primitive.md`, `specs/pending/port-flow-family.md`.

## Context

llm4ts has two shapes of autonomous work: a flat task plan
(`implementPlanFlow`) and an epic of stories with a dependency graph, a
worktree, a judge and a merge each (ADR 0013). The Bun port that motivated
ADR 0027 had a third shape: thousands of file-sized units with no graph, a
shared rulebook, a filesystem definition of done ("the `.rs` exists"), a
reviewer pair per unit, and compiler errors fed back as the next units. A
story would pay for a judge, a perimeter, a branch and a merge that a file
does not need; a task plan has no notion of hundreds of independent items,
resume by output, or failures becoming the next round.

The port scenario is not clean-room: the source file is the specification,
in the tree, beside its target, as it was for Bun. The clean-room wall
(ADR 0012) does not apply to it.

## Decision

1. **A work queue is a module, not a story shape.** `flow/src/WorkQueue.ts`:
   `runQueue({ items, done, work, concurrency, maxRounds, ledger, afterRound })`
   works the items whose `done` predicate is false, round after round, under
   a concurrency cap; a unit's failure (or work that leaves no output: the
   predicate decides, not the work's account of itself) is the next round's
   item; a round that finishes nothing ends the queue typed `Stalled`
   (`no-progress`); every outcome is one JSON line in a ledger, with the
   confidence and todo count the unit reported; `afterRound` is where the
   flow commits. Items are lanes: `llm4ts watch` and `profile` show them.
2. **Two port flows now, three later.** `port-files` drafts every source
   the pack matches at its target path (one implementer per file reading
   the rulebook, the pitfall cards and exactly one source; two adversarial
   votes; a separate fixer; a `PORT STATUS` trailer parsed by code;
   batches of 100 files, 6 when led by a file over 2200 lines; a commit per
   round). `port-compile` runs the pack's diagnostics command once per
   round, groups what is red by unit, gives each unit to one fixer that may
   edit only that unit and neither build nor touch git, reviews with two
   votes, rebuilds and commits, until dry or until a round lowers nothing.
   `port-guide` (an audited rulebook), `port-ledger` (a precomputed
   cross-file table) and `port-tests` (the differential tier) wait for a
   live run of these two.
3. **The pilot is a gate.** `LLM4TS_PORT_PILOT=n` ports n files and writes
   `.llm4ts/port/pilot.md`: rates measured, totals extrapolated, ending in
   `- [ ] Approved`. A later full run refuses while that report exists
   unapproved (`requireApproval`), so the rulebook is read against real
   drafts before the rest is spent.
4. **Language pairs are kit material.** A porting pack adds `target:` (the
   target path template: `{{dir}}`, `{{base}}`, `{{ext}}`, `{{path}}`),
   `comment:` (the trailer's comment marker), `## Diagnostics`
   (`- command:` and `- format: json | cargo`), `prompts/porting.md` (the
   rulebook), `reviewers/*.md` and `patterns/pitfalls-*.md`. The flows know
   none of Zig or Rust; `kits/port/packs/zig-rust` is the reference pair,
   distilled from the Bun rulebook and the four regressions it shipped.
   `flow/src/Diagnostics.ts` reads two formats, JSON lines and cargo's
   messages; a new toolchain is a format, or a wrapper that prints JSON.
5. **Not clean-room, and said so.** The port flows do not run `checkWall`;
   the source is the spec.

## Consequences

- A port of N files costs N implementer calls plus two votes and a fixer
  each; the pilot report gives the number before the rest runs. Votes
  default to 2 in these flows and 1 everywhere else (ADR 0027).
- The queue is reusable: a future fan-out over fixtures, pages or
  programs can use it; `convert-all` is a candidate.
- `Stalled` gains the `no-progress` signal; `Pack` gains three optional
  fields and one section; everything existing parses unchanged.
- Divergence from the pinned llm4zio, which has no port flows and no queue,
  is recorded in `docs/parity.md`.

## Not decided here

The audited rulebook flow and the lifetime-style ledger; the differential
equivalence tier (`modernize-verify --tier differential`); a diagnostics
format for `tsc` and `javac`; sharding across worktrees (one checkout, one
queue, concurrency on seats is enough for a first live run).
