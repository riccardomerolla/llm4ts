# llm4ts Engineering Guide

`llm4ts` is the Effect-TS counterpart of the owned `llm4zio` library.

## Start Here

1. Read `plan.md` for scope, package boundaries, pinned revisions, and delivery
   phases.
2. Read the relevant contract in `docs/csp/`.
3. Inspect the pinned `llm4zio` source and tests when implementing parity.
4. For Effect work, consult `.repos/effect` and the repository Effect skill
   before coding.

## Package Graph

```text
core → flow → runner → js
                 └────→ modernize
```

`modernize` may also depend directly on `core` and `flow`.

## Non-Negotiable Rules

- Use Effect 4 services and layers for replaceable dependencies.
- Use schemas at external and persistence boundaries.
- Keep expected failures typed with `Schema.TaggedErrorClass`.
- Do not use `any`, unchecked type assertions, namespaces, unmanaged promises,
  or global `Error` as a domain error.
- Use explicit package subpath exports and `.ts` extensions for relative imports.
- Never expose secrets in process arguments, logs, traces, persisted plans, or
  error messages.
- Add deterministic tests with `@effect/vitest`; default CI must not need network
  access, provider credentials, or installed provider CLIs.

## Verification

Run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```
