# ADR 0045: epic-stories --defer-tests — Missing Tests Become Debt

Status: Accepted · Date: 2026-10-29 · Extends ADR 0031, ADR 0043, ADR 0044

## Context

In epic-stories the story judge scores four dimensions. `tests` below the
bar is a Warning; at 0 it is Critical (`judgeSeverity`). So a story with no
tests fails, even with `--defer-findings`. A user who wants the code now and
the tests in a later round had two ways out, and neither fits:

- `testsDeferred` in the plan. It is meant for code that runs only in a live
  runtime, it changes the story's hash (the story restarts from scratch),
  and nothing records the tests as owed.
- `epic-draft` (ADR 0043). It drops tests for the whole epic up front, under
  one lens and one review round.

What is missing: run epic-stories at its normal standard, accept a story
whose judge finds tests missing, and plan those tests afterwards.

## Decision

1. **`--defer-tests` on epic-stories** (or `LLM4TS_DEFER_TESTS=1`). epic-mvp
   and epic-draft do not take it: the runner rejects the unknown flag.
2. **Only the judge's `tests` score is excused, at any value, 0 included.**
   - The judge still scores `tests`. The score stays in the verdict, and the
     judge's reasoning goes to the verdict's `excused` list.
   - Below the maximum, the score is never a finding. The judge is told the
     tests may be deferred, and not to lower another dimension because they
     are missing.
   - The coder is still asked for tests, and the `test` lens still reviews.
   - A red test gate still fails the story: a missing test is debt, a broken
     test is not.
   - The plan and `storyHash` are unchanged, so no story restarts.
3. **The judge's bar is part of its cache key** (`StoriesOptions.judgeBar`).
   A verdict judged under one bar is never reused under the other. This is
   the main use case: a story that failed on `tests 0`, rerun with
   `--defer-tests`, is judged again rather than failed again by the cached
   verdict.
4. **The debt is the same `debt.md` epic-draft writes.** After each unit
   (the epic or a round), one section per merged story whose last verdict
   scored `tests` below the maximum, excluding stories whose plan already
   defers tests and stories a hardening round has paid. Each section lists:
   - the score and the judge's reasoning;
   - each acceptance outcome as `- [ ] test: …`.

   Deferred findings are left out. With `--defer-findings` they already get
   their own follow-up round (ADR 0031); listing them here would plan them
   twice.
5. **`epic-stories --harden` pays it.** It plans the open debt as a refine
   round under the full standard, the same as `epic-draft --harden`, and
   marks the debt paid once that round settles. The harden code moves to
   `flows/lib/debt.ts`, shared by both flows. The run that writes the debt
   only names the command: it does not start the round, so the debt can be
   read first. `--harden` with `--defer-tests` is a usage error.

## Consequences

- A team can merge an epic whose tests are missing and still have every owed
  test listed, against the story's own acceptance criteria.
- The judge's `tests` score is the only signal for what is owed. A judge that
  scores tests at full while the `test` lens still has findings owes nothing;
  those lens findings are carried in `findings.md` as before.
- Old `judge.json` files decode unchanged; `excused` is optional.
- No `llm4zio` parity impact: the epic flows are llm4ts-only.

## Not decided here

- Starting the hardening round automatically (`--then-harden`).
- Excusing other judge dimensions, or the `test` lens's own findings.
