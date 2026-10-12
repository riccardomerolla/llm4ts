# A light epic-stories fixture for before/after comparisons

`examples/seed.sh epic` creates a small TypeScript repository with a
three-story epic and the failure modes ADR 0027 targets planted on purpose,
so a release can be compared live before and after in minutes rather than
hours. Release A of ADR 0027 (consequence: every release in this line is
compared on it).

Driver: the only epic fixture, `conto-bonifico` on the internet-banking
portal, is eight stories with full gates per task; the comparison has to be
run twice per release and must show the triage and the oracle guard firing
in a live run, not only in unit tests.

## Decisions (agreed 2026-10-06)

| Decision | Choice                                                                                                                                                                                                                                                                                                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape    | About ten files: `package.json` with `typecheck`, `lint`, `test` scripts (tsc, eslint, vitest), two feature folders (`src/features/greeting`, `src/features/counter`) each with one module and one test, one composition point (`src/app.ts`), a `CONTRIBUTING.md` with the house rules, a `README.md`.                                                                             |
| Epic     | Three stories: `format-contract` (a shared `src/contracts/format.ts`), `greeting-locale` and `counter-history` (depend on the contract, disjoint `owned`), gates in seconds.                                                                                                                                                                                                        |
| Planted  | (1) one pre-existing red test on `main` in a file no story owns, so triage must list it as `base`; (2) one `it.skip` in `counter` that the epic's acceptance says to restore, so the oracle guard sees a marker removed, not added; (3) `counter-history`'s acceptance can only be met by changing an existing test's expectation, and its plan entry declares `testsChange: true`. |
| Roster   | `examples/epic-light.roster.json`: reasoning seat Claude; coder priority 1 Pi harness with the Codex model, priority 2 Claude Code with `claude-sonnet-5-5`; usage-limit exclusion does the switch (ADR 0019).                                                                                                                                                                      |
| Protocol | Documented in `examples/README.md`: seed, run `epic-stories` with the roster before the release and after, then `llm4ts profile` on both; compare explore calls before first edit, review rounds, gate failures by origin, `FabricatedStatus` count, cost. The two profiles are kept under `docs/harness-evals/` as the first ledger entries.                                       |

## Tasks

- [ ] `examples/seed.sh epic` and the template files; `seed.sh implement`
      unchanged.
- [ ] The epic markdown with its `json storyplan` block checked by
      `validateStoryPlan` in a test (`examples/test`).
- [ ] The roster file and the protocol section in `examples/README.md`.
- [ ] A dry run in CI: seed into a temp dir, `pnpm install --offline` is not
      required; the fixture's own `pnpm test` must show exactly one red
      test and one skipped.
- [ ] `docs/harness-evals/README.md` explaining what a ledger entry is.

## Tests

Seeding into a temporary directory and running the fixture's gates yields
one failing test and one skipped; `validateStoryPlan` accepts the epic;
`owned` sets are disjoint.

## Non-goals

Replacing the portal rehearsal; measuring model quality beyond the profile
counters; a formal eval harness (phase 4.7 of the plan).
