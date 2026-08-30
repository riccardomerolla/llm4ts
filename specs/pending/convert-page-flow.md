# Flow: convert-page (J2EE page → Next.js page + mocked ACL)

New flow script `flows/convert-page.ts`: convert ONE legacy page into the
destination Next.js repo, on its own branch, gated by deterministic checks,
generated component tests, and a spec judge. This is the target-side half
of the bank PoC (legacy-side extraction: `specs/pending/j2ee-nextjs-pack.md`).

Driver: one run = one page = one branch is the unit of delivery, review,
and progress the client sees. The converted page must respect the original
form (from the Page Spec) but be redesigned in the destination repo's
style, imitating its existing pages, with all business-logic calls behind a
mocked anti-corruption layer.

## Decisions (agreed 2026-08-30)

| Decision   | Choice                                                                                                                                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspaces | Two: legacy repo read-only, target repo read-write — the established two-workspace idiom (`modernize-seed` precedent); git operations only on the target repo. Not clean-room: the coder gets the PageSpec, the legacy page's bounded closure (`closureFor`), the destination exemplars, and `CONTRIBUTING.md`. |
| Delivery   | Branch `convert/<page-id>` off the default base; commits per task; **no PR** (offline workshop, no hosting dependency). Judge verdict + cost estimate + diff summary land in a per-page conversion report file, linked from the board (`specs/pending/convert-all-orchestrator.md`).                            |
| ACL shape  | Contract-first: emit `contracts/<domain>.openapi.yaml` from the PageSpec API section (domain names, not legacy DTO names), a typed port interface, and a mock adapter returning schema-valid fixtures. The page depends only on the port. The OpenAPI file is the future B4F handoff artifact.                  |
| Gates      | Hard: target `typecheck` + `lint` + `build` (existing reviewAndFixLoop + lint gate). Hard: generated component tests pass. Judge: `ProgramJudge` on the page's diff slice (via pack `filesFor`) against its PageSpec with the pack rubric.                                                                      |
| Tests      | Generated RTL tests are constrained to three assertions families — spec'd fields render, spec'd validations fire, port called with spec-shaped payloads — driven by pattern cards, not free-form test authoring (bounds the flake risk accepted on 2026-08-30).                                                 |

## Flow outline (what, not how)

Input: page id + paths to both repos + PageSpec location. Resolve PageSpec
(fail typed if missing/unapproved). Build the conversion plan via
`implementPlanFlow` with a page-scoped plan (ACL contract → port+mock →
page → tests), `chatPerTask` per ADR 0003, branch from the page id.
Coder prompt assembles: PageSpec, legacy closure (capped via `Context`
budgeting), destination exemplar excerpts, house rules. After the loop:
per-page `ProgramJudge` round(s) with feedback, then write the conversion
report and leave the branch in place.

## Tasks

- [ ] Flow input/args: page id, `--legacy-repo` (or env, matching
      `modernize-seed`'s `LLM4TS_LEGACY_REPO` precedent), PageSpec
      discovery from the extract output layout.
- [ ] PageSpec → OpenAPI fragment emission (deterministic where possible;
      schema-checked output; legacy→domain rename table applied).
- [ ] Plan construction per page (contract, port+mock adapter, page
      component(s), tests) and branch-per-page wiring.
- [ ] Context assembly with `Context.cap`/`withShrink` over legacy closure
      and exemplar pages; truncations recorded to provenance.
- [ ] Gate wiring: typecheck/lint/build commands from the target repo,
      generated-test execution as a hard gate, judge rounds with
      `LLM4TS_JUDGE_ROUNDS`-style feedback loop.
- [ ] Conversion report artifact per page (schema + markdown render):
      spec reference, judge verdict, gate results, estimated tokens/cost,
      branch name, files touched, open questions carried forward.
- [ ] Resumability: rerunning the flow for a page with an existing branch
      resumes the plan (existing plan-file checkpointing) instead of
      restarting — this is the on-stage crash-recovery story.
- [ ] Deterministic tests with in-src fakes (memory workspace/file store,
      process fakes): plan shape, OpenAPI emission, gate ordering, report
      content, two-workspace boundary (legacy never written).

## Non-goals

PR creation, auto-merge, connecting real services, B4F code generation,
Playwright/E2E, visual diffing, multi-page batching (that is the
orchestrator's job), and token-usage capture from CLI connectors (pure
estimates per the 2026-08-30 decision).
