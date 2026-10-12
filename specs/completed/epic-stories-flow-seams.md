# Flow seams: story plan, perimeter, parallel story executor

New `@llm4ts/flow` modules and one runner extension so a flow can split an
epic into stories with a declared dependency graph and implement them with
parallel coding agents, one git worktree per story, merging into an epic
branch in dependency order. This is the library half of the parallel
sub-agent example; the script and the demo epic live in
`specs/pending/epic-stories-flow.md`, the target repo in
`specs/pending/internet-banking-portal-fixture.md`. Design record: ADR 0013.

Driver: today `Plan` is a flat task list, `implementPlanFlow` walks it
sequentially, and a CLI coder seat is bound to one working directory when
its connector is prepared. Parallel stories therefore need three things the
library lacks: a story-level plan with dependencies and file ownership, a
scheduler that respects both, and a way to obtain a flow context rooted in
another directory. Everything else (per-task loop, review, judge, board,
estimates) already exists and is reused unchanged.

## Decisions (agreed 2026-09-11)

| Decision     | Choice                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependencies | Declared up front in the story plan (`dependsOn`), never discovered by a running agent. A coder that finds it needs unplanned work from another story ends its story with the `BLOCKED_ON: <what>` sentinel (precedent: `TASK_ALREADY_SATISFIED`), which becomes a typed `MissingDependency` failure. No automatic re-planning.                                           |
| Isolation    | Worktree per story (`.llm4ts/worktrees/<story-id>`) on branch `story/<epic-id>/<story-id>`, created from the epic branch head only once every predecessor has merged. Dependency satisfaction is a merge.                                                                                                                                                                 |
| Perimeter    | Each story declares `owned` (paths it may change) and `sharedReadOnly` (paths fed as context, forbidden to change). Enforced post hoc: the story branch's changed files vs its base must all fall under `owned`, else a typed `PerimeterViolation` listing the offending paths. Shared-surface changes happen only through dedicated stories in the DAG.                  |
| Inner loop   | `implementPlanFlow` unchanged, run inside the worktree with `chatPerTask: true`, `checkoutBranch: false`, the target's gates as `lint`. The coder plans its own tasks from the story description; the reasoning seat reviews each task (existing behaviour). One story-level `ProgramJudge` round against the story description and `provides`, one fix round, then fail. |
| Integration  | Story branch merged into the epic branch after judge and perimeter pass; the target's full gate command runs on the epic branch after every merge. A merge conflict fails the story typed with the conflicting paths; no model-driven resolution.                                                                                                                         |
| Failure      | Continue-on-failure by default (`failFast` option): a failed story marks every transitive dependent `skipped` with reason `blocked by <id>`; independent stories keep running. Concurrency cap option, default 3.                                                                                                                                                         |
| Resume       | A story whose branch already merged is `done` and skipped. A failed or interrupted story resumes from its worktree's plan checkpoint unless the hash of its story-plan entry differs from the hash recorded at branch creation, in which case the branch is recreated from the current epic head.                                                                         |
| Context      | The executor takes `contextFor: (workDir) => Effect<FlowContextShape, FlowError, Scope>`; it never resolves seats itself. The runner implements it by rebinding every seat (coder, reasoning, reviewers) to the worktree while sharing the run's event hub and cost tracker.                                                                                              |

## Modules

### `packages/flow/src/StoryPlan.ts`

- `Story` schema: `id`, `title`, `description`, `dependsOn: string[]`,
  `owned: string[]` (glob-free directory or file prefixes, repo-relative),
  `sharedReadOnly: string[]`, `provides: string[]` (routes, exports,
  contracts other stories may rely on).
- `StoryPlan` schema: `epicId`, `epic` (the prompt), `stories`, versioned
  like `Board`/`PageSpec` (`StoryPlanVersion`).
- Fenced-block idiom as `PageSpec`: `json storyplan` block inside markdown,
  `parseStoryPlan` hard-validates, `renderStoryPlan` produces the markdown
  the operator edits. Persist through `PlanStoreShape`-style
  `recoverOrCreate`: an existing file wins over regeneration.
- `validateStoryPlan`: unique ids, every `dependsOn` target exists, acyclic,
  `owned` sets pairwise disjoint (prefix overlap counts as overlap),
  `owned` and `sharedReadOnly` disjoint within a story. Failures are one
  typed `StoryPlanInvalid` carrying every violation, not the first.
- `topologicalWaves(plan)` and `readyStories(plan, done, failed)` as pure
  functions the scheduler and tests share. `storyHash(story)` stable over the
  entry's content.

### `packages/flow/src/Perimeter.ts`

- `checkPerimeter(changedPaths, story)` → pass or `PerimeterViolation`
  (paths outside `owned`; paths inside `sharedReadOnly` reported separately
  so the message can say "revert or request via a story").
- Pure; the executor feeds it `git.changedFilesVsBase`.

### `packages/flow/src/Stories.ts`

- `implementStoriesFlow(context, options)` where options carry the story
  plan effect and path, `contextFor`, `board: BoardSyncShape`, `gates`
  (command lists run in a worktree and on the epic branch), `judge`
  options, `concurrency`, `failFast`, `worktreeRoot`, `commitMessage`.
- Lifecycle per story: board `start` → worktree add (or resume) → inner
  `implementPlanFlow` → judge round(s) → perimeter check → merge → epic
  gates → board `complete` with branch, estimated tokens and cost; any
  failure → board `fail` with the typed reason, dependents `skip`.
- Scheduler: ready set recomputed after every completion; `Effect.forEach`
  with the concurrency cap over a queue, not a fixed wave list, so a slow
  story does not hold back an unrelated ready one.
- Merge and epic gates are serialized behind a `Semaphore.make(1)` (precedent:
  `Chat`, `FlowRecorder`): two stories may implement concurrently, only one
  merges at a time.
- Story prompt assembly: story description, `provides`, the `owned` and
  `sharedReadOnly` lists as hard rules, the `BLOCKED_ON` protocol, and the
  target's `CONTRIBUTING.md`; shared read-only files enter context through
  `Context` budgeting with truncations recorded.
- Report: `EpicReport` schema plus markdown render — per story status,
  branch, judge verdict, gate results, estimated usage with the `estimated`
  marker end to end (`EstimatedUsage` precedent), skip and failure reasons.
- Result type is the report; the epic branch is left in place.

### `packages/flow/src/GitTool.ts`

- New `merge(branch, message)` returning a typed result; a conflict is a
  `MergeConflict` error carrying the conflicting paths and leaves the epic
  tree aborted (`git merge --abort`) so the next story can proceed.
- New `changedFilesVsBase` already exists; `addWorktree` must accept an
  existing branch (resume) as well as creating one from a start point.

### `packages/flow/src/FlowError.ts`

- `StoryPlanInvalid`, `PerimeterViolation`, `MissingDependency`,
  `MergeConflict`, `StoryFailed` (wraps the inner cause with the story id)
  as `Schema.TaggedErrorClass`, added to the `FlowError` union.

### `packages/runner/src/FlowRunner.ts`

- The bundle exposes `contextFor(workDir)`: prepares every configured seat
  with `workingDir` set to that directory (the `prepareConnector` path),
  resolves them through the same registry, wraps them in the same transient
  retry, and builds `GitTool`/`GitHubTool` rooted there, while returning the
  run's existing `events` and `tracker`. `runNode` passes it into the flow
  body's context as an optional member so existing flows are unaffected.
- No scheduling, gating, or policy lands in the runner.

## Tasks

- [ ] `StoryPlan` schema, fenced-block parse/render, persistence via the
      plan store, `validateStoryPlan` with all-violations reporting.
- [ ] `topologicalWaves`, `readyStories`, `storyHash`.
- [ ] `Perimeter.checkPerimeter`.
- [ ] `GitTool.merge` with typed conflict and abort; worktree add for an
      existing branch.
- [ ] New `FlowError` members.
- [ ] `Stories.implementStoriesFlow`: scheduler, worktree lifecycle, inner
      loop wiring, judge, perimeter, serialized merge and epic gates, board
      transitions, continue-on-failure and transitive skip, hash-guarded
      resume, `BLOCKED_ON` detection, epic report.
- [ ] Runner `contextFor` rebind sharing events and tracker.
- [ ] Deterministic tests with in-src fakes: plan validation cases (cycle,
      overlap, missing target), wave and ready-set computation, perimeter,
      scheduler ordering under a cap with a fake `contextFor` and fake
      process (a story never starts before its predecessors merged),
      transitive skip, fail-fast, resume paths (done skipped, changed hash
      recreates), merge-conflict failure, report rendering with the
      estimated marker.
- [ ] `docs/parity.md` note under the additive-modules section and an
      `docs/api.md` entry for the new subpath exports.

## Non-goals

Runtime dependency discovery, automatic re-planning after a failure,
model-driven conflict resolution, cross-story shared chats, pull requests or
auto-merge to the default branch, and any board adapter beyond the existing
local `BoardSync` (the Azure DevOps mirror works unchanged through the same
port and is not required).
