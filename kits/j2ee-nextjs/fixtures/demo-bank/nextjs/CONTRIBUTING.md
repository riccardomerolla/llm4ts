# DemoBank house rules

These rules apply to every page added to this repository — by people or by
automated converters. The exemplar pages (`src/app/cards/page.tsx`,
`src/app/profile/page.tsx`) demonstrate all of them; imitate the exemplars
before inventing anything.

## File layout

```text
contracts/<domain>.openapi.yaml   wire contract (OpenAPI 3.0)
src/app/<route>/page.tsx          one page per route, always "use client"
src/auth/AuthProvider.tsx         SSO stub — consume, never reimplement
src/components/                   design system (import from '@/components')
src/services/<domain>/port.ts     typed interface + factory type
src/services/<domain>/mock.ts     mock adapter with fixture data
src/services/registry.ts          the only place adapters are wired to ports
src/theme/                        tokens + component CSS
tests/<route>.page.test.tsx       one component test file per page
```

Imports use the `@/` alias (`@/components`, `@/services/registry`); no deep
relative paths across top-level folders.

## Pages

- Every page starts with `'use client'` and default-exports the page
  component. No server components fetching data, no API routes.
- Every page renders exactly one `PageLayout` at its root and puts content
  in `Card`s.
- Get the signed-in user from `useAuth()`. Never implement login, tokens, or
  redirects.
- Loading states: hold `null` until the port resolves and render
  `<p className="db-loading">…</p>` meanwhile (see the exemplars).

## Components

- Compose the design system: `Button`, `Field`, `Form`, `DataTable`,
  `Stepper`, `Card`, `PageLayout`. Do not add external UI kits and do not
  hand-roll tables, labels, or submit handling that a component covers.
- Tabular data goes through `DataTable` with declarative columns.
- Every form control sits inside a `Field` (label + error handled for you)
  and every form is a `Form` render prop (values, errors, setValue,
  submitting). Validation is a pure function next to the page returning a
  `ValidationErrors<T>` map.
- Styling: use the `db-*` classes from `src/theme/components.css`, which
  consume only the custom properties in `src/theme/tokens.css`. No inline
  colors, no new CSS files per page, no CSS-in-JS.

## Services (ports and adapters)

- No `fetch`/network calls in components — ever. Pages call ports; adapters
  talk to the gateway.
- Each domain gets `src/services/<domain>/port.ts` (interface + `...Factory`
  type), `src/services/<domain>/mock.ts` (deterministic fixture data, small
  artificial delay), and `contracts/<domain>.openapi.yaml` matching the port.
- Pages obtain ports only from `src/services/registry.ts`. Swapping a mock
  for a real adapter is a one-line change there; pages never import adapters
  directly.

## Tests

- One test file per page under `tests/`, named `<route>.page.test.tsx`,
  written with Vitest + React Testing Library.
- Style: `vi.mock('@/services/registry', …)` with instrumented port
  functions, render the page inside `AuthProvider`, then assert (1) fields
  or rows render, (2) validation fires and blocks the port on bad input,
  (3) the port is called with the expected payload.
- Tests are deterministic and network-free.

## TypeScript and lint

- `strict` TypeScript; no `any`, no type assertions (`as`), no `@ts-ignore`.
- Model domain data with `readonly` interfaces exported from the port.
- Gates that must stay green: `pnpm typecheck && pnpm lint && pnpm test &&
  pnpm build`.
