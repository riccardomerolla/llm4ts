# ADR 0060: A Temporal Package That Runs Flows As Activities

Status: Accepted · Date: 2026-11-25 · Extends ADR 0041, ADR 0056, ADR 0057, ADR 0058, ADR 0059

## Context

Temporal gives a run durable orchestration: a workflow survives its worker,
retries what failed, and takes signals. A review of a first design (flows
as activities, built on the shell's run supervisor) ran it against a
Temporal dev server and the built CLI with a stub coding agent, and found
nine things that broke the intent. Four were llm4ts defects and became
ADR 0058. One (credentials reaching the coding agent) became ADR 0059. The
rest shaped this package:

- A cancellation reached the activity about 40 s late, and the workflow
  closed first: the next workflow on the checkout met a live run.
- The activity's retry policy had no end, so a task the cut-off journal
  (ADR 0056) refuses to start again was retried for ever.
- A retry after the first run's worker died returned the id of a run that
  did nothing; the work and its cost sat under another id.
- The package imported shell modules, which are not exported (ADR 0050): the
  layer check had no place for it and a packed install failed on import.
- Its workflow tests needed a server the SDK downloads, which the default
  test run may not do.

## Decision

1. **`@llm4ts/temporal` is a sixth package, one layer above the shell.** It
   imports public subpaths of `flow` and `runner` and no shell module.
2. **An activity runs the `llm4ts` bin, not a library call.** `runFlow`
   starts `llm4ts run <flow>` from the installed `@llm4ts/shell`, in its own
   process group. The flow it starts takes the writer lock, ends its own
   children and exits non-zero when it fails, as from a terminal. The
   activity adds no second copy of those rules.
3. **A run's id is derived, not random:**
   `tw-<workflow id>-<activity id>-<attempt>`, given to the run as
   `LLM4TS_RUN_ID`, with its trace at `.llm4ts/trace-<run id>.jsonl`. A
   later attempt finds the runs of earlier ones without being told, so the
   heartbeat carries nothing.
4. **Before it starts anything, an attempt looks for those runs.** One that
   completed is the result. One that is alive (it holds the writer lock) is
   waited for, and its id is the result. One that was cut off is resumed by
   a run of this attempt. A checkout another run holds fails the attempt as
   `CheckoutBusy` with nothing started.
5. **The result is read from the run, not from the exit code alone.** A run
   completed when the process exited 0 and its trace's last line says
   `completed`. That line now carries the `_tag` of the failure a failed run
   ended with.
6. **Failures are typed, and the retry policy reads the type.**
   `InvalidRequest`, `FlowFailed` and `TaskCutOff` are final;
   `CheckoutBusy`, `RunCutOff` and `LaunchFailed` are retried, four
   attempts in all by default. The cut-off limit is a tagged error of its
   own, `TaskCutOff`, so it can be told from any other stop.
7. **A cancelled workflow closes after its run is gone.** The activity is
   called with `WAIT_CANCELLATION_COMPLETED`. On cancellation it interrupts
   the run's process group (what Ctrl-C does), waits, then kills the group
   and the groups the writer lock names, and only then reports the
   cancellation. The heartbeat timeout is 20 s and the worker's heartbeat
   throttle is capped at 5 s, so the request arrives within seconds.
8. **Signals go through the control inbox.** `retryStory` and `skipStory`
   become `steerRun` activities that append one command to the epic's
   control log (ADR 0057). The command's id is derived from the workflow and
   its sequence number, so a retried activity writes it once.
9. **Nothing secret enters history.** Inputs name a checkout, a flow, its
   arguments and `LLM4TS_*` settings; a setting whose scope is `secret` is
   refused. The activity adds `TEMPORAL_*` to the run's
   `LLM4TS_CHILD_ENV_DROP` (ADR 0059).
10. **The rules are testable without a server.** Options, failure
    classification and ids are a pure module (`Policy`); the activities are
    Effects over a `FlowHost` and run against a fake one, and through
    Temporal's `MockActivityEnvironment`; the workflow file is bundled in a
    test. Tests against a dev server and the built CLI are opt-in
    (`LLM4TS_TEMPORAL_LIVE=1`).
11. **The package is not published yet.** It is `private` in its manifest:
    npm trusted publishing is set up per package, so the first publish is
    the owner's step. Its version moves with the others.

## Alternatives

- **Call the run supervisor in process.** It is a shell module, and it
  would make the worker the flow's parent in process: a worker that dies
  takes the knowledge of its runs with it.
- **Carry the run id in the heartbeat.** A worker killed before its first
  heartbeat leaves nothing; a derived id needs no delivery.
- **Retry every failure.** A red epic or a refused request fails the same
  way each time, and each retry costs model calls.

## Consequences

- A workflow gets durable, retried, cancellable flow runs with one writer
  per checkout, on the rules the CLI already enforces.
- The worker must run where the checkout is, and needs `@llm4ts/shell`
  installed beside it.
- The workflow file is written against Temporal's promise API, not Effect:
  it runs in Temporal's deterministic sandbox, which cannot host a runtime.
- Windows is not supported, as for the rest of llm4ts: stopping a run relies
  on process groups.
- `RunEnded` gains an optional `error` field, and the cut-off limit fails
  with `TaskCutOff` where it failed with `Aborted`.
- A run that outlives its worker is waited for by the next attempt, up to
  that attempt's start-to-close timeout.
- Not covered: Temporal Cloud specifics (namespaces, mTLS, API keys), worker
  versioning, and a workflow over several flows; `flowRun` is one run.
