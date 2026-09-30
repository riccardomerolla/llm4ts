# Agent tree dashboard for a running flow

Decided on 2026-09-30 in ADR 0022. The design was grilled from a video of a
"Claude Code agent tree" terminal view and checked with a throwaway prototype
on the branch `prototype/agent-tree`
(`tools/prototype/agent-tree.prototype.ts`), which renders a frame from a real
demo-epic trace. Run it before starting to see the target layout:

```bash
git show prototype/agent-tree:tools/prototype/agent-tree.prototype.ts > /tmp/agent-tree.ts
npx tsx /tmp/agent-tree.ts ~/demo/portal/.llm4ts/trace-1790260336550.jsonl
```

Target release: 2.20.0, additive. The classic status block stays the
default.

## Why it matters

`epic-stories` runs stories concurrently on a roster of executors, and the
current terminal shows one status row per lane. It cannot show which
executor holds which story, whether the roster is saturated, what the judge
last decided, or which stories are waiting and why. The trace already has
most of this; the view does not.

## Layout

At 90 columns, top to bottom:

- **Header and legend**: epic, judge seat, one colour per executor.
- **Left rail (judge seat)**: executor, last verdict, review calls, verdict
  calls, tokens read.
- **Orchestrator box**: epic, run action (`runAction`: RunPlan, RunRound n,
  PlanRound, Land), current non-lane stage, story and wave counts, elapsed.
- **Judgment box**: per story, `StoryJudged` score bars
  (`cleared → merge`, `blocked → coder`) or `JudgmentObserved` certainty
  bars (act / caution / hold).
- **Lanes**: up to three running stories as boxes: story, executor, current
  stage, last tool, elapsed, `~` tokens and `~$`, status. All other stories
  are chips (`✓ ◐ ✗ ⏸ ·`). Key `e` switches the lanes to one column per
  executor (lease, role, busy or idle, exclusion).
- **Session log**: the last lines of stage ends and failures, verdicts,
  roster leases, exclusions and handovers, merges, waiting and held stories.
  Tool calls and assistant text only in the expanded lane, or in the log at
  `LLM4TS_VERBOSITY=verbose`.
- **Status line**: stories done/total, running, failed, waiting; roster
  busy/total; `~$`; round.

## Seams to extend

- Events: `packages/flow/src/FlowEvents.ts` (union, `withLane`).
- Roster: `packages/flow/src/Roster.ts` (`say`, around line 465) and
  `packages/flow/src/RosterSeats.ts` (line 55).
- Story judge: `judgeStory` and `rubricStoryJudge` in
  `flows/lib/epic-stories.ts`; the judge loop in
  `packages/flow/src/Stories.ts`.
- Trace: `packages/flow/src/FlowRecorder.ts`, `readTrace` in
  `packages/flow/src/Replay.ts`.
- Terminal: `packages/runner/src/Terminal.ts` (`TerminalSurface`,
  `consumeTerminalEvents`, `quietTerminalInput`), `FlowRunnerOptions.surface`
  in `packages/runner/src/FlowRunner.ts`.
- Pricing: `packages/runner/src/Costs.ts`.
- Shell: `packages/shell/src/Cli.ts` (`runCommand`, command list),
  `packages/shell/src/FlowLaunch.ts`.

## Tasks

### Events

- [ ] `ExecutorLeased`, `ExecutorReleased`, `ExecutorExcluded` and
      `ExecutorResumed` in the `FlowEvent` union (executor, role, optional
      lane, reason for an exclusion, handover target when there is one),
      published by `Roster` and `RosterSeats` in place of the `roster:` `Info`
      lines.
- [ ] The classic terminal renders the roster events so its output reads as
      it does today (a test pins the lines).
- [ ] `StoryJudged` (lane, round, dimensions `{id, score, max}`, cleared)
      published by the story judge on every verdict, in `epic-stories` and
      `epic-stories-board`.
- [ ] The recorder appends a `RunEnded` trace line (outcome: completed,
      failed, interrupted) when the run's scope closes, including on
      interruption.
- [ ] `epic-stories` appends `{runId, tracePath, round, startedAt}` to
      `.llm4ts/epics/<id>/runs.jsonl` when a run starts.

### Core (`packages/runner/src/AgentTree.ts`)

- [ ] `TreeState` and `reduce(state, FlowEvent)`: lanes with a stage stack
      each, executors and leases, judge seat, judgment entries, session log,
      token and `~$` totals, run action and round, ended or live.
- [ ] `view(state, width, mode)`: the layout above, as lines of text with
      ANSI colour. Pure: no clock, no terminal size reads.
- [ ] A fixture trace with three concurrent lanes, one exclusion with a
      handover, one failed and one waiting story, `StoryJudged` and
      `JudgmentObserved` verdicts, and a `RunEnded` line.
- [ ] Golden-frame tests: fold the fixture to chosen sequence numbers and
      compare the frame text (colours stripped) at 90 and 120 columns, in
      both lane modes.

### Hosts

- [ ] `TreeSurface`: an alternative to the live terminal surface, fed from
      the hub, redrawn full-screen at most every 100 ms, with key input
      through `quietTerminalInput`. `q` returns to the classic surface for
      the rest of the run.
- [ ] `llm4ts run <flow> --ui tree` sets `LLM4TS_UI=tree` for the flow child;
      the runner picks `TreeSurface` when the variable is set, stdout is a
      TTY, `NO_COLOR` is unset and the terminal is at least 90 columns wide,
      and the classic surface otherwise.
- [ ] `llm4ts watch [trace] [--repo R] [--epic id] [--replay] [--speed n]`:
      with no trace, the newest `trace-*.jsonl` in the repository's
      `.llm4ts/`; with `--epic`, the latest entry of its `runs.jsonl`. It
      follows a trace without `RunEnded`, shows the last frame of one with
      it, and replays on timestamps with gaps over 2 s shortened.
- [ ] Keys in both hosts: `↑/↓` or `1–9` select a lane, `enter` expands it
      (stage stack, last 20 tool calls), `e` switches lanes/executors, `l`
      toggles the full log, `q` quits or detaches, `ctrl-c` keeps its
      meaning.
- [ ] Refine rounds: the header shows the round; `watch --epic` shows a
      finished earlier round as a collapsed strip.

### Docs and release

- [ ] README and the flow docs: `--ui tree` and `llm4ts watch`, with a
      frame.
- [ ] CHANGELOG entry for 2.20.0.

## Acceptance

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` pass;
      no test needs network, credentials or a provider CLI.
- [ ] Folding a trace written before these events renders without error
      (roster and judgment boxes show what the older events allow).
- [ ] `llm4ts watch --replay` on the demo epic's recorded trace renders
      every frame without an exception.

## Out of scope

Controls that act on a run, a web renderer, and retiring the classic status
block (ADR 0022, "Not decided here"). The live rehearsal (demo epic, demo
roster, `epic-stories-board`, `--concurrency 3`, one `--refine` round) is
run by the user after release; its findings become a follow-up spec.
