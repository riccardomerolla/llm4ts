# ADR 0056: A Cut-Off Journal For Plan Tasks

Status: Accepted · Date: 2026-11-22 · Extends ADR 0003

## Context

A plan's task is marked complete, and the plan saved, once its coder turn,
review rounds and commit have all finished (`implementTaskLoop`,
`implementTaskGraph`). If the flow's process dies in between (the machine
sleeps, the terminal closes, the process is killed for memory), the next
run finds the task still open and runs it again from its first prompt.

Two things go wrong there. The coder is not told that an earlier run got
part of the way, though its uncommitted edits are still in the working
tree, so it starts over on top of them. And nothing counts: a task that
kills its process every time is started again on every run.

Reading pi-durable (`@earendil-works/pi-durable` 1.6.0) for ADR 0055
showed both handled inside one harness: a tool call cut off by a crash gets
the result "was interrupted and may have partially run", and a task cut off
`restartLimit` times ends instead of running again. Its request ids, which
let a re-run find a turn already admitted, do not carry over: llm4ts drives
agents as CLI processes and keeps no stored turn to return to. What does
carry over is knowing that a run was cut off, and counting.

## Decision

1. **A journal beside the plan file.** `makeTaskAttempts` keeps
   `<plan path>.attempts.json`, a versioned document with one entry per
   task that needs one: `{ running, cutOff }`. `PlanStoreShape.attempts`
   hands it to the task loops; `makePlanStore` provides it, so every flow
   on the plan spine has it without asking. A store that has none (the
   field is optional) runs every task as before.
2. **Marked before, unmarked after.** A task's entry is written with
   `running: true` before its run starts. When the run ends while the
   process lives (finished, failed or interrupted), the entry is unmarked;
   a finished task's entry is removed, and an empty journal is deleted.
   A mark still there at the next start means the process died during
   that run: the entry's `cutOff` goes up by one.
3. **Stopping the flow is not a cut-off.** `runFlowMain` interrupts the
   fiber on SIGINT and SIGTERM, so finalizers run and the mark is cleared.
   A failed gate or a failed review is not one either. Only a process that
   ends without running finalizers leaves the mark: SIGKILL, a crash, the
   machine going down.
4. **The coder is told.** The task's body receives `TaskAttempt`
   (`{ cutOff }`) as a third argument, and an aside task finds it on
   `AsideRequest.attempt`. When `cutOff` is above zero, `implementPlanFlow`
   puts `cutOffNote` before the task's prompt: an earlier run may have
   partially run, its changes are uncommitted in the working tree, look at
   them and finish from there. The run also publishes one `Info` event
   with the count.
5. **Three cut-offs end the task.** A task whose runs were cut off
   `cutOffLimit` times (default 3, `PlanStoreOptions.cutOffLimit`) is not
   started again: the loop fails with `FlowAborted`, naming the task and
   the journal file. The journal is left as it is, so every later run
   fails the same way until someone deletes the file. In epic-stories the
   story fails, as it does for any failed task.
6. **The journal follows the plan.** `PlanStoreShape.remove` removes it
   with the plan, and a story that is restarted from scratch removes it
   with its plan file.

## Consequences

- A task resumed after a crash costs a few more prompt tokens and starts
  from the edits already made, instead of redoing them or tripping over
  them.
- A task that takes its process down three times stops the plan with a
  message that says so, where today it loops for as long as someone keeps
  re-running the flow.
- The count survives a failed run: a task cut off twice, then failed on
  its gates, has one cut-off left. Only finishing the task clears it.
- The limit is an option of the store, not yet a setting an operator can
  change from the command line or a config file (ADR 0049).
- The failure was `FlowAborted` at first. Since ADR 0060 it is
  `TaskCutOff`, a tag of its own: a caller that retries runs has to tell it
  from any other stop.
- Work above the task is unchanged. A story's own steps outside its plan
  (the red phase, the story-level review, the judge) are not journaled; a
  crash there re-runs the step as before.
- Two flows writing one plan file at once would write one journal at once.
  That was already unsupported for the plan itself.
