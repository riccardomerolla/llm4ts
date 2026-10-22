# ADR 0042: epic-mvp — Test-First to an MVP

Status: Accepted · Date: 2026-10-22 · Extends ADR 0013, ADR 0021, ADR 0025, ADR 0027

## Context

Customers running `epic-stories` report that it works but is too slow, and
reviews too much, for some kinds of work. Every task goes through up to
three rounds of four review lenses. Every story then goes to the rubric
judge, which sends any score below 2 back for revision. The flow also
treats the epic as done only when every story and every outcome is done.
For greenfield or additive work, where a test can say what done means,
most of that is ceremony. Customers asked for a lighter flow that reaches
an MVP sooner and parks the rest for a later iteration.

Two pieces existed already. `flows/sdd.ts` writes red tests before any
code and aborts if they pass. The ADR 0025 acceptance criteria give each
story its outcomes. Nothing tied an outcome to a test, though: gate output
was parsed only for pass and fail counts. The design was settled in a
grilling session on 2026-10-22 (Q1–Q22).

## Decision

1. **A new flow on the same engine.** `llm4ts run epic-mvp` is its own
   program (`flows/epic-mvp.ts`, policy in `flows/lib/epic-mvp.ts`). It runs
   on `runEpicStories` and the story executor, so seats, rosters, worktrees,
   `--plan-only`, `--epic`, `--list`, `--land`, restart, `watch`, `profile`
   and `epic-retro` all work unchanged. `runEpicStories` takes a policy
   (`EpicStoriesOptions`): an optional story judge, `preflight`,
   `generatePlan`, `checkPlan`, executor options per unit (`stories`),
   `afterUnit`, `beforeLand`, `refineFeedback`, and `argv`. Behaviour
   without them is epic-stories' own.
2. **Input.** Either raw epic text or an approved epic-design brief. The
   planner parks items the brief marks deferred or dropped.
3. **The MVP cut lives in the plan.** A story's `acceptance` holds its MVP
   outcomes (one to four, each testable), and the new optional `later`
   holds the outcomes cut from this iteration. Stories the MVP does not
   need are kept out of `plan.md` and written to `mvp-cut.json`, so the
   epic can still land with every planned story merged. A human approves
   the cut by editing `plan.md`, as with epic-stories. `checkMvpPlan`
   rejects a story with no MVP outcome. `later` enters `storyHash` only
   when set, so existing plans keep their hashes.
4. **Tests are tied to outcomes by name, not by the planner.** Outcome _n_
   of story _s_ is encoded by tests whose names carry the tag `[s#n]`
   (`criterionTag`). The planner cannot know test names in advance, so the
   grilled "`file::name` per criterion" became this tag rule: the link is
   mechanical and needs no extra plan field.
5. **Per-test evidence is required.** `LLM4TS_TEST_REPORT` names the JUnit
   XML report the test gate writes (relative to the app directory). Vitest,
   jest, pytest, Surefire/Gradle and cargo-nextest all write one. The
   fallback, `LLM4TS_TEST_ONE`, is a command run once per outcome with
   `{tag}` or `{tagRegex}` filled in, and it is green when it exits 0.
   Without either, the run refuses before any seat starts. An outcome is
   green only when every tagged case passed; a skipped case is not passed.
   A tag the report does not show but the test sources carry reads red,
   because a suite that cannot load yet reports no case. The report must
   be git-ignored, or a story would commit it; the run stops if git sees it,
   and the report is deleted after every read
   (`@llm4ts/flow/TestEvidence`).
6. **The executor's one new seam is a red phase.** `StoriesOptions.redPhase`
   runs once per story, before its tasks are planned. The executor commits
   what it wrote and records `stories/<id>.red.json` (the frozen test paths,
   the commit, and what it parked). From then on, `frozenTestsGate` turns
   any change to a frozen test into a Critical gate failure. A story whose
   plan entry changes starts over without its red record.
7. **epic-mvp's red phase, step by step:**
   - Its MVP outcomes only (Q14); the coder writes the tagged tests and no
     production code.
   - One review of the tests: one lens, one round, then one fix turn and no
     re-review.
   - The evidence check. An outcome no test names gets one more turn, then
     fails the story. An outcome whose tests already pass is parked, with
     "check the outcome or its test".
   - It freezes the changed test files, by the oracle's test-file rules.
8. **Green tests replace review.** Each story gets one task: make the
   frozen tests pass. `reviewers: []` and no story judge. The gates, the
   perimeter, the oracle guard and the freeze still run. The review loop's
   rounds (default 3) are the green attempts, and a red epic merge gets the
   usual one revision. `--review` brings back one correctness lens per
   task. Task concurrency is 1, since there is one task.
9. **The verdict.** After each unit, `afterUnit` checks every finished
   story's tags on the epic checkout. It writes `parked.md` (stories cut
   whole, `later` outcomes, outcomes already green, and every MVP outcome
   of a story that failed, is waiting, or is not green) and `mvp.json`.
   The MVP is **reached** when nothing parked is MVP. The run publishes
   typed `CriterionChecked` and `Parked` events; the terminal, the run
   readers and `run_wait` show them.
10. **Landing.** `--land` refuses until `mvp.json` says reached, in the
    epic and in every round, and lists the open MVP outcomes. A partial
    land does not exist.
11. **Iterating.** `--iterate` is `--refine` with the parked lists as the
    feedback. With no text it plans all of them; with text it plans only
    the items the text names. The round runs test-first like the epic.
    Unlike epic-stories' deferred findings (ADR 0031), nothing parked is
    re-planned automatically.
12. **Defaults.** No judge seat. A roster keeps its per-role effort (the
    suggested shape is in `examples/epic-mvp.roster.json`): planner high,
    coder medium, reviewer low.

## Consequences

- There is a second epic flow, with no second engine to maintain. Every
  epic-stories improvement reaches epic-mvp for free.
- The tests are the only quality bar, so their quality is the risk. The
  one review of the tests, the freeze, the oracle guard and `--review` are
  the mitigations, and epic-stories remains the flow for refactors,
  cross-cutting changes, and work that needs judgment on house style.
- A repository whose test runner writes no JUnit report and cannot filter
  by name cannot run epic-mvp.
- Not measured yet: the 50% wall-clock target against epic-stories on the
  epic-light fixture. It is a rehearsal spec,
  `specs/pending/epic-mvp-rehearsal.md`.
