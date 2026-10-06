# Harness evals

Every change to a prompt, a gate, a compaction window, a default effort or a
cache header can move coding quality without any test going red (Anthropic's
April 2026 postmortem is the argument). This folder is the ledger: before and
after each release in the rewrite-grade loops line (ADR 0027), the same epic
runs on the light fixture with the same roster, and both `llm4ts profile`
outputs are kept here.

## The protocol

1. Seed the fixture: `examples/seed.sh epic` prints the path; `pnpm install`
   there once.
2. Run the epic with the comparison roster (Claude reasoning seat; Pi with
   the Codex model as the first coder, Claude Code with `claude-sonnet-5-5`
   as the second, so the roster's usage-limit exclusion does the switch):

   ```bash
   LLM4TS_ROSTER=examples/epic-light.roster.json llm4ts run epic-stories --repo <seeded path> -- --epic epic-light
   ```

3. `llm4ts profile --repo <seeded path>` on the run, saved as
   `docs/harness-evals/<version>-<before|after>.md`.
4. Compare, in this order: explore calls before the first edit per story,
   review rounds, gate failures by origin (`new`, `base`, `flaky`),
   `fabricated status` count, inherited failures listed, cost.

What the fixture plants, and what a correct run shows:

| Planted                                                     | Expected                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `src/platform/clock.test.ts` red on `main`, owned by nobody | listed once as inherited; every story merges                         |
| `it.skip` in `counter.test.ts`                              | removed by `counter-history`; the oracle guard reports no new marker |
| `counter-history` must change an expectation                | `testsChange: true` keeps the guard silent for that story only       |

The ledger is empty until the first release in the line runs it.
