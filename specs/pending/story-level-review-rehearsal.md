# Rehearsal: story-level review against per-task review

ADR 0044 moves the review lenses from each task to one review per story,
merged with the story judge, with incremental re-checks. Fakes prove the
mechanics; only a live run shows whether it is faster without losing
quality.

This is a **live rehearsal**, run by the user with authenticated seats. It is
not work for the autonomous loop. Findings become fixes or ADR notes, not
edits to this file.

## Targets

- Review time per story at least **50% lower** than the sum of the per-task
  review time for the same story today.
- **No more** judge revisions than the per-task run.
- **No more** findings carried into the retro than the per-task run.

## Setup

- One epic from a real slow run (a Gemini or ESQL epic), seeded twice, so
  both runs start from the same commit.
- The same roster for both runs.

## Checklist

- [ ] Count tasks per story in the chosen epic; the saving should scale
      with it.
- [ ] `epic-stories --review-at task` run to merged; record
      `llm4ts profile --epic <id> --json`.
- [ ] `epic-stories` (story review, the default) run to merged; record its
      profile.
- [ ] `llm4ts profile --against` across the two runs: review time, fix time,
      gate time, wall-clock.
- [ ] Judge revisions and carried findings compared.
- [ ] Story diff sizes recorded by the profile; note the largest.
- [ ] Stop one run during the story review and restart it: it resumes at
      the review, at the right round, without redoing the tasks.
- [ ] Quality check: read both diffs. Did the per-task run catch anything
      real that the story review missed?
