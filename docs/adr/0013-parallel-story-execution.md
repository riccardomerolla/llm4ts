# ADR 0013: Parallel Story Execution Over A Declared Dependency Graph

Date: 2026-09-11. Status: accepted.
Specs: `specs/pending/epic-stories-flow-seams.md`,
`specs/pending/epic-stories-flow.md`,
`specs/pending/internet-banking-portal-fixture.md`.

## Context

Every flow in the pinned `llm4zio` and in llm4ts runs one coding agent at a
time: `implementPlanFlow` walks a flat task list, and `convert-all` chose
sequential page conversions on purpose. The parallel sub-agent example needs
several coders at once on one repository, each confined to its story, with
stories that depend on other stories. The shape of that confinement and of
that waiting had to be decided, because the obvious reading — an agent that
notices mid-run it needs another story's output and waits for it — is the
most fragile one to build.

## Decision

1. **Dependencies are declared, not discovered.** The reasoning seat splits
   the epic into a `StoryPlan` whose stories carry `dependsOn`, `owned`,
   `sharedReadOnly`, and `provides`. It is persisted before any coder runs,
   an existing file wins over regeneration (so editing it is the approval
   and the re-plan path), and `validateStoryPlan` rejects cycles, missing
   targets, and overlapping `owned` sets deterministically. A running coder
   never blocks: if it needs something unplanned it ends its story with the
   `BLOCKED_ON:` sentinel, which is a typed `MissingDependency` failure the
   operator resolves by editing the plan and rerunning.
2. **A story is a worktree and a branch; waiting is a merge.** Each story
   runs in its own git worktree on `story/<epic>/<id>`, created from the
   epic branch only after every predecessor has merged into it. The story
   branch merges back after its judge and perimeter checks pass, and the
   target's full gates run on the epic branch after every merge, so a broken
   epic head is never inherited. Merges and epic gates are serialized; a
   conflict is a typed failure, never model-resolved, because with disjoint
   ownership a conflict is a planning bug worth seeing.
3. **The perimeter is enforced after the fact, on the diff.** The prompt
   states the rules, and `checkPerimeter` fails the story if the branch
   touched anything outside `owned`. Changes to the shared surface happen
   only through dedicated stories that dependents declare. The target
   repository must therefore have no file every feature edits: per-feature
   dictionaries, routes, and service contracts, with one composition point
   owned by exactly one story per epic. That layout rule is part of the
   fixture's house rules, not of the flow.
4. **The runner rebinds seats; the flow schedules.** CLI coder seats are
   bound to a working directory when prepared, so the executor takes a
   `contextFor(workDir)` function and the runner supplies it, rebinding
   every seat to the worktree while sharing the run's event hub and cost
   tracker. Scheduling, gating, resume, and failure policy live in
   `@llm4ts/flow` (`StoryPlan`, `Perimeter`, `Stories`); the runner stays
   thin.
5. **Continue on failure, skip transitively, resume by hash.** A failed
   story marks its transitive dependents skipped with the reason and lets
   independent stories finish (fail-fast is an option). A rerun skips merged
   stories, resumes a failed one from its worktree checkpoint, and recreates
   the branch when the story's plan entry changed.
6. **The reference stack is Vite + React + Effect, not Next.js.** The
   example's target is a new retail-banking fixture trimmed from the owned
   `whitelabel-fund-tokenizer` portal kit (English and Italian, Effect
   `HttpApi` contracts with a stateful fake transport), because the demo's
   claim is reuse of an existing house kit, and the existing Next.js fixture
   belongs to the J2EE conversion story (ADR 0012).

## Consequences

- Additive divergence from the pinned source: `StoryPlan`, `Perimeter`,
  `Stories`, `GitTool.merge`, the runner's `contextFor`, and the
  `epic-stories` flow have no `llm4zio` counterpart; `docs/parity.md`
  records them, and back-porting is out of scope.
- `implementPlanFlow` is reused unchanged inside each worktree
  (`chatPerTask`, `checkoutBranch: false`), so the per-task review and the
  plan checkpoint carry over without a second task loop.
- Concurrency multiplies CLI processes: N stories means N coder and up to N
  reviewer processes. The default cap of 3 is a rate-limit posture, not a
  design limit.
- Delivery stays branches-only with a local board and a report whose usage
  figures are estimates (ADR 0012, decision 4), consistent with the other
  demo flows.
- If runtime dependency discovery is ever wanted, it must be added as a
  separate executor mode with its own ADR; this design deliberately keeps
  the coder unable to wait.
