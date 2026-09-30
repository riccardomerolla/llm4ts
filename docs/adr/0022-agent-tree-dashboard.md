# ADR 0022: Agent Tree Dashboard For A Running Flow

Status: Accepted · Date: 2026-09-30

## Context

An `epic-stories` run is concurrent: up to `--concurrency` stories hold a
coder lease from the executor roster (ADR 0019), borrow reviewer and judge
seats per call, and are judged before they merge. The terminal shows this as
a pinned status block with one row per lane (`runner/src/Terminal.ts`) and
scrolling log lines above it. That answers "is it alive", not "what is the
run doing": which executor holds which story, whether the roster is
saturated, what the judge last said, which stories wait on which.

The run already carries most of the answer:

- every flow event goes through one hub (`flow/src/FlowEvents.ts`), and most
  carry a `lane` (story id) and an `executor`;
- the trace (`.llm4ts/trace-<ms>.jsonl`, on by default) appends one line per
  event, so another process can tail it while the run is live;
- the epic's board and story states are rewritten atomically on every change.

A throwaway prototype (branch `prototype/agent-tree`,
`tools/prototype/agent-tree.prototype.ts`) rendered a 90-column frame from a
real trace of the demo epic. The layout fits. It also showed the gaps:

- roster leases, exclusions and handovers are `Info` lines (`roster: X takes
Y for Z`) without a lane, so a pool view must parse prose;
- the default story judge (the rubric) leaves no numbers in the trace, only
  review-round issue counts and the final `judge cleared (round n)` text;
- nothing marks the end of a run in the trace, so a reader cannot tell a
  finished run from a stalled one.

Spec: `specs/pending/agent-tree-dashboard.md`.

## Decision

A running or finished flow can be shown as an **agent tree**: a full-screen
terminal view of the orchestrator, the judgment layer, the story lanes on the
roster, the judge seat and a session log.

1. **One pure core, two hosts.** `reduce(state, FlowEvent)` and
   `view(state, width)` live in `packages/runner/src/AgentTree.ts`. They know
   nothing about where events come from. Two hosts feed them:
   - **in-process**, a `TreeSurface` behind `llm4ts run <flow> --ui tree`,
     subscribed to the hub. The shell passes the choice to the flow child as
     `LLM4TS_UI=tree`, as it passes `--verbose`;
   - **out of process**, `llm4ts watch`, which tails a trace file. The shell
     owns the command; the runner still knows nothing of the shell.
2. **The trace is the log.** Live watching, a finished run and a replay are
   the same fold over the same lines: `watch` follows a trace that has no
   end marker, shows the last frame of one that has, and
   `watch --replay [--speed n]` re-folds it on its timestamps (gaps over
   2 s shortened). Golden-frame tests fold fixture traces; no network.
3. **Typed roster events.** `Roster` publishes `ExecutorLeased`,
   `ExecutorReleased`, `ExecutorExcluded` and `ExecutorResumed` (executor,
   role, lane when the lease belongs to a story, reason for an exclusion)
   in place of its `roster:` `Info` lines. The classic terminal renders the
   new events, so its output does not change.
4. **Typed story verdicts.** The story judge publishes `StoryJudged` (lane,
   round, dimensions with score and maximum, cleared). The judgment box
   renders it as score bars; for a flow that publishes `JudgmentObserved`
   (`epic-stories-board`) it renders certainty bars. Both are shown when both
   exist.
5. **The trace records the end of a run.** The recorder appends a
   `RunEnded` line (outcome: completed, failed, interrupted) when the run's
   scope closes. It is a trace line like `StreamError`, not a flow event.
6. **An epic knows its runs.** `epic-stories` appends
   `{runId, tracePath, round, startedAt}` to `.llm4ts/epics/<id>/runs.jsonl`
   at start, so `watch --epic <id>` opens the latest run and a future
   `--list` can reach every run that touched the epic.
7. **Read-only.** Keys select and expand a lane, switch lanes between
   stories and executors, toggle the full log and quit. `q` detaches
   `watch`; in-process it returns to the classic status block while the run
   goes on. `ctrl-c` keeps its meaning. Acting on a run from the view
   (pause, restart, approve) is not decided here.
8. **The classic surface stays the default**, and is used whenever stdout is
   not a TTY, `NO_COLOR` is set, or the terminal is narrower than 90
   columns. Rendering stays hand-rolled ANSI; no TUI library.

Stage nesting is derived per lane from `StageStarted`/`StageCompleted`
pairs, as the classic surface does; events get no parent id. Cost is an
estimate from `TokensUsed` and the pricing that `llm4ts costs` uses, shown
as `~$`.

## Consequences

- The new events are additive; the trace keeps schema version 1 and older
  readers skip kinds they do not know. `llm4ts costs` is unaffected.
- `StageStarted` and other emitters do not change. `Roster` and the story
  judge gain a publish each; `RosterSeats` stops publishing prose.
- The layout is fixed to the video's shape: orchestrator box, judgment box,
  up to three lane boxes with the other stories as status chips, judge-seat
  rail, session log, status line. The prototype showed three executor
  columns truncate names at 90 columns; lane boxes use short labels and the
  expanded lane shows the full text.
- The judge seat is borrowed for every task review as well as for the story
  verdict, so the rail counts reviews and verdicts separately and the log
  shows verdicts, not leases.
- Refine rounds (ADR 0021) are a header field and a collapsed strip of the
  finished round above the live one.

## Not decided here

- Controls: pausing a lane, restarting or approving a story from the view.
- A web renderer over the same core.
- Showing flows other than `epic-stories` beyond the generic lane view.
- Retiring the classic status block.
