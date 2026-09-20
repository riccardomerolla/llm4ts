# Judgment Evaluation Baseline (Decision Map Phase 1)

Order: after the typed-judgments foundation (commit `2d41abc`, ADR 0017).
Blocks Phase 2 (local candidates compared) and every automated consumer.
Route and gates: `docs/judgment-decision-map.md`. Vocabulary: `CONTEXT.md`.

## Why

The foundation can answer questions but cannot yet say how good an answer
is for any llm4ts decision. Local answers carry no calibration evidence
(`origin.calibration: none`), their confidence is nearly always 1.0, and
the only safeguard is `support`. Before any consumer acts on a judgment,
the project needs, per decision, a held-out labelled set, the measures a
gate can read, and a stream of real observations from which a local
scorer can later be trained. This spec establishes all three without
automating anything: every consumer runs in observe mode.

## Selected decisions

In order; each is one consumer already wired to the `Judgment` service:

1. **Review lens pre-screen**: one Truth per lens over a diff
   (`prescreenReviewers`, `packages/flow/src/Review.ts`).
2. **Empty-diff confirmation**: one Truth over the coder's reply
   (`satisfiedByJudgment`, `packages/flow/src/Flow.ts`).
3. **Program judge dimensions**: one Score per rubric dimension over spec
   and diff (`judgeWithJudgment`, `packages/core/src/eval/Judge.ts`,
   consumed by `ProgramJudge`).

## Shape

### Observe mode on every consumer

- A `JudgmentMode` literal in `packages/flow/src/Judgment.ts`:
  `observe | advise | act`. Default `observe` wherever a consumer takes a
  judgment; `act` is what the current code does when the option is on and
  stays reachable only by explicit choice.
- Each consumer, in `observe`, runs its judgment **and** its full path,
  then publishes one typed flow event per question,
  `JudgmentObserved { consumer, key, decision, certainty, support, origin,
outcome }`, where `outcome` is what the full path produced (the lens's
  issues by severity, the literal token match, the generative judge's
  score). In `advise` the same event is also rendered to the operator. In
  `act` the consumer behaves as today.
- Nothing in observe mode changes a run's result, tokens aside.

### Observation capture

- A schema-validated observation record (`JudgmentObservation`: run id,
  consumer, timestamp, state, question, answer, outcome, judgment
  identity) appended as JSON lines under
  `.llm4ts/judgments/<consumer>.jsonl` through `PlainFileStoreShape`, by a
  small `JudgmentLog` in flow subscribed to `JudgmentObserved`. Off unless
  a flow enables it; never committed by the engine (the modernization
  phases decide what to commit, as with other artifacts).
- State is captured verbatim (it is the training input); secrets follow
  the existing `Classified` rules and are never written.

### Labelled sets

- `tools/judgment/datasets/<decision>.jsonl`: one record per item
  (`state`, `question`, `label`, `source`, `labelledBy`, `labelledAt`),
  30 to 100 items per decision, held out from anything a scorer trains on.
- `pnpm judgment:label <decision>`: seeds candidate items from llm4ts's own
  history (the replay commits' diffs per lens; recorded coder replies;
  program-judge slices from a modernization fixture) into a pending file a
  human fills in; the tool refuses to promote an unlabelled item.
- The first sets are labelled by the user; the spec does not assume a
  second labeller, but records the field so agreement can be measured
  later.

### Measures and the report

- `pnpm judgment:eval <decision> [--backend ...]`: runs one judgment
  backend over a labelled set and prints, per decision and overall:
  accuracy; expected calibration error (10 equal-width bins over the
  label probability) and Brier score; for the pre-screen, missed issues by
  severity when the answer would have skipped the lens; latency p50 and
  p95 per question; the judgment seat's resident memory (from the server
  process) at rest and peak. Backends: `llm` on any connector, `typesafe`,
  and later the trained scorer, selected exactly as the runner does.
- `pnpm judgment:replay` gains the same calibration and missed-issue
  columns and reports reviewer-seat and judgment-seat tokens separately
  (already done for tokens).
- Reports are committed under `docs/judgment/evals/<date>-<decision>.md`
  so a later checkpoint is compared against a fixed baseline.

### The shared-prefix batching design point

The partial replay (2026-09-20) showed the pre-screen's judgment seat
re-sending the diff once per lens, costing as many tokens as the review it
screens. Add `LlmJudgmentConfig.batching: independent | shared-prefix`:
`independent` is today's behaviour (Jev's answer independence);
`shared-prefix` asks every question of one request in a single local call
whose state prefix is sent once, each question still scored as its own
label read. Measure both in `judgment:eval` on the pre-screen set (accuracy
and calibration, tokens, latency) before choosing a default. Neither mode
is allowed to change answers' `support` semantics.

## Gate to leave the phase

- Labelled sets exist for the three decisions with at least 30 items each.
- `judgment:eval` reports exist for the `llm` backend on `mlx-lm` and, if
  a key is available, for `typesafe`, committed under `docs/judgment/evals/`.
- Every consumer runs in observe mode by default and observations reach
  `.llm4ts/judgments/` in a real run (the dogfood loop or a modernization
  rehearsal).
- The batching comparison is recorded, with a chosen default.

Nothing automates on this phase's evidence alone; Phase 4 gates each
consumer separately on a `measured` checkpoint.

## Tasks

- [ ] `JudgmentMode` and the `JudgmentObserved` event; consumers 1 to 3
      honour `observe` (default), `advise`, `act`, with fake-judgment tests
      showing the full path still runs and the event carries the outcome.
- [ ] `JudgmentObservation` schema and `JudgmentLog` (JSON lines through
      `PlainFileStoreShape`), memory-store tests, secret handling test.
- [ ] `tools/judgment/label.ts` (`pnpm judgment:label`): seeding from
      history, pending file, refusal to promote unlabelled items.
- [ ] `tools/judgment/eval.ts` (`pnpm judgment:eval`): the measures above,
      markdown report, deterministic test on a fake backend and a tiny
      fixture set.
- [ ] `judgment:replay`: calibration and missed-issue columns.
- [ ] `LlmJudgmentConfig.batching` with `shared-prefix` implemented on
      `LlmJudgment` (one call, per-question label reads), tests on the fake
      LLM for both modes.
- [ ] Label the three sets (user), run the evals on `mlx-lm` and record the
      reports; run the batching comparison and record the chosen default.
- [ ] `docs/judgment-decision-map.md`: mark Phase 1 done with the report
      links; `docs/api.md` and `docs/flow-authoring.md`: observe mode.
