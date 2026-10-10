# ADR 0033: Executor Clones And A List-First Watch Dashboard

Status: Proposed · Date: 2026-10-10 · Amends ADR 0019 and ADR 0022

## Context

A roster entry's `slots` reads as "how many of this agent exist", and for
a CLI harness that is what it is: every call spawns a process, so `slots: 3`
runs three codex processes with the same role and model. Three rules made
it look like something else:

- an executor with coder and reasoning roles kept one slot for reasoning
  (`coderSlots` defaulted to `slots - 1`), so `slots: 3` gave two coders;
- leases named the executor, never the instance, so the dashboard, the log
  and the cost ledger showed one "codex" with a held list;
- the agent tree (ADR 0022) drew at most three lane boxes and folded every
  other running story into a status chip, so a run at concurrency five
  looked like a run at three.

Meanwhile the task loop ticks each task in `stories/<id>.plan.md` as it
finishes, and `board.md` moves stories between columns, but neither reaches
the screen: the tree infers a story's phase from stage names, and `watch`
reads `board.json` once at start. The three CLI harnesses also delegate to
their own sub-agents by default in headless mode (ADR 0035), and nothing in
the event stream says so; their tool calls flatten into the parent's lane.

## Decision

1. **A slot is a clone.** `coderSlots` defaults to `slots`; a roster that
   wants a slot kept free for reasoning sets it. Every lease carries a clone
   number (`codex#2`), published on `ExecutorLeased` and `ExecutorReleased`,
   shown in the dashboard and the cost ledger, and recorded in transcripts.
   Independence (ADR 0019, decision 2) stays at the executor level: clones
   of one executor are the same model, so a reviewer or judge still avoids
   the executor that holds the story's coder. When the roster has to borrow
   the story's own executor, the dashboard says `judge borrowed from own
executor` on the lane and in the rail, so a one-executor roster is never
   mistaken for an independent review.
2. **A list, then one detail box.** The orchestrator and judgment boxes stay.
   Below them, instead of up to three lane boxes, every running agent is one
   line: story id, clone, `task n/m` with the task's title, the open stage,
   elapsed time and tokens. A task coder of a parallel task (ADR 0034) and a
   sub-agent a harness spawned (ADR 0035) are indented child lines under
   their story. The terminal's height decides how many lines show; the list
   scrolls and the header says `N running`, so nothing is hidden silently.
   One detail box follows the list for the selected line: the task
   checklist with its ticks, the acceptance criterion the current task
   satisfies, the stage log, recent tools, tokens, and the harness state
   when it is retrying or compacting. Up and down select; the selection
   defaults to the most recently changed lane so an unattended screen still
   shows what moved.
3. **Tasks are events.** The plan execution loop publishes `TaskStarted`
   (lane, index, count, title, satisfies) and `TaskCompleted`. The dashboard
   stops inferring task progress from stage names. `plan.md` keeps its
   `## [x]` headings as the file artifact.
4. **The board is events too.** `BoardSync` publishes `StoryStatusChanged`
   (id, status) whenever a story moves column, so the trace stays the log
   (ADR 0022, decision 2) and `watch` reads `board.json` only for its first
   frame. A third view mode, `boards`, shows the epic board (planned,
   active, waiting, done, failed, skipped) and, for the selected story, its
   task board (todo, doing, review, done). `board.md` is unchanged.
5. **Sub-agents are observed, not leased.** `LlmChunk` tool metadata and
   `ToolUse` gain an optional `parent` id. The Claude connector fills it
   from `parent_tool_use_id`, the Codex parser keeps `collab_tool_call`
   items and fills it from the thread ids, and the Gemini connector marks
   its agent tools by name. A `delegate` tool category covers `Agent`,
   `spawn_agent` and Gemini agent names. Claude usage is read from
   `modelUsage`, which includes sub-agents, instead of `result.usage`,
   which does not.
6. **pi's richer events reach the tree.** The pi connector maps
   `agent_settled` as the end of a turn, `auto_retry_start`/`compaction_start`
   as lane states, `tool_execution_end.durationMs` as the tool's `Timed`,
   nested `parentToolCallId` as `parent`, and `stopReason: "aborted"` as a
   typed failure.

## Consequences

- The three-box layout of ADR 0022 is superseded. The 90-column floor, the
  classic surface as default, the hand-rolled renderer and the golden-frame
  tests stay; the golden frames change.
- The `coderSlots` default changes behavior for a roster that relied on the
  reservation. Such a roster sets `coderSlots` explicitly; the release note
  says so.
- New events are additive; the trace keeps schema version 1 and older
  readers skip kinds they do not know. A trace from an older release renders
  without task lines or board moves.
- Clone numbers are per run, not stable identities across runs: a resumed
  story that kept its executor (ADR 0019, decision 3) may get another clone
  number.
- `parent` is optional everywhere, so flows and tools that never set it are
  unchanged.
