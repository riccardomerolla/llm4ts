# Public error projection: category, retryable, remediation

Give operators what the tagged errors already know: a pure projection
`category` and `retryable` over the core `LlmError` union and the flow
`FlowError` union, and a `remediation` sentence for the dozen errors an
operator meets, rendered by `describeFlowError`, the terminal and `watch`.
Item 7 of `docs/research/rea-gap-analysis.md` section 6; no ADR.

Driver: errors are typed for code (ADR 0001: tags, stable messages) but a
run ends with the tag's message and nothing about what to do; `watch` and
the report print it verbatim.

## Decisions

| Decision    | Choice                                                                                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projection  | `errorFacts(error): { category, retryable, remediation? }`, a pure function over `_tag` (and a field or two where the tag is not enough, e.g. HTTP status); no new fields on the error classes.                                                            |
| Category    | `credentials \| provider \| usage-limit \| workspace \| merge \| contract \| configuration \| internal`.                                                                                                                                                   |
| Retryable   | True for transient provider and rate-limit errors, a `Stalled` with `no-progress`, a flaky gate; false for contract, perimeter, configuration and parse errors.                                                                                            |
| Remediation | One sentence, no secrets, for at least: `RosterExhausted`, `UsageLimitError`, `EpicCheckoutDirty`, `MergeConflict`, `PerimeterViolation`, `ContractConflict`, `DecisionsInvalid`, `OpenPointsPending`, `ProviderError` with 401/403, `WatchTargetMissing`. |
| Rendering   | `describeFlowError` appends the remediation after the message when present; `Terminal.ts` colours by category; `watch` shows category and remediation on a failed story line.                                                                              |
| Drift       | A test asserts every tag in both unions has a projection entry; a new error without one fails the test.                                                                                                                                                    |

## Modules

- `packages/core/src/Errors.ts`: `errorFacts` for the core union.
- `packages/flow/src/FlowError.ts`: `errorFacts` for the flow union,
  delegating to core for wrapped causes; `describeFlowError` rendering.
- `packages/runner/src/Terminal.ts`, `Watch.ts`: category and remediation.

## Tasks

- [ ] Core projection with the exhaustive-tag test.
- [ ] Flow projection with delegation and the same test.
- [ ] Remediations for the listed errors; a test that none contains a
      key-like token (reuse `Redaction.ts` patterns).
- [ ] `describeFlowError`, terminal, watch rendering; snapshot tests.
- [ ] `docs/api.md` errors section, `docs/configuration.md` where a
      remediation names a variable, CHANGELOG.

## Tests

Pure and exhaustive over the unions; rendering snapshots with the plain
palette.

## Non-goals

Error codes as a published schema; changing any message; automatic retry
on `retryable` (the connectors' retry policy stays where it is).
