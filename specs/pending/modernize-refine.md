# Flow: modernize-refine (prune, deepen, consolidate the extracted spec pack)

New engine flow `flows/modernize-refine.ts` plus a shell verb `llm4ts refine`:
an OPTIONAL phase between `modernize-extract` and `modernize-seed`, rooted at
the LEGACY repository, that lets a human decide what the extracted pack
should become before it is approved and seeded. Three concerns, one flow:

1. **Prune** — some legacy behaviour is deprecated (`drop`), already
   provided or solved differently by the target (`provided`), or not for
   this delivery (`defer`).
2. **Deepen** — a spec is thin, a behaviour or use case is missing or badly
   described, and the analyst must go back to the source with a focus.
3. **Consolidate** — extraction is per program (per JSP page), but the
   estate is really a set of domain features spanning related pages: list
   and detail, wizard steps, a shell of included fragments. The plan should
   be derived per domain feature, not per page.

Companion spec: `specs/pending/convert-feature.md` (feature-level
conversion, depends on this one). Decisions: ADR 0015; addendum to ADR 0012.

## Decisions (agreed 2026-09-15)

| Decision            | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Placement           | Between extract and seed, rooted at the legacy repo (the pack and its approval live there). Optional: with no overlay present the pipeline behaves exactly as today.                                                                                                                                                                                                                                                                                                                                                                              |
| Overlay vs mutation | Prune and consolidate are OVERLAYS: the judged per-program specs stay the source-grounded record of what the legacy does. Deepen is the only step that mutates specs, and it re-runs the per-program gate and judge.                                                                                                                                                                                                                                                                                                                              |
| Disposition keys    | Program (page) and Gherkin scenario (`<program> / <scenario title>`) only. Coverage units are never addressed directly; they are derived as waived through the traceability fragments. No rule-level or pagespec-level keys.                                                                                                                                                                                                                                                                                                                      |
| Vocabulary          | `drop` (reason required), `provided` (target pointer required, verified to exist), `defer` (reason, optional milestone). `migrate` is the implicit default and is never listed. Program-level entries may also say `wrap`. Every entry carries who and when. `defer` is never proposed by the model.                                                                                                                                                                                                                                              |
| Authorship          | The file is the contract; an LLM proposal is opt-in. Marks (`?` with a note) ask the model to propose. Proposal is an agent session on a read-only target workspace (`LLM4TS_TARGET_REPO`), bounded by `LLM4TS_ANALYST_TURNS` and the shared Context budget; without the target pointer no `provided` is ever proposed.                                                                                                                                                                                                                           |
| State               | The file is the state, never the conversation. `decisions.md` holds marks, proposals, `## Open points`, and the approval marker; `domains.md` the same for grouping. Quitting at any beat loses nothing; off a tty the flow halts on open points and the user edits the file. Both files start with a guide header (vocabulary, one example per disposition, a `?` example).                                                                                                                                                                      |
| Deepen              | Program-level `deepen` mark with a MANDATORY free-text focus; no "just go deeper" mode. Re-extract through `extractProgramsResumably` with the previous four artifacts as the starting point ("revise, do not restart") and the focus as a must-address requirement injected into the completeness rubric. Own commit per program. Runs before prune and consolidate. Scenario titles must stay stable (brief + judge check); dangling references become open points. Synthetic scenario ids/tags are deferred.                                   |
| Consolidate         | Deterministic clusters first (pack-declared `cluster:` edge kinds union pages; `context:` edge kinds attach as shared context and never cluster), then one structured reasoning call names each cluster as a domain feature, merges duplicate scenarios, and may propose split/join/fold (fold of singleton filler pages is a proposal, never a rule), each with evidence. Every surviving scenario lands in exactly one feature (deterministic check). `domains.md` is approvable; `plan.md` is regenerated per feature in today's `Plan` shape. |
| Approval            | Any refine write resets the README `- [ ] Approved` marker with a line naming what changed. Seed requires README approval always, `decisions.md`/`domains.md` approval when the file exists (`ApprovalRequired` via the existing seam).                                                                                                                                                                                                                                                                                                           |
| Projection at seed  | Seed projects the overlay: `.feature` files copied to the target contain only surviving scenarios; specs are copied unchanged with `decisions.md` and `domains.md` beside them; `rules.txt` gains a `# waived` section; provenance hashes the overlays. Implement's compliance judge and verify are handed the decisions as "out of scope, do not score"; `provided` pointers are handed to the coder.                                                                                                                                            |
| Convert flows       | `convert-all` skips program-level dispositions and lists them in the migration report; `convert-page` filters scenarios in memory and passes decisions to the conversion judge. Feature-level conversion is the companion spec.                                                                                                                                                                                                                                                                                                                   |
| Shape               | ONE engine flow, file-driven, never prompting; marks decide what runs (no step flags); halts with a typed `OpenPointsPending`. ONE shell verb composes the interactive loop (pick lists via Prompt → write file → run flow → walk open points → rerun → approve). "Regroup" discards `domains.md` and re-seeds.                                                                                                                                                                                                                                   |
| Pack contract       | `## Consolidate` section (`cluster:` / `context:` edge kinds, validated against the pack's survey rules and the `llm-` prefix); optional sidecars `prompts/refine-propose.md` and `prompts/consolidate.md` with engine defaults (pack-check warns, never fails); `prompts/plan.md` rewritten per domain feature.                                                                                                                                                                                                                                  |
| Names               | `modernize-refine`, `llm4ts refine`, `docs/modernization/decisions.md`, `docs/modernization/domains.md`, "domain feature", `# waived`.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Release             | Additive, 2.2.0, no breaks: everything is opt-in by the presence of a file or a pack section.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Artifacts

`docs/modernization/decisions.md` (legacy repo):

```markdown
# Decisions

<guide header: vocabulary, one example per disposition, a `?` example, how open points are answered>

## Programs

- promoQ3: drop — expired 2011 campaign (riccardo, 2026-09-15)
- login: provided — src/auth/AuthProvider.tsx; target owns session and login (riccardo, 2026-09-15)
- oldTransfer: ? — looks dead, confirm nothing links here

## Scenarios

- accountOverview / Export movements as CSV: drop — reporting moves to the data platform (riccardo, 2026-09-15)
- beneficiaryList / Delete a beneficiary: defer — milestone: wave-3 (riccardo, 2026-09-15)

## Deepen

- accountOverview: the movements filter has a date-range rule I cannot find in the spec; check AccountServlet and the JSTL loop
  <after execution: `done <commit>` appended>

## Open points

1. …numbered questions the proposal could not settle; the answer is appended under the question…

- [ ] Approved
```

`docs/modernization/domains.md` (legacy repo): one section per domain
feature with its programs, its attached context fragments, the scenarios it
absorbs (each exactly once, with `merged from` notes), the model's evidence,
a recorded hash of its inputs (specs + decisions) for staleness, an
`## Open points` section, and the approval marker.

`docs/modernization/plan.md`: regenerated from `domains.md`, today's `Plan`
shape, tasks per domain feature naming the scenarios and programs covered.

`docs/modernization/rules.txt`: unchanged universe plus a trailing
`# waived` section listing `unit — waived by <decision>`.

## Seams to extend (not parallel code)

- `@llm4ts/flow/Artifacts.extractProgramsResumably` — deepen re-extracts
  through it (delete the spec, supply the revision brief via the existing
  `extract` callback and `onCreated` commit hook).
- `@llm4ts/flow/Approval` — `requireApproval` / `withDraftApproval` for both
  overlays; `OpenPointsPending` is a new `Schema.TaggedError` beside
  `ApprovalRequired`.
- `@llm4ts/flow/Survey` — clusters come from `SurveyGraph` edges filtered by
  the pack's `cluster:` kinds; `context:` kinds produce the attached
  fragments; `closureFor` stays the evidence bound.
- `@llm4ts/flow/SpecChecks.coverageReport` — learns the waived set and
  reports `waived` beside `covered`/`uncovered`.
- `@llm4ts/flow/Pack` — parses `## Consolidate`, the two optional prompts,
  and validates edge kinds; `modernize-pack-check` reports them.
- `@llm4ts/flow/Planner.planFrom` — called once per domain feature with the
  rewritten pack plan prompt; `plan.md` is the concatenation in feature order.
- `flows/modernize-seed.ts` — the projection step and the three optional
  markers; `Provenance` gains the overlay hashes.
- `flows/modernize-implement.ts` / `modernize-verify.ts` — decisions text
  injected into the judge brief and the waived section honoured.
- `kits/j2ee-nextjs/flows/lib/convert.ts` — `conversionInventory` skips
  disposed programs; `convertPage` filters scenarios and briefs the judge.
- `@llm4ts/shell` — the `refine` verb on `effect/unstable/cli` Prompt; the
  runner and the flow keep zero knowledge of it (ADR 0006).

## Tasks

- [ ] `Decisions` module (flow package): schema for program/scenario
      entries, `?` marks, deepen marks, open points, guide header render,
      parse with typed errors (unknown program, unknown scenario title,
      missing reason/pointer), waived-unit derivation through traceability
      fragments.
- [ ] `Domains` module (flow package): deterministic clustering over
      `SurveyGraph` by pack `cluster:`/`context:` kinds, exactly-once
      scenario check, naming prompt + structured result schema, staleness
      hash, render/parse with open points and approval marker.
- [ ] `Pack`: `## Consolidate` section, `refine-propose` and `consolidate`
      prompt slots with engine defaults; `modernize-pack-check` warnings;
      `j2ee-nextjs-spa` and `cobol-springboot` manifests and sidecars;
      `prompts/plan.md` rewritten per domain feature.
- [ ] `flows/modernize-refine.ts`: validate → deepen marks → prune proposal
      (agent session on read-only `LLM4TS_TARGET_REPO`, pointer existence
      verified, `defer` never proposed) → consolidate when `domains.md` is
      absent or stale → plan regeneration → README marker reset → commit;
      `OpenPointsPending` halt; no-op run reports "nothing to refine".
- [ ] Deepen: revision brief (previous artifacts + mandatory focus + title
      stability), focus injected into the completeness rubric, per-program
      gate/judge/fix round, own commit, mark flagged done with the commit,
      dangling references re-validated into open points.
- [ ] `modernize-seed`: three markers, feature filtering, `# waived`
      section, overlays copied, provenance hashes.
- [ ] `modernize-implement`/`modernize-verify`: decisions in the judge
      brief, `provided` pointers in the coder brief, waived units in verify.
- [ ] `convert-all`/`convert-page`: dispositions honoured, report rows.
- [ ] Shell verb `llm4ts refine`: pick lists from the pack's specs and
      features, disposition/`?`/deepen prompts, open-point walk, regroup,
      final approval confirmation; every beat reachable by editing the file.
- [ ] Deterministic tests with the in-src fakes: decisions parse/validate,
      waived derivation, clustering on the demo-bank graph (three hero
      features + singletons, fragments as context), exactly-once check,
      stale hash, seed projection, marker resets, `OpenPointsPending`,
      convert inventory filter; a `modernize-refine` smoke test in
      `flows/test/`.
- [ ] Demo fixture answer key (`PAGES.md`) extended with expected clusters
      and the dead scenarios; RUNBOOK Act 1 gains the `llm4ts refine` beat.
- [ ] ADR 0015 accepted; `docs/parity.md` note; `docs/flow-authoring.md`
      and `docs/guide/05-your-first-pack.md` mention `## Consolidate` and
      the sidecars; CHANGELOG under 2.2.0 saying explicitly "no breaks".

## Non-goals

Rule-level (single validation) dispositions, pagespec-level keys, synthetic
scenario ids, a free "go deeper" mode, a multi-turn chat as the state, a
story-plan-shaped `plan.md` with a dependency graph, running refine on the
target repo, and feature-level conversion (companion spec).
