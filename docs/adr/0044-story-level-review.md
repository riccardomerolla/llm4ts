# ADR 0044: Review Per Story, Not Per Task

Status: Accepted · Date: 2026-10-29 · Amends ADR 0013, ADR 0031, ADR 0042,
ADR 0043

## Context

Users of `epic-stories` report that tasks take a long time to finish, and
that the waiting grows as a story goes on. The time goes to the review loop:

- Every task runs `reviewAndFixLoop` with the default `allEveryRound`
  selector. After each fix, every lens reviews the whole task diff again, up
  to 3 rounds. A lens that was clean in round 1 still runs in rounds 2 and 3,
  and a one-line fix costs four full reviews.
- The review cache is keyed on the whole diff, so after any fix it misses.
- After the tasks, the story judge reviews the story, and each revision it
  asks for reruns the whole task cycle, lenses included.

Lens calls therefore grow with tasks × lenses × rounds, and the judge then
repeats part of the same work at story level. Its rubric (provides, scope,
house style, tests) overlaps with the lenses.

## Decision

1. **Tasks merge on their gates.** Inside a story, a task runs its gates
   (typecheck, lint, build, test, as the flow selects them) and the oracle
   guard. No lens runs per task.
2. **One story review.** When the story's tasks are in, the lenses and the
   story judge review the story diff side by side. Their findings merge into
   one set, and each finding records the lens that raised it (`ReviewIssue`
   gains an optional `lens`; the judge's findings carry `judge`). Records
   written before this ADR simply have no lens.
3. **One fix turn per round.** A fresh coder chat from the roster gets the
   story brief, the merged findings and the story's working copy. Then the
   gates run, then the re-check. Judge findings that say a piece is missing
   entirely (today's `empty` and `provides` cases) still become revision
   tasks, which run on gates only, and the story review runs again after
   them.
4. **Incremental re-checks.** From round 2, a reviewer (lens or judge)
   reruns only if it had findings in the last round it ran, or if the fix
   touched files it now matches and never saw. A rerun gets the whole story
   diff with the fix's changes highlighted, plus its own earlier findings,
   and is asked whether they were fixed and whether the fix broke anything.
   It does not start a fresh full review. A reviewer that never ran (because
   the gates were red) runs a full review. There is no final full pass: the
   judge is part of the loop.
5. **Rounds.** One setting, `--review-rounds <n>` (default 3), bounds the
   merged loop. `--judge-rounds` and `LLM4TS_JUDGE_ROUNDS` stay as aliases.
   The story settles when the lenses are clean (or, under ADR 0031's
   `blocking` settle, only non-blocking findings remain) and the judge
   approves. Out of rounds:
   - judge not approved: the story **fails**, as today;
   - judge approved, lens findings still open: the story **merges**, and the
     open findings are recorded as carried findings for the retro.
6. **Where it applies.** A story policy setting, `reviewAt: "story" |
"task"`. Story is the default in `epic-stories`, `epic-mvp` and
   `epic-draft` (whose single correctness lens moves to story level).
   `--review-at task` switches back to today's behaviour.
   `reviewAndFixLoop` and the library's default selector are unchanged, so
   other flows and `llm4zio` parity are unaffected; the story review is a new
   stage in `Stories.ts` that reuses the loop's pieces.
7. **Restart.** A run that stops during the story review resumes there, at
   the right round with each reviewer's state. Saved findings and the review
   cache are keyed on the story diff. The tasks are not redone.
8. **Size.** No limit on the story diff for now. `llm4ts profile` records
   the story diff size so a limit can be set later from data.

## Consequences

- Lens calls scale with stories instead of tasks, and rounds after the first
  run only the reviewers that had findings.
- Logic and design problems surface at story level, after the tasks.
  Problems the gates catch (compile, lint, tests) are still caught per task.
  A story whose task 1 has a design flaw may carry it into tasks 2 and 3;
  the fix turn then corrects all of them at once.
- Lenses see the whole story, so they can catch problems that span tasks.
- The judge gets one more fix turn than before (3 rounds instead of 2), each
  of which is a single fix turn instead of a task cycle.
- The claim needs a live measurement:
  `specs/pending/story-level-review-rehearsal.md`.

## Not decided here

- Folding the lens checklists into the judge's rubric as one call.
- Splitting the review of a very large story by owned files.
- Turning recurring findings into coder rules and deterministic gates (a
  separate ADR).
