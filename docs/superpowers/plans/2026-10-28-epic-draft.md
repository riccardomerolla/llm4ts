# epic-draft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fast epic flow that writes code without tests or heavy review, records what it deferred as debt, and pays that debt in a `--harden` round with epic-stories' full bar.

**Architecture:** A third policy on the `runEpicStories` spine (like `epic-mvp`): a planner overlay, an executor policy (one lens, one round, findings deferred, test gate off, no judge), an `afterUnit` that writes `debt.md`, and a `--harden` mode that maps to `--refine` with the debt as feedback. Two small seams are added to the spine; everything else lives in `flows/lib/epic-draft.ts`.

**Tech Stack:** TypeScript, Effect 4, `@effect/vitest`, pnpm workspace.

**Spec:** `docs/adr/0043-epic-draft.md`

## Global Constraints

- Effect 4 only; expected failures typed (`FlowAborted`, `ScriptUsage`, `PersistenceError`), never global `Error`.
- No `any`, no unchecked type assertions; relative imports end in `.ts`.
- Tests deterministic with `@effect/vitest`, using the in-src fakes (`makeMemoryPlainFileStore`, `makeCollectingFlowEvents`, `flows/test/support.ts`); no network, no provider CLIs.
- epic-stories and epic-mvp behaviour unchanged when the new options are absent.
- Every commit passes `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Existing tests broken during the draft.** The test gate is off, so a draft can turn existing tests red; gates with a memory would then treat them as inherited. Expect `debt.md` to carry the test gate's failing lines (Task 3, test `records the skipped test gate's failures`).
2. **A pack whose test command is not recognised** (`mvn verify`, `./gradlew check`). `testGateCommand` finds nothing, so nothing is dropped. Expect every gate kept and a line saying so (Task 1, test `keeps every gate when no test command is found`).
3. **`--harden` twice.** The second run must not replan paid debt. Expect the debt moved to `debt.paid.md` after a settled round, and a second `--harden` with no text to stop with a message (Task 4, tests `moves consumed debt to debt.paid.md` and `refuses when there is no debt and no text`).
4. **Failed or waiting draft stories.** Debt lists merged stories only; a hardening round must not plan tests for code that never merged (Task 3, test `lists only merged stories`).
5. **`--harden` on an epic made by epic-stories** (no `debt.md`). Expect the text alone as feedback, or the refusal from item 3 when there is no text (Task 4, same test).

---

### Task 1: Spine seams — `deferNonBlocking` policy, `selectGates`, shared unit folders

**Files:**

- Modify: `flows/lib/epic-stories.ts` (`StoriesPolicy` ~2111, `EpicStoriesOptions` ~2115, gate resolution ~2513)
- Modify: `flows/lib/epic-mvp.ts` (`verdictDirs` ~572 moves out)
- Test: `flows/test/epic-stories.test.ts`, `flows/test/epic-mvp.test.ts` (unchanged tests must still pass)

**Interfaces:**

- Produces:
  - `StoriesPolicy` = `Partial<Pick<StoriesOptions, "redPhase" | "planTasks" | "reviewers" | "maxRounds" | "taskConcurrency" | "deferNonBlocking">>`
  - `EpicStoriesOptions.selectGates?: (commands: ReadonlyArray<ReadonlyArray<string>>) => { readonly commands: ReadonlyArray<ReadonlyArray<string>>; readonly note?: string }`
  - `withoutTestGate(commands): { commands; note? }` exported from `flows/lib/epic-stories.ts`
  - `unitStateDirs(files: PlainFileStoreShape, epicStateDir: string): Effect.Effect<ReadonlyArray<string>, PersistenceError>` exported from `flows/lib/epic-stories.ts` (the body of epic-mvp's `verdictDirs`; epic-mvp imports it)

- [ ] **Step 1: Write the failing tests** in `flows/test/epic-stories.test.ts`, `describe("draft seams (ADR 0043)")`:

```ts
it("withoutTestGate drops the test command and says which", () => {
  const picked = withoutTestGate([["pnpm", "typecheck"], ["pnpm", "test"], ["pnpm", "build"]])
  assert.deepStrictEqual(picked.commands, [["pnpm", "typecheck"], ["pnpm", "build"]])
  assert.strictEqual(picked.note, "test gate deferred: pnpm test")
})
it("keeps every gate when no test command is found", () => {
  const picked = withoutTestGate([["mvn", "verify"]])
  assert.deepStrictEqual(picked.commands, [["mvn", "verify"]])
  assert.strictEqual(picked.note, "test gate: none recognised, every gate kept")
})
it.effect("unitStateDirs lists the epic folder, then each round that has a plan", () => …)
// writes /e/plan.md, /e/rounds/1/plan.md; expects ["/e", "/e/rounds/1"]
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run flows/test/epic-stories.test.ts -t "draft seams"`
Expected: FAIL, `withoutTestGate` / `unitStateDirs` not exported.

- [ ] **Step 3: Implement.** Add `"deferNonBlocking"` to `StoriesPolicy`. Add `withoutTestGate` beside `testGateCommand` (filter out the command it returns). Move `verdictDirs` to `unitStateDirs` in epic-stories and import it in epic-mvp. Add `selectGates` to `EpicStoriesOptions` and apply it right after `epicGateCommands(...)`: the selected `commands` replace `resolvedGates.commands` for the gate list message, `gatesIn`, `testGateCommand` and `gateCommands`; publish `note` as an `Info` when present. The automatic ADR 0031 follow-up stays keyed on the flag (`deferring`), not on the policy's `deferNonBlocking`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run flows/test/epic-stories.test.ts flows/test/epic-mvp.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit** — `epic-stories: draft seams (deferNonBlocking policy, selectGates, unitStateDirs)`

---

### Task 2: Draft planner overlay

**Files:**

- Create: `flows/lib/epic-draft.ts`
- Test: `flows/test/epic-draft.test.ts`

**Interfaces:**

- Consumes: `storyPlanInstructions`, `storyPlanJsonSchema`, `PlanInputs` from `./epic-stories.ts`; `structuredAndPublish` from `@llm4ts/flow/Usage`
- Produces:
  - `draftPlanInstructions(epicId: string, guidance: string, orientation?: string): string`
  - `generateDraftPlan(inputs: PlanInputs): Effect.Effect<StoryPlan, FlowLlmError>`

- [ ] **Step 1: Write the failing tests**

```ts
it("the draft cut overrides the tests rule and keeps acceptance", () => {
  const text = draftPlanInstructions("e", "rules")
  assert.include(text, "Draft cut (this run is epic-draft")
  assert.include(text, "No story writes or owns test files now")
  assert.include(text, "`acceptance` still lists two to six outcomes")
  assert.include(text, "Leave `testsDeferred` out")
})
it.effect("generateDraftPlan keeps our epic id and text", …)
// seat replies a one-story plan with epicId "ignored"; expect plan.epicId === "e", plan.epic === "Accounts."
```

- [ ] **Step 2: Run to see them fail** — `pnpm vitest run flows/test/epic-draft.test.ts` → FAIL, module missing.

- [ ] **Step 3: Implement.** `draftPlanInstructions` = `storyPlanInstructions(...)` followed by a "Draft cut" block (same layering as `mvpPlanInstructions`) with these rules: no story writes or owns test files now; `acceptance` still lists two to six outcomes, each one a test the hardening round will write; prefer fewer, thinner stories; leave `testsDeferred` out (every outcome is owed). `generateDraftPlan` mirrors `generateStoryPlan` with these instructions and `brief ?? epic`, then overwrites `epicId`/`epic`.

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit** — `epic-draft: planner overlay`

---

### Task 3: The debt ledger (`debt.md`)

**Files:**

- Modify: `flows/lib/epic-draft.ts`
- Test: `flows/test/epic-draft.test.ts`

**Interfaces:**

- Consumes: `EpicUnitContext` (incl. `testGate`), `deferredFeedback` from `./epic-stories.ts`; `EpicReport` from `@llm4ts/flow/Stories`
- Produces:
  - `debtPath(stateDir: string): string` → `join(stateDir, "debt.md")`
  - `paidPath(stateDir: string): string` → `join(stateDir, "debt.paid.md")`
  - `renderDebt(plan: StoryPlan, report: EpicReport, deferred: string | undefined, testFailures: string | undefined): string`
  - `draftAfterUnit(withTests: boolean): (unit: EpicUnitContext, report: EpicReport) => Effect.Effect<void, FlowError>`

- [ ] **Step 1: Write the failing tests**

```ts
it("lists only merged stories, each outcome as a test owed", () => {
  // plan: a (acceptance ["shows the balance"]), b (acceptance ["sends a transfer"]); report: a done, b failed
  const text = renderDebt(plan, report, undefined, undefined)
  assert.include(text, "## a")
  assert.include(text, "- [ ] test: shows the balance")
  assert.notInclude(text, "sends a transfer")
})
it("appends deferred findings and the skipped test gate's failures", () => {
  const text = renderDebt(plan, report, "- [Warning] naming", "FAIL src/a.test.ts > balance")
  assert.include(text, "Deferred findings")
  assert.include(text, "- [Warning] naming")
  assert.include(text, "Test gate on the epic checkout (skipped while drafting)")
  assert.include(text, "FAIL src/a.test.ts > balance")
})
it.effect("records the skipped test gate's failures", …)
// unit.testGate returns a ReviewResult with one Critical issue; draftAfterUnit(false) writes debt.md containing its title,
// and publishes Info "debt: 1 test owed, no deferred findings, test gate red — run epic-draft --harden (<path>)"
it.effect("with --with-tests the test gate is not rerun", …)
// testGate that fails the test if called; draftAfterUnit(true) still writes debt.md
```

- [ ] **Step 2: Run to see them fail** — FAIL, not exported.

- [ ] **Step 3: Implement.** `renderDebt`: a `# Debt — <epicId>` heading, one `## <story id>` section per `done` story with `- [ ] test: <outcome>` per acceptance outcome, then optional `## Deferred findings` (the `deferred` text) and `## Test gate on the epic checkout (skipped while drafting)` (the failing lines). `draftAfterUnit`: read `deferredFeedback(unit.files, unit.stateDir, unit.plan)`; when `!withTests && unit.testGate !== undefined`, run `unit.testGate(unit.workDir, unit.events)` once and join its issue titles and descriptions as `testFailures` (clean → undefined); write `debtPath(unit.stateDir)` with `writeAtomic`; publish one `Info`: `debt: <n> test owed|tests owed, no deferred findings|<m> deferred finding(s)[, test gate red] — run epic-draft --harden (<debt path>)`. An empty draft (nothing merged, nothing deferred, gate clean) writes nothing and publishes nothing.

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit** — `epic-draft: debt ledger`

---

### Task 4: `--harden` — debt as refine feedback, paid debt moved aside

**Files:**

- Modify: `flows/lib/epic-draft.ts`
- Test: `flows/test/epic-draft.test.ts`

**Interfaces:**

- Consumes: `unitStateDirs` (Task 1), `debtPath`/`paidPath` (Task 3)
- Produces:
  - `hardenFeedback(epicStateDir: string, text: string, files: PlainFileStoreShape): Effect.Effect<string, PersistenceError>`
  - `hardenAfterUnit(unit: EpicUnitContext, report: EpicReport): Effect.Effect<void, FlowError>`

- [ ] **Step 1: Write the failing tests**

```ts
it.effect("plans every open debt list, with the text first", …)
// /e/debt.md "## a\n- [ ] test: shows the balance"; hardenFeedback("/e", "focus on a", store)
// includes "Pay this epic's draft debt", "focus on a", "shows the balance"
it.effect("refuses when there is no debt and no text", …)
// hardenFeedback("/e", "", store) === "" — epic-stories' runAction (packages/flow/src/RefineRound.ts)
// already answers empty feedback with Usage "--refine needs the feedback to plan a round from";
// hardenFeedback("/e", "free text", store) === "free text"
it.effect("moves consumed debt to debt.paid.md once the round settles", …)
// report all done → debt.md becomes "", debt.paid.md holds the old text; a failed story → debt.md untouched
```

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement.** `hardenFeedback`: collect non-empty `debt.md` across `unitStateDirs`; none → return `text` unchanged (an empty string is refused by `runAction`). Otherwise a header ("Pay this epic's draft debt: write the tests owed as deterministic tests in the house style, make the test gate green, and close the findings that still apply."), then the text, then each debt list. `hardenAfterUnit`: when `report.count("failed") === 0 && report.count("waiting") === 0`, for each dir from `unitStateDirs(unit.files, unit.epicStateDir)` with non-empty debt, append it to `paidPath` and write `debt.md` as `""`.

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit** — `epic-draft: --harden pays the debt`

---

### Task 5: Flags, policy and the program

**Files:**

- Modify: `flows/lib/epic-draft.ts`
- Create: `flows/epic-draft.ts`
- Modify: `flows/package.json` (script `"epic-draft": "node --experimental-strip-types epic-draft.ts"`)
- Test: `flows/test/epic-draft.test.ts`

**Interfaces:**

- Consumes: everything above; `rubricStoryJudge`, `withoutTestGate`, `runEpicStories` from `./epic-stories.ts`; `correctnessReviewer` from `@llm4ts/flow/Review`
- Produces:
  - `interface DraftFlags { readonly harden: boolean; readonly withTests: boolean; readonly argv: ReadonlyArray<string> }`
  - `parseDraftFlags(argv: ReadonlyArray<string>): DraftFlags` (`--harden` → `--refine` in `argv`)
  - `epicDraftOptions(flags: DraftFlags): EpicStoriesOptions`

- [ ] **Step 1: Write the failing tests**

```ts
it("--harden becomes --refine; --with-tests is the flow's own", () => {
  assert.deepStrictEqual(parseDraftFlags(["--harden", "--with-tests", "--epic", "e"]), {
    harden: true,
    withTests: true,
    argv: ["--refine", "--epic", "e"]
  })
})
it("a draft run: one lens, one round, findings deferred, no judge, test gate off", () => {
  const options = epicDraftOptions(parseDraftFlags([]))
  assert.isUndefined(options.storyJudge)
  assert.isDefined(options.selectGates)
  const policy = options.stories?.(unit)
  assert.deepStrictEqual(
    policy?.reviewers?.map((r) => r.name),
    [correctnessReviewer.name]
  )
  assert.strictEqual(policy?.maxRounds, 1)
  assert.isTrue(policy?.deferNonBlocking)
})
it("--with-tests keeps the test gate", () => {
  assert.isUndefined(epicDraftOptions(parseDraftFlags(["--with-tests"])).selectGates)
})
it("--harden runs epic-stories' full bar", () => {
  const options = epicDraftOptions(parseDraftFlags(["--harden"]))
  assert.strictEqual(options.storyJudge, rubricStoryJudge)
  assert.isUndefined(options.stories)
  assert.isUndefined(options.selectGates)
  assert.isDefined(options.refineFeedback)
})
```

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement.** Draft mode: `generatePlan: generateDraftPlan`, `stories: () => ({ reviewers: [correctnessReviewer], maxRounds: 1, deferNonBlocking: true })`, `selectGates: withoutTestGate` unless `withTests`, `afterUnit: draftAfterUnit(flags.withTests)`, no `beforeLand` (landing a draft is allowed; the debt line was printed when the unit ended). Harden mode: `storyJudge: rubricStoryJudge`, `refineFeedback: hardenFeedback`, `afterUnit: hardenAfterUnit`. `flows/epic-draft.ts`: header comment in the style of `flows/epic-mvp.ts` (one-line purpose, four example invocations: draft, `--plan-only`, `--harden`, `--land`), then `runFlowMain(runEpicStories({ ...epicDraftOptions(flags), argv: flags.argv }))`.

- [ ] **Step 4: Run** the new tests, then `pnpm build && node scripts/pack-smoke.mjs`; expected: pack smoke lists 36 built-in flows.

- [ ] **Step 5: Commit** — `epic-draft: flags, policy and program (ADR 0043)`

---

### Task 6: Docs and the rehearsal spec

**Files:**

- Modify: `docs/adr/0043-epic-draft.md` (Status → Accepted), `flows/README.md` (table row + a section after "Reaching an MVP sooner"), `docs/configuration.md` (`--harden`, `--with-tests`), `skills/using-llm4ts/SKILL.md` (when to pick draft vs mvp vs stories), `CHANGELOG.md` (`## Unreleased`)
- Create: `specs/pending/epic-draft-rehearsal.md`

- [ ] **Step 1: Write the docs.** The README section states the trade in one line ("fast first, then `--harden`; a draft that lands unhardened ships untested code") and the three-flow choice: stories for the full bar, mvp for test-first, draft for code-first.
- [ ] **Step 2: Write the rehearsal spec** in the shape of `specs/pending/epic-mvp-rehearsal.md`: the epic-light fixture seeded three times, one roster, runs of `epic-stories`, `epic-mvp` and `epic-draft` then `epic-draft --harden`; record `llm4ts profile --epic <id> --json` for each and compare with `--against`. Checklist: draft wall-clock vs epic-stories (target ≤ 30%), draft + harden vs epic-stories, debt.md complete (every merged outcome listed), test gate failures captured, harden turned the test gate green, second `--harden` planned nothing.
- [ ] **Step 3: Verify** — `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
- [ ] **Step 4: Commit** — `docs: epic-draft (ADR 0043), rehearsal spec`
