# Epic unknowns ledger

Give every epic one append-only record of what its runs could not settle,
written by code from the places that already know (blocked stories,
deferred findings, low-confidence trailers, judge warnings) and read by the
planner, retro, profile and watch. ADR 0038; item 1 of
`docs/research/rea-gap-analysis.md` section 6.

Driver: `epic-retro` digests prose to rediscover what the run already knew;
the next planner starts without the previous run's open questions; `watch`
cannot show what is unsettled. rea keeps a residual-unknowns registry with
stable ids, statuses and evidence-only resolution; the idea ports, the code
does not.

## Decisions (ADR 0038)

| Decision   | Choice                                                                                                                                                                                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File       | `.llm4ts/epics/<id>/unknowns.jsonl`, one record per line, append-only; a refine round shares the parent epic's file.                                                                                                                                                                                |
| Record     | `id` (hash of question, story, scope), `question`, `story`, `task?`, `scope: string[]`, `status: open \| blocked \| contradicted \| resolved`, `severity: Severity`, `closes: gate \| captured-vector \| human-answer \| story`, `raisedBy: blocked \| deferred \| trailer \| judge`, `resolution?` |
| Resolution | `{ by: merged-story \| gate-green \| retro-applied \| human, cites: string }` where `cites` is a run artifact path, a story id or an approval line; a resolved record without `cites` is invalid.                                                                                                   |
| Supersede  | A later line with the same `id` replaces the earlier in the folded view; nothing is rewritten.                                                                                                                                                                                                      |
| Writers    | Code only: `Stories.ts` on `BLOCKED_ON`, on a deferred findings file, on `confidence: low`; the story judge on warnings; `Retro.ts` apply step and the merge path on resolution.                                                                                                                    |
| Readers    | Planner prompt (open records, capped by the ADR 0025 budget), `Retro.ts` digest, `Profile.ts` counts, `Watch.ts` epic view.                                                                                                                                                                         |
| Not        | No assignee, due date, comments or board sync; `--land` keeps the file.                                                                                                                                                                                                                             |

## Modules

### `packages/flow/src/Unknowns.ts`

- `Unknown` schema class, `UnknownStatus`, `UnknownResolution`.
- `unknownId(question, story, scope)` hashed through the caller-supplied
  `fingerprint` (hashing stays outside flow, as `ProgramJudge` does).
- `appendUnknown(files, path, record)` through `PlainFileStoreShape`;
  `readUnknowns(files, path)` returns the folded view (last line per id
  wins) and the raw count.
- `renderOpenUnknowns(records, budget)` for the planner prompt, through
  `cap` from `Context.ts`.

### `packages/flow/src/Stories.ts`

- Append on `blockedOnIn` match, on writing `deferredPath`, on a trailer
  with `confidence: low`; append a resolution when a story whose `Owns:`
  covers the scope merges.

### `packages/flow/src/Retro.ts`

- The digest opens with the folded ledger; blocked and deferred sections
  are derived from it rather than from prose; applying an approved
  proposal appends `retro-applied` resolutions.

### `packages/runner/src/Profile.ts`, `Watch.ts`

- Profile: open, resolved and contradicted counts per story and per epic,
  in the text and `--json` output.
- Watch: an "unsettled" line per story in the epic list view.

## Tasks

- [ ] `Unknowns.ts` with schema, id, append, fold and render; pure tests
      with a memory file store, including supersede and invalid resolution.
- [ ] `Stories.ts` writers for the three raise paths and the merge
      resolution; tests on the existing story fixtures.
- [ ] Judge warnings appended with `raisedBy: judge`.
- [ ] Planner prompt renders open records under the budget; snapshot test.
- [ ] `Retro.ts` digest reads the ledger first; retro apply appends
      resolutions.
- [ ] `Profile.ts` counts and `Watch.ts` line.
- [ ] `docs/flow-authoring.md` section, `docs/parity.md` additive note,
      CHANGELOG with the tuned-on model line (planner prompt changed).
- [ ] Light-fixture profile before and after in `docs/harness-evals/`.

## Tests

Deterministic with `makeMemoryPlainFileStore` and the story fixtures: a
story ending in `BLOCKED_ON` leaves one open record; a second run of the
same story with the same need leaves the same id; a story owning the scope
merging appends a resolution citing the story; a resolution without
`cites` fails to decode; the planner prompt lists open records and omits
resolved ones; retro's digest contains the ledger's questions verbatim.

## Non-goals

A board column for unknowns; editing records by hand; cross-epic ledgers;
a model writing records.
