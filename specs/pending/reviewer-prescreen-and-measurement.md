# Review Lenses: Truth Pre-Screen, With A Replay To Prove It

Order: last; after `judgment-flow-helpers`. ADR 0017. The pre-screen goes
on by default only when the replay passes its acceptance bar.

## Why

The seven review lenses (`packages/flow/src/Review.ts`) each run a full
generative pass over the diff. Most diffs have nothing for most lenses. One
judgment fan-out of Truth questions over the diff ("does this diff plausibly
introduce a security issue", one per lens) costs one state prefix and seven
single-token answers, and lets the flow skip lenses the screen rates
unlikely. This is Jev's speculative fan-out and confidence-gated routing on
the most expensive step in the engine.

## Shape

- `prescreenReviewers(context, diff, lenses, policy)`: builds one request
  with the diff as state and one Truth question per lens (each lens
  declares its screening statement); returns the lenses to run. A lens
  runs when its truth is above the policy's act threshold for the answer's
  origin, or when the answer failed, was escalated, or has low support
  (never skip on
  doubt).
- `reviewAndFixLoop` option `prescreen?: JudgmentPolicy | false`, default
  `false` until the replay passes.

## Measurement

`tools/judgment/replay-review.ts`: for the last N commits of a repo
(default 30, this repo), run the full lenses and the pre-screened variant on
each commit's diff with the same reviewer seat and judgment seat; report
per commit and in total: review tokens, wall time, lenses skipped, issues
lost (an issue reported by a lens the pre-screen skipped), by severity.
Output as markdown to stdout. Runs outside CI; needs a local model.

Acceptance to flip the default to on: zero Critical issues lost and at least
40% fewer review tokens on the 30-commit sample.

## Measurement runs

- 2026-09-20, partial (3 of 30 commits; the run was stopped when the 30B
  reviewer plus the 4B judgment seat swapped the 36 GB machine; a full run
  needs the reviewer loaded with a bounded context, `lms load <model>
--context-length 32768`, and nothing else running): reviewer
  `qwen/qwen3-coder-30b` on LM Studio, judgment `Qwen3-4B-Instruct-2507`
  on mlx-lm. Reviewer-seat tokens 87,207 full versus 43,168 pre-screened
  (50.5% fewer); issues lost 0/0/0; judgment-seat tokens 93,223, about the
  same as the full review's, because the pre-screen re-sends the diff once
  per lens. Inconclusive on 3 commits; the bar applies to 30. The
  judgment-seat cost is the open design point: a shared-prefix batch of all
  screening questions in one local call would divide it by the lens count
  at the price of Jev's answer independence, and belongs in Phase 1 of
  `docs/judgment-decision-map.md`.

## Tasks

- [ ] Screening statement on each built-in lens.
- [ ] `prescreenReviewers` with fake-judgment tests: skip below threshold,
      run on failure or escalation, verbalized held to the higher bar.
- [ ] `reviewAndFixLoop` option, default off, event listing skipped lenses.
- [ ] `tools/judgment/replay-review.ts` and a `pnpm judgment:replay` script.
- [ ] Record the replay numbers in this spec and, if the bar is met, flip
      the default and note it in `CHANGELOG.md`.
