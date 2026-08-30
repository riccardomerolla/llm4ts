# Pack: j2ee-nextjs-spa (Page Spec extraction for the bank PoC)

Create a new flow pack `flows/packs/j2ee-nextjs-spa/` that drives
`modernize-survey` and `modernize-extract` over the synthetic legacy J2EE
repo and produces, per page, a **schema-validated Page Spec** — the
contract consumed by the convert-page flow.

Driver: the bank PoC's audit story. The Page Spec is the reviewable,
machine-checkable deliverable that makes the conversion "enterprise grade":
extraction quality is judged against it, conversion is judged against it,
and its API section seeds the anti-corruption contract and the future B4F
requirements.

Baseline: the existing `flows/packs/jsp-nextjs/` pack (sources/programs
regexes, `web.xml` url-pattern and JSP `action` coverage rules, judge
rubric). Known gaps to close there apply here: no `programFiles:` set, no
pattern cards.

## Decisions (agreed 2026-08-30)

| Decision       | Choice                                                                                                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reuse line     | `modernize-survey` + `modernize-extract` run as-is against the legacy repo via this pack; the target side is a new flow (`specs/pending/convert-page-flow.md`). Wall-agnostic legacy machinery is reused; `checkWall` is NOT part of this scenario. |
| Spec form      | Per page, a JSON artifact validated by an Effect Schema (`PageSpec`) plus the human-readable markdown the extract phase already emits. JSON is the machine contract; markdown is the review surface.                                                |
| Not clean room | Conversion may read legacy source for context; the Page Spec is guidance and contract, not a legal barrier. Record this divergence from the modernize clean-room posture in an ADR.                                                                 |
| programFiles   | Set `programFiles:` so `filesFor(page)` resolves the target-repo files belonging to a page precisely (required for per-page `ProgramJudge` diff slicing on the convert side).                                                                       |

## PageSpec schema (shape, refine while implementing)

Route/name/title; forms (fields with name, type, label, required,
validation rules and where they were enforced — client JS, server, both);
DTOs with legacy field names AND proposed domain names (the anti-corruption
rename table); API calls (method, path, request/response shape, the ESB
service behind it); navigation (inbound/outbound links, multi-step
ordering); session/state assumptions; open questions; complexity grade.
Schema lives in the flow/pack layer next to the other flow schemas; the
JSON artifact is written via the versioned persistence envelope
(`saveVersioned`) so the format can evolve.

## Tasks

- [ ] `PageSpec` Effect Schema + versioned persistence + render-to-markdown
      (deterministic tests with the memory file store).
- [ ] Pack manifest: sources/programs regexes for the J2EE fixture,
      `programFiles:` template for the target repo layout defined in
      `specs/pending/demo-bank-nextjs-fixture.md`, coverage rules
      (url-patterns, form actions, `$.ajax` endpoints), judge rubric for
      extraction quality (all fields found, all endpoints found, rename
      table plausible, session state captured).
- [ ] Extraction wiring: pack lenses/prompts so `modernize-extract` emits
      the PageSpec JSON alongside its markdown artifacts, with the judge
      gate validating spec completeness per page (resumable per page, as
      extract already is).
- [ ] Pattern cards (`patterns/`) for the J2EE→Next.js translation:
      scriptlet/JSTL table → DataTable component; jQuery validation →
      house form validation; `HttpSession` step state → SPA stepper state;
      legacy DTO → domain model via port; JSP include shell → PageLayout.
      (The cobol packs are the precedent; the jsp packs have none.)
- [ ] Survey config: triage that classifies the fixture's dead pages and
      fragments correctly and orders hero pages into a wave plan.
- [ ] ADR: bank-conversion scenario is not clean-room — converter may read
      legacy source; Page Spec remains the contract of record for judging.
      Why, and what still holds (provenance, judging, coverage).
- [ ] Deterministic pack tests mirroring the existing pack test style
      (manifest parses, `filesFor` precision, coverage rules fire on
      fixture samples).

## Non-goals

Changing `modernize-extract`'s phase structure, back-porting to llm4zio,
supporting arbitrary J2EE frameworks (Struts/JSF specifics beyond what the
fixture contains), and B4F code generation (the spec only carries enough
API detail to enable it later).
