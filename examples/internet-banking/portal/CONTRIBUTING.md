# Banca Demo portal — house rules

These rules apply to every feature added to this repository, by people or by
coding agents. The exemplar feature `src/features/profilo/` demonstrates all
of them; imitate it before inventing anything.

## Vocabulary

A **feature** is one screen (or a small group) under `src/features/<name>/`.
A **domain** is one service contract under `src/contracts/<name>.ts` with its
fake routes beside it. A **story** (in the llm4ts flow) owns a set of paths
(`owned`) and may read but never change the **shared** ones
(`sharedReadOnly`). This layout is the perimeter.

## File layout

```text
src/kit/                         the shared kit — read, never edit (see below)
src/kit/theme.css                design tokens and every class a feature may use
src/kit/messages.ts              the kit's own strings (shell, sign-in, common words)
src/contracts/<domain>.ts        Effect HttpApi contract + wire schemas
src/contracts/<domain>.fake.ts   fake routes over an in-memory store + `<domain>Domain`
src/features/<feature>/messages.ts     the feature's dictionary (English defines, Italian covers)
src/features/<feature>/route.tsx       the feature's id, nav label, screen
src/features/<feature>/<Name>Screen.tsx the screen(s)
src/features/<feature>/*.test.tsx      the feature's tests, inside its own directory
src/App.tsx                      the single composition point: the feature list
contracts/openapi/<domain>.json  rendered from the contract by `pnpm openapi`
```

Imports are relative with `.ts`/`.tsx` extensions; no path aliases.

## Shared surface (read-only for feature work)

`src/kit/**`, `src/App.tsx`, `CONTRIBUTING.md`, and every other feature's
directory. A feature that needs a new kit component or a change to the
composition point does not make it: that is a separate piece of work (in the
flow, a dedicated story). When something you need is not there and is not
yours to build, stop and say so rather than working around it.

## Screens

- Read the signed-in customer from `useAuth()`; never implement sign-in.
- Compose kit components only: `Panel`, `Field`, `Notice`, `DataTable`,
  `StateBadge`, `Figure`, `KeyValues`, `LoadMore`, `SelectFilter`,
  `Loading`. No new CSS files, no inline colours, no external UI kits; the
  classes in `theme.css` are the whole vocabulary.
- Load data with `useLoad(domain, (client) => client.<group>.<endpoint>(...), deps)`;
  act with `useAction(domain)`; page with `usePages`. Never call `fetch`.
- Validation is a pure function beside the screen returning message *keys*,
  rendered through `Field`'s `error`.
- Money is integer cents on the wire; render with `euroText`, parse with
  `parseEuro`. Dates are ISO strings; render with `dateText`.
- Move between features with `useNavigate()(id)`.

## Text

- Every string a customer reads comes from the feature's `messages.ts`:
  `messages({ en }, { it })`. Italian must cover every English key, or the
  build fails. Italian is the default language.
- Engineering stays in English: code, comments, contracts, commit messages.

## Domains

- One `HttpApi` per domain in `src/contracts/<domain>.ts`, schemas as
  `Schema.Class`, errors from `HttpApiError`.
- Fake routes in `<domain>.fake.ts`: deterministic fixture data, an
  in-memory store per page session, a `reset<Domain>Fake()` for tests, and
  the exported `<domain>Domain = domain(routes, (httpClient, baseUrl) =>
  HttpApiClient.makeWith(Api, { httpClient, baseUrl }))` features import.
- Run `pnpm openapi` after changing a contract and commit the rendered JSON.

## Tests

- Vitest + React Testing Library, next to the feature. Render inside
  `ConfigProvider`, `LanguageProvider`, and `AuthProvider customer={DEMO_CUSTOMER}`
  against the domain's own fake transport — no mocking of the kit.
- Assert: fields or rows render, validation fires and blocks a bad submit,
  a good action reaches the fake and is visible afterwards, and the screen
  renders in both languages.
- Deterministic and network-free.

## Gates

`pnpm typecheck && pnpm lint && pnpm test && pnpm build` must stay green.
`strict` TypeScript with `exactOptionalPropertyTypes`; no `any`, no type
assertions, no `@ts-ignore`.
