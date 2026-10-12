# Flow: convert-feature (one domain feature → one branch)

New kit flow `kits/j2ee-nextjs/flows/convert-feature.ts` and a feature walk
in `convert-all`: convert ONE domain feature of the approved
`docs/modernization/domains.md` (its pages, its shared anti-corruption
port, its attached fragments) on ONE branch. Depends on
`specs/pending/modernize-refine.md` (the domain map is its output).
Decisions: addendum to ADR 0012.

Driver: extraction is per page, but delivery, review, and the board should
follow the business shape — beneficiary list and edit are one feature over
one servlet and one ESB pair; the three transfer steps are one wizard over
one session draft. Two overlapping per-page contracts for one service is
the wrong handoff artifact.

## Decisions (agreed 2026-09-15)

| Decision   | Choice                                                                                                                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit       | One domain feature = one branch `convert/<feature>` = one board item = one report `docs/conversion/<feature>.md` with a section per page. No PR, no auto-merge (ADR 0012 unchanged).                                                                                                      |
| Contract   | ONE `contracts/<feature>.openapi.yaml`, one port `src/services/<feature>/port.ts`, one mock adapter. Deterministic extension of `PageSpec.openApiFor` over several page specs: operations unioned by method + path, the source page recorded in each operation's description.             |
| Conflicts  | Same method + path with different request/response shapes, or same domain operation name with different fields, fail the deterministic merge and become open points in `domains.md`. Nothing converts until the map is clean.                                                             |
| Pages      | Components `src/app/<page>/` and tests `tests/<page>.page.test.tsx` stay per page; only the service layer and contract are feature-owned.                                                                                                                                                 |
| File scope | Pack `feature-files:` template with `<NAME>` (feature) and `<PAGES>` (alternation of its page names); a feature's scope is the union of its pages' `program-files` scopes plus the feature-named paths.                                                                                   |
| Plan       | Task 1: feature port, contract, mock adapter, registry wiring. Then one task per page in navigation order (from the map's edges: no-inbound page first, list before edit, step 1 → 2 → confirm), each page task carrying its own tests so every task is a vertical slice behind the gate. |
| Judge      | Every page scored against its own page spec through the multi-program judge seam, plus one feature-level check that the port matches the merged contract; feedback rounds bounded by `LLM4TS_JUDGE_ROUNDS` on the whole branch.                                                           |
| Board      | One item per feature; `detail` lists the pages and their dispositions; `wave` is the earliest wave of its pages. Page items disappear when a domain map exists.                                                                                                                           |
| Order      | `convert-all` walks features by earliest wave then feature name, skipping features whose every page is disposed; without an approved domain map it falls back to per-page as today.                                                                                                       |
| Release    | Additive, in 2.2.0 with refine; the per-page path is unchanged when no map exists.                                                                                                                                                                                                        |

## Seams to extend

- `@llm4ts/flow/PageSpec.openApiFor` → a multi-spec projection (same
  module, same YAML writer), with a typed `ContractConflict` error listing
  the pages and the operation.
- `@llm4ts/flow/Pack` — `feature-files:` template validated like
  `program-files:`; `filesFor` gains a feature form.
- `kits/j2ee-nextjs/flows/lib/convert.ts` — `convertPage`'s stages
  (branch, contract, plan, gates, judge, report) generalised to a feature
  with N pages; `conversionInventory` learns to read `domains.md`;
  `migrationReport` gets feature rows.
- `@llm4ts/flow/BoardSync.BoardItem` — unchanged schema; `detail` carries
  the page list.
- `@llm4ts/flow/ProgramJudge.judgeAllPrograms` — already multi-program;
  add the contract check as one more dimension input.

## Tasks

- [ ] Multi-spec OpenAPI projection with deterministic union and
      `ContractConflict`; conflicts surfaced as `domains.md` open points by
      `modernize-refine`'s consolidate step (so the map is clean before
      conversion starts).
- [ ] `feature-files:` in the pack manifest and `filesFor` feature form;
      `j2ee-nextjs-spa` manifest updated; pack-check reports it.
- [ ] `convert-feature` flow: task text is the feature name; branch,
      contract, feature plan (port task + page tasks in navigation order
      with tests), gates, judge, report.
- [ ] `convert-all` feature walk with fallback to pages; board items per
      feature; migration report feature rows; dispositions honoured.
- [ ] Deterministic tests: union/conflict cases on the demo-bank specs
      (beneficiary pair shares `/beneficiary`; transfer steps share
      `/transfer`), navigation ordering, feature file scope, inventory
      walk and fallback, board item shape; kit tests in `kits/test/`.
- [ ] RUNBOOK Act 2 converts "Beneficiary maintenance" as one branch;
      `PAGES.md` answer key lists the expected feature contracts.
- [ ] ADR 0012 addendum accepted; `docs/parity.md` note; CHANGELOG.

## Non-goals

PR creation, parallel feature conversion (ADR 0013's machinery is a later
composition), B4F generation from the feature contract, and changing the
per-page path when no domain map exists.
