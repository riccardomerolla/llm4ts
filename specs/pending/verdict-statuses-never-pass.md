# Verdict statuses that never aggregate to pass

Give `ProgramJudge` and `modernize-verify` five verdict statuses, `pass`,
`fail`, `truncated`, `unsupported`, `unknown`, of which only `pass`
aggregates to pass; force `truncated` when the judged context was capped
and `unsupported` when a coverage rule required a captured vector and got
none. ADR 0039 decisions 4 and 5; item 3 of
`docs/research/rea-gap-analysis.md` section 6.

Driver: `Provenance.contextTruncations` records that a judge saw part of a
spec, but the verdict still counts; a generated vector can satisfy a rule
that ADR 0012 says needs a captured one; both are enforced by reading the
report, not by type.

## Decisions (ADR 0039)

| Decision    | Choice                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status      | `VerdictStatus = pass \| fail \| truncated \| unsupported \| unknown` in `Review.ts`, next to `ReviewResult`.                                                      |
| Program     | `ProgramJudge` returns, per program, a `ReviewResult` plus `status`; the cached verdict file gains the field and a cache entry without it is treated as `unknown`. |
| Truncated   | Forced when the truncations recorded for that program's judge call are non-empty, whatever the findings say; the result keeps the findings.                        |
| Unsupported | A `## Coverage:` rule with `required: captured` and no `captured` vector among the passing ones.                                                                   |
| Unknown     | The judge or comparison did not run (backend failure, skipped program, missing spec).                                                                              |
| Aggregate   | `aggregateStatus(statuses)` is `pass` only when every status is `pass`; otherwise the worst by the order `fail`, `unsupported`, `truncated`, `unknown`.            |
| Exit        | `modernize-verify` exits non-zero on any non-pass; the report prints a status line per program and per rule, and a one-line summary with counts per status.        |
| Pack        | `required: captured` is a new optional key on a `## Coverage:` rule (`CoverageRule.required?`); absent keeps today's behaviour; `modernize-pack-check` accepts it. |
| Provenance  | `gateVerdicts` values gain the status word; `equivalenceReport` names unsupported rules.                                                                           |

## Modules

- `packages/flow/src/Review.ts`: `VerdictStatus`, `aggregateStatus`.
- `packages/flow/src/ProgramJudge.ts`: status per program; the judge call
  records its truncations (the caller already folds `renderTruncation`
  strings into `Provenance`; the per-program split is new).
- `packages/flow/src/SpecChecks.ts`, `Pack.ts`: `CoverageRule.required`;
  `## Coverage:` parsing and `modernize-pack-check`.
- `packages/flow/src/Equiv.ts`, `EquivReport.ts`: `unsupported` per rule,
  status column in the report.
- `flows/modernize-verify.ts`: exit code and summary; `Provenance` update.
- `kits/`: the bank packs set `required: captured` where ADR 0012 applies.

## Tasks

- [ ] `VerdictStatus` and `aggregateStatus`; pure tests for the order.
- [ ] `ProgramJudge` status with forced `truncated`; cache compatibility
      test (old entry reads as `unknown`, is re-judged).
- [ ] `CoverageRule.required` parsed and checked; pack-check test.
- [ ] `Equiv` marks `unsupported`; report shows a status column.
- [ ] `modernize-verify` exit and summary; provenance fields.
- [ ] Bank packs updated; one existing approved pack re-verified and the
      result noted in the PR.
- [ ] `docs/parity.md` divergence note, `docs/flow-authoring.md`, pack
      authoring docs (`skills/authoring-llm4ts-packs`), CHANGELOG.

## Tests

Deterministic with the modernize fixtures and `makeMemoryWorkspace`: a
judge call whose spec is capped yields `truncated` with findings intact; a
rule `required: captured` exercised only by a generated vector is
`unsupported` while an unmarked rule passes; `aggregateStatus` of
`[pass, truncated]` is `truncated`; `modernize-verify` on that fixture
exits 1 and prints both statuses.

## Non-goals

Statuses on story verdicts (the story judge's dimensions already fail
below the bar); retrying truncated judges automatically; changing what is
truncated.
