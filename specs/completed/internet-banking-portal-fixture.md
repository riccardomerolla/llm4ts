# Demo fixture: retail internet-banking portal (Vite + React + Effect)

Author the target repository for the parallel sub-agent example: a
client-only retail internet-banking SPA in the tech stack and visual
language of the owned `whitelabel-fund-tokenizer` portals, in English and
Italian, with one feature (Profilo) finished end to end as the exemplar the
story agents imitate. The flow that fills it is
`specs/pending/epic-stories-flow.md`; the library seams it exercises are
`specs/pending/epic-stories-flow-seams.md`. Design record: ADR 0013.

Driver: the demo narrative is "replace an internet banking, feature by
feature, with parallel agents that reuse the house kit". The fixture must
therefore embody a kit worth reusing (auth, API access, i18n, components,
theme), a house style visible in diffs, the four hard gates green out of the
box, and — decisive for parallel work — no file that every feature must
edit.

## Decisions (agreed 2026-09-11)

| Decision    | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location    | `examples/internet-banking/portal/`, standalone (installed with `--ignore-workspace`), plus `seed-portal.mjs` and `smoke-portal.mjs` following `examples/demo-bank/seed-nextjs.mjs` (deterministic initial commit, excluded build dirs, offline pnpm store note).                                                                                                                                                                                                     |
| Stack       | Vite 8, React 19, TypeScript, `effect` at this repo's exact pinned beta, TanStack Query; no Next.js, no wagmi/viem. Gates: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` (eslint, vitest with React Testing Library added on top of the reference's typecheck + build).                                                                                                                                                                                    |
| Kit         | `src/kit/` trimmed from the owned `packages/portal-kit`: `auth.tsx` (OIDC-shaped provider with a stubbed sign-in and a fixed demo customer; pages consume `useAuth`, never implement auth), `api.ts` (`useLoad`, `useAction`, `usePages` over an Effect `HttpApiClient`), `components.tsx` (Shell, Panel, Field, DataTable, Notice, StateBadge, LanguageSwitch, LoadMore, SelectFilter), `format.ts`, `theme.css` tokens. Wallet, explorer, and story pieces dropped. |
| Services    | Effect `HttpApi` contract per domain under `src/contracts/<domain>.ts`; a single fake `HttpClient` layer in `src/kit/fake-transport.ts` answers those requests from deterministic fixture data with an in-memory store per session (transfers created then confirmed then listed). Swapping to a real backend is one config line. OpenAPI generated from the contracts into `contracts/openapi/` by a script, committed.                                              |
| i18n        | Per-feature dictionary modules: `src/features/<feature>/messages.ts` exports `en` and `it` with `it: Record<keyof typeof en, string>`; screens call `useMessages(messages)` for a `t` typed to that feature. Kit strings (shell, auth, common) live in `src/kit/messages.ts`, shared read-only. Italian is the default language (ADR-0022 of the reference). No global registry file.                                                                                 |
| Routes/nav  | Per feature: `src/features/<feature>/route.tsx` exports its route element(s) and nav entry; `src/App.tsx` composes a static list and is the single composition point, owned by exactly one story per epic (the fan-in).                                                                                                                                                                                                                                               |
| Exemplar    | Profilo (customer profile, read-only): `contracts/profile.ts`, fake handlers and fixtures, `features/profilo/` screen + messages + route, one RTL test showing the house test style (fields render, port called, both languages render). Not one of the demo epic's features.                                                                                                                                                                                         |
| House rules | `CONTRIBUTING.md`: kit usage, contract → fake handler → screen → test pattern, per-feature messages/routes, the composition-point rule, the perimeter vocabulary (`owned`, `sharedReadOnly`) so the story prompt and the repo agree on words.                                                                                                                                                                                                                         |

## Requirements

- Client-only: no server, no API routes; the fake transport is the only
  data source and is deterministic (fixed seed data, no clocks or randomness
  in fixtures — the SCA stub accepts any six-digit code except one fixed
  refused code).
- Baseline green: all four gates pass on the seeded repo; a red baseline
  would poison every story.
- Deterministic offline install: committed lockfile, documented warm-cache
  step; tests, typecheck, lint, build never touch the network.
- Layout is the perimeter: a feature's `owned` set is its
  `src/features/<feature>/<sub>/` directory plus its contract and fake
  handler files; `src/kit/**`, `src/kit/messages.ts`, `theme.css`,
  `CONTRIBUTING.md`, and `App.tsx` are `sharedReadOnly` for every story
  except a dedicated kit story or the fan-in.
- Not part of the llm4ts pnpm workspace; llm4ts CI runs only the smoke
  script (seed into a temp dir, assert expected files), never the fixture's
  own gates.

## Tasks

- [ ] Package skeleton, Vite/TS/eslint/vitest configuration, gate scripts,
      lockfile.
- [ ] Kit: auth stub, api hooks over `HttpApiClient`, components, format,
      theme tokens, kit messages, `useMessages`.
- [ ] Fake transport layer with in-memory store and the SCA stub; OpenAPI
      generation script.
- [ ] Profilo exemplar end to end with its RTL test.
- [ ] `App.tsx` composition point, Shell with language switch, home
      placeholder.
- [ ] `CONTRIBUTING.md` house rules.
- [ ] `seed-portal.mjs`, `smoke-portal.mjs`, README with install, gates,
      offline notes.
- [ ] Smoke test wired into the llm4ts suite.

## Non-goals

A real backend or OIDC provider, wallet or chain features from the
reference, Playwright/E2E, visual regression, and the Conto/Bonifico
features themselves (those are the demo epic's stories).
