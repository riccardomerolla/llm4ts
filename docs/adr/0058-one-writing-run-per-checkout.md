# ADR 0058: One Writing Run Per Checkout, And A Red Epic Fails

Status: Accepted · Date: 2026-11-24 · Extends ADR 0041, ADR 0056

## Context

ADR 0041 decided that a repository has one writing run at a time (decision
7). The check lives in the operator server's registry, so it holds only for
runs that one server process started. A review of a possible Temporal
integration (2026-11-22) showed what that leaves open, each case run against
the built CLI with a stub coding agent:

- Two operator processes that start a run on one repository at the same
  moment both start it (8 of 8 rounds).
- `llm4ts run` from a terminal beside a supervised run is never refused.
- A flow whose parent was killed keeps running, and a retry starts a second
  flow beside it.

In each case both runs coded every plan task and committed it twice, and the
cut-off journal (ADR 0056) counted the first, still-live run as cut off.

Two more cases leave a writer behind with no run alive:

- A coding agent outlives a flow that was killed with SIGKILL. The next run's
  commit held both agents' lines.
- A process the coding agent started outlives a graceful stop. The stop
  returned, the process kept writing, and the next run committed its writes.

The review also found that a caller cannot trust how a run ended: an epic
with `0 done, 1 failed, 1 waiting` exited 0 with `RunEnded{outcome:"completed"}`.

## Decision

1. **The flow process holds the lock.** `runWithBundle` takes it before the
   run writes anything, and releases it when the run's scope closes. Every
   route to a flow passes there: `llm4ts run`, the operator server, a flow
   script run with `node`. The check in the operator's registry stays; it
   answers before a process is spawned.
2. **The lock is a file outside the checkout:**
   `${XDG_STATE_HOME:-~/.local/state}/llm4ts/locks/<name>-<8 hex>.json`,
   the hex from the SHA-256 of the checkout's real path. Coders have deleted
   `.llm4ts/` (ADR 0041), and a coder that could remove the lock could let a
   second writer in. It holds the run's pid, run id, flow, start time and
   the process groups of its running children.
3. **Taking it is one step across processes.** A guard file created
   exclusively (a hard link, so it is never seen half-written) serializes
   check-and-take. A guard whose process is dead is removed.
4. **A dead holder gives the lock up, unless its children live.** The lock
   is free when the holder's pid is gone and none of its recorded process
   groups has a live member. While one does, a new run fails: the checkout
   may still be written to.
5. **A refused run fails with `CheckoutBusy`** before its trace, its ledger
   line or any plan task exists. It names the holder's run id, flow and pid,
   or the process groups left behind and the lock file to remove if they are
   not that run's. The operator's `start_run` answers `RunInProgress` with the
   same text when the lock is held by a run its registry does not know.
6. **Every child process leads its own process group**, and ending the child
   ends the group. This applies to coding agents, gates and setup commands
   alike (`NodeProcessExecutor`). The turn's processes end with the turn, the
   stop or the run. A flow that exits without its finalizers (a second
   Ctrl-C) kills its children's groups on the way out, since they no longer
   share the terminal's foreground group. Not on Windows.
7. **Read-only runs take no lock.** `FlowRunnerOptions.readOnly` marks a run
   that writes nothing to the checkout but its own run state; `epic-retro`
   and `chief` set it, the two flows the operator already lets run beside a
   writing one.
8. **`LLM4TS_WRITER_LOCK=off` turns the lock off** for a run. The operator
   sets it for its children under `--parallel-runs` above 1, where the owner
   has asked for runs side by side.

9. **A red epic fails its run.** A run on the story spine (`epic-stories`,
   `epic-stories-board`, `epic-mvp`, `epic-draft`) that leaves stories
   failed or waiting ends with `EpicUnfinished`: the process exits 1 and the
   trace ends `RunEnded{outcome:"failed"}`. It is raised last, after the
   board, the report, the flow's own after-unit files (`debt.md`,
   `parked.md`) and the retro hint are written, so nothing a red run left
   before is missing. Before, such a run exited 0 and ended `completed`, and
   a script or supervisor could not tell it from a finished epic.

## Considered options

- **Keep the check in the operator and make it cross-process.** Rejected: a
  run from a terminal never passes the operator.
- **The lock under `.llm4ts/` or in the git directory.** The first is
  writable and deletable by coders. The second needs a git call before
  anything else and a checkout that is a git repository.
- **Record child pids, not process groups.** A pid says nothing about what
  the child started; the case with a surviving subprocess stays open.
- **Kill a child's group only when the child is still running.** Rejected:
  a subprocess left by a turn that ended normally is the same writer.
  A command that means to leave a daemon running starts it in its own
  session, which this does not touch.
- **Make the flow die with its parent.** Not done. A flow left by a killed
  server is a run ADR 0041 already describes; it finishes, and the lock
  refuses a second one meanwhile.
- **Wait for the lock instead of failing.** Rejected: a run that starts
  hours later on a changed checkout is not what was asked for.

## Consequences

- A second writing run on a checkout fails at once, whoever started it. Two
  epics on one checkout, which shared its working tree before, are refused
  as well.
- A flow that only reads but does not set `readOnly` is refused beside a
  writing run. `LLM4TS_WRITER_LOCK=off` is the way round until it is marked.
- Coding agents and gates no longer have a controlling terminal: a child
  that prompts on `/dev/tty` fails instead of waiting. Under the operator
  this was already so.
- A subprocess a coder leaves running in the background is ended with the
  turn.
- A stale lock is only as good as pid liveness: a recycled pid can hold a
  lock for a run that is gone. The error names the file to remove.
- Two users, or two values of `XDG_STATE_HOME`, on one checkout do not see
  each other's lock.
- ADR 0056's count of cut-offs is no longer raised by a run that is alive.
- `llm4ts run epic-stories … && next` stops at a red epic. A script that
  ran `epic-retro` after any run must now run it on failure too.
- `epic-mvp` ends failed when a story failed, as well as saying "MVP not
  reached"; parked items alone do not fail it.
- A trace's `failed` now covers a red epic as well as a run that broke; the
  error line and the board tell them apart.

## Open

Reported by the same review, not decided here:

- **Children inherit the parent's environment.** Only `LLM4TS_*` is removed
  on the way to a coding agent, so any credential in the launching shell
  reaches it.
