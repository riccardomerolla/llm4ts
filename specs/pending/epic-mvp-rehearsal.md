# Rehearsal: `epic-mvp` against `epic-stories` on the epic-light fixture

`epic-mvp` shipped in 2.47.0 (ADR 0042). Every test so far runs against fakes.
Customers asked for it because epic-stories was too slow and reviewed too
much. The target agreed on 2026-10-22: **at least 50% less wall-clock to an
MVP than epic-stories**, with fewer model calls and every MVP outcome green.
Only a live run can measure that.

This is a **live rehearsal**, run by the user with authenticated seats. It is
not work for the autonomous loop. Findings become fixes or ADR notes, not
edits to this file.

## Setup

- The epic-light fixture (`docs/harness-evals/README.md`), seeded twice,
  so each flow gets a fresh copy of the same epic.
- The same roster for both runs, for example `examples/epic-mvp.roster.json`.
- The fixture's test gate writes a JUnit report: vitest
  `--reporter=default --reporter=junit --outputFile=reports/junit.xml`,
  then `LLM4TS_TEST_REPORT=reports/junit.xml`, with `reports/` in `.gitignore`.

## Checklist

- [ ] `epic-stories` run to merged; record `llm4ts profile --epic <id> --json`.
- [ ] `epic-mvp` run to "MVP reached"; record its profile the same way.
- [ ] `llm4ts profile --against` across the two runs. Is the MVP wall-clock
      at most 50% of epic-stories? Fewer model calls?
- [ ] The plan's cut makes sense to a human: MVP outcomes testable, `later`
      and `mvp-cut.json` hold the right things.
- [ ] Every red phase proved its tests red, and none parked "already green"
      wrongly.
- [ ] The test review caught a vacuous or detail-only test at least once, or
      we note that it never fired.
- [ ] No coder edited a frozen test (look for "frozen red test changed" in
      the findings).
- [ ] `--land` refused before the MVP was reached and landed after.
- [ ] `--iterate` planned the parked items as round 1, and that round ran
      test-first.
- [ ] Quality check: read the landed diff. Is anything the four lenses or
      the judge would have caught a real defect in the MVP?
