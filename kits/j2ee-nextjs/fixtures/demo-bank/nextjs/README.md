# demo-bank-nextjs

Synthetic, client-only Next.js SPA for a fictional bank ("DemoBank"). This is
the **destination fixture** for the llm4ts bank-conversion PoC: converted
legacy pages land here, and the convert flow judges them by how well they
imitate this repo's house style (see `CONTRIBUTING.md` and the exemplar
pages `src/app/cards/page.tsx` and `src/app/profile/page.tsx`).

Everything is fake: SSO is a stubbed `AuthProvider`, service adapters are
in-memory mocks behind typed ports, and the data is deterministic fixture
data. No real bank, brand, or person is referenced.

## Install and run

This package is standalone — it is **not** part of the llm4ts pnpm
workspace, so install with the workspace ignored:

```bash
pnpm install --ignore-workspace
pnpm dev        # local dev server
```

Gates (the convert flow's hard gates — all must pass):

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

`pnpm build` produces a static export in `out/` (`output: 'export'`; there
is no server runtime).

## Offline notes

- `pnpm-lock.yaml` is committed; installs are deterministic.
- To run on a machine without network (e.g. workshop stage): warm the pnpm
  store once while online with `pnpm install --ignore-workspace` here, then
  in a seeded copy run `pnpm install --ignore-workspace --offline` — pnpm
  resolves everything from the lockfile and the local store.
- Tests, typecheck, lint, and build never touch the network.

## Seeding a working copy

The fixture is materialized as a standalone git repository by
`../seed-nextjs.mjs` (node_modules and build output are excluded; the
initial commit is deterministic). `../smoke-nextjs.mjs` seeds into a temp
dir and asserts the expected files exist.
