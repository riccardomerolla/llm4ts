# ADR 0053: epic-stories Is Test-First by Default

Status: Accepted · Date: 2026-11-19 · Extends ADR 0042, ADR 0044, ADR 0045

## Context

A user running epic-stories (plan with `--plan-only`, then run) saw two
things. Both had been true since the flow began.

- **Inside a story, the tests came last.** The story's coder plans its own
  tasks, and the task-plan prompt said nothing about tests or their order.
  So the coder planned "build it, then add tests". The only check that a
  story has tests was the judge's `tests` score, after the code existed.
- **The epic could end in a "write all the tests and integrate" story.** The
  planner's rules said every story owns its test files, but only as a
  sentence; `validateStoryPlan` does not enforce it. The fan-in story that
  owns the composition point runs last, so it became the place to put
  everyone's tests. Because owned paths are disjoint, the other stories then
  owned no test path and could not write tests at all.

epic-mvp (ADR 0042) is already test-first. Its red phase runs once per story,
before the tasks are planned: the coder writes tagged tests, a reviewer reads
them, the tests must fail, and the executor commits and freezes them. It
needs per-test evidence (`LLM4TS_TEST_REPORT` or `LLM4TS_TEST_ONE`), which
an ordinary epic-stories run does not have.

## Decision

1. **epic-stories runs a red phase by default** (`StoriesOptions.redPhase`,
   the seam ADR 0042 added). `--no-test-first` or `LLM4TS_TEST_FIRST=off`
   turns it off. It is also off under `--defer-tests` and `--harden`, whose
   stories are not held to tests written first. epic-mvp, epic-draft and
   epic-stories-board are unchanged.
2. **One red phase, two policies** (`flows/lib/red-phase.ts`).
   - epic-mvp: per-test evidence; a criterion no test names fails the story;
     a criterion green before implementation is parked.
   - epic-stories: per-test evidence when the environment names it;
     otherwise the test gate runs once. A red gate proves the story red, and
     a green one is noted ("may not pin the new behaviour"). With no test
     gate, the tests are written and frozen but not run, and the run says so.
     A criterion no test names is noted, after one more turn, and the story
     goes on: the review and the judge still score its tests. Only a red
     phase that writes no test file fails the story.
3. **The skipped stories.** A story with no acceptance criteria,
   `testsDeferred`, or `testsChange` gets no red phase. A story whose task
   plan already exists (an epic in flight before this release) does not get
   one either, as in ADR 0042.
4. **The task planner is told.** After a red phase that froze tests, the
   task-plan prompt names them and says the tasks write the production code
   that makes them pass, never the tests again (`redTestsNote`). A task may
   add further tests of its own. A frozen test changed later is still a gate
   failure (`frozenTestsGate`).
5. **No test-only story.** The story planner's rules say each story writes
   the tests of its own behaviour and the composition story tests only its
   wiring. `generateStoryPlan` asks once more when a story owns nothing but
   test files and is not a `testsChange` migration (`testOnlyStories`). If
   the second answer still has one, the plan is kept and the run says which
   story to fold in. It is not rejected: a hand-edited or in-flight
   `plan.md` keeps working.

## Consequences

- Every story with acceptance criteria costs one more coder conversation,
  one review of its tests and one test-gate run before its tasks are planned.
- The tests a story is judged by exist before its code, and the code cannot
  weaken them.
- A wrong red test blocks its story: the coder cannot change it, only the
  operator can, by editing it and rerunning. `--no-test-first` is the way
  back to the earlier behaviour.
- A whole-suite test gate proves the story red, not each criterion. Per-test
  evidence (`LLM4TS_TEST_REPORT`, `LLM4TS_TEST_ONE`) makes the proof per
  criterion, as in epic-mvp.
