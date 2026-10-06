# Oracle guard: no deleted or skipped tests without saying so

A deterministic check beside the perimeter that fails a story's gate round
when its diff deletes test files, adds skip or focus markers, or lowers the
passed-test count, unless the story's plan entry declares `testsChange:
true`. Release A of ADR 0027 (decision 4).

Driver: the Bun port's merge condition was "0 tests skipped or deleted", and
Anthropic's guidance treats the test suite as immutable from the agent's
side. Today nothing in llm4ts notices a coder skipping a test to go green;
the judge might, after the fact, if it reads the diff closely.

## Decisions (agreed 2026-10-06)

| Decision    | Choice                                                                                                                                                                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signals     | (1) deleted test files, from the diff; (2) added skip or focus markers, from the diff's added lines; (3) a drop in the passed-test count between the baseline and the story's test gate output, only when a summary line parses; otherwise skipped with an Info.                                                       |
| Severity    | A gate failure: blocks the round, feeds the coder "restore the tests or declare the change", fixable within `maxRounds`.                                                                                                                                                                                               |
| Declaration | Story field `testsChange: true`, optional, in `storyHash` only when set (a plan edit restarts the story as ADR 0013); for flat plans an `implementPlanFlow` option. `sdd` sets it for its red phase.                                                                                                                   |
| Patterns    | Defaults for Vitest/Jest (`.skip`, `.only`, `xit`, `xdescribe`, `test.todo`), JUnit (`@Ignore`, `@Disabled`), pytest (`@pytest.mark.skip`), Rust (`#[ignore]`); test file detection by the pack's `tests:` regex or a default (`*.test.*`, `*.spec.*`, `__tests__/`, `src/test/`). A pack extends both in `## Oracle`. |
| Scope       | Every `reviewAndFixLoop` caller that has a diff: epic-stories, `implement`, `sdd`, `issue-pr`, `modernize-implement`.                                                                                                                                                                                                  |

## Modules

### `packages/flow/src/OracleGuard.ts`

- `OracleRules` schema (`testFiles: RegExp source`, `markers: string[]`) with
  `defaultOracleRules`; `parseOracleSection(pack)` for `## Oracle`.
- `checkOracle(diff: { deleted: string[], addedLines: Array<{ file, line, text }> }, counts?: { base, current }, rules): ReadonlyArray<ReviewIssue>` —
  pure; one Critical per deleted test file, one per added marker with
  `file:line`, one for a count drop; empty when `testsChange` is set.
- `passedCountIn(output): number | undefined` — recognizes the Vitest,
  Jest, pytest, cargo and JUnit summary lines; `undefined` otherwise.

### Callers

- `Stories.ts`: the oracle gate joins the perimeter gate in the per-task
  `lint`; the story's `testsChange` is read from its plan entry.
- `Flow.ts`: `implementPlanFlow({ oracle?: { rules, testsChange } })`.
- `sdd` flow: `testsChange: true` while writing red tests, off afterwards.
- `StoryPlan.ts`: `testsChange` optional field, in the hash only when set;
  the planner prompt names it for stories that must rewrite tests.

## Tasks

- [ ] `OracleGuard.ts` with rules, `checkOracle`, `passedCountIn`;
      table-driven tests over the default patterns and the summary formats.
- [ ] `StoryPlan` field, hash rule, planner prompt mention; existing plan
      fixtures still hash identically.
- [ ] Wire into `Stories.ts` as a gate; into `implementPlanFlow` as an
      option; `sdd` declares its red phase.
- [ ] Pack `## Oracle` section parsed and merged with defaults; the
      `j2ee-nextjs` and `soap-ace` packs checked against their test layouts.
- [ ] Docs: `docs/flow-authoring.md`, pack authoring skill note, CHANGELOG.

## Tests

A story diff that deletes `foo.test.ts` fails the round with a Critical
naming the file; the same diff with `testsChange: true` passes; an added
`it.skip` is a Critical with `file:line`; a count drop is reported only when
the fixture output has a summary line; a pack `## Oracle` adding `@Flaky`
makes it a marker.

## Non-goals

Judging whether a test was wrong (the coder reports that as a finding);
counting assertions; running tests the gates do not run.
