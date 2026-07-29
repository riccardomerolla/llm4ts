# Review Loop Robustness At The Structured-Output Boundary

Found by the dogfood loop's first real run (connector-tests spec, task 2). The
reviewer seat (claude, read-only) returned a `ReviewResult` whose issue omitted
`confidence`. Decoding failed hard —
`SchemaError(Missing key at ["issues"][0]["confidence"])` — which failed
`reviewAndFixLoop`, rolled back the task, and aborted the whole flow. One
slightly-off reviewer reply should not kill an otherwise healthy run.

## Root cause

`ReviewIssue.confidence` (and `description`, and `ReviewResult.summary`) use
`Schema.withConstructorDefault(...)`. Constructor defaults apply to `.make()`
only — they do **not** apply when decoding unknown JSON at the LLM boundary,
so the field is effectively required from the model's perspective. This
pattern likely exists on other LLM-boundary schemas too.

## Tasks

- [ ] Make `ReviewIssue.confidence`/`description` and `ReviewResult.summary`
      tolerant at decode time (decoding-side defaults or optional-with-
      normalization), keeping constructor ergonomics. Audit other schemas
      decoded from model output (`Planner`, `PrSummary`, judge/eval schemas)
      for the same constructor-default-at-decode-boundary mistake.
- [ ] Verify `reviewJsonSchema` (and sibling hand-written JSON schemas) marks
      truly-optional fields as optional so the model is not misled.
- [ ] Add one bounded retry in `reviewWith` on `ParseError`: re-ask the
      reviewer with the parse error appended, before failing the flow.
- [ ] Regression tests: reviewer output missing optional fields decodes; a
      persistently malformed reviewer fails typed after the retry.

## Related finding: no-op task diffs

Task 2 failed while reviewing a diff that "does not add the described test" —
because the coder had already folded that test into task 1's commit, so task
2's diff was empty of new work. `implementPlanFlow`/the loop should
short-circuit tasks whose diff is empty (skip review, mark complete with an
Info event) instead of asking reviewers to review nothing.

- [ ] Empty-diff short-circuit in the per-task loop, with a test.

## Harness note

The loop run was invoked as `pnpm loop ... | tee log`, which masked the
non-zero exit (no pipefail). Document `set -o pipefail` (or direct invocation)
in `tools/loop/README.md`.

- [ ] README note.
