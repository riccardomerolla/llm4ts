# Rehearsal: `epic-draft` against `epic-stories` and `epic-mvp`

`epic-draft` ships with ADR 0043. Every test so far runs against fakes.
Prospective users asked for a much faster flow that defers tests and
validation to a later iteration. The target: **a draft in at most 30% of
epic-stories' wall-clock**, and draft plus `--harden` no slower than
epic-stories, with the test gate green at the end. Only a live run can
measure that.

This is a **live rehearsal**, run by the user with authenticated seats. It is
not work for the autonomous loop. Findings become fixes or ADR notes, not
edits to this file.

## Setup

- The epic-light fixture (`docs/harness-evals/README.md`), seeded three
  times, so each flow gets a fresh copy of the same epic.
- The same roster for every run, for example `examples/epic-mvp.roster.json`.
- For epic-mvp, the JUnit report setup from `epic-mvp-rehearsal.md`.

## Checklist

- [ ] `epic-stories` run to merged; record `llm4ts profile --epic <id> --json`.
- [ ] `epic-mvp` run to "MVP reached"; record its profile the same way.
- [ ] `epic-draft` run to merged; record its profile.
- [ ] `epic-draft --harden` run to merged; record its profile.
- [ ] `llm4ts profile --against` across the runs. Is the draft at most 30%
      of epic-stories? Is draft plus harden at most epic-stories?
- [ ] `debt.md` lists every merged story's acceptance outcomes, and the
      deferred findings the stories wrote.
- [ ] The test gate's failures on the epic checkout were captured (seed one
      red test in the fixture to be sure the path runs).
- [ ] The harden round wrote the owed tests and ended with the test gate green.
- [ ] `debt.paid.md` holds what the round paid; a second `--harden` with no
      text stopped with "--refine needs the feedback to plan a round from".
- [ ] Quality check: read the draft's diff before hardening. Is anything
      the lenses or the judge would have caught a real defect?
