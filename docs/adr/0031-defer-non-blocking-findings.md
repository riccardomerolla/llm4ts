# ADR 0031: Defer Non-Blocking Findings To A Follow-Up Round

Status: Accepted · Date: 2026-10-07

## Context

An epic's first story is usually the one every other story depends on (the
contract, the shared component, the route shell). Until it merges, no other
story starts. That is the story that spends the most time in review:

- a task's review settles only when it has **no** findings
  (`ReviewResult.isClean` ignores severity), so a naming Warning or a
  test-coverage Info is sent back to the coder like a crash, for up to three
  rounds;
- the rubric judge (`subBar`) turns any dimension under 2/2 into a
  Critical, so a story with thin tests or minor drift gets a revision task
  and, on the last round, fails and holds every dependent.

Findings that do not stop a dependent from building on the story are paid for
in the critical path, one story at a time, instead of in parallel at the end.

## Decision

`epic-stories --defer-findings` (or `LLM4TS_DEFER_FINDINGS=1`) turns on a
lighter review. It is opt-in, and runs without it behave as before.

1. **Blocking means Critical.** `isBlocking(issue)` is `severity ===
"Critical"`. `reviewAndFixLoop` gains `settle: "clean" | "blocking"`
   (default `"clean"`). With `"blocking"`, a round with no Critical findings
   settles before `maxRounds`. A red gate never settles early, whatever the
   severities of its lines.
2. **The judge's severity is graded.** A dimension below the bar is a
   Critical when it is `provides` (dependents build on it) or scores 0, and
   a Warning otherwise (a partial `scope`, `house-style` or `tests`). This
   grading applies whether or not deferral is on. Without deferral it changes
   only how findings are labeled, since any finding still fails the judge.
3. **Deferring, the judge clears a verdict with nothing blocking.** The
   story merges and its dependents start. A verdict with a Critical gets a
   revision and fails as before (`--judge-rounds`).
4. **Nothing is dropped.** A settled review round's leftovers (blocking ones
   too, when the rounds ran out, since the task commits them anyway) and a
   cleared judge's Warnings are written, when the story finishes, to
   `stories/<id>.deferred.md` (`deferredPath`) beside its findings log.
5. **Deferred findings become one refine round (ADR 0021).** When the
   epic's own stories are all merged, the run joins every story's deferred
   list, in plan order, as the round's feedback. It plans round `n` with
   `planRound`, which keeps its rules: plan what is clear, list the rest as
   not planned. Then it runs the round in the same invocation. The round is
   an ordinary round: `feedback.md`, `plan.md`, `not-planned.md`, sequential,
   and it must merge before `--land`.
6. **The follow-up does not loop.** Findings deferred inside a refine round
   are written and named in the run's output, never planned automatically.
   Neither are a plan's deferrals while a story is failed or waiting, nor
   when the epic checkout has uncommitted changes. A person passes them to
   `--refine`.

## Consequences

- The first story merges once nothing Critical is left, so parallel stories
  start sooner. The cost is a later round that touches files merged stories
  own, which ADR 0021 already allows.
- Severity now matters for flow control. Reviewers that label a real bug a
  Warning let it through to the follow-up round instead of fixing it in
  place. `demoteUnplaced` already moves an unplaced Critical down to a
  Warning, so under deferral that finding waits too.
- Deferred lists are collected in memory during a story's run and written
  when it finishes. A story interrupted and resumed keeps only what its
  resumed run found.
- No `llm4zio` parity impact: the epic flows are llm4ts-only.

## Not decided here

- Making deferral the default.
- A per-lens or per-repository severity policy (`.llm4ts/review-rules.md`).
- Planning a round's deferrals into a further round.
