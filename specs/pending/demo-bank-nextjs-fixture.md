# Demo fixture: synthetic Next.js SPA target repo

Author the destination repository for the bank-conversion PoC: a rich
Next.js SPA (client-only) with SSO stubbed, a small in-house design system,
and existing exemplar pages — so the convert flow can "code the new like
what we have" by imitating them.

Driver: the converted pages must respect destination best practices,
styles, and web components by looking at pages already in the repo. The
fixture therefore has to embody a recognizable house style worth imitating,
plus the toolchain the convert flow's hard gates run (`typecheck`, `lint`,
`build`, component tests).

## Decisions (agreed 2026-08-30)

| Decision  | Choice                                                                                                                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location  | Source tree under `examples/demo-bank/nextjs/`; same seed-script mechanism as the legacy fixture (standalone git repo materialized in a work dir).                                                                                                                                                      |
| Baseline  | Start from the existing `flows/fixtures/scaffolds/nextjs-spa` scaffold if it fits; extend rather than fork a second scaffold.                                                                                                                                                                           |
| Style     | Small bespoke "bank design system" component set (Button, Field, Form, DataTable, Stepper, Card, PageLayout) with tokens/theme — enough that imitation is observable in diffs, no external UI kit dependency weight.                                                                                    |
| Exemplars | 2 finished pages in the house style (e.g. cards overview + a profile form) demonstrating the layout, form handling, service-port usage, and test conventions the converter must copy.                                                                                                                   |
| ACL seam  | The repo predefines the port/adapter convention: `services/<domain>/port.ts` (typed interface), `services/<domain>/mock.ts` (fixture adapter), `contracts/<domain>.openapi.yaml`. Exemplar pages already use it, so converted pages have a pattern to follow. See `specs/pending/convert-page-flow.md`. |
| Testing   | Vitest + React Testing Library configured, with one exemplar component test per exemplar page showing the house test style (fields render, validation fires, port called with expected payload).                                                                                                        |

## Requirements

- Client-only SPA: no server components fetching data, no API routes with
  business logic; pages call ports, adapters call the (mocked) gateway.
  This mirrors the client's architecture (SPA → API gateway → ESB).
- SSO/security stubbed: an `AuthProvider` that fakes a logged-in user;
  converted pages consume it, never implement auth.
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` must pass on the
  seeded repo out of the box — these are the convert flow's hard gates, so
  a red baseline would poison every conversion.
- A short `CONTRIBUTING.md` in the fixture stating the house rules
  (component usage, port/adapter pattern, test expectations) — the convert
  flow feeds this to the coder as destination guidance.
- Deterministic offline install for the workshop: committed lockfile and a
  documented warm-cache step in the seed script (no live npm fetch on
  stage).

## Tasks

- [ ] Evaluate `flows/fixtures/scaffolds/nextjs-spa` as the base; extend it
      or document why a separate tree is needed.
- [ ] Design-system components + tokens + `PageLayout`.
- [ ] `AuthProvider` SSO stub and app shell (nav, routing).
- [ ] Port/adapter/contract convention: directory layout, one worked
      example (`services/cards/` with port, mock adapter, OpenAPI file).
- [ ] Two exemplar pages in house style, each with a component test.
- [ ] `CONTRIBUTING.md` house rules.
- [ ] Toolchain: vitest + RTL + lint + typecheck + build all green.
- [ ] Seed script + CI smoke check (repo materializes, gates pass) — CI may
      need a cached node_modules strategy to stay network-free; document
      the choice.

## Non-goals

Real SSO/OIDC, a real API gateway, server-side rendering concerns,
visual-regression tooling, Storybook, and any page for the three legacy
hero pages (those must be authored by the convert flow, not by hand — do
not pre-build them).
