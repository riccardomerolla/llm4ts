# ADR 0034: Parallel Tasks Inside A Story

Status: Accepted · Date: 2026-10-10 · Extends ADR 0013 and ADR 0019

## Context

Parallelism exists only between stories (ADR 0013). Inside a story one coder
plans its own tasks and runs them one after another on one worktree; only
review lenses run in parallel. A story on the epic's critical path therefore
runs no faster however many coder slots the roster has free, and an epic
with few, large stories leaves slots idle.

Finer stories are the first answer and need no change: the planner already
splits an epic, and the story boundary already has isolation, gates, review,
judge and merge. This decision is for the case where a story is as small as
its acceptance criteria allow and still has independent tasks.

## Decision

1. **The coder declares the task DAG.** The task-planning prompt asks for a
   `Depends on:` line (task numbers) and an `Owns:` line (paths) per task,
   next to the existing `Satisfies:` line. A task without `Depends on:`
   depends on the previous task, so a plan written the old way runs as it
   does today. `Plan.ts` parses and renders both lines.
2. **A parallel task gets its own worktree.** A task that runs beside
   another runs in a sub-worktree on `story/<epic>/<id>/task-<n>`, branched
   from the story branch. Its gates, review-and-fix loop and perimeter check
   (against `Owns:`) run there. When they pass it merges into the story
   branch under a per-story lock, in completion order. The first ready task
   of a story runs in the story worktree as today.
3. **Extra coders are opportunistic.** The story keeps its one held coder
   (ADR 0019). Another ready task takes a free coder slot from the roster,
   any executor or clone, only when one is free; otherwise it waits its turn
   behind the held coder, so no story can deadlock or starve another.
   `--task-concurrency <n>` (default 2, `LLM4TS_TASK_CONCURRENCY`) caps the
   coders one story may hold; `--concurrency` stays the story cap.
4. **Per task, then per story.** After every task has merged, the story
   gates, the judge rounds, the perimeter restore and the epic integration
   run as today, on the whole story diff. A story branch that turns red
   after a task merge goes to the held coder as a revision, as a red epic
   merge does (ADR 0032), bounded by `mergeRevisions`.
5. **A task merge conflict serialises.** A task whose merge-back conflicts
   is not failed: it is rerun in the story worktree after the other tasks,
   where the coder sees the merged state. A second conflict fails the story.
6. **Task coders are lanes' children.** `TaskStarted` (ADR 0033) carries the
   clone, and the dashboard lists a parallel task under its story.

## Consequences

- Gates and reviews run once per task instead of once per story step, so a
  story with independent tasks costs more tokens and gate time to finish
  sooner. A profile (`llm4ts profile`) decides whether that trade is worth
  it for a given epic; the default of 2 keeps the blast radius small.
- `Owns:` is advisory until the perimeter check enforces it; a coder that
  writes outside its paths fails the task's perimeter, not the story.
- The judge sees one story diff, so its verdict and acceptance criteria are
  unchanged. Deferred findings (ADR 0031) are per story as before.
- This diverges from `llm4zio` v4.2.0, which has no intra-story
  parallelism; this ADR is the record.

## Implementation notes (2.42.0)

- A task's branch is `story/<epic>/<id>--task-<n>`, not `…/<id>/task-<n>`:
  git cannot hold a branch `a/b` and a branch `a/b/c` at once. Its worktree
  is `<worktreeRoot>/<id>.task-<n>`; both go when the task ends, merged or not.
- The aside coder is held only if a slot is free at that moment
  (`ContextOptions.ifFree`, `tryLease`): a task never waits for a slot, so a
  story never starves another. Without a roster it always runs aside.
- Not only a conflict hands the task back: no free coder, a failed setup,
  red gates the review could not settle, or a `BLOCKED_ON` there all give
  the task to the story's coder, which runs it in the story worktree. A task
  run aside cannot fail its story.
- A task without `Depends on:` waits for every earlier task, not only the
  one before it, so an old-style task after a `none` one cannot overlap
  the task before it. `Depends on:` lists earlier tasks only; a forward or
  self reference is dropped, so the graph has no cycle, and a line left
  naming none is read as no line. `Depends on: none` runs beside the task
  before it.
- The aside coder's lease ends with its work: the merge back waits for the
  story's coder without holding a slot another story could use.
- The aside coder is told its own working directory and, when the task
  names them, its `Owns:` paths; the evidence check (ADR 0027 decision 6)
  is skipped for it, since its tool calls are on its own transcript.
- After any task merged in, the story's gates run on the result before the
  judge (`story <id>: gates after parallel tasks`); red is a revision task
  for the story's coder, up to `mergeRevisions` times, then the story fails.
