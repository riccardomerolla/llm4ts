# Epic Design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A built-in flow `epic-design` that turns a request, a legacy `modernize-extract` pack and a target repository into an approved epic brief that `epic-stories` plans from.

**Architecture:** The brief is a parseable markdown file and the only state (`<target>/.llm4ts/epics/<id>/brief.md`). `packages/flow/src/EpicBrief.ts` holds its schema, parser, renderer, the deterministic checks and the pure loop decision. `flows/lib/epic-design.ts` builds the pack index, the prompts and the one-run `designEpic` effect (select → propose → check → one fix round → write); `flows/epic-design.ts` is the entry. `runEpicStories` picks up an approved brief as the planner's input.

**Tech Stack:** TypeScript, Effect 4 rc.115, `@effect/vitest`; existing seams `structuredAndPublish`, `makeOpenPointsCollector`, `scenarioTitles`, `parseDecisions`, `epicIdFor`, `OpenPointsPending`.

**Spec:** `docs/superpowers/specs/2026-09-30-epic-design-design.md`

**Execution note:** author and executor are the same session (user chose inline execution and asked for both in one go). Each task below fixes its files, exported names and signatures, formats, and the test cases; implementation code is written test-first during execution (RED observed, then GREEN), not duplicated here.

## Global Constraints

- Effect 4 pinned `4.0.0-rc.115`; check `.repos/effect/packages/effect/src/*.ts` when unsure of an API.
- No `any`, no type assertions (eslint forbids all), no namespaces, no unmanaged promises, no global `Error` as a domain error; expected failures are `Schema.TaggedError`s in `FlowError`.
- `.ts` relative imports; explicit subpath exports in `packages/flow/package.json`.
- The legacy input is always the extract pack under `docs/modernization/`; refuse without it.
- Error messages name files, programs and scenario titles; never spec, source or diff content.
- The brief is never written with a silent defect: a check that still fails after the fix round becomes a `[check]` open point.
- An `approved` brief is never rewritten by the flow.
- `flows/test/epic-stories.test.ts` stays green; existing tests there are not modified (additions only).
- Tests deterministic and offline. Verification before each commit: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A brief the user edited by hand (reordered bullets, extra blank lines, prose between sections, an answer on several lines) still parses and keeps the edits through a revision (Task 1, Task 4).
2. A scenario title containing `—` or `›` (Task 1: split on the first `›` and the first `—` after it; the checks catch a title that no longer matches).
3. A cited program that exists with a scenario title differing only in case or trailing whitespace → reported as `UnknownScenario`, naming the closest title (Task 2).
4. `--epic <id>` for a folder holding a brief but no plan yet → `epic-stories` finds it (Task 5; `listEpics` only lists folders with a plan).
5. A draft brief in the epic folder when the user runs `epic-stories` with the same text → refused with `EpicBriefNotApproved`, not silently planned from the one-line text (Task 5).

---

### Task 1: The brief — schema, parser, renderer, errors

**Files:**

- Create: `packages/flow/src/EpicBrief.ts`
- Modify: `packages/flow/src/FlowError.ts` (three errors + union), `packages/flow/package.json` (`"./EpicBrief"` export)
- Test: `packages/flow/test/EpicBrief.test.ts`

**Interfaces (Produces):**

- `BriefStatus = Schema.Literals(["draft", "approved"])`
- `class Citation { program: String, scenario: String }`
- `class ScopeItem { title: String, citations: Array<Citation>, newBehaviour: optionalKey(String) }`
- `class Disposed { program: String, scenario: String, note: String }` — used for dropped (reason), provided (pointer), deferred (note)
- `class ConsideredProgram { name: String, reason: String }`
- `class EpicBrief { epicId, status, request, legacy, goal, programs: Array<ConsideredProgram>, scope: Array<ScopeItem>, dropped: Array<Disposed>, provided: Array<Disposed>, deferred: Array<Disposed>, constraints, openPoints: Array<OpenPoint>, feedback }` (`OpenPoint` from `./Decisions.ts`)
- `parseEpicBrief(markdown: string, path?: string): Effect<EpicBrief, EpicBriefInvalid>` — accumulates violations with line numbers
- `renderEpicBrief(brief: EpicBrief): string`
- `unanswered(brief): ReadonlyArray<OpenPoint>` — points with no or empty answer
- In `FlowError.ts`: `ExtractPackMissing { legacyRepo }`, `EpicBriefInvalid { path?: String, violations: Array<String> }`, `EpicBriefNotApproved { path }`, all added to the `FlowError` union.

**Format** (what `renderEpicBrief` writes and `parseEpicBrief` reads):

```markdown
# Epic brief: <epicId>

Status: draft
Request: <one line>
Legacy: <text>

## Goal

<prose, any lines>

## Legacy programs considered

- NAME — reason

## In scope

- Item title
  - PROGRAM › scenario title
  - new: reason

## Dropped

- PROGRAM › scenario title — reason

## Provided by the target

- PROGRAM › scenario title — pointer

## Deferred

- PROGRAM › scenario title — note

## Constraints

<prose>

## Open points

1. question
   answer: text

## Feedback

<prose>
```

Parsing rules: section by `## ` title (unknown sections are a violation naming the line); header lines `Status:`, `Request:`, `Legacy:` anywhere before the first section; prose sections keep their text trimmed; bullets in list sections must match the shapes above or are a violation with the line number; fenced code blocks inside prose are kept verbatim; open points through `makeOpenPointsCollector` (so `answer:` is lower-case, continuation lines allowed). A rendered unanswered point carries an empty `   answer:` line so the user sees where to write.

- [ ] **Step 1: failing tests** — round trip (`render(parse(render(b))) === render(b)`); a hand-edited brief (reordered bullets, blank lines, multi-line answer, prose between bullets in Goal) parses; a scope item with two citations and one with `new:`; titles containing `—`; violations: unknown section, malformed bullet, missing `Status`, bad status word — all reported together with line numbers; `unanswered` treats an empty answer as unanswered.
- [ ] **Step 2: run** `pnpm vitest run packages/flow/test/EpicBrief.test.ts` → FAIL (module missing).
- [ ] **Step 3: implement**; add the export and the errors.
- [ ] **Step 4: run** the tests → PASS; `pnpm typecheck && pnpm lint && pnpm format:check`.
- [ ] **Step 5: commit** `flow: the epic brief — schema, parser, renderer`.

---

### Task 2: Deterministic checks

**Files:**

- Modify: `packages/flow/src/EpicBrief.ts`
- Test: `packages/flow/test/EpicBrief.test.ts` (append)

**Interfaces (Produces):**

- `interface PackProgram { name: string; summary: string; scenarios: ReadonlyArray<string> }`
- `interface RefineDisposition { program: string; scenario?: string; disposition: "drop" | "provided" | "defer" | "wrap" }`
- `interface PackIndex { programs: ReadonlyArray<PackProgram>; refine: ReadonlyArray<RefineDisposition> }`
- `BriefProblem` = Schema.Union of structs with `kind`: `UnknownProgram {program}`, `UnknownScenario {program, scenario, closest?: String}`, `MissingPointer {program, scenario, pointer}`, `MissingReason {where: String}`, `DuplicateDisposition {program, scenario, lists: Array<String>}`, `Unaccounted {program, scenario}`, `RefineConflict {program, scenario, disposition}`, `ApprovedWithOpenPoints {numbers: Array<Int>}`
- `renderBriefProblem(problem): string`
- `checkEpicBrief(brief: EpicBrief, inputs: { pack: PackIndex; pointers: ReadonlySet<string> }): ReadonlyArray<BriefProblem>` — `pointers` is the set of `provided` pointers the caller verified to exist
- `providedPointers(brief): ReadonlyArray<string>` — what the caller must verify

Rules: every citation and disposed entry names a known program and scenario (closest = case/whitespace-insensitive match when there is one); provided entries need a pointer in `pointers`; dropped/deferred need a non-empty note; an uncited scope item needs `newBehaviour`; a scenario in two lists is `DuplicateDisposition`; every scenario of every program in `brief.programs` appears somewhere (`Unaccounted` otherwise); a scenario refine marks `drop`/`provided` (scenario-level, or program-level for all its scenarios) that is in scope is `RefineConflict` unless an answered open point mentions both the program and the scenario title; `approved` with unanswered points is `ApprovedWithOpenPoints`.

- [ ] **Step 1: failing tests** — one per problem kind; a clean brief yields `[]`; several problems are all reported; the closest-title hint; a refine conflict cleared by an answered open point.
- [ ] **Step 2–4:** RED, implement, GREEN, verify.
- [ ] **Step 5: commit** `flow: deterministic checks for the epic brief`.

---

### Task 3: Proposal schemas, brief assembly, the loop decision, the revision diff

**Files:**

- Modify: `packages/flow/src/EpicBrief.ts`
- Test: `packages/flow/test/EpicBrief.test.ts` (append)

**Interfaces (Produces):**

- `class ProgramSelection { programs: Array<ConsideredProgram> }` + `programSelectionJsonSchema: JsonSchema`
- `class EpicBriefProposal { goal, scope: Array<ScopeItem>, dropped, provided, deferred: Array<Disposed>, constraints, openPoints: Array<String> }` + `epicBriefProposalJsonSchema`
- `assembleBrief(options: { epicId; request; legacy; programs: ReadonlyArray<ConsideredProgram>; proposal: EpicBriefProposal; previous?: EpicBrief; problems?: ReadonlyArray<BriefProblem> }): EpicBrief` — status `draft`; open points numbered from 1: the proposal's questions, then one `[check] <renderBriefProblem>` per problem; answered points of `previous` are dropped (they were folded in), unanswered ones the proposal did not restate are kept; feedback emptied
- `type LoopAction = "propose" | "revise" | "halt" | "await-approval" | "validate"`
- `loopAction(brief: EpicBrief | undefined): LoopAction` — per the spec's table
- `diffBriefs(previous: EpicBrief | undefined, next: EpicBrief): ReadonlyArray<string>` — human lines: scenarios added to / moved between lists (`CONTO › X: deferred → in scope`), open points raised and closed, programs added/removed

- [ ] **Step 1: failing tests** — `loopAction` for each of the five rows; `assembleBrief` numbering, `[check]` points, carrying unanswered points, dropping answered ones, emptying feedback; `diffBriefs` for a move, an addition, a closed point; the two JSON schemas decode a sample with their Schema.
- [ ] **Step 2–4:** RED, implement, GREEN, verify.
- [ ] **Step 5: commit** `flow: epic brief proposals, the loop decision and the revision diff`.

---

### Task 4: `designEpic` — one run of the loop

**Files:**

- Create: `flows/lib/epic-design.ts`
- Create: `flows/fixtures/epic-design/legacy/docs/modernization/{README.md,specs/CONTO_SALDO.md,specs/CONTO_MOVIMENTI.md,features/conto_saldo.feature,features/conto_movimenti.feature,decisions.md}` and `flows/fixtures/epic-design/target/{CONTRIBUTING.md,src/kit/session/SessionGuard.tsx}`
- Test: `flows/test/epic-design.test.ts`

**Interfaces (Consumes):** Task 1–3 exports; `structuredAndPublish` (`@llm4ts/flow/Flow`); `scenarioTitles`, `parseDecisions` (`@llm4ts/flow/Decisions`); `capped`/`cap` (`@llm4ts/flow/Context`); `OpenPointsPending`, `ExtractPackMissing`, `EpicBriefInvalid` (`@llm4ts/flow/FlowError`); `ModDir` (`./modernize-extract.ts`).

**Interfaces (Produces):**

- `interface EpicDesignArgs { list: boolean; epic: string | undefined; rest: ReadonlyArray<string> }`, `parseEpicDesignArgs(argv): Effect<EpicDesignArgs, ScriptUsage>`
- `readPackIndex(options: { files: PlainFileStoreShape; legacyRepo: string; specNames: ReadonlyArray<string> }): Effect<{ index: PackIndex; specs: Record<string,string>; features: Record<string,string> }, FlowError>` — `specNames` come from the caller (node `readdir` in the flow, a list in tests); empty → `ExtractPackMissing`; summary = first non-heading paragraph of the spec; refine dispositions from `decisions.md` when present
- `selectPrompt(request, index)`, `proposePrompt(options)` — pure strings
- `interface DesignDeps { files; reasoning: LlmServiceShape; events: FlowEventsShape; targetDir: string; legacyRepo: string; specNames: ReadonlyArray<string>; epicId: string; request: string; budget: number; guidance: string; packNote: string | undefined; pathExists: (absolute: string) => Effect<boolean> }`
- `interface DesignOutcome { action: LoopAction; path: string; changes: ReadonlyArray<string>; problems: ReadonlyArray<BriefProblem> }`
- `designEpic(deps: DesignDeps): Effect<DesignOutcome, FlowError>`:
  - reads `<targetDir>/.llm4ts/epics/<epicId>/brief.md`, parses, `loopAction`;
  - `propose`: `ProgramSelection` call → `EpicBriefProposal` call (specs of selected programs, capped) → resolve pointers with `pathExists` → `checkEpicBrief` → on problems one more proposal call with the problems listed → re-check → `assembleBrief` (remaining problems as `[check]` points) → write;
  - `revise`: same, with `programs` from the current brief (plus any the feedback names, left to the model via the proposal's open points), the current brief rendered into the prompt, and the instruction to keep everything the feedback does not ask to change;
  - `halt`: fail `OpenPointsPending { path, points }`;
  - `await-approval`: no write;
  - `validate`: check; problems → `EpicBriefInvalid`; never writes.
- `renderOutcome(outcome, epicId): ReadonlyArray<string>` — the lines the flow prints (what changed; how to approve; the `epic-stories --epic <id>` command when validated)

- [ ] **Step 1: failing tests** (memory store seeded from the fixture; a reasoning fake whose `executeStructured` answers by schema: selection, then proposals in sequence):
  - no pack → `ExtractPackMissing`;
  - first run writes a `draft` brief with the selected programs, citations that pass the checks, and the model's open points;
  - a proposal citing an unknown scenario gets one fix round; still wrong → the brief has a `[check]` open point and the run reports the problem;
  - completeness: a proposal covering 2 of 3 scenarios of a considered program → fix round → `[check]` point naming the third;
  - rerun with unanswered points and no feedback → `OpenPointsPending` naming them; the file is unchanged;
  - rerun with an answer + feedback → revised brief; a line the user edited directly in Goal survives when the fake echoes the current goal; Feedback is empty; the answered point is gone; `changes` lists the move;
  - `approved` + clean → `validate`, file byte-identical, outcome mentions `epic-stories`;
  - `approved` with an unanswered point → `EpicBriefInvalid`, file untouched;
  - a `provided` pointer that does not exist in the target → problem;
  - refine's `decisions.md` drop put in scope → `RefineConflict` surfaced.
- [ ] **Step 2–4:** RED, implement, GREEN, verify.
- [ ] **Step 5: commit** `epic-design: one run of the brief loop over an extract pack`.

---

### Task 5: Hand-off in `runEpicStories`

**Files:**

- Modify: `flows/lib/epic-stories.ts` (`generateStoryPlan` optional `brief` parameter; `listBriefs`; `chooseEpic` accepts brief-only folders; `plannerInput`; the three call sites in `runEpicStories`)
- Test: `flows/test/epic-design.test.ts` (append)

**Interfaces (Produces):**

- `generateStoryPlan(reasoning, events, epic, epicId, guidance, brief?: string)` — the prompt reads `brief ?? epic`; `plan.epic` stays `epic`
- `listBriefs(files, workDir): Effect<ReadonlyArray<{ dir: string; request: string; status: BriefStatus }>, FlowError>` — epic folders holding a `brief.md` (parseable ones)
- `EpicChoice` gains `{ _tag: "Brief"; dir: string; request: string }`; `chooseEpic` takes `briefs` and returns it when `--epic <id>` matches a brief-only folder
- `plannerInput(files, stateDir, planPath): Effect<string | undefined, FlowError>` — `undefined` when a plan exists or there is no brief; the rendered brief when approved and clean of unanswered points; `EpicBriefNotApproved` for a draft; `EpicBriefInvalid` for an unparseable one
- `runEpicStories`: epic id = the brief's folder for a `Brief` choice; `recoverOrCreate(planPath, generateStoryPlan(…, input.prompt, epicId, guidance, brief))`

- [ ] **Step 1: failing tests** — `plannerInput` four cases; `chooseEpic` with a brief-only folder; `generateStoryPlan` with a brief sends the brief in the prompt and keeps the request as `plan.epic` (a recording reasoning fake); `listBriefs` on a seeded store (it takes the directory names as an argument in tests, as `readPackIndex` does).
- [ ] **Step 2–4:** RED, implement, GREEN; `pnpm vitest run flows/test/epic-stories.test.ts` still green with no existing test changed.
- [ ] **Step 5: commit** `epic-stories: plan from an approved epic brief`.

---

### Task 6: The flow entry, docs, published surface

**Files:**

- Create: `flows/epic-design.ts`
- Modify: `flows/package.json` (script), `flows/README.md` (table row + a section before "Parallel stories from an epic"), `docs/configuration.md` (`LLM4TS_LEGACY_REPO` under Modernization), `CHANGELOG.md` (`## Unreleased`)
- Test: `flows/test/epic-design.test.ts` (append: the entry's first line is a description; it calls `designEpic`)

The entry: header comment (first line = catalog description); `parseEpicDesignArgs`; `resolveFlowInput`; `LLM4TS_LEGACY_REPO` required (`ScriptUsage` otherwise); spec names via node `readdir` of `<legacy>/docs/modernization/specs`; epic id `epicIdFor(text)` or `--epic`; `--list` prints `listBriefs`; `runNode` with the read-only reasoning seat (`reasonerFromEnvironment`, as `epic-stories`), `coder` the same seat (no coder turn is ever taken); `guidance` = target CONTRIBUTING.md capped at 24k; `packNote` = the pack's name and target description when `LLM4TS_PACK` is set (`openPack`), else undefined; `pathExists` over the target directory; stages `pack`, `select`, `propose`, `check`; prints `renderOutcome`.

- [ ] **Step 1: failing test**; **Step 2:** RED; **Step 3:** implement + docs; **Step 4:** full verification `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build && node scripts/pack-smoke.mjs` (expect 27 built-in flows).
- [ ] **Step 5: commit** `epic-design: the flow entry, docs and changelog`.

---

## Self-review notes

- Spec coverage: brief format and rules (T1), checks table (T2), proposal/selection schemas, loop table, revision diff (T3), select → propose → check → fix round → `[check]` points, the five loop states, errors (T4), hand-off (T5), invocation, `--list`, docs (T6). Out-of-scope items of the spec are not built.
- Two narrowings against the spec, to record in the final summary: the `Legacy:` line carries the repository path without a commit hash (the flow never runs git on the legacy repo); `pack:` pointers are accepted only when `LLM4TS_PACK` is set and are verified against what the opened pack exposes, else reported as a problem.
- Review Focus pinned: 1 → T1 hand-edited parse, T4 edit survives; 2 → T1 title test; 3 → T2 closest hint; 4 → T5 brief-only `--epic`; 5 → T5 draft refused.
