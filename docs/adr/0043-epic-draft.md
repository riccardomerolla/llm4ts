# ADR 0043: epic-draft — Defer Tests and Validation, Then Harden

Status: Accepted · Date: 2026-10-28 · Extends ADR 0013, ADR 0021, ADR 0031, ADR 0042

## Context

Prospective users shown llm4ts asked for a much faster flow. They want to
put the effort into a detailed epic (`epic-design`) and a pack, get working
code quickly, and push tests and validation to a later iteration.

`epic-mvp` (ADR 0042) is the existing lighter path, but it is test-first: a
red test is written and frozen before any code. That is not "defer tests".
`epic-stories` with `--defer-findings` and `--judge-rounds 1` gets closer,
but it still runs four review lenses per task, the story judge, and the
test gate, and it takes five flags to say "go fast".

Running gates takes seconds. The time goes to LLM rounds: review lenses,
judge revisions, and red-test phases. Dropping deterministic compile checks
saves little and lets a broken merge break every story built on it.

## Decision

1. **A new flow on the same engine.** `llm4ts run epic-draft` is its own
   program (`flows/epic-draft.ts`, policy in `flows/lib/epic-draft.ts`) on
   `runEpicStories`, like epic-mvp. Seats, rosters, worktrees,
   `--plan-only`, `--epic`, `--list`, `--land`, restart, `watch`, `profile`
   and `epic-retro` work unchanged.
2. **Defer, don't drop.** A draft run differs from epic-stories in four ways:
   - **No tests now.** The planner is told stories write no test files; each
     story still lists its `acceptance` outcomes, which become the tests
     owed.
   - **The test gate is off.** The other gates (typecheck, lint, build)
     still run on every task and after every merge. `--with-tests` keeps the
     test gate.
   - **One review lens, one round.** `correctnessReviewer`, `maxRounds: 1`,
     and non-blocking findings deferred (ADR 0031's `deferNonBlocking`).
   - **No story judge.** Stories merge on their gates, as in epic-mvp.
     The oracle guard stays on: a draft story may not delete or skip an
     existing test.
3. **The debt is written down.** After each unit, `debt.md` in the unit's
   state folder lists, per merged story, the acceptance outcomes that have
   no test yet, followed by the story's deferred findings. When the gates
   name a test command and the draft skipped it, the test gate runs once on
   the epic checkout and its failing lines go into `debt.md` too: gates with
   a memory (ADR 0027) would otherwise treat those failures as inherited and
   never charge a hardening story with them. The run ends by naming the file
   and its counts. After a hardening round settles (nothing failed or
   waiting), the debt it consumed is moved to `debt.paid.md`.
4. **`--harden` pays the debt.** `--harden` is `--refine` with the epic's
   debt lists (and any text given) as the feedback. The hardening run uses
   epic-stories' full bar: default review lenses, the rubric story judge,
   and every gate, including the test gate. Its stories write the owed
   tests and close the findings.
5. **Landing a draft is allowed.** `--land` lands a draft with open debt; the
   debt line was printed when the draft's unit ended. Hardening before
   landing is the operator's choice.
6. **Two seams on the spine.** `StoriesPolicy` gains `deferNonBlocking`, so
   a policy can defer findings without epic-stories' automatic follow-up
   round. `EpicStoriesOptions` gains `selectGates`, so a policy can narrow
   the resolved gate commands. Without them, behaviour is unchanged.

## Consequences

- The fastest path is a draft followed by a harden round. A draft that lands
  unhardened ships untested code, and the debt file says so.
- Deferred findings no longer plan a follow-up round automatically in a
  draft run; `--harden` does it, alongside the owed tests.
- No `llm4zio` parity impact: the epic flows are llm4ts-only.
- The claim of "fast" needs a measurement: see
  `specs/pending/epic-draft-rehearsal.md`.

## Not decided here

- A `--pace` knob on epic-stories itself, if the rehearsal shows the draft
  policy is only a set of existing flags.
- Refusing `--land` while debt is open (decision 5 can be revisited after
  the rehearsal).
- An advisory story judge that scores and records without sending work back.
