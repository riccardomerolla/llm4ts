# One autonomy contract, and evidence checked against the transcript

Every coder system prompt carries the same contract paragraph from one
module; the task's `## Findings` trailer gains `verified:` and
`confidence:` lines; code cross-checks `verified:` against the transcript's
tool calls and flags a claimed command that never ran. Release A of
ADR 0027 (decisions 5–6).

Driver: flows each hand-write their own autonomy rules; Anthropic's model
guides define the contract an unattended coder needs (nobody is watching;
act; scope is the task; minimal change; no test gaming; evidence not
claims) and report that auditing progress claims against tool results
"nearly eliminated fabricated status". Transcripts are already on for
epic-stories (ADR 0025), so the check costs no model call.

## Decisions (agreed 2026-10-06)

| Decision   | Choice                                                                                                                                                                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract   | `flow/src/AutonomyContract.ts` renders one paragraph; built-in flows use it and drop their overlapping sentences; custom flows import it.                                                                                                                                                                                     |
| Profiles   | Roster entry field `contract: full \| minimal \| off` per executor (default `full`); `minimal` keeps scope and no-test-gaming rules only, for models that over-verify under the full text.                                                                                                                                    |
| Trailer    | `## Findings` gains `verified: <command>` (repeatable) and `confidence: high \| medium \| low`; parsed by `CarriedNotes` helpers; absent lines are allowed and noted.                                                                                                                                                         |
| Check      | Each `verified:` command is matched (normalized, substring) against the transcript's `Tool` entries for that task; a miss is a `FabricatedStatus` Warning appended to the story findings, counted in the profile, a retro signature. API coders (no `Tool` entries) get one Info: "no tool transcript, evidence not checked". |
| Confidence | Shown to the judge with the task plan; counted in the profile; no automatic action.                                                                                                                                                                                                                                           |

## Modules

### `packages/flow/src/AutonomyContract.ts`

- `autonomyContract(profile): string` — the paragraph; `full` text: nobody
  is watching and nobody answers questions; act, do not announce; the task
  is the scope, never narrowed or widened; make the minimal change; a
  pre-existing bug is a finding, not a fix; scratch checks do not become
  permanent tests; never edit, skip or delete a test to pass; end with the
  commands you ran and their exit, not a claim.
- `ContractProfile` schema literal; roster `ExecutorEntry.contract`.

### `packages/flow/src/CarriedNotes.ts`

- `findingsRequest` asks for the two new lines; `parseTrailer(reply)` returns
  `{ notes, verified: string[], confidence? }`.

### `packages/flow/src/Evidence.ts`

- `checkEvidence(verified, toolEntries): ReadonlyArray<ReviewIssue>` — pure;
  normalizes whitespace and quoting; a command appears when any `Tool`
  entry's `args` contains it.
- Caller in `Stories.ts` after each task: reads the task's transcript slice
  (`Transcript.ts` entries between the task's `Call` and `End`), appends
  issues to `stories/<id>.findings.md`, publishes a `Timed`-style event the
  profile counts.

### Callers

- `Stories.ts` coder system prompt, `Flow.ts` task prompt, `implement`,
  `sdd`, `issue-pr`, `modernize-implement` prompts: replace their own
  autonomy sentences with the contract.
- `llm4ts profile`: per story, counts of `FabricatedStatus` and the
  confidence mix.
- Judge prompt: the task plan with each task's confidence beside it.

## Tasks

- [ ] `AutonomyContract.ts`, profiles, roster field; snapshot test of the
      three texts.
- [ ] Built-in flows adopt the contract; a diff review of each prompt
      confirms no rule was lost and no sentence is duplicated.
- [ ] Trailer parsing for `verified:` and `confidence:`; existing Findings
      parsing unchanged for replies without them.
- [ ] `Evidence.ts` and the `Stories.ts` caller; API coder Info path.
- [ ] Profile counters and judge visibility.
- [ ] Docs: roster documentation, `docs/flow-authoring.md`, CHANGELOG.

## Tests

A reply claiming `verified: pnpm test` with a transcript whose only tool
call is `ls` yields one `FabricatedStatus`; the same reply with a `Tool`
entry whose args contain `pnpm test` yields none; a transcript with no
`Tool` entries yields the Info; profiles render the three contract texts;
a flow prompt snapshot shows the contract once.

## Non-goals

Judging the quality of the verification; forcing a coder to run anything
(the gates are the truth about the code); per-customer free-text contract
edits.
