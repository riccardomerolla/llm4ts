# Banca Demo — retail internet-banking portal (fixture)

A client-only retail internet-banking SPA for a fictional Italian bank, in
English and Italian. This is the **target repository** of the llm4ts
`epic-stories` flow (ADR 0013): parallel coding agents add features here,
each confined to its own story, reusing the house kit.

Stack: Vite, React 19, TypeScript, Effect (HttpApi contracts), vitest with
React Testing Library, eslint. Nothing here talks to a network: every domain
contract is answered by a deterministic in-memory fake transport, and the
sign-in is a stub with one fictitious customer.

## Install and run

Standalone package — not part of the llm4ts pnpm workspace, so install with
the workspace ignored (the `.npmrc` already says so):

```bash
pnpm install
pnpm dev        # http://127.0.0.1:5180
```

Gates (the flow's hard gates — all must pass):

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

`pnpm openapi` renders every contract under `src/contracts/` into
`contracts/openapi/`.

## Layout and rules

See `CONTRIBUTING.md`. The exemplar feature is `src/features/profilo/`; the
shared kit is `src/kit/`; `src/App.tsx` is the single composition point.

## Offline notes

- `pnpm-lock.yaml` is committed; installs are deterministic.
- To run on a machine without network: warm the pnpm store once while
  online with `pnpm install` here, then in a seeded copy run
  `pnpm install --offline`.
- Tests, typecheck, lint, and build never touch the network.

## Seeding a working copy

`../seed-portal.mjs` materialises this fixture as a standalone git
repository (node_modules and build output excluded; deterministic initial
commit). `../smoke-portal.mjs` seeds into a temp dir and asserts the
expected files exist.
