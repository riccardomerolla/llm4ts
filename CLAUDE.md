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
                 ├────→ modernize
                 └────→ shell
```

`modernize` may also depend directly on `core` and `flow`. `shell` is the
interactive terminal entry point and `llm4ts` CLI (ADR 0006); the runner
keeps zero knowledge of it.

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

## Deep Modules Over Parallel Code

Extend the existing seams instead of writing one-off variants:

- API providers: `makeApiConnector` (`packages/core/src/Connector.ts`)
- CLI coding agents: `makeCliConnector` + `versionProbe` (same module)
- Connector identity: the id/provider/baseUrl table in
  `packages/core/src/Models.ts`
- Flow spine: `implementPlanFlow` (`packages/flow/src/Flow.ts`)
- Node composition: `runNode` in `packages/runner/src/FlowRunner.ts` — the
  runner stays thin; policy belongs in core/flow
- Tests use the in-src fakes (core: process/HTTP/temp-file fakes; flow:
  `makeMemoryPlainFileStore`, `makeMemoryWorkspace`)

Behavior divergences from pinned `llm4zio` v4.2.0 require an ADR
(`docs/adr/`) or a `docs/parity.md` note.

## Verification

Run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

`pnpm build && node scripts/pack-smoke.mjs` additionally verifies the
published artifacts resolve for an external consumer.

## Releases

Publishing is tag-driven via npm trusted publishing (OIDC) — no tokens:

```bash
pnpm version:set X.Y.Z   # bumps all five packages in lockstep
# update CHANGELOG.md, commit, then:
git tag vX.Y.Z && git push origin main vX.Y.Z
```

The release workflow refuses to publish when the tag does not match every
package version.

## Autonomous Loop (Ralph)

`./ralph-auto.sh "<focus prompt>"` runs an autonomous agent loop against the
work queue in `specs/` (see `specs/README.md`). The script owns git commits
and enforces the verification chain; the agent prompt template is
`RALPH_AUTO_PROMPT.md`. Specs in `specs/pending/` are only moved to
`specs/completed/` by the user.
