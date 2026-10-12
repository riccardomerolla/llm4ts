# ADR 0038: An Epic-Scoped Unknowns Ledger

Status: Proposed · Date: 2026-10-12 · Extends ADR 0013, ADR 0023, ADR 0031

## Context

A run leaves behind what it could not settle in four shapes in four places:
a coder's `BLOCKED_ON:` sentinel (ADR 0013, `Stories.ts`), the deferred
findings file written beside a story when non-blocking findings are parked
(ADR 0031, `stories/<id>.deferred.md`), the `confidence: low` line of a
Findings trailer (`CarriedNotes.ts`), and the open points of a refine
overlay (`Decisions.ts`, which is a modernization pack's term and never
reaches epic-stories). Judge warnings and the oracle guard's doubts are a
fifth, held only in the trace.

Nothing reads them together. `epic-retro` (ADR 0023) digests prose to
rediscover what the run already knew. The next epic-stories run, or the
next refine round, starts its planner without the previous run's open
questions. `llm4ts watch` cannot show what is unsettled, only what is
running. The gap analysis against `morluto/rea`
(`docs/research/rea-gap-analysis.md`, section 3.1) found rea's residual
unknowns registry to be the one structure llm4ts has no counterpart for: a
durable record per unresolved question with a stable id, a status, the
evidence a resolution would need, and a resolution that is verified only
when it cites evidence.

## Decision

1. **One ledger per epic**, `.llm4ts/epics/<id>/unknowns.jsonl`, append-only,
   one JSON record per line, read through a `Schema` in a new
   `packages/flow/src/Unknowns.ts` beside `Decisions.ts`. A refine round
   (ADR 0021) shares its parent epic's ledger.
2. **A record is a question, not a task.** It carries a stable id hashed
   from the question text, the story id and the scope (file paths or
   program names), a status (`open`, `blocked`, `contradicted`, `resolved`),
   a severity, what would close it (`gate`, `captured-vector`,
   `human-answer`, `story`), a link to what raised it (a `BLOCKED_ON`, a
   deferred finding, a trailer, a judge warning, by story and task id), and
   on resolution a citation of a run artifact (a merged story, a gate log, a
   retro approval line). A later record with the same id supersedes the
   earlier one; the ledger is never rewritten.
3. **Code writes it, never a model.** `Stories.ts` appends on `BLOCKED_ON`,
   on a deferred findings file, on a `confidence: low` trailer; the judge
   appends its warnings. A resolution is appended by the code path that
   has the evidence: a story merging that owned the scope, a gate going
   green on the base, a retro proposal being approved and applied.
4. **Four readers.** The epic-stories planner prompt receives the open
   records for the stories it plans, capped by the existing context budget
   (ADR 0025); `Retro.ts` starts its digest from the ledger instead of
   re-deriving blocked and deferred items from prose; `Profile.ts` counts
   open, resolved and contradicted records per story; `Watch.ts` lists
   open records in the epic view.
5. **Never a board.** The ledger has no assignee, no due date, no comment
   thread and no board sync (`BoardSync.ts` does not read it). A question a
   person wants tracked becomes a story in the epic plan; the ledger then
   records that story as the resolution path.

## Considered options

- Keep the five shapes and teach retro to parse them. Rejected: retro is one
  reader of four, and parsing prose is what the ledger removes.
- Reuse `Decisions.OpenPoint`. Rejected: it is numbered per overlay, has no
  stable id or status, and belongs to a pack's scope overlay (ADR 0015),
  not to a run.
- A general issue tracker, or writing records to the board tool. Rejected
  as scope creep: the board already carries stories; a second queue of
  questions beside it would be the parallel code CLAUDE.md forbids.

## Consequences

- Behavior divergence from llm4zio v4.2.0, which has no epics; recorded in
  `docs/parity.md` as additive.
- The planner's view changes: a story planned after a blocked one sees the
  block. This is a harness change under ADR 0029 and ships with a
  before-and-after profile on the light fixture.
- `--land` keeps the ledger: it is the epic's record of what remained open
  and is small by construction.
