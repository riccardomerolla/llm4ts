# llm4ts Engineering Guide

`llm4ts` is an Effect-TS library for agent-agnostic engineering workflows. It
began as a port of `llm4zio`; parity with it is no longer a goal.

## Start Here

1. Read the ADRs in `docs/adr/` that cover the area you are changing. They are
   the living design record.
2. Read `docs/architecture.md` and `docs/api.md` for package boundaries and
   the public surface.
3. For Effect work, consult `.repos/effect` and the repository Effect skill
   before coding.

`plan.md`, `docs/csp/`, `docs/CSP_STATUS.md` and `docs/parity.md` are
historical, frozen at 2.54.1. Do not follow or update them.

## Package Graph

```text
core → flow → runner → js
                 └────→ shell
```

`shell` is the interactive terminal entry point and `llm4ts` CLI (ADR 0006);
the runner keeps zero knowledge of it. Stack-specific material (packs,
scaffolds, pattern cards, kit flows) lives in `kits/` (ADR 0014), not in a
package.

## Non-Negotiable Rules

- Use Effect 4 services and layers for replaceable dependencies.
- Use schemas at external and persistence boundaries.
- Keep expected failures typed with `Schema.TaggedError`.
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
- Typed judgments: the `Judgment` service in `packages/core/src/judgment/`
  (ADR 0017); a new backend is a layer over it, a new decision is questions
  plus a `JudgmentPolicy` in flow, never a parsed prose reply. Connectors
  reach probabilities only through `scoreLabels` (`LabelScoring.ts`)
- Flow spine: `implementPlanFlow` (`packages/flow/src/Flow.ts`)
- Node composition: `runNode` in `packages/runner/src/FlowRunner.ts` — the
  runner stays thin; policy belongs in core/flow
- Tests use the in-src fakes (core: process/HTTP/temp-file fakes; flow:
  `makeMemoryPlainFileStore`, `makeMemoryWorkspace`)

A design decision that changes documented behaviour is recorded as an ADR
(`docs/adr/`).

## Verification

Run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm unused
pnpm test
```

`pnpm unused` fails when a module under `packages/*/src` has no production
importer; remove it, use it, or list it in `scripts/unused-modules.mjs` with
the reason it stays.
It also fails on an import cycle among those modules, type-only imports
included: move the shared type or value into a module both can depend on.

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
package version, or when `CHANGELOG.md` has no `## X.Y.Z` section: that
section becomes the body of the GitHub Release the workflow creates after
publishing (`scripts/release-notes.mjs`). Alternatively, once the version bump is on `main`, run the
Release workflow manually (workflow_dispatch in the Actions tab): it publishes
the checked-out versions and pushes the matching `vX.Y.Z` tag itself.

## Autonomous Loop (Ralph)

`tools/ralph/ralph-auto.sh "<focus prompt>"` runs an autonomous agent loop against the
work queue in `specs/` (see `specs/README.md`). The script owns git commits
and enforces the verification chain; the agent prompt template is
`tools/ralph/RALPH_AUTO_PROMPT.md`. Specs in `specs/pending/` are only moved to
`specs/completed/` by the user.
