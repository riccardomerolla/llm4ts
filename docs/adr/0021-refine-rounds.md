# ADR 0021: Refine Rounds On A Finished Epic

Status: Accepted · Date: 2026-09-30

## Context

`epic-stories` (ADR 0013) ends with every story merged into `epic/<id>`.
Then a person tries the branch and returns with feedback: move this, remove
that, this form loses its value on error. The flow had no place for it:

- the planner writes a plan only when none exists, so follow-up stories had
  to be hand-written in the plan format;
- a plan refuses two stories owning one path, and a fix almost always
  touches files a merged story owns;
- a second epic stacks a branch on a branch and lands twice.

Design spec: `docs/superpowers/specs/2026-09-30-refine-rounds-design.md`.

## Decision

Feedback on a finished, not yet landed epic becomes a **refine round**:
a round of follow-up stories with its own story plan, run by the unchanged
story executor on the same epic branch.

1. **A round is its own plan inside the epic.** It lives in
   `.llm4ts/epics/<epic>/rounds/<n>/` with `feedback.md`, `plan.md`,
   `not-planned.md` and the executor's state for the round (story states,
   board, report). The epic's approved plan and record are never rewritten.
2. **The ownership rule does not change.** A round's plan holds only that
   round's stories, so paths stay exclusive within it; earlier stories are
   merged and not in it, so their paths are free to claim. Feedback items
   that need the same file go into one story.
3. **Rounds are sequential.** A round starts only when the plan's stories
   and every earlier round are merged. An unfinished round blocks the next
   round and blocks `--land`.
4. **Story ids are unique across the epic.** The flow prefixes every round
   story with `r<n>-`; a dependency on a story merged before the round is
   dropped as already satisfied.
5. **Plan what is clear, list the rest.** The planner returns stories and a
   not-planned list (item, reason or question). The round runs with the
   clear items; the list is kept and shown to the next round's planner. It
   never guesses.
6. **An existing round plan wins**, as an existing plan does: editing it is
   the approval and the re-plan path.
7. **What a run does is one pure decision** (`runAction`): the plan's
   stories, the open round, a new round, the landing, or a typed refusal
   (`RefineRefused`) that says what to do next.

## Consequences

- `implementStoriesFlow` and `StoryPlan` are untouched: a round is a plan,
  a state folder and the epic's branch.
- `landEpic` takes the rounds beside the plan: it refuses while a round
  story is unmerged and removes the rounds' worktrees and branches too.
- `--list` and the coverage ledger's progress count round stories.
- Several feedback items on one file become one larger story. If that
  proves too coarse, the alternative is an ownership rule that lets
  dependent stories share a path; it was not needed to ship rounds.

## Not decided here

- Refining a landed epic (a round based on the target, landed again).
- Updating the epic's brief when feedback removes something it has in
  scope; the coverage ledger still counts it.
- Checking visual feedback by looking at the page.
- Whether the story judge's rubric is too strict for a small fix.
