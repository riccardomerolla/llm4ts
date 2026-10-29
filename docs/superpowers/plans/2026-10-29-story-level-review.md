# Story-Level Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the review lenses from each task to one review per story, run side by side with the story judge, with incremental re-checks and one fix turn per round.

**Architecture:** `reviewAndFixLoop` gains an opt-in `recheck` mode (its default is unchanged, for `llm4zio` parity): reviewer memory across rounds, extra named reviews (the judge), re-check prompts, and the findings that still stand as the result. A small pure module, `Recheck.ts`, holds the round planning. `implementStoriesFlow` gains `reviewAt: "story"`: tasks get no lenses, and a story review stage replaces the judge loop by calling `reviewAndFixLoop` in recheck mode on the story diff. The epic flows switch it on by default.

**Tech Stack:** TypeScript, Effect 4 (`Schema.Class`, `Schema.optionalKey`, `Ref`), `@effect/vitest`, pnpm workspaces.

**Spec:** `docs/adr/0044-story-level-review.md`

## Global Constraints

- Library defaults unchanged: `reviewAndFixLoop` without `recheck`, and `implementStoriesFlow` without `reviewAt`, behave exactly as before (existing tests pass untouched).
- New schema fields are `Schema.optionalKey`: records written before this change still decode.
- `--review-rounds <n>` default **3** in story mode; `--judge-rounds` and `LLM4TS_JUDGE_ROUNDS` are aliases. In task mode the value keeps its old meaning (judge attempts, default 2).
- `--review-at task|story`; story is the default in `epic-stories`, `epic-mvp`, `epic-draft`.
- Judge findings carry `lens: "judge"`; gate findings carry no lens.
- A judge verdict whose `provides` dimension scores **0** becomes a revision task; every other finding goes to the fix turn.
- Out of rounds: judge findings still standing (blocking, or any when not deferring) fail the story; lens findings still standing are logged in `findings.md` as carried and the story merges.
- Relative imports end in `.ts`; no `any`, no unchecked casts; tests use the in-src fakes.
- Verification: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
- Leave the user's uncommitted `flows/modernize-refine.ts`, `flows/test/modernize-refine.smoke.test.ts` and `docs/research/*` untouched; stage files by name.

## Review Focus

1. **Restart after the fix turn ran but before the next review**: resumes at the next round, re-checks, does not redo tasks and does not exceed `--review-rounds`. Pinned in Task 5.
2. **A story that failed out of rounds and is rerun**: its saved review state is gone, so the rerun starts at round 1 instead of failing at once. Pinned in Task 5.
3. **Story with an empty diff** (code already in place on the epic): no lenses run on an empty diff; the judge rules on the owned code as today. Pinned in Task 5.
4. **Gates red at the story review**: no reviewer runs that round, the fix turn gets the gate output, and a reviewer that never ran does a full review next round. Pinned in Task 3.
5. **Parallel tasks merged aside, then the story review**: the review sees the merged story diff once, after the "gates after parallel tasks" step. Pinned in Task 5.

---

### Task 1: Findings remember their lens

**Files:**

- Modify: `packages/flow/src/Review.ts` (`ReviewIssue` ~line 67; `run` inside `reviewOnce` ~line 966)
- Test: `packages/flow/test/Review.test.ts`

**Interfaces:**

- Produces: `ReviewIssue.lens?: string` (optionalKey). `tagLens(name: string, result: ReviewResult): ReviewResult` exported from `Review.ts`: sets `lens` on each issue that has none.

- [ ] **Step 1: Write the failing tests**

```ts
it("tagLens names the lens on untagged issues only", () => {
  const result = ReviewResult.make({ issues: [
    ReviewIssue.make({ severity: "Warning", title: "a" }),
    ReviewIssue.make({ severity: "Warning", title: "b", lens: "judge" })
  ] })
  expect(tagLens("correctness", result).issues.map((i) => i.lens)).toEqual(["correctness", "judge"])
})
it.effect("reviewAndFixLoop tags each lens's findings with its name", ...)
// two fake lenses each returning one issue; onRound's result issues carry lens "correctness" and "security"
it("a ReviewIssue without lens still decodes", ...) // decode {"severity":"Info","title":"x"}
```

- [ ] **Step 2: Run** `pnpm vitest run packages/flow/test/Review.test.ts` — expect FAIL (`tagLens` not exported).
- [ ] **Step 3: Implement** the field and `tagLens`; apply it in `run` after `demoteUnplaced`, with `lens.name`.
- [ ] **Step 4: Run** the same command — PASS; then `pnpm vitest run packages/flow` — all PASS.
- [ ] **Step 5: Commit** `git add packages/flow/src/Review.ts packages/flow/test/Review.test.ts && git commit -m "flow: review findings record their lens (ADR 0044)"`

---

### Task 2: Round planning (pure)

**Files:**

- Create: `packages/flow/src/Recheck.ts`
- Modify: `packages/flow/package.json` (add the `./Recheck` subpath export, as the other modules)
- Test: `packages/flow/test/Recheck.test.ts`

**Interfaces:**

- Produces:
  - `diffChunks(diff: string): Readonly<Record<string, string>>`: file path → fingerprint (`fingerprintOf` from `ReviewCache.ts`) of that file's section of a unified diff (split on `diff --git a/… b/…`, path from the `b/` side).
  - `touchedFiles(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): ReadonlyArray<string>`: paths added, removed or with a changed fingerprint, sorted.
  - `ReviewerState` = `Schema.Struct({ name: Schema.String, status: Schema.Literals(["clean", "dirty"]), findings: Schema.Array(ReviewIssue), seen: Schema.Array(Schema.String) })`.
  - `class ReviewMemory extends Schema.Class<ReviewMemory>("ReviewMemory")({ version: Schema.Literal(1), round: Schema.Int, chunks: Schema.Record(Schema.String, Schema.String), reviewers: Schema.Array(ReviewerState) })`.
  - `interface Candidate { readonly name: string; readonly matches: (files: ReadonlyArray<string>) => boolean; readonly onlyWhenDirty?: boolean }`. Extra reviews (the judge) set `onlyWhenDirty`: once clean they never rerun.
  - `planRound(candidates: ReadonlyArray<Candidate>, memory: ReviewMemory | undefined, changedFiles: ReadonlyArray<string>, touched: ReadonlyArray<string>): { readonly full: ReadonlyArray<string>; readonly recheck: ReadonlyArray<string> }`.
  - `standing(memory: ReviewMemory): ReviewResult`: the findings of every dirty reviewer, merged.
  - `remember(memory: ReviewMemory | undefined, round: number, chunks: Record<string,string>, ran: ReadonlyArray<{ name: string; result: ReviewResult }>, files: ReadonlyArray<string>): ReviewMemory`: reviewers that ran get `status` from `result.isClean`, `findings` = `result.issues`, `seen` = union of old `seen` and `files`; others are kept as they were.
  - `recheckPrompt(title: string, diff: string, touched: ReadonlyArray<string>, prior: ReadonlyArray<ReviewIssue>): string`.

`planRound` rules, in order, per candidate:

1. No state for it: `full` when `matches(changedFiles)` (or `changedFiles` is empty).
2. `dirty`: `recheck`.
3. `clean` and not `onlyWhenDirty`: `full` when the touched files it has not `seen` are non-empty and it `matches` them; else skipped.

`recheckPrompt` copy (exact):

```
This is a re-check of a change you reviewed before, for "${title}".
Your earlier findings are listed below. The fix since then touched: ${touched.join(", ") || "no files"}.
For each earlier finding, report it again only if it is still present.
Report a new problem only if the fix itself introduced it. Do not review the rest of the change afresh.
Earlier findings:
${prior.map((i) => `- [${i.severity}] ${i.title}${i.description ? `: ${i.description}` : ""}`).join("\n")}
```

followed by `reviewPrompt(title, diff)` (the JSON contract and the diff).

- [ ] **Step 1: Write the failing tests** in `Recheck.test.ts`:
  - `diffChunks` keys two files of a two-file diff; `touchedFiles` returns only the file whose hunk changed, plus an added file.
  - `planRound` with no memory → all matching in `full`; with `a` dirty, `b` clean and `touched=["x.ts"]` already in `b.seen` → `{ full: [], recheck: ["a"] }`; with `touched=["x.test.ts"]` unseen and `b` matching it → `full: ["b"]`.
  - `remember` keeps a reviewer that did not run; `standing` merges only dirty findings.
  - `recheckPrompt` contains each prior title and the touched file list.
- [ ] **Step 2: Run** `pnpm vitest run packages/flow/test/Recheck.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** `Recheck.ts`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "flow: Recheck round planning (ADR 0044)"` (Recheck.ts, its test, package.json).

---

### Task 3: `reviewAndFixLoop` recheck mode

**Files:**

- Modify: `packages/flow/src/Review.ts` (`ReviewAndFixOptions` ~line 709; `reviewOnce` and `loop` ~lines 912–1085)
- Test: `packages/flow/test/Review.test.ts`

**Interfaces:**

- Consumes: Task 2's `planRound`, `remember`, `standing`, `diffChunks`, `touchedFiles`, `recheckPrompt`, `ReviewMemory`; Task 1's `tagLens`.
- Produces:

```ts
export interface ExtraReview {
  readonly name: string
  /** `prior`: its own standing findings when this run is a re-check; undefined for a full review. */
  readonly review: (diff: string, prior: ReadonlyArray<ReviewIssue> | undefined) => Effect.Effect<ReviewResult, FlowError>
}
export interface RecheckOptions {
  readonly extra?: ReadonlyArray<ExtraReview>
  readonly memory?: {
    readonly load: Effect.Effect<ReviewMemory | undefined, FlowError>
    readonly save: (memory: ReviewMemory) => Effect.Effect<void, FlowError>
  }
}
// ReviewAndFixOptions gains:
readonly recheck?: RecheckOptions
```

Behaviour when `recheck` is set (absent: unchanged):

- Extra reviews are candidates that match every file, with `onlyWhenDirty`. Lenses keep `lens.matches`.
- Each review round: gates first, as today; red gates → return the gate result, memory untouched. Otherwise `planRound` with `touched = touchedFiles(memory.chunks, diffChunks(diff))`; `full` lenses use `reviewWith`; `recheck` lenses use `recheckPrompt` through the same structured call (factor the call out of `reviewWith` as `reviewPromptWith(service, events, lens, prompt)`); extras get `prior` for recheck, `undefined` for full. Results are tagged (`tagLens`, extras with their `name`), `remember`ed, saved through `memory.save`.
- The round's result, its settle check, `onRound` and the returned value use `standing(memory)`, not just this round's results.
- Start: `memory.load`; when it returns a memory, the loop starts at `min(memory.round + 1, maxRounds)`.
- Cache fingerprint for a re-check adds `"recheck"` and the prior titles.
- The prescreen does not apply in recheck mode.

- [ ] **Step 1: Write the failing tests** (fake reviewer service answering by lens name in the prompt; fake coder that edits a fake diff):
  - `"recheck: round 2 reruns only the lens with findings, with its earlier findings in the prompt"`: lenses A (finding in round 1) and B (clean); assert round 2 prompts = one, containing `"re-check"` and A's finding title.
  - `"recheck: a clean lens reruns when the fix touches a file it never saw"`.
  - `"recheck: the result is the standing findings across rounds"`: A dirty round 1, B dirty round 1, round 2 rechecks A clean, B still dirty → returned issues are B's only.
  - `"recheck: an extra review runs beside the lenses and gets its prior on re-check"`.
  - `"recheck: a red gate round runs no reviewer and a lens that never ran reviews in full next round"`.
  - `"recheck: resumes from saved memory at the next round"`: memory round 1 saved with A dirty → loop's first review is round 2, a re-check of A.
  - `"without recheck every lens runs every round, as before"` (guards the default).
- [ ] **Step 2: Run** `pnpm vitest run packages/flow/test/Review.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm vitest run packages/flow` — PASS (all existing review tests unchanged).
- [ ] **Step 5: Commit** `git commit -m "flow: reviewAndFixLoop recheck mode — reviewer memory, extra reviews, standing findings (ADR 0044)"`

---

### Task 4: Diff size in the events and the profile

**Files:**

- Modify: `packages/flow/src/FlowEvents.ts` (`ReviewFindings` ~line 132), `packages/flow/src/Review.ts` (the `ReviewFindings.make` in `loop`), `packages/runner/src/Profile.ts` (`StoryProfile` ~line 77, `profileOf`, `renderProfile`)
- Test: `packages/runner/test/Profile.test.ts`, `packages/flow/test/Review.test.ts`

**Interfaces:**

- Produces: `ReviewFindings.diffLines?: Int` (optionalKey; set by the loop to the reviewed diff's line count on rounds where reviewers ran). `StoryProfile.reviewDiffLines?: Int`: the largest `diffLines` on the story's lane. `renderProfile` prints `review diff N lines` in the story's row when present.

- [ ] **Step 1: Failing tests:** `"ReviewFindings carry the reviewed diff's line count"` (Review.test.ts); `"profile reports the largest review diff per story"` (two `ReviewFindings` events on lane `s1` with 40 and 120 → `reviewDiffLines: 120`, rendered text contains `review diff 120 lines`).
- [ ] **Step 2: Run** `pnpm vitest run packages/flow/test/Review.test.ts packages/runner/test/Profile.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `git commit -m "profile: largest review diff per story (ADR 0044)"`

---

### Task 5: The story review stage

**Files:**

- Modify: `packages/flow/src/Stories.ts` (`StoriesOptions` ~line 661; `implementTasks` options ~line 1867; the judge loop ~lines 1976–2135)
- Test: `packages/flow/test/Stories.test.ts`

**Interfaces:**

- Consumes: Task 3's `recheck`, `ExtraReview`, `ReviewMemory`; `flowReviewer` from `Flow.ts`; the existing `coderTurn`, `gates`, `triage`, `appendRevision`, `guarded`, `implementTasks`, `catchUp`, `repairPerimeter`, `appendFindings`, `judgePath`, `reviewCacheDir`, `deferredLine`, `failed`.
- Produces on `StoriesOptions`:

```ts
/** Where the review lenses run (ADR 0044): each task (default) or once per story with the judge. */
readonly reviewAt?: "task" | "story"
/** Story mode: rounds of the merged story review. Default 3. Task mode ignores it. */
readonly reviewRounds?: number
```

and `reviewStatePath(stateDir: string, storyId: string): string` = `stories/<id>.review-state.json` (exported).

Story mode (`reviewAt === "story"`):

- `implementTasks` gets `reviewers: []`, no `repoRules`, no `reviewCache`; gates, triage, oracle and the stall rule stay.
- After the tasks (and after "gates after parallel tasks", `catchUp`, `repairPerimeter`), when the story diff vs the epic is **empty**, the existing judge-on-code path runs unchanged (round loop with `judgeRounds`).
- Otherwise one `reviewAndFixLoop` call:
  - `reviewers`: `options.reviewers ?? minimalReviewers` plus the repo rules lens; `reviewerService: flowReviewer(storyContext)`; `taskTitle`: `story ${story.id}: ${story.title}`; `currentDiff`: `git.diffVsBase(epicBranch)`; `lint`: `gates`; `triage`; `maxRounds`: `reviewRounds ?? 3`; `settle: "blocking"` when deferring; `cache: { files, dir: reviewCacheDir(story) }`.
  - `recheck.extra`: when `options.judge` is set, one `ExtraReview` named `"judge"` running the current per-round judge body (evidence notes, `cachedValue` on `judgePath`, EVALUATOR span, `StoryJudged` event, judge findings line) and tagging its issues `lens: "judge"`. It keeps the latest verdict in a `Ref`.
  - `recheck.memory`: load/save JSON at `reviewStatePath`, decoded with `ReviewMemory`; an undecodable file counts as absent.
  - `fixWith`: when the latest verdict is a `StoryVerdict` whose `provides` dimension scores 0 → `addRevision(verdict, false)`, `guarded(implementTasks, implementTasks)`, `catchUp`, `repairPerimeter`, return `""`; otherwise `coderTurn(prompt)`.
  - `onRound`: `appendFindings(story, "story review round N — …", result)`; for a settled round, standing issues go to `deferred` (as `deferredLine("story review", issue)`) when deferring.
- After the loop: standing issues with `lens === "judge"` that block (all of them when not deferring) → `failed(story, "judge not cleared after N story review rounds:\n…")`. Remaining lens issues → `appendFindings(story, "carried: review rounds ran out", …)`. Then the existing perimeter, deferred and merge steps.
- `reviewStatePath` is removed when the story ends (merged or failed) and before a merge revision reruns the tasks.

- [ ] **Step 1: Write the failing tests** (reuse `makeHarness`, `makeOptions`, `scriptedCoder`; count reviewer prompts with a recording reviewer service):
  - `"story review: tasks run no lens, the story is reviewed once"`: 3 tasks, 4 lenses, clean → exactly 4 lens prompts, each containing every task's file.
  - `"story review: one fix turn per round, then only the lens with findings re-checks"`.
  - `"story review: the judge runs beside the lenses and its findings reach the same fix turn"`.
  - `"story review: provides at 0 becomes a revision task"`.
  - `"story review: out of rounds, judge not cleared fails the story"`.
  - `"story review: out of rounds with only lens findings, the story merges and the findings are carried"` (findings log contains `carried`).
  - `"story review: an empty diff is judged on its owned code, with no lens"`.
  - `"story review: restart resumes at the saved round without redoing the tasks"`.
  - `"story review: a failed story's review state is removed"`.
  - `"story review: parallel tasks are reviewed once after their gates together"`.
  - `"task review stays the default"` (no `reviewAt`: per-task lens prompts as before).
- [ ] **Step 2: Run** `pnpm vitest run packages/flow/test/Stories.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Extract the per-round judge body into a local `judgeOnce(round)` used by both the task-mode loop and the `ExtraReview`, so the judge code exists once.
- [ ] **Step 4: Run** `pnpm vitest run packages/flow` — PASS.
- [ ] **Step 5: Commit** `git commit -m "flow: story review stage — lenses and judge once per story (ADR 0044)"`

---

### Task 6: Epic flows default to story review

**Files:**

- Modify: `flows/lib/epic-stories.ts` (flags ~lines 120–300, `judgeRoundsOption` ~376, `StoriesPolicy` ~2145, executor options ~2800, usage text ~157), `flows/lib/epic-draft.ts` (~270), `flows/lib/epic-mvp.ts` (~635)
- Test: `flows/test/epic-stories.test.ts`, `flows/test/epic-draft.test.ts`, `flows/test/epic-mvp.test.ts`

**Interfaces:**

- Consumes: Task 5's `reviewAt`, `reviewRounds`.
- Produces: `EpicFlags.reviewAt: "task" | "story" | undefined`, `EpicFlags.reviewRounds: number | undefined` (replaces `judgeRounds`; `--judge-rounds` parses into it). `StoriesPolicy` adds `"reviewAt" | "reviewRounds"`. `reviewRoundsOption(flag, env)` replaces `judgeRoundsOption`: reads `LLM4TS_JUDGE_ROUNDS` too, and returns `{ reviewRounds }` in story mode or `{ judgeRounds }` in task mode.

Usage lines (exact):

```
  --review-at <task|story> where the review lenses run (default story: once per story,
                      beside the judge; task: every task, as before 2.51)
  --review-rounds <n> rounds of the story review (default 3); in task mode, judge attempts
                      (default 2). --judge-rounds and LLM4TS_JUDGE_ROUNDS set it too
```

- [ ] **Step 1: Failing tests:** flag parsing (`--review-at task`, `--review-at nope` → Usage error, `--judge-rounds 4` → `reviewRounds: 4`); the executor gets `reviewAt: "story"` by default and `"task"` with the flag; epic-draft's policy passes `reviewers: [correctnessReviewer]` with `reviewAt: "story"` and `reviewRounds: 1`; epic-mvp's passes `reviewAt: "story"`.
- [ ] **Step 2: Run** `pnpm vitest run flows/test/epic-stories.test.ts flows/test/epic-draft.test.ts` — FAIL.
- [ ] **Step 3: Implement.** In epic-draft, `maxRounds: 1` becomes `reviewRounds: 1`.
- [ ] **Step 4: Run** `pnpm vitest run flows` — PASS.
- [ ] **Step 5: Commit** `git commit -m "epic flows: review per story by default, --review-at, --review-rounds (ADR 0044)"`

---

### Task 7: Docs and full verification

**Files:**

- Modify: `docs/adr/0044-story-level-review.md` (Status: Accepted), `docs/guide/02-run-a-flow.md`, `docs/configuration.md`, `flows/README.md`, `skills/using-llm4ts/SKILL.md`, `CHANGELOG.md` (an Unreleased section)

- [ ] **Step 1:** Document `--review-at`, `--review-rounds`, the per-story review and where its state lives (`stories/<id>.review-state.json`), in the voice of the surrounding docs.
- [ ] **Step 2: Run** `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` — all PASS.
- [ ] **Step 3: Run** `pnpm build && node scripts/pack-smoke.mjs` — PASS.
- [ ] **Step 4: Commit** `git commit -m "docs: story-level review (ADR 0044)"`
