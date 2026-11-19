# ADR 0054: The Judge's Agent Rescues a Story Before It Fails

Status: Accepted · Date: 2026-11-19 · Extends ADR 0019, ADR 0044

## Context

In epic-stories a story fails when its last round leaves it open. In
story-review mode (the default, ADR 0044), the gates are still red or the
judge is still not cleared after `--review-rounds`. In task mode, the judge
is not cleared after its revisions. Every fix in those rounds is the
story's own coder's: the same agent and model that could not close the
findings the first time. A failed story also puts its dependents on hold,
so one weak story can stall the epic.

The judge is usually the stronger model. It has read the story's diff and
written the findings, but its seat is read-only, so it can only send the
findings back to the coder.

## Decision

1. **One rescue turn before a story fails.** At both failure points, the
   judge's agent takes the coder's seat for one turn in the story's
   worktree. It gets the story, its acceptance criteria, why it is about to
   fail and every open finding (`rescuePrompt`). What it writes is
   committed as `<story>: rescue`, and the perimeter is repaired as after
   any coder turn. Then the gates must be green, and the judge gives one
   more verdict. Cleared, the story goes on to merge ("judge cleared after a
   rescue"). Otherwise it fails as before, its reason saying the rescue did
   not clear it. There is only ever one rescue turn per story.
2. **The rescuer is the judge's agent, with write access.**
   - Without a roster: the reasoning seat's agent and model
     (`LLM4TS_REASONER`, `LLM4TS_REASONING_MODEL`, `LLM4TS_REASONING_FLAGS`),
     resolved without `readOnly` in the story's worktree. The flow passes it
     as `FlowRunnerOptions.rescuer`; the runner puts it on the story's
     context as `FlowContextShape.rescuer`.
   - With a roster: a judge slot is leased away from the story's coder, as
     for a verdict, and the executor is seated as a coder, so it writes
     (`RosterSeatOptions.seatAs`). With no other judge executor free, the
     coder's own executor is borrowed, as the judge would be.
3. **The verdict after a rescue comes from someone else where it can.**
   With a roster, the executor that rescued is avoided by the story's later
   leases, the judge's included (`onLease`). Without a roster there is one
   reasoner, so the same model judges its own fix, read-only.
4. **On by default in epic-stories.** `--no-rescue` or `LLM4TS_RESCUE=off`
   turns it off. It applies under `--defer-tests` and `--harden` too. The
   executor option is `StoriesOptions.rescue`; without a `rescuer` on the
   context it does nothing. epic-mvp, epic-draft and epic-stories-board do
   not ask for it.

## Consequences

- A story that would fail costs one more turn of the stronger model, one
  gate run and one judge verdict. Stories that clear in their rounds cost
  nothing more.
- Fewer stories fail, and fewer dependents wait behind them.
- The rescuer is held to the same rules as the coder: the perimeter, the
  frozen red tests (ADR 0053) and the gates.
- Without a roster the judge grades a fix it wrote. It is still held to the
  gates and to its own rubric, but it is not an independent check; a roster
  with a second judge executor makes it one.
- The rescue shows in the run as a `story <id>: rescue` stage, in the
  transcript as the `rescuer` agent, and in the trace's timings.
