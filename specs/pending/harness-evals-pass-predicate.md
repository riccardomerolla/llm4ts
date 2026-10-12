# Harness evals: a pass predicate and a claim manifest

Make the light fixture grade itself: a claim manifest next to the fixture
listing what a correct run shows, and `llm4ts profile --check <expect.json>`
printing pass or fail per claim over the facts `Profile.ts` already folds,
plus a repeated-identical-call count read from the trace. Item 5 of
`docs/research/rea-gap-analysis.md` section 6; no ADR.

Driver: the harness-evals ledger (`docs/harness-evals/README.md`) is empty
because the protocol ends in reading two profile tables by eye; rea's
evaluation lane is one predicate, which is why it runs.

## Decisions

| Decision | Choice                                                                                                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest | `examples/epic-light.expect.json`: a list of claims `{ name, fact, op, value, story? }` over the profile's JSON fields; ops `eq`, `lte`, `gte`, `contains`.                                                                                                   |
| Claims   | Inherited failure listed exactly once; oracle marker count zero after `counter-history`; every story merged; fabricated-status count zero; explore calls before first edit per story at most N (N from the first measured run); repeated identical calls ≤ M. |
| New fact | `repeatedIdenticalCalls` per story: tool name plus normalized arguments seen more than once in one task, folded from `ToolUse` events in `Profile.ts`.                                                                                                        |
| Command  | `llm4ts profile --check <path> [--repo] [--json]`; prints one line per claim with the measured value; exit 1 when any claim fails.                                                                                                                            |
| Ledger   | The protocol in `docs/harness-evals/README.md` gains step 5: `--check` output saved beside the profile; a release in the ADR 0027 line ships only when `--check` passes before and after.                                                                     |

## Modules

- `packages/runner/src/Profile.ts`: `repeatedIdenticalCalls`, `Claim`
  schema, `checkClaims(profile, claims)` pure.
- `packages/shell/src/Cli.ts`: `--check` on `profile`.
- `examples/epic-light.expect.json`, `docs/harness-evals/README.md`.

## Tasks

- [ ] `repeatedIdenticalCalls` folded and printed; replay test on a trace
      fixture with a repeated `read` call.
- [ ] `Claim` schema and `checkClaims`; pure tests for every op.
- [ ] `--check` flag, output and exit code.
- [ ] The manifest for the light fixture, values taken from the planted
      table in the README (counts that need a first run are left at a
      generous bound and tightened by the first ledger entry).
- [ ] README step 5 and the "ships with" rule; CHANGELOG.

## Tests

A recorded trace of the light fixture (no credentials: the trace file is
the fixture) folds to a profile on which the manifest passes; the same
trace with one `ToolUse` duplicated fails the repeated-calls claim with the
measured value in the line.

## Non-goals

Running the epic in CI; claims over cost; a general assertion language.
