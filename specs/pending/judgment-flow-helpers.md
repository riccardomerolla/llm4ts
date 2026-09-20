# Flow: Judgment Policy, Escalation, And Answer Cache

Order: after `core-judgment` and `judgment-seat`. `reviewer-prescreen-and-measurement`
depends on it. ADR 0017.

## Why

Core answers questions and reports their origin; it never decides what to
do with a number. Policy is a flow concern: bands that depend on
calibration evidence and extraction method, a minimum support, escalation
of low-confidence answers to a reasoning model, and not re-asking what has
not changed (keyed on the judgment identity, so a swapped checkpoint never
reuses its predecessor's answers).

## Shape

`packages/flow/src/Judgment.ts`:

- `JudgmentPolicy`: one typed value per flow. Bands keyed by calibration
  evidence (`measured`, `claimed`) and otherwise by method, with defaults
  stricter for `verbalized` than for `logprobs`, plus `minSupport`
  and `calibrated` (for example act at 0.9 / 0.8 / 0.8, escalate below
  0.6 / 0.5 / 0.5). Jev's advice, kept: questions and thresholds in one
  reviewable place.
- `judgeOrEscalate(context, request, policy)`: runs the judgment; for each
  answer below the escalate threshold, asks the `reasoning` seat the same
  question through `executeStructured` and replaces the answer with
  origin method `reasoning` with `escalated` set; publishes an event per
  escalation; a reply that gives its chosen option no mass fails and keeps
  the earlier answer.
- `cachedJudgment(store, request)`: fingerprint of state, questions, and
  backend id, persisted like `cachedReview` (`packages/flow/src/ReviewCache.ts`),
  so re-runs re-judge only what changed.
- `decide(answer, policy)`: `act | caution | hold` from confidence and
  origin and support, the three bands Jev documents.

## Tasks

- [ ] `JudgmentPolicy` schema with defaults and a test that verbalized is
      held to a higher bar than logprobs.
- [ ] `judgeOrEscalate` with tests on the fake judgment and fake LLM:
      no escalation above threshold; escalation replaces the answer and
      marks the origin; escalation failure keeps the original answer and
      publishes.
- [ ] `cachedJudgment` with memory-store tests: hit, miss, backend change
      invalidates.
- [ ] `decide` with boundary tests.
- [ ] Consumer 3a: the empty-diff `TASK_ALREADY_SATISFIED` probe in
      `implementPlanFlow` becomes one Truth question with the coder's
      reply as state, behind an option defaulting to the current literal
      match.
- [ ] Consumer 3b: `ProgramJudge` gains a judgment-backed variant whose
      dimensions are Score questions over `{ spec, diff }`, same cache
      keying, same `ReviewIssue` output.
- [ ] `docs/flow-authoring.md` section with one fan-out example.
