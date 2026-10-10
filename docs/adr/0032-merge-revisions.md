# ADR 0032: A Story Red After Merging Gets A Revision

Status: Accepted · Date: 2026-10-10

## Context

A story merges into `epic/<id>` only after its gates pass in its worktree.
The epic gates then run on the merged head, and if they are red the merge is
undone and the story fails (ADR 0013), putting its dependents on hold.

Parallel stories make that common. Each story caught up with the epic before
its judge, but its gates ran before that catch-up, and another story can
merge while it waits for the merge lock. Two stories that are green alone can
be red together: a shared store changed by one, a component test written
against the old store by the other. Refine rounds (ADR 0021, ADR 0031) make
this more likely, since their stories touch files many merged stories own.

A failed story can only be fixed by a person rerunning the epic, although the
failure is exactly the kind of feedback the task loop already handles.

## Decision

1. `integrate` no longer fails the story. It undoes the merge and returns the
   failures the merge added (after triage against the head's baseline and a
   flaky rerun of the test gate).
2. `runStory` sends the story back up to `mergeRevisions` times (default 1;
   `epic-stories --merge-revisions <n>` or `LLM4TS_MERGE_REVISIONS`).
   `implementStory` runs again with those failures. It catches up with the
   epic and reruns setup, as every run of a story does, so the worktree's
   gates now see the combination that was red. Then it appends
   `Revision N: make the epic gates green after merging` to the story's plan,
   with the failures, and runs the task loop, the perimeter repair and the
   judge as usual before merging again.
3. Past the limit the story fails as before, and the reason says how many
   merge revisions it had and names the gate log.
4. `0` keeps the old behavior: fail at the first red merge.

## Consequences

- A cross-story break costs one more coder turn and gate run instead of a
  failed story with held dependents.
- The default changes behavior, but only on a path that used to fail.
- The judge runs again on the revised diff, since the diff changed.
- Deferred findings (ADR 0031) of the story's first run are kept and joined
  with the revision run's.
- Token estimates in the story's outcome cover the last run only.
- A merge conflict (`MergeConflict`) still fails the story; only red gates
  are revised.
