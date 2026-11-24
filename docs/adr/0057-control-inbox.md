# ADR 0057: A Control Inbox For Running Epics

Status: Accepted · Date: 2026-11-22 · Extends ADR 0013, ADR 0041

## Context

ADR 0041 gave a supervisor typed reads of a run and three acts: start a
run, stop a run, approve a retro. It named the next project in its
consequences: steering a running story (retry, skip, add a story, approve a
mid-run proposal) "needs a control inbox the scheduler polls".

A person cannot change what a live epic does. The story scheduler
(`implementStoriesFlow` in `packages/flow/src/Stories.ts`) decides alone:
a failed story stays failed until the whole flow is run again, its
dependents wait with it, and a story that is burning tokens can only be
stopped by stopping the run. The scheduler already has the states a
command would move a story between (`ready`, `running`, `failed`,
`waiting`); nothing outside the process can reach them.

A person also cannot see in one place what is waiting for them: approval
markers in documents (`Approval.ts`), a roundtable or taskforce stopped on
`AgendaPending` or `PlanPending`, a retro report. That is the second half
of an inbox. It shares the name and the listing with the first, not the
code, and it follows in its own release (see Considered options).

A gap analysis against a published agent-platform blueprint
(2026-11-22) ranked the inbox first of three gaps, for the same reason
ADR 0041 did: unattended runs need one human surface.

## Decision

Decisions the owner made:

- **The first release is commands only**: what a person tells a live run.
  The listing of what waits for a person follows.
- **Two commands, retry and skip.** Holding and resuming launches is left
  out: stopping the run already drains it, and it resumes from its files.
- **A skipped story always holds its dependents**, as a failed one does.
- **The scheduler polls** the log every two seconds; it does not watch the
  file.

The design:

1. **Commands are lines in a log outside the checkout.** Per repository and
   epic: `${XDG_STATE_HOME:-~/.local/state}/llm4ts/control/<repo key>/<epic>.jsonl`.
   Outside the checkout for the reason ADR 0041 moved its registry there:
   coders have deleted `.llm4ts/`, and a coder that could write this file
   could steer its own run. `<repo key>` is the directory name plus eight
   hex characters of the SHA-256 of the repository's real path, so two
   checkouts with one name never share commands. The log is append-only
   and written through `PlainFileStoreShape.append`, one line per call, as
   `runs.jsonl` and `costs.jsonl` are.
2. **Two kinds of line.** A `ControlCommand` is `{ id, at, by, command }`:
   `id` is supplied by the writer or generated, and a second command with
   an id already in the log is ignored, as `start_run`'s `requestId`;
   `by` says where it came from (`cli`, `mcp`, `chat:<user id>`) and is
   recorded, not authenticated. A `ControlReceipt` is
   `{ id, runId, at, outcome }` with outcome `applied`, `refused` (with a
   reason) or `expired`. A command with no receipt is pending. Both are
   Effect schemas in a versioned union.
3. **The commands.**
   - `RetryStory { story }`: a story that failed in this run becomes ready
     again, and dependents held as "waiting for" it are released. Refused
     when the story is running, done, or not in the plan.
   - `SkipStory { story, reason }`: a story not yet started is not
     launched; a running one is interrupted, so its finalizers run and its
     lease is released. Either way it is recorded `skipped` on the board
     with the reason, and its dependents wait as they do for a failed
     story. Refused when the story is done. A dependent that does not
     need the skipped story's code is freed by editing its `dependsOn`
     between runs, not by the command.
4. **A command is for the run that is live when it is written.** A run
   that starts writes an `expired` receipt for every pending command it
   finds, and a run that ends does the same for what it leaves. Nothing
   carries over to a later run: a rerun already retries failed stories,
   and a skip meant for last week's run must not fire today. A writer
   needs no liveness check; a command written with no run live is simply
   expired by the next one.
5. **The scheduler polls.** `ControlInbox` is a service in `flow`
   (`packages/flow/src/Control.ts`) with `pending(epic)`, `receipt(…)` and
   `submit(…)`; the scheduler's wait races the completion queue and the
   roster's capacity change with a poll of `pending` every two seconds.
   Deciding what a command does is a pure function over the scheduler's
   progress and the plan, returning the new progress or a refusal, so it
   is tested without a clock or a file. The file-backed layer takes its
   root directory from the runner; `makeMemoryControlInbox` is the in-src
   fake. A flow run without the service behaves as today.
6. **A run whose last story failed still ends.** The scheduler does not
   stay alive waiting for a retry: once nothing is running and nothing is
   ready, the run ends and expires what is pending. Retrying then is
   running the flow again.
7. **Every command leaves a trace line.** `ControlApplied` and
   `ControlRefused` (`{ id, command, story, by, reason? }`) are flow
   events, so the watch views show them and `run_wait` returns them as
   meaningful events. `StoryStatusChanged` gains an optional `reason`,
   which the operator design also owed: a story skipped or failed says
   why on the event, not only on the board.
8. **Tools on the operator server.** `story_retry` and `story_skip` take
   `repo`, `epic`, `story` and an optional `requestId`, and are registered
   only under `--allow-run`: whoever may start and stop a run may steer
   it. `control_list` is always registered and returns an epic's pending
   commands and its last receipts. Each tool returns once the command is
   written; the outcome is the receipt, read through `control_list` or
   seen as the event in `run_wait`.
9. **A CLI verb for a person at a terminal.** `llm4ts inbox` lists;
   `llm4ts inbox retry <story>` and `llm4ts inbox skip <story> --reason …`
   write. `--epic` names the epic when the repository has more than one.
   The verb and the tools call the same functions, and neither needs the
   operator server running, because the log is a file.
10. **Scope is the story scheduler.** Every flow on that spine gets it
    (`epic-stories`, `epic-stories-board`, `epic-mvp`, `epic-draft`). The
    plan-task loops of `implement` are not steered in this release.

As built:

- The epic's name in the log is its state folder under `.llm4ts/epics/`,
  which a plan's own `epicId` need not match. The flows pass it to the
  scheduler; the tools and the CLI accept only a folder found on disk.
- The repository key and the state directory are the ones the writer lock
  uses (ADR 0058): `checkoutKey` and `stateHome` in the runner.
- A retry is also refused once the run launches no further story (a serving
  engine that is down, a dirty epic checkout). A skip of a running story is
  refused when the story ended on its own before the interrupt landed.
- `story_skip` takes an optional `reason`; without one the board says
  "skipped by the operator". The CLI requires `--reason`.
- A run that ends with a skipped story ends with `EpicUnfinished` and exits
  non-zero (ADR 0058): the epic is not finished.
- Both events are a line on the terminal at every verbosity and a digest in
  `run_wait`. The agent tree and the web view take the story's new status
  from `StoryStatusChanged`; they do not show the log.

## Considered options

- **Commands in `.llm4ts/epics/<id>/`.** Rejected: a coder can write and
  delete there, and the deny list is of uneven grade across harnesses
  (ADR 0029). A coder could retry or un-skip its own story.
- **One file per command, renamed into place.** Safer under several
  writers than appending, but `PlainFileStoreShape` has no listing, and
  two existing ledgers already rely on single-line appends. Revisit if a
  torn line is ever seen.
- **Watch the log instead of polling.** Rejected: `fs.watch` differs by
  platform and filesystem, needs a polling fallback anyway, and is harder
  to fake. Two seconds is short beside a story.
- **A signal or the run's stdin.** Rejected: a signal carries no payload,
  and stdin exists only for a supervised child.
- **A socket or HTTP endpoint in the flow process.** Rejected: flows listen
  on nothing today, and a file outlives the reader and the writer, like
  every other piece of run state.
- **Hold and resume launches.** Left out: stopping the run drains it and a
  later start resumes from files. A held run with nothing running would
  stay alive and keep its repository's one writing slot (ADR 0041
  decision 7).
- **A flag on skip that releases dependents.** Rejected: they would start
  without code they declared they need. The plan's `dependsOn` is where
  that is corrected.
- **A separate `--allow-steer`.** Rejected for now: steering is weaker
  than stopping a run, which `--allow-run` already grants.
- **Add a story to a live run.** Deferred. It changes the plan the resume
  rules hash, and a new story needs the planner and, by default, a red
  phase (ADR 0053). `--refine` between runs stays the way.
- **The requests half in this release.** Deferred to its own ADR. The
  sketch: a flow that writes a draft approval marker, or ends with
  `ApprovalRequired`, `AgendaPending` or `PlanPending`, publishes a
  `RequestRaised` event; a pure fold in `runner` lists those whose
  document is still unapproved, so the marker stays the only truth;
  `approve` on the operator server takes a request id. It touches every
  flow that writes a marker and none of the code above.
- **`ask_user` answered through the inbox.** Deferred. An
  `InteractionShape` that writes a question and waits for an answer line
  is small, but the autonomy contract tells coders nobody answers
  mid-task, only one connector offers the tool, and a turn that waits an
  hour for a person meets the stall timeouts. It belongs with unifying the
  two MCP servers (ADR 0041 decision 11).
- **Push delivery.** Still rejected: `run_wait` returns the new events.

## Consequences

- A person, a bot on the operator server, or later the Chief (ADR 0052)
  can retry or skip one story without stopping the other lanes.
- `skipped` becomes a status the scheduler records, not only one the board
  and the event schema allow. `OutcomeStatus` and the epic report gain it.
- A command can take up to two seconds to apply, and a tool call returns
  before it has. A client that needs the outcome reads the receipt.
- `llm4ts inbox` ships listing only commands. The name is kept for the
  release that adds requests, so the verb does not change then.
- The operator registry still keys a repository by directory name alone
  (ADR 0041 decision 4). Moving it to the hashed key is a separate change.
- Not in this release: a watch view of the log, and retry or skip in the
  Chief's typed action set.
