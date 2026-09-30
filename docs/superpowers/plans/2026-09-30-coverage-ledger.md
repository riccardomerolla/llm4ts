# Coverage Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A derived coverage ledger across the epic briefs of a target repository, used as a report (`epic-design --coverage`), as inherited context for the next brief, and as cross-brief checks.

**Architecture:** `packages/flow/src/CoverageLedger.ts` is pure: `buildLedger` turns the pack index, the parsed briefs and the epics' progress into entries with every claim and a derived status; `inheritedFrom` projects what approved briefs decided; `renderLedger` writes the markdown report. `checkEpicBrief` takes that projection as an optional input. `flows/lib/epic-design.ts` loads the briefs, feeds `designEpic` the ledger of the _other_ briefs, and adds the `--coverage` report, which makes no model call.

**Tech Stack:** TypeScript, Effect 4 rc.115, `@effect/vitest`; existing `EpicBrief.ts`, `listEpics`, `listBriefs`, `readPackIndex`.

**Spec:** `docs/superpowers/specs/2026-09-30-coverage-ledger-design.md`

**Execution note:** author and executor are one session (the user asked for plan and implementation together). Tasks fix files, exported names, rules and test cases; code is written test-first at execution.

## Global Constraints

- Effect 4 pinned `4.0.0-rc.115`; no `any`, no type assertions (`as const` allowed), no namespaces, no unmanaged promises, no global `Error` as a domain error; `.ts` relative imports; explicit subpath export `@llm4ts/flow/CoverageLedger`.
- The ledger is derived, never state: nothing but `coverage.md` is written, and `--coverage` never edits a brief and never starts a model seat.
- Only approved briefs bind; a draft's claims are `proposed`.
- No change to the brief file format.
- With no other briefs, `checkEpicBrief` and `designEpic` behave exactly as in 2.17.0: every existing test stays green unchanged, except the one assertion on `parseEpicDesignArgs`' result shape, which gains the `coverage` field.
- Messages name epics, programs and scenario titles; never spec content.
- Verification before each commit: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`. Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A scenario deferred by approved epic A and then dropped (not claimed in scope) by approved epic B → `dropped`, owned by B, not a conflict (Task 1).
2. Three briefs on one scenario: approved in scope in A, approved dropped in B, draft in scope in C → `conflict` naming A and B; C only listed as a draft claim (Task 1).
3. A brief being designed whose own id is among the loaded briefs → it must not inherit from, or conflict with, itself (Task 4).
4. An estate where no brief exists → the report still lists every program as unclaimed and 0% (Task 2, Task 5).
5. A program inherited completely from another epic: the new brief lists it as considered but disposes of none of its scenarios → passes completeness (Task 3).

---

### Task 1: `buildLedger` and `inheritedFrom`

**Files:** Create `packages/flow/src/CoverageLedger.ts`; modify `packages/flow/package.json` (export), `packages/flow/src/EpicBrief.ts` (export `InheritedDecision`, `hasOverride`); test `packages/flow/test/CoverageLedger.test.ts`.

**Produces:**

- In `EpicBrief.ts`: `type BriefDisposition = "in-scope" | "dropped" | "provided" | "deferred"`; `interface InheritedDecision { program; scenario; epic; disposition: BriefDisposition; note: string }`; `hasOverride(brief: EpicBrief, problem: BriefProblem): boolean` (the check's own `[check]` question answered `keep…`; replaces the private `justified`).
- `Claim` (Schema.Class) `{ epicId, approved: Boolean, disposition, note }`; `LedgerStatus` literals `unclaimed | in-scope | dropped | provided | deferred | proposed | conflict`; `DeliveryState` literals `approved | planned | in-progress | landed`.
- `LedgerEntry { program, scenario, status, claims: Array<Claim>, owners: Array<String>, delivery: optionalKey(DeliveryState) }`
- `ProgramTotals { program, scenarios, inScope, dropped, provided, deferred, proposed, unclaimed, conflicts }`
- `StaleClaim { epicId, program, scenario, disposition }`
- `LedgerBriefInfo { epicId, status: BriefStatus, delivery: optionalKey(DeliveryState) }`
- `CoverageLedger { entries, programs: Array<ProgramTotals>, stale: Array<StaleClaim>, skipped: Array<String>, briefs: Array<LedgerBriefInfo>, totals: { scenarios, accounted, delivered, remaining, conflicts } }`
- `interface LedgerBrief { epicId: string; brief: EpicBrief }`; `interface EpicProgress { epicId; planned: boolean; stories: number; merged: number; landed: boolean }`
- `buildLedger(inputs: { pack: PackIndex; briefs: ReadonlyArray<LedgerBrief>; epics: ReadonlyArray<EpicProgress>; legacy?: string }): CoverageLedger`
- `inheritedFrom(ledger: CoverageLedger): ReadonlyArray<InheritedDecision>` — one per approved claim of every entry.

**Rules:** claims come from each brief's four lists (in scope: `note` = the item's title). `legacy` given and a brief's `Legacy:` differing → the brief is `skipped`, its claims ignored. A claim on a program or scenario not in the pack → `stale`. Status from the approved claims: none → `proposed` if a draft claims it, else `unclaimed`; any in-scope → owners are those epics; more than one owner without a `keep:` override in one of them (`AlreadyOwned`) → `conflict`; an approved dropped/provided by another epic beside an in-scope one, without the in-scope brief's `ContradictsBrief` override → `conflict`; approved `deferred` beside anything else is history, not a conflict; no in-scope: both dropped and provided → `conflict`, otherwise dropped or provided wins over deferred, else `deferred`. Delivery of an in-scope entry = its first owner's progress: landed → `landed`; merged > 0 → `in-progress`; planned → `planned`; else `approved`. Totals: `accounted` = in-scope + dropped + provided; `delivered` = dropped + provided + in-scope landed; `remaining` = unclaimed + deferred + proposed + conflicts; `accounted + remaining = scenarios`.

- [ ] Failing tests: each status; several claims kept; the hand-over; Review Focus 1 and 2; two approved owners with and without the override; equal non-scope dispositions; stale; skipped; delivery states; totals and the identity above; `inheritedFrom` lists approved claims only.
- [ ] RED, implement, GREEN, verify, commit `flow: the coverage ledger across epic briefs`.

### Task 2: `renderLedger`

**Files:** modify `CoverageLedger.ts`; test (append).

**Produces:** `renderLedger(ledger: CoverageLedger, options: { legacy: string; unreadable?: ReadonlyArray<{ dir: string; reason: string }> }): string`, and `ledgerHeadline(ledger): string` (`N scenarios · A accounted for (P%) · D delivered · R remaining · C conflicts`).

Sections in order: title and headline, legacy path, briefs read (id, status, delivery); a table per program (`Program | Scenarios | In scope | Dropped | Provided | Deferred | Proposed | Unclaimed | Accounted`); then, only when non-empty: `## Conflicts`, `## Deferred, still waiting`, `## Unclaimed` (grouped by program), `## Proposed by drafts`, `## Stale citations`, `## Skipped briefs`, `## Briefs that could not be read`.

- [ ] Failing tests: headline; a table row; each list present only with entries; an estate with no briefs (Review Focus 4); percentages with zero scenarios do not divide by zero.
- [ ] RED, implement, GREEN, verify, commit `flow: render the coverage ledger`.

### Task 3: cross-brief checks

**Files:** modify `packages/flow/src/EpicBrief.ts`; test `packages/flow/test/EpicBrief.test.ts` (append).

**Produces:** `BriefCheckInputs.others?: ReadonlyArray<InheritedDecision>`; problems `AlreadyOwned { program, scenario, epic }` and `ContradictsBrief { program, scenario, epic, here: String, disposition: String }`, rendered with the `keep: <why>` hint.

**Rules:** completeness also counts a scenario any other approved brief disposed of (any disposition). For each scenario this brief disposes of and another approved brief disposes of: other is `deferred` → fine; both in scope → `AlreadyOwned`; same non-scope disposition → fine; anything else → `ContradictsBrief`. Both overridable through `hasOverride`. No `others` → results unchanged.

- [ ] Failing tests: completeness eased (Review Focus 5); `AlreadyOwned`; `ContradictsBrief` (in scope vs dropped; dropped vs provided; dropped vs in scope); the deferred hand-over; both overrides; restating the same disposition; no `others` leaves the existing results.
- [ ] RED, implement, GREEN, verify, commit `flow: epic briefs are checked against the approved briefs of other epics`.

### Task 4: `designEpic` inherits

**Files:** modify `flows/lib/epic-stories.ts` (`loadBriefs`), `flows/lib/epic-design.ts`; test `flows/test/epic-design.test.ts` (append).

**Produces:**

- `loadBriefs(files, workDir, dirs): Effect<{ briefs: ReadonlyArray<LedgerBrief>; unreadable: ReadonlyArray<{ dir: string; reason: string }> }, FlowError>` (`epicId` = the folder name).
- `DesignDeps.others?: ReadonlyArray<LedgerBrief>` — the other briefs; the one with `epicId === deps.epicId` is ignored (Review Focus 3).
- `ProposePromptOptions.inherited?: ReadonlyArray<InheritedDecision>`: two prompt sections ("Already decided by other epics (do not restate)", "Deferred by other epics, available to this one"), and the list of scenarios to dispose of drops those another approved brief has in scope, dropped or provided.
- `DesignOutcome.inherited: ReadonlyArray<{ epic: string; scenarios: number }>`; `renderOutcome` says how many were inherited and points at `--coverage`.

- [ ] Failing tests: with an approved first brief in the store, the second proposal's prompt names its decisions and omits them from the list; a brief that disposes of only what is open passes completeness; claiming what the first owns raises a `[check]` point naming the first epic; a draft first brief feeds nothing; the brief's own folder among `others` is ignored; no `others` → the existing tests unchanged.
- [ ] RED, implement, GREEN, verify, commit `epic-design: a brief inherits what approved briefs of other epics decided`.

### Task 5: `--coverage`, docs, published surface

**Files:** modify `flows/lib/epic-design.ts` (`coverage` flag, `coverageReport`), `flows/epic-design.ts` (branch before the seat is resolved; pass `others` to `designEpic`), `flows/README.md`, `CHANGELOG.md`; test `flows/test/epic-design.test.ts` (append; update the one args assertion).

**Produces:**

- `EpicDesignArgs.coverage: boolean`
- `epicProgressOf(epics: ReadonlyArray<EpicSummary>): ReadonlyArray<EpicProgress>`
- `coverageReport(options: { files; targetDir; legacyRepo; specNames; dirs: ReadonlyArray<string>; epics: ReadonlyArray<EpicSummary> }): Effect<{ path: string; headline: string; ledger: CoverageLedger }, FlowError>` — writes `<target>/.llm4ts/epics/coverage.md`.

- [ ] Failing tests: the report is written with the headline and a conflict between two approved briefs; an unreadable brief is listed; no briefs at all → every program unclaimed; the run touches no brief file; `--coverage` parses; the entry mentions `--coverage` and calls `coverageReport(`.
- [ ] RED, implement + docs, GREEN; full chain plus `pnpm build && node scripts/pack-smoke.mjs`; commit `epic-design: the coverage report, docs and changelog`.

## Self-review notes

- Spec coverage: ledger data and statuses (T1), report (T2, T5), inherited context (T4), cross-brief checks (T3), error handling for unreadable briefs (T4, T5). Out-of-scope items are not built.
- One sharpening against the spec: `accounted` excludes deferred (deferred is `remaining`), so `accounted + remaining = scenarios` as the spec's headline example implies; conflicts count in `remaining` and are also reported on their own.
- `ContradictsBrief` carries `here` besides the spec's fields, so its question text is unique per brief.
