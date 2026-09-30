# Coverage ledger: what the epics of a target have decided about a legacy pack

Date: 2026-09-30 · Status: design agreed in conversation, spec for review

## Purpose

`epic-design` (2.17.0) writes one brief per epic. A brief gives every
scenario of the legacy programs it touches a disposition: in scope, dropped,
provided by the target, deferred. Its checks stop at the brief's own edge.
Across the briefs of a target repository nothing answers:

- how much of the legacy application is accounted for, by which epic, and
  what nobody has claimed yet;
- whether two briefs disagree about a scenario, or both claim it;
- where a scenario "deferred to the next epic" went.

This spec adds the **coverage ledger**: one derived view, across every brief
of a target repository, against the whole extract pack. The same view is
used three ways: as a report for the engagement, as an input to the next
brief (earlier decisions are inherited, deferred scenarios resurface as
candidates), and as a rule (a brief that contradicts an approved one is told
so).

Success: an analyst designing the third epic of an engagement does not
restate what the first two dropped, is offered what they deferred, is
stopped from re-claiming what they own, and can hand a steering committee a
page that says what is covered, delivered and left.

## Decisions taken

1. **One thing, three uses.** The ledger is a derived data structure; the
   report, the proposal's context and the cross-brief checks all read it.
2. **Derived on demand, never state.** It is a pure function of the extract
   pack, the briefs and the epics' recorded progress. The report file is an
   output. Editing a brief is the only way to change the ledger.
3. **Earlier decisions stand; the next brief inherits them.** Only
   **approved** briefs bind. A draft's dispositions are shown as proposed
   and neither block nor feed another brief.
   - `dropped` and `provided` in an approved brief are facts about the
     estate: another brief does not restate them and its completeness check
     counts them as accounted for.
   - `in scope` in an approved brief is ownership: the scenario is not
     proposed for another epic.
   - `deferred` in an approved brief means available: it is offered to the
     next brief, and claiming it there is the normal hand-over.
   - A brief that contradicts an approved one gets a `[check]` open point
     naming the other epic, resolved as a refine conflict is today: move the
     scenario out, or answer `keep: <why>`, which stays in the brief.
4. **No ordering between briefs.** "Earlier" needs no dates: approved binds
   draft, and two approved briefs that disagree are in conflict with each
   other. The brief format does not change.
5. **Delivered means the epic landed.** Stories do not cite scenarios, so
   the ledger reports an epic's state for all its in-scope scenarios.
6. **Scenario level.** The ledger has the granularity briefs have. Coverage
   of legacy code units stays with `modernize-extract`'s own gate.

## The ledger as data

`packages/flow/src/CoverageLedger.ts`, pure, no I/O:

```ts
buildLedger(inputs: {
  pack: PackIndex                       // programs and scenario titles (EpicBrief.ts)
  briefs: ReadonlyArray<LedgerBrief>    // { epicId, brief: EpicBrief }
  epics: ReadonlyArray<EpicProgress>    // { epicId, stories, merged, landed? }
}): CoverageLedger
```

For every scenario of every program in the pack, one `LedgerEntry`:

| Status      | Meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `unclaimed` | no brief mentions it                                                    |
| `in-scope`  | an approved brief carries it over; with the owning epic and its item    |
| `dropped`   | an approved brief dropped it; with the epic and the reason              |
| `provided`  | an approved brief found it in the target; with the epic and the pointer |
| `deferred`  | an approved brief deferred it; with the epic and the note               |
| `proposed`  | only draft briefs mention it; with each draft's disposition             |
| `conflict`  | approved briefs disagree, or more than one has it in scope              |

An entry keeps **every** claim on the scenario (`claims: [{ epicId, status:
"approved" | "draft", disposition, note }]`); the status above is derived
from the approved claims, falling back to `proposed`. Two approved claims
with the same non-scope disposition (both dropped) are not a conflict; two
approved `in-scope` claims are, unless one of the two briefs carries the
answered `keep:` override for it (then the entry is `in-scope` and lists
both owners).

An approved `deferred` claim beside another brief's approved `in-scope`
claim is the hand-over, not a conflict: the entry is `in-scope`, owned by the
claiming epic, and keeps the deferral as history.

Also in the ledger:

- `stale`: claims whose program or scenario the pack no longer has (the
  program was re-extracted, a title changed), each with its epic. They are
  listed, never silently dropped.
- `skipped`: briefs whose `Legacy:` line names another legacy repository
  than the pack in hand.
- Per in-scope entry, the owning epic's **delivery state**, from what
  `epic-stories` records: `approved` (brief only), `planned` (a plan
  exists), `in progress` (n of m stories merged), `landed`.
- Totals per program and for the estate: scenarios, accounted for (any
  approved disposition), delivered (in scope and landed, plus dropped and
  provided, which need no delivery), remaining (unclaimed, deferred,
  proposed), conflicts.

`CoverageLedger`, `LedgerEntry` and the totals are `Schema` types, so the
ledger can be encoded into a trace or a JSON export later without redesign.

## Use 1: the report

```sh
LLM4TS_LEGACY_REPO=~/legacy/ib-core \
  llm4ts run epic-design --repo ~/work/portal -- --coverage
```

Builds the ledger, writes `<target>/.llm4ts/epics/coverage.md`
(`renderLedger`), and prints the estate's headline and the counts that need
a human. No model call; the reasoning seat is not started.

The file, in order:

1. The headline: `142 scenarios · 96 accounted for (68%) · 58 delivered ·
46 remaining · 2 conflicts`, the legacy path and the briefs read (id,
   status, delivery state).
2. A table per program: scenarios, in scope, dropped, provided, deferred,
   proposed, unclaimed, accounted-for percentage. Programs no brief touches
   are in the table with everything unclaimed.
3. **Conflicts**, each with both epics and their dispositions.
4. **Deferred, still waiting**: scenario, the epic that deferred it, its
   note.
5. **Unclaimed**, grouped by program.
6. **Stale citations** and **skipped briefs**, when there are any.

`--coverage` is a read of the repository: it never edits a brief.

## Use 2: the next brief inherits

When `designEpic` proposes or revises, it builds the ledger from the
**other** briefs of the repository (every brief but the one being designed)
and passes what approved ones decided for the selected programs:

- the prompt gains a section "Already decided by other epics (do not
  restate)": dropped and provided scenarios with the deciding epic, and
  scenarios owned by another epic;
- and a section "Deferred by other epics, available to this one", with the
  deferring epic and its note;
- the "every scenario to give a disposition to" list shrinks to the
  scenarios that are still open: unclaimed, deferred elsewhere, or only
  proposed by a draft.

The brief file does not repeat inherited decisions. `renderOutcome` says how
many scenarios were inherited and from which epics, and points at
`--coverage` for the full picture.

## Use 3: checks across briefs

`checkEpicBrief` takes the inherited view as an optional input
(`others: InheritedDecisions`, built from the ledger of the other briefs):

- **Completeness** counts a scenario as accounted for when this brief
  disposes of it **or** an approved brief of another epic does.
- New problem `AlreadyOwned { program, scenario, epic }`: in scope here and
  in scope in approved epic X.
- New problem `ContradictsBrief { program, scenario, epic, disposition }`:
  in scope here, dropped or provided in approved epic X.
- Both are overridable like `RefineConflict`: the check's own `[check]`
  question answered `keep: <why>`.
- Restating an inherited `dropped` or `provided` with the same disposition
  is allowed (a hand-written brief may do it) and is not a problem; a
  different non-scope disposition than the approved one (dropped here,
  provided there) is `ContradictsBrief`.
- Claiming a scenario another approved brief **deferred** is not a problem.

The checks run where they run today: on every proposal, and when an
approved brief is validated. So two briefs approved by hand in contradiction
are caught the next time either is validated, and appear as conflicts in the
report.

Without other briefs the inherited view is empty and every check behaves
exactly as in 2.17.0.

## Components

```text
packages/flow/src/CoverageLedger.ts   buildLedger, inheritedFrom, renderLedger, schemas
packages/flow/src/EpicBrief.ts        checkEpicBrief: optional `others`, two problems
flows/lib/epic-design.ts              loadBriefs + epic progress, --coverage, prompt sections,
                                      the ledger of the other briefs in designEpic
flows/epic-design.ts                  the --coverage branch (no seat, no runNode)
```

`CoverageLedger.ts` depends on `EpicBrief.ts` types only. Reading briefs and
epic progress from disk stays in `flows/lib` (`listBriefs` exists; it gains
a variant returning the parsed briefs), so the builder and the renderer are
testable with values.

## Error handling

- A brief that does not parse is not skipped silently: `--coverage` lists it
  under "briefs that could not be read" with its first violation, and the
  ledger is built from the others. In `designEpic` an unreadable **other**
  brief is a warning in the outcome, not a failure of the run.
- `--coverage` without `LLM4TS_LEGACY_REPO`, or with no extract pack there,
  fails as `epic-design` does today (`ScriptUsage`, `ExtractPackMissing`).
- Messages name epics, programs and scenario titles; never spec content.

## Testing

Deterministic, offline:

- `buildLedger`: each status; several claims on one scenario; the deferred →
  in-scope hand-over; two approved in-scope claims with and without the
  `keep:` override; equal non-scope dispositions are not a conflict; a draft
  only → `proposed`; stale citations; a skipped brief; delivery states from
  epic progress; totals per program and for the estate.
- `renderLedger`: the headline, a program table row, each list present only
  when it has entries; a snapshot of a small estate.
- `checkEpicBrief` with `others`: completeness eased by an inherited
  decision; `AlreadyOwned`; `ContradictsBrief` in both forms; both
  overrides; a deferred scenario claimed without a problem; no `others` →
  unchanged results on the existing tests.
- `designEpic` with a second brief in the repository: the proposal prompt
  lists the first brief's decisions and omits them from the scenarios to
  dispose of; the designed brief passes completeness without restating
  them; a draft first brief feeds nothing.
- `--coverage`: writes the file and makes no model call; an unreadable brief
  is listed; the entry's argument parsing.

## Out of scope

History of the ledger over time; coverage at legacy code-unit level; several
legacy repositories feeding one target in one report; a machine-readable
export (the schemas make it a later addition); any change to the brief file
format.
