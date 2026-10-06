# ADR 0028: A Work Queue Primitive And The Port Flow Family

Status: Accepted · Date: 2026-10-06
Research: `docs/research/rewrite-grade-loops-plan.md` (phase 3) and
`docs/research/bun-zig-to-rust-rewrite.md`.
Specs: `specs/pending/work-queue-primitive.md`, `specs/pending/port-flow-family.md`,
`specs/pending/queue-sharding-and-javac.md`.

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
2. **Five port flows.** `port-files` drafts every source
   the pack matches at its target path (one implementer per file reading
   the rulebook, the pitfall cards and exactly one source; two adversarial
   votes; a separate fixer; a `PORT STATUS` trailer parsed by code;
   batches of 100 files, 6 when led by a file over 2200 lines; a commit per
   round). `port-compile` runs the pack's diagnostics command once per
   round, groups what is red by unit, gives each unit to one fixer that may
   edit only that unit and neither build nor touch git, reviews with two
   votes, rebuilds and commits, until dry or until a round lowers nothing.
   `port-guide` audits the rulebook (dimension auditors over sample sources,
   three refuters per finding, a trial port by the rules and natively whose
   differences become findings) into a patch to `prompts/porting.md` behind
   an approval the next run applies. `port-ledger` classifies every unit the
   pack's `## Ledger` regex names, with the line that proves it, refutes the
   unknown and low-confidence rows plus a fifth of the rest, and writes
   `<specs>/ledger.tsv`, whose rows `port-files` hands each implementer
   ("trust the table over local guessing"). `port-tests` is the differential
   tier: every test file once on the legacy build for a baseline, then on
   the target; pass means exit 0 and the same pass count; diverge, crash and
   hang become `.diag` files one fixer each reads as its only runtime
   evidence; one rebuild per round until green or stalled.
3. **The pilot is a gate.** `LLM4TS_PORT_PILOT=n` ports n files and writes
   `.llm4ts/port/pilot.md`: rates measured, totals extrapolated, ending in
   `- [ ] Approved`. A later full run refuses while that report exists
   unapproved (`requireApproval`), so the rulebook is read against real
   drafts before the rest is spent.
4. **Language pairs are kit material.** A porting pack adds `target:` (the
   target path template: `{{dir}}`, `{{base}}`, `{{ext}}`, `{{path}}`),
   `comment:` (the trailer's comment marker), `## Diagnostics`
   (`- command:` and `- format: json | cargo | tsc`), `## Ledger` (`- unit:`
   regex, `- classes:`, `- question:`), `## Differential` (`- tests:`,
   `- legacy:`, `- target:` with `{{file}}`, `- timeout:`), `## Audit`
   (`- dimensions:`), `prompts/porting.md` (the rulebook), `reviewers/*.md`
   and `patterns/pitfalls-*.md`. The flows know none of Zig, Rust, Scala or
   TypeScript; `kits/port/packs/zig-rust` is the reference pair distilled
   from the Bun rulebook and the four regressions it shipped, and
   `kits/port/packs/scala-ts` is the pair the llm4zio parity pilot needs.
   `flow/src/Diagnostics.ts` reads three formats; a new toolchain is a
   format, or a wrapper that prints JSON lines.
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

Folding the differential tier into `modernize-verify` (it stands as
`port-tests`, whose packs name the two commands; the clean-room flows keep
their vectors).

## Decided later (2026-10-06)

- **A `javac` diagnostics format**: `parseDiagnostics(text, "javac")` reads
  `javac`'s `path/File.java:12: error: message` and Maven's
  `[ERROR] /path/File.java:[12,5] message`; the unit is the Maven module
  (the path before `/src/`), else the file's folder.
- **Sharding across worktrees**: `runQueue` takes optional `shards`
  (`{ id, dir }`), hands each in-flight item one shard and never two items
  the same shard at once; `port-files` with `LLM4TS_PORT_SHARDS=n` creates
  `n` worktrees under `.llm4ts/port/shards/`, binds its seats there, commits
  and merges each shard after every round and removes them at the end. One
  checkout stays the default.
