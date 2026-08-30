# ADR 0012: The Bank Conversion Scenario Is Not Clean-Room

Date: 2026-08-30. Status: accepted.
Specs: `specs/pending/j2ee-nextjs-pack.md`, `specs/pending/convert-page-flow.md`,
`specs/pending/convert-all-orchestrator.md`.

## Context

The modernize-\* flows are clean-room by design: `modernize-implement` refuses
to run when legacy source sits in the target tree (`checkWall`), so the coder
provably rebuilds from specs alone. The bank-conversion PoC (J2EE/JSP →
existing Next.js SPA) has a different goal: the legacy vendor owns the code,
there is no license wall to respect, and conversion quality improves when the
coder can consult specific legacy source — the divergent client/server
validation rules, the session-carried draft DTOs — instead of guessing from
prose.

## Decision

1. **The wall is dropped for the convert flows only.** `convert-page` builds
   a read-only legacy workspace beside the writable target workspace and
   injects a BOUNDED excerpt (the page source plus its `closureFor` include
   closure, capped by the shared `Context` budget) as evidence. The
   modernize-\* flows keep the wall untouched.
2. **The Page Spec stays the contract of record.** Extraction (the unchanged
   `modernize-extract`, driven by the `j2ee-nextjs-spa` pack) must embed a
   `json pagespec` fenced block in each spec; `PageSpec.parsePageSpec`
   hard-validates it, and the conversion judge scores the branch against the
   spec, never against the legacy source. Evidence is for disambiguation; a
   spec/source conflict is an open question, not a silent choice. Riding
   inside the spec markdown (rather than a fifth extract artifact) keeps
   `ProgramArtifacts` and every other pack untouched.
3. **The anti-corruption contract is generated, not written.**
   `PageSpec.openApiFor` deterministically projects the spec's API section —
   domain names only, ESB routine names demoted to descriptions — into
   `contracts/<page>.openapi.yaml`, which the port, the mock adapter, and a
   future B4F implement. The coder may not edit it.
4. **All usage accounting in these flows is ESTIMATED.** The seats are CLI
   connectors, which report no usage; `EstimatedUsage` decorates them with
   character-count estimates published under `estimated:<model>` labels, and
   every report and board figure carries the estimate marking. The user's
   explicit decision (2026-08-30) was estimates over parsing CLI usage
   output; revisiting that is a product change, not a bug fix.
5. **Delivery is branches-only.** One page = one `convert/<page>` branch plus
   a committed conversion report; no PR and no auto-merge — the human review
   gate is the governance story, told through the `BoardSync` board (local
   files by default, Azure DevOps work items as the optional mirror, built on
   the az-CLI `AzureDevOpsTool` of ADR 0011 — see `docs/parity.md`).

## Consequences

- The conversion scenario cannot claim license clean-room properties; it
  claims auditability instead (spec, contract, judge verdicts, reports).
- `migrationReport` projects whole-estate cost as a plain average of per-page
  estimates rather than through `Bench`'s wave projection: the Bench record
  shapes are phase-keyed to the modernize pipeline, and an estimate-of-an-
  estimate does not deserve that machinery. If the projection ever needs
  provider spread, revisit with real Bench records.
- Back-porting to llm4zio is out of scope for the PoC.
