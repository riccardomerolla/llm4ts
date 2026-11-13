# ADR 0050: Public Surface — Decided in the Sources, Checked by `pnpm unused`

Status: Accepted · Date: 2026-11-13 · Relates to ADR 0006, ADR 0014

## Context

Until 4.0.0 a package's public surface was whatever its hand-written
`exports` map listed. Every new module got a subpath by habit, so the maps
grew to 219 entries (core 56, flow 106, runner 33, js 3, shell 21). Nothing
said which of them a caller was meant to import:

- Fifteen exported modules had no importer outside their own package,
  repository tools aside, and no line in the API docs, yet each was a
  subpath a semver release had to keep.
- The shell, the `llm4ts` CLI, exported 20 modules that nothing outside the
  shell imports.
- A module added without a map entry worked inside the workspace, where
  `tsconfig` paths and the vitest aliases resolve any `src` file, and failed
  only for a consumer of the published tarball.

## Decision

### The marker

A module whose first line is `// @internal: <reason>` is not part of its
package's public surface. The reason is short and names who uses it, such
as `the Node HTTP client FlowRunner provides`. Any other first line that
mentions `@internal` is an error, so a misspelled marker cannot silently
publish a module.

### Public or internal

A module under `packages/<pkg>/src` is public when one of these imports it:

- another package (its source or its tests);
- `flows/`, `kits/` or `examples/`, which stand for user-authored flows;
- a sibling project built on llm4ts (nightcall, dunder-mifflin; the list is
  in `docs/research/architecture-review-2026-11-09/phase-2-review.md`).

It is also public when `docs/api.md` or `docs/flow-authoring.md` documents
it as something callers import, by name or by a wildcard such as
`@llm4ts/core/providers/*`. Every other module carries the marker.
`tools/` and `scripts/` never ship. A module only they import is internal,
and they reach it by relative path.

A public module may re-export names from an internal one: `Review` re-exports
`ReviewModel`'s values and `Judgment` re-exports `JudgmentTypes`' literals.

### Derived exports

`scripts/unused-modules.mjs` derives each package's `exports` map: every
non-internal module except `index.ts` gets `"./<path>": "./dist/<path>.js"`,
plus `./package.json`. The root entry (`.`) stays as the manifest declares
it and must not point at an internal module. `pnpm exports:write`
(`node scripts/unused-modules.mjs --write-exports`) rewrites the maps.

### The checks

`pnpm unused` keeps its unused-module, import-cycle and package-direction
checks and adds four:

- **Drift.** A manifest's `exports` differs from the derived map.
- **Outside import.** A file outside a package imports one of its internal
  modules, by `@llm4ts/<pkg>/<path>` or by relative path. `tools/` and
  `scripts/` may use a relative path.
- **`export *`** anywhere in `packages/*/src`. A star export hides what a
  module offers.
- **Docs.** `docs/api.md` or `docs/flow-authoring.md` names an
  `@llm4ts/<pkg>/<path>` that is not exported.

`scripts/pack-smoke.mjs` installs the packed tarballs and resolves every
module of every package: a public subpath must resolve, and an internal one,
the shell's included, must fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

### The shell is its bin

`@llm4ts/shell` exports only `./package.json`; its surface is the `llm4ts`
bin. The script lists the shell as bin-only, so every shell module is
internal without carrying the marker, and a new shell module needs none.

## Consequences

- Adding a module adds a subpath unless the author writes the marker. The
  decision is made once, in the file, and the map follows.
- A flow, kit or example that imports an internal module fails `pnpm unused`
  before it can fail for a user at run time.
- 4.0.0 removes 35 subpaths, leaving 184 (core 55, flow 98, runner 27, js 3,
  shell 1):
  - `@llm4ts/core`: `UsageLimits`.
  - `@llm4ts/flow`: `CapabilityGuard`, `CarriedNotes`, `Evidence`,
    `JudgmentDataset`, `JudgmentEval`, `OracleGuard`, `Recheck`,
    `ReviewModel` (its four names stay importable from `@llm4ts/flow/Review`).
  - `@llm4ts/runner`: `NodeGeminiCliExecutor`, `NodeGeminiModelBridge`,
    `NodeHttpClient`, `Otel`, `Package`, `WindowsCommand`. `runNode` wires
    the HTTP client, the Gemini executors and the OpenTelemetry export.
  - `@llm4ts/shell`: `Cli`, `CoderChoice`, `Config`, `ConfigCommand`,
    `ConfigEdit`, `ConfigTrust`, `FlowCatalog`, `FlowLaunch`, `FlowProcess`,
    `Menu`, `OperatorActTools`, `OperatorConfig`, `OperatorNode`,
    `OperatorRuns`, `OperatorServer`, `OperatorTools`, `Package`, `Refine`,
    `RunSupervisor`, `ShellErrors`. Use the `llm4ts` bin.
- `JudgmentTypes`, `settings/Registry` and `settings/Value` in flow had no
  subpath before and are now marked internal.
- `GraphRules` stays public though nothing outside flow imports it: the
  4.0.0 migration note names it as the home of `JoinMatch`.
- The core providers stay public: `docs/api.md` documents
  `@llm4ts/core/providers/*` as the connector implementations.

## Alternatives rejected

- **A hand-kept allowlist of public modules.** It is a second file to keep
  in step with the sources, which is the problem the maps already had.
- **Marking public modules instead of internal ones.** Most modules are
  public. Marking the exception keeps the marker rare and the reason close
  to the code that needs it.
- **Exporting the shell's modules for tests or tools.** Nothing outside the
  shell imports them. The CLI is the contract.
