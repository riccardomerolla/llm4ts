# Rehearsal: `epic-stories-board` on the demo repo

Postponed on 2026-09-30. `epic-stories-board` shipped in 2.15.0 as a fork of
`epic-stories` whose story judge is a blackboard ruleset (ADR 0020,
`flows/lib/story-board.ts`, design in
`docs/superpowers/specs/2026-09-28-story-board-design.md`). It has only run
against `FakeJudgment`. Before the ruleset judge can replace the rubric judge
in `epic-stories`, it needs a live run on the demo repository and a
side-by-side comparison with the rubric judge on the same stories.

This is a **live rehearsal**, run by the user with authenticated seats; it is
not work for the autonomous loop (it needs provider credentials and a local
model, which default CI must not). The checklist below is what the run must
establish; findings become fixes or ADR notes, not edits to this file.

## Why it matters

The fork exists to answer one question: is the ruleset judge good enough to
become the default? Unit tests prove the wiring; they cannot say whether
four Score judgments from a real backend clear the stories the rubric judge
clears, hold the ones it holds, and give the coder feedback it can act on.
Three known risks from the 2.15.0 review are only measurable live:

- **Feedback quality.** Issues carry the rubric level's text, not the
  model's reasoning, so a coder may get less to act on than from the rubric
  judge.
- **Certainty on local models.** ADR 0017's spike found local log-probs
  fully peaked (probability 1.00 on the chosen label, including wrong
  answers). Under the default policy that means `act` on every answer, so
  the bar would reduce to the score alone; a verbalized backend is held to
  0.95 and may `hold` everything instead. Either extreme makes the
  `unsure` path the norm or dead code.
- **Prompt size.** The judge's State is the capped diff **plus** up to 24k
  characters of CONTRIBUTING.md, which can exceed the context budget the
  diff cap was meant to guarantee.

## Setup the run needs

- Demo repository: `~/demo/portal` (the internet-banking fixture; runbook
  `examples/internet-banking/RUNBOOK.md`). Its epic "Conto e Bonifico"
  finished 8/8 on 2026-09-25, so the rehearsal needs **a second epic** or a
  clean copy of the repository at the pre-epic commit. Decide which before
  the run; a fresh copy gives a like-for-like comparison with the recorded
  rubric-judge run.
- Global `llm4ts` at 2.15.0 or later.
- Seats: the reasoner and coder of the last green rehearsal (roster of
  ADR 0019), plus a judgment seat: `LLM4TS_JUDGMENT_PROVIDER` /
  `LLM4TS_JUDGMENT_MODEL`. Run once with a log-prob backend (`mlx-lm`) and
  once with the reasoning seat as the judgment fallback (variable unset).
- Command: `llm4ts run epic-stories-board --repo <path> "<epic>"`, same
  flags as `epic-stories`.

## What the rehearsal must establish

- [ ] The fork runs an epic end to end on the demo repository: plan, waves,
      judge rounds, merges into the epic branch, report.
- [ ] Every judge round leaves a `BlackboardRun` line in the trace and four
      lines in `.llm4ts/judgments/story-board.jsonl`; the run's `judge`
      firing names the backend and checkpoint actually used.
- [ ] Agreement with the rubric judge: for each story, record both verdicts
      on the same diff (rubric: `epic-stories`; ruleset: the fork) and the
      rounds each needed. State the agreement rate and list every
      disagreement with the dimension that caused it.
- [ ] The decision distribution per backend: how many answers were `act`,
      `caution`, `hold`, and how many "unsure" issues reached a coder.
      Decide whether the default `JudgmentPolicy` thresholds suit the story
      judge or the fork needs its own.
- [ ] Coder feedback: for every not-cleared round, whether the coder's next
      turn addressed the issue. If the level text is not enough, specify
      what the issue should carry instead.
- [ ] Prompt size: the largest judge State in characters against the
      context budget; whether house rules must be capped or dropped from
      the State.
- [ ] Outage behaviour: stop the judgment backend during a judge round and
      confirm the story waits for recovery instead of failing.
- [ ] Cost and time per story against the rubric judge, from the run's cost
      summary (figures marked as estimates where they are).
- [ ] A recommendation, with the evidence above: promote the ruleset judge
      to `epic-stories`' default, keep the fork and iterate, or drop it.

## Follow-ups this rehearsal is expected to feed

- Escalating `hold` answers to the reasoning seat (`judgeOrEscalate`)
  instead of spending a coder round on an "unsure" issue.
- Adding the `story-board` consumer to `JudgmentDataset.DatasetDecision`,
  so `pnpm judgment:label` can seed a dataset from the rehearsal's log.
- The landing decision as a second ruleset, if the story bar proves itself.

## Out of scope

Changing the ruleset, the bar or the policy before the first run: the
rehearsal measures 2.15.0 as shipped.
