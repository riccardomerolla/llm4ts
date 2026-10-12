# A typed wait for human input

Make "waiting on a person" a recorded state instead of an absence: when a
run needs an answer or an approval and no operator is at the terminal, write
a `Wait` record, mark the story `waiting` with the question as its detail,
and resume from the answer on the next run (or in-run, when the operator
returns). The idea is `effect/workflow`'s `DurableDeferred` (a durable
result an external party completes) distilled onto llm4ts's state folder
(assessment of 2026-10-12). ADR 0038's unknowns ledger carries the open
question; this spec carries the answer path. ADR only if the in-run
blocking wait lands (it changes resume semantics); the record-and-exit form
is additive.

Driver: `ask_user` and `approve` (`McpServer.ts`) answer through
`TerminalInteraction` and have nothing to do when no one is there;
`requireApproval` (`Approval.ts`) fails with `ApprovalRequired` and the
operator edits a marker and reruns; `watch` shows a failed story, not a
question.

## Decisions

| Decision   | Choice                                                                                                                                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Record     | `Wait { id, kind: question \| approval, story, task?, prompt, toolName?, askedAt, answer?: { text \| allow \| deny, by, at } }` in `packages/flow/src/Wait.ts`; `id` is `fingerprintOf(kind, story, task, prompt)`.                                                                          |
| Path       | `.llm4ts/epics/<id>/waits.jsonl`, append-only like the unknowns ledger; a later line with the same id supersedes; for flat plans, `<state>/waits.jsonl`.                                                                                                                                     |
| Raise      | `InteractionShape` gains a recording implementation used when stdin is not a TTY or `--unattended` is set: `askUser`/`approve` append an unanswered `Wait`, fail the turn with a typed `WaitingOnHuman`, and the story ends `waiting`. `requireApproval` does the same for approval markers. |
| Answer     | `llm4ts answer <wait-id> "<text>"` and `llm4ts approve <wait-id>` / `deny` (shell commands appending the answered line); editing the file by hand is equivalent.                                                                                                                             |
| Resume     | On the next run, a story in `waiting` whose waits are all answered restarts its task; the recording interaction returns the stored answer for a matching id without asking; an unanswered wait keeps the story `waiting`.                                                                    |
| In-run     | Behind `LLM4TS_WAIT_POLL=<seconds>` (default off): instead of failing the turn, poll the file until answered, with a `Timed` of `waiting` so `profile` attributes the time; this is the part that needs an ADR.                                                                              |
| Visibility | `Board.wait(id, reason)` carries the question; `watch` lists open waits with their ids; the epic report and the retro digest list unanswered waits; the unknowns ledger gets an `open` record with `closes: human-answer` and a resolution on answer.                                        |
| Safety     | Answers are data: an answer to a question is shown to the model as the human's reply; an approval answer is enforced by `CapabilityGuard`'s policy, never trusted from the model's claim.                                                                                                    |

## Modules

- `packages/flow/src/Wait.ts`: schema, id, append, fold, `WaitingOnHuman`
  (a `FlowError` member), `recordingInteraction(files, path, clock)`.
- `packages/flow/src/Approval.ts`: `requireApproval` records a wait before
  failing.
- `packages/flow/src/Stories.ts`: `waiting` on `WaitingOnHuman`; resume
  check on start.
- `packages/runner/src/FlowRunner.ts`, `TerminalInteraction.ts`: choose the
  recording interaction when not a TTY or `--unattended`.
- `packages/shell/src/Cli.ts`: `answer`, `approve`, `deny`.
- `packages/runner/src/Watch.ts`, `Profile.ts`, `Retro.ts`: visibility.

## Tasks

- [ ] `Wait.ts` with schema, id, append, fold; pure tests including
      supersede.
- [ ] Recording interaction; `ask_user` under no TTY ends the story
      `waiting` with the question as detail; the same id answered resumes
      without asking.
- [ ] `requireApproval` records; the marker path still works.
- [ ] Shell `answer`/`approve`/`deny`; a test on the appended line.
- [ ] Watch, report, retro and unknowns-ledger integration.
- [ ] In-run poll behind the variable, with the ADR, as a separate PR.
- [ ] `docs/configuration.md`, `docs/flow-authoring.md` (interaction seam),
      `docs/parity.md` additive note, CHANGELOG.

## Tests

Deterministic with `makeMemoryPlainFileStore`, a fake clock and the story
fixtures: a question with no TTY yields one unanswered wait and a
`waiting` story; appending an answer and rerunning passes it to the coder
as the reply; an approval answered `deny` fails the tool call as
`ApprovalDenied`; the in-run poll resolves under the fake clock.

## Non-goals

A notification channel (the board tools already mirror `waiting`); a web
form; answering through the model; timeouts that auto-approve.
