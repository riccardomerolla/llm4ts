# ADR 0015: Refinement Is An Overlay On The Extracted Pack

Date: 2026-09-15. Status: accepted.
Specs: `specs/pending/modernize-refine.md`, `specs/pending/convert-feature.md`.

## Context

`modernize-extract` produces a judged, source-grounded spec pack per legacy
program and proposes a plan in one reasoning call over all specs. Between
"gate passed" and "human approves" there is no place to say that a behaviour
is deprecated, that the target already provides it, that a spec is too thin,
or that three pages are really one domain feature. The first J2EE → Next.js
rehearsal (2026-09-15) showed all four needs at once: dead campaign pages,
a login the target's AuthProvider already owns, a movements filter the
analyst missed, and a beneficiary list + edit pair that only makes sense
as one feature over one servlet.

Survey's triage (rewrite / retire / wrap) is the only scope decision the
pipeline has, and it is per program. The judge's faithfulness rubric
("every statement grounded in source, nothing missing") and the coverage
gate ("every legacy unit appears in traceability") both punish a spec that
has been pruned in place. This is a divergence from pinned `llm4zio` v4.2.0,
which has no refinement phase.

## Decision

1. **Specs stay the record of what the legacy does.** Scope decisions live
   in a separate, human-owned overlay, `docs/modernization/decisions.md`,
   keyed at program and Gherkin-scenario level with three dispositions:
   `drop` (deprecated, reason required), `provided` (the target already has
   it, pointer required and verified to exist), `defer` (not this
   delivery). `migrate` is the implicit default and is never written. Every
   entry names who decided and when. Coverage units are never addressed;
   they are derived as waived through the traceability fragments, and the
   gate reports them as waived, not uncovered.
2. **Deepen is the only mutation.** A program-level `deepen` mark with a
   mandatory focus re-extracts that program through the existing resumable
   seam, revising the previous artifacts rather than restarting, with the
   focus injected into the completeness rubric so the fix loop enforces it.
   Scenario titles are the key and must stay stable; a dangling reference
   becomes an open point. Synthetic scenario ids are the escalation path if
   title drift proves real, deliberately not built now.
3. **Consolidation is deterministic first.** The pack declares which survey
   edge kinds `cluster:` pages into one domain feature and which
   `context:` kinds only attach shared fragments. The model names the
   clusters, merges duplicate scenarios, and may propose split, join, or
   fold with evidence; every surviving scenario must land in exactly one
   feature. `docs/modernization/domains.md` is approvable, and `plan.md` is
   regenerated per domain feature in the existing `Plan` shape.
4. **The file is the state, never the conversation.** One file-driven
   engine flow, `modernize-refine`, never prompts and halts on a typed
   `OpenPointsPending`; one shell verb, `llm4ts refine`, composes the
   interactive loop over the same files. Any refine write resets the pack's
   README approval, and seed requires every overlay present to be approved.
5. **Seed projects the overlay.** The target receives feature files with
   only surviving scenarios, unchanged specs with the overlays beside them,
   a `# waived` section in `rules.txt`, and provenance hashes of the
   overlays. Downstream judges are told what is out of scope instead of
   guessing.

## Consequences

- An estate that needs no refinement runs survey → extract → seed exactly
  as before; every change is opt-in by the presence of a file or a pack
  section. Shipped additive in 2.2.0.
- The audit trail gains "the legacy had this, here is who decided not to
  carry it and why" — the property a regulated client asks for — at the
  cost of one more approvable file per concern.
- The pack contract grows a `## Consolidate` section and two optional
  prompt sidecars with engine defaults; pack-check warns when they are
  missing.
- Feature-level conversion becomes possible because the domain map exists
  (ADR 0012 addendum).
- Back-porting to llm4zio is out of scope.
