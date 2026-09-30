# Refine Rounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `epic-stories --refine "<feedback>"` plans a round of follow-up stories on a finished, not yet landed epic, runs it through the unchanged story executor on the same epic branch, and lands once.

**Architecture:** `packages/flow/src/RefineRound.ts` is pure: the proposal schema, round assembly (id prefixing, dropped dependencies on merged stories), the decision of what a run does, and the not-planned rendering. `landEpic` takes the rounds' plans and state folders beside the epic's. `flows/lib/epic-stories.ts` loads rounds from `rounds/<n>/plan.md`, prompts the planner, and hands the chosen unit (the plan or a round) to `implementStoriesFlow`, which does not change.

**Tech Stack:** TypeScript, Effect 4 rc.115, `@effect/vitest`; existing `StoryPlan.ts`, `Stories.ts`, `Landing.ts`, `makeStoryPlanStore`, `structuredAndPublish`.

**Spec:** `docs/superpowers/specs/2026-09-30-refine-rounds-design.md`

**Execution note:** author and executor are one session (the user asked for plan and implementation together). Tasks fix files, exported names, rules and test cases; code is written test-first at execution.

## Global Constraints

- Effect 4 pinned `4.0.0-rc.115`; no `any`, no type assertions (`as const` allowed), no namespaces, no unmanaged promises, no global `Error` as a domain error; `.ts` relative imports; explicit subpath export `@llm4ts/flow/RefineRound`.
- `implementStoriesFlow` and `StoryPlan.ts` do not change. The epic's own `plan.md`, story states, board and report are never written by a round.
- A round's plan carries the epic's `epicId`; its story ids start with `r<n>-`.
- Without `--refine` and without round folders, every run behaves exactly as in 2.18.0: existing tests stay green unchanged, except assertions on the shapes of `EpicArgs` and `EpicSummary`, which gain fields.
- Feedback text goes to the reasoning seat and to `feedback.md` only: never into a child process's arguments, never into an error message.
- Verification before each commit: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`. Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. The planner names a merged story of the epic (or of an earlier round) in `dependsOn` → the dependency is dropped as already satisfied, not rejected as unknown (Task 1).
2. The planner returns ids already prefixed `r2-` for round 2, or reuses an id of the epic's plan → prefixing is idempotent and the result never collides with an earlier story (Task 1).
3. `--refine "<text>"` when the only open epic is a brief-only folder or the text matches no epic → refused as "no plan", never planned as a new epic from the feedback text (Task 3).
4. A round planned with `--plan-only` and never run → it is the open round: a plain rerun runs it, `--refine "<new text>"` and `--land` are refused (Task 1, Task 2).
5. A hand-edited round plan that no longer parses → `--list` shows it, `--refine` and `--land` refuse naming the file; later rounds are still found (Task 3).

---

### Task 1: `RefineRound.ts`

**Files:** Create `packages/flow/src/RefineRound.ts`; modify `packages/flow/package.json` (export), `packages/flow/src/FlowError.ts` (`RefineRefused`, in the `FlowError` union); test `packages/flow/test/RefineRound.test.ts`.

**Produces:**

- `RefineRefused` (`Schema.TaggedError`) `{ epicId: String, reason: String }`, message `epic '<id>' cannot be refined: <reason>`.
- `NotPlanned` (Schema.Class) `{ item: String, reason: String }`; `RefineProposal` (Schema.Class) `{ stories: Array<Story>, notPlanned: Array<NotPlanned> (default []) }`; `refineProposalJsonSchema: JsonSchema`.
- `roundPrefix(round: number): string` → `r<n>-`.
- `assembleRound(inputs: { epicId: string; round: number; feedback: string; proposal: RefineProposal; earlier: ReadonlyArray<string> }): StoryPlan` — `earlier` = ids of every story of the epic's plan and earlier rounds. Each story id gets the prefix unless it already has it; `dependsOn` is rewritten the same way; a dependency naming an `earlier` id is dropped; `epic` = the feedback.
- `interface RoundProgress { round: number; stories: number; merged: number; unreadable?: string }`
- `type RunAction = { _tag: "RunPlan" } | { _tag: "RunRound"; round: number } | { _tag: "PlanRound"; round: number } | { _tag: "Land" } | { _tag: "Refused"; reason: string } | { _tag: "Usage"; message: string }`
- `runAction(inputs: { planned: boolean; stories: number; merged: number; landed: string | undefined; rounds: ReadonlyArray<RoundProgress>; refine: boolean; feedback: string; land: boolean }): RunAction`
- `renderNotPlanned(round: number, items: ReadonlyArray<NotPlanned>): string` (one `- **item** — reason` line each, whitespace collapsed); `countNotPlanned(markdown: string): number`.
- `interface EarlierStory { id: string; title: string; owned: ReadonlyArray<string>; provides: ReadonlyArray<string> }`; `earlierStories(plans: ReadonlyArray<StoryPlan>): ReadonlyArray<EarlierStory>`.

**`runAction` rules, in order:**

1. `land` → `Land` (the landing itself refuses what is unmerged or unreadable).
2. `refine` false: the plan has unmerged stories or no round is open → `RunPlan`; else → `RunRound` of the open round. An unreadable round with `refine` false and the plan merged → `Refused` naming it.
3. `refine` true: not `planned` → `Refused` ("no story plan yet: run the epic first"); `landed` → `Refused`; any round unreadable → `Refused`; plan unmerged → `Refused` naming the counts; open round and feedback empty → `RunRound`; open round and feedback given → `Refused` ("round n is open: rerun without --refine text to finish it, or edit its plan"); no open round and feedback empty → `Usage`; otherwise → `PlanRound` of `rounds.length + 1`.

The open round is the last round with `merged < stories`; rounds are created one at a time, so only the last can be open.

- [ ] Failing tests: every row of the spec's decision table and the rules above (Review Focus 4); `assembleRound` prefixes, is idempotent, rewrites and drops dependencies (Review Focus 1, 2) and the assembled plan of two stories on one path with a dependency passes `storyPlanViolations` only when the paths differ (ownership stays exclusive within the round); `renderNotPlanned`/`countNotPlanned` round-trip the count, zero for an empty list; `earlierStories`; `RefineProposal` decodes without `notPlanned`.
- [ ] RED, implement, GREEN, verify, commit `flow: refine rounds — proposal, assembly and the run decision`.

### Task 2: landing counts the rounds

**Files:** modify `packages/flow/src/Landing.ts`; test `packages/flow/test/Landing.test.ts` (append).

**Produces:** `LandOptions.rounds?: ReadonlyArray<{ readonly plan: StoryPlan; readonly stateDir: string }>`. The merged check and the worktree/branch cleanup iterate the epic's plan and then each round, each against its own state folder. `EpicIncomplete.stories` names unmerged round stories by their prefixed ids.

- [ ] Failing tests: an epic whose plan is merged and whose round has an unmerged story is refused naming `r1-…`; a round planned and never started (no state file) is refused; with every round merged the epic lands and the round's worktree and branch are removed; no `rounds` → the existing tests unchanged.
- [ ] RED, implement, GREEN, verify, commit `flow: landing waits for the refine rounds and cleans up after them`.

### Task 3: rounds on disk, the planner, `--list`

**Files:** modify `flows/lib/epic-stories.ts`, `flows/lib/epic-design.ts` (`epicProgressOf`); test `flows/test/epic-stories.test.ts` (append; update the two shape assertions).

**Produces:**

- `EpicArgs.refine: boolean` (`--refine`), in `parseEpicArgs` and `epicUsage`.
- `roundDir(stateDir: string, round: number): string` → `<stateDir>/rounds/<n>`.
- `interface RoundOnDisk { round: number; stateDir: string; plan: StoryPlan | undefined; merged: number; notPlanned: number; unreadable: string | undefined }`
- `loadRounds(files, stateDir): Effect<ReadonlyArray<RoundOnDisk>, FlowError>` — probes `rounds/1/plan.md`, `rounds/2/plan.md`, … until a file is missing; a plan that does not parse or validate is a round with `unreadable` set (Review Focus 5).
- `EpicSummary.rounds: ReadonlyArray<RoundOnDisk>`; `renderEpicList` adds `· round 1: 3/3 merged · round 2: 1/2 merged, 1 not planned` (and `round n: unreadable plan`).
- `epicProgressOf` counts round stories and merged round stories with the plan's.
- `refinePlanInstructions(inputs: { epicId: string; round: number; guidance: string; earlier: ReadonlyArray<EarlierStory>; brief?: string; openItems?: string }): string` and `generateRefineProposal(reasoning, events, inputs & { feedback: string }): Effect<RefineProposal, FlowLlmError>`.
- `planRound(deps: { files; reasoning; events; stateDir: string; epicId: string; round: number; feedback: string; guidance: string; plans: ReadonlyArray<StoryPlan>; brief?: string }): Effect<{ plan: StoryPlan | undefined; notPlanned: ReadonlyArray<NotPlanned> }, FlowError>` — proposes, assembles, validates, then writes `feedback.md`, `plan.md` and `not-planned.md` (the last only with items). No story → nothing written, `plan: undefined`. It reads the previous round's `not-planned.md` for `openItems`.

- [ ] Failing tests: `--refine` parses with text, with `--plan-only`, with `--epic`; `loadRounds` finds rounds 1 and 2, counts merged states and not-planned items, reports an unparsable plan and still finds the round after it; `--list` shows the rounds; `epicProgressOf` counts them; the refine prompt carries the feedback, an earlier story's owned path and the previous not-planned list; `planRound` writes the three files with `r1-` ids, accepts a story claiming a path the epic's plan owns, rejects two round stories on one path, writes nothing on an empty proposal and on a rejected one; the epic's own `plan.md` is byte-identical afterwards.
- [ ] RED, implement, GREEN, verify, commit `epic-stories: refine rounds on disk, their planner and the list`.

### Task 4: the run, docs, published surface

**Files:** modify `flows/lib/epic-stories.ts` (`runEpicStories`), `flows/README.md`, `CHANGELOG.md`, `CONTEXT.md` (the term "Refine round"), `scripts/pack-smoke.mjs` (import `@llm4ts/flow/RefineRound`); create `docs/adr/0021-refine-rounds.md`; test `flows/test/epic-stories.test.ts` (append), `packages/flow/test/Stories.test.ts` (append).

**Changes to `runEpicStories`:**

- With `--refine`, the positional text is the feedback: `chooseEpic` is called with empty text, and a choice that is not `Existing` is `RefineRefused` ("no story plan yet…") (Review Focus 3).
- After the epic's plan is loaded: `loadRounds`, then `runAction`. `Refused` → `RefineRefused`; `Usage` → `ScriptUsage`.
- `PlanRound`: checkout the epic branch, `planRound`; print the not-planned items; no plan → stop; `--plan-only` → stop; else run the round.
- The executor call takes a unit `{ plan, stateDir, label }`: the epic (`Epic: <id>`) or a round (`Epic: <id> · round <n>`), same branch, worktree root, seats, gates, judge and setup. The story judge and the blocked-claim verifier get the unit's plan.
- `Land`: `landEpic` with `rounds`; an unreadable round is `RefineRefused` before landing.
- The closing message names the round and repeats its not-planned count.

- [ ] Failing tests: (Stories) a round plan whose story owns a path of a merged epic story runs in a separate state folder, branches from and merges into the epic branch, and leaves the epic's state files as they were; (flows) the entry's wiring — `runAction(` and `planRound(` are called, the epic branch is checked out before planning, `landEpic` receives `rounds` — asserted on the source as the existing entry tests do; the README and usage mention `--refine`.
- [ ] RED, implement + docs + ADR, GREEN; full chain plus `pnpm build && node scripts/pack-smoke.mjs`; commit `epic-stories: --refine runs a round of follow-up stories; docs, ADR 0021, changelog`.

## Self-review notes

- Spec coverage: decisions 1, 2, 6 and the table (T1, T4), round as its own plan and disk layout (T3), ownership (T1 test, T3, T4 Stories test), not planned (T1, T3), planning inputs (T3), running (T4), landing and listing (T2, T3), error handling (T1, T3, T4), ADR and components (T4).
- One sharpening against the spec: a dependency on an already merged story is dropped rather than rejected, since a round starts only when those are merged.
- The spec's "round folder without a readable plan" is detected by the plan file failing to parse; a folder with no `plan.md` at all ends the numbering, and nothing in the flow creates one.
