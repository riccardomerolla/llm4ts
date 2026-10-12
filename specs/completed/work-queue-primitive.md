# Work queue primitive

A `@llm4ts/flow` module for the third shape of autonomous work: many
independent items with a filesystem definition of done, worked in rounds
under a concurrency cap, failures becoming the next round's items, progress
in a ledger, a typed stall when a round finishes nothing. Design record:
ADR 0028 decision 1. Built 2026-10-06 (`flow/src/WorkQueue.ts`).

## Decisions (agreed 2026-10-06)

| Decision    | Choice                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| Done        | A caller-supplied predicate over the filesystem; the queue re-checks it after the work, whatever the work said.     |
| Rounds      | Items not done are worked; failures go to the next round; default 3 rounds; no progress in a round → `Stalled`.     |
| Ledger      | One JSON line per item per round (`QueueOutcome`: status, ms, note, confidence, todos); readable with `readLedger`. |
| Visibility  | Each item is a lane: `StageStarted/Completed/Failed` with `lane: item.id`, so watch and profile show items.         |
| Commit hook | `afterRound(round, done, failed)`: the flow commits what the round finished.                                        |

## Tasks

- [ ] `WorkQueue.ts` with `runQueue`, `QueueOutcome`, `readLedger`; tests for
      resume, failure rounds, no-output failure, stall, ledger.
- [ ] `Stalled` gains `no-progress`.
- [ ] Used by `port-files` and `port-compile` (see `port-flow-family.md`).

## Non-goals

Worktree sharding; a DAG between items (that is a story plan); a judge per
item.
