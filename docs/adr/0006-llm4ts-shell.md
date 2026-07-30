# 0006. The llm4ts shell: discovery + run + CLI core

Status: Accepted · Date: 2026-07-29

## Context

llm4ts had a single-shot `llm4ts` bin inside `@llm4ts/runner` (stream one
prompt to the selected coding agent) and a set of runnable flow scripts, but
no interactive entry point, no way to discover which flows exist, and no
subcommand CLI. Orca — the Scala sibling of this project family — solved the
same problem with its shell (orca ADR 0021): a wizard, three-tier flow
discovery, agent-assisted flow authoring, session continuation, and a
mirroring CLI. This ADR records the llm4ts port of that design's v1 core and
the places where the npm ecosystem makes different choices correct.

## Decision

### Package and bin

`@llm4ts/shell` is a sixth workspace package depending on `@llm4ts/runner`
(graph: core → flow → runner → shell); the runner keeps zero knowledge of the
shell, mirroring orca's add-on constraint. The `llm4ts` bin moves from
`@llm4ts/runner` to `@llm4ts/shell` — a breaking change recorded in the
CHANGELOG. The old bin's two capabilities survive as explicit verbs: `llm4ts
ask "<prompt>" [--repo]` (one-shot streaming via the runner's
`makeCliProgram`) and `llm4ts doctor`.

Distribution is plain npm: `npx -y @llm4ts/shell` is the zero-install path,
global install optional. No curl installer or shim script — orca needed one
because scala-cli launches from a Maven dependency; npm's own bin wiring
already does that job.

### CLI and menu

Verbs: `run <flow> [task…] [--verbose]`, `list [--json]`, `view <flow>`,
`ask`, `doctor`, plus `--help`/`--version`. No arguments on a real terminal
opens the interactive menu (Run a flow · View a flow · Exit); off a tty it is
a usage error. Built on `effect/unstable/cli` (`Command`, `Flag`, `Prompt`)
from the pinned Effect 4 beta, with `@effect/platform-node` (version-aligned)
providing the terminal/filesystem services — the one new dependency, confined
to the shell package.

CLI hygiene follows orca ADR 0021 §10: data to stdout, diagnostics to
stderr; exit 0 success, 1 action failure, 2 usage error; `run` propagates the
child's raw exit code instead of the flat convention.

### Flow model and discovery

A flow is a single-file TypeScript script per the flow-script contract
(`flows/README.md`): imports only `@llm4ts/*`, `effect`, and `node:*`; first
line is a `//` comment holding the one-line description; task text arrives
via argv. Discovery lists three tiers, keyed by filename, precedence
project > global > builtin, with a `shadows <tier>` annotation on winners:

- project: `{cwd}/.llm4ts/flows/*.ts`
- global: `${XDG_CONFIG_HOME:-~/.config}/llm4ts/flows/*.ts`
- builtin: the `flows/` directory shipped inside the `@llm4ts/shell` package

Built-ins are real files copied from the repository's top-level `flows/` by
`scripts/sync-shell-flows.mjs` during `pnpm build` — npm packages are
directories, so orca's jar-resource embedding and versioned cache extraction
(ADR 0021 §7) have no equivalent here and are deliberately absent.

### Execution and version policy

`run` spawns the flow as a child `node` process with type stripping enabled,
terminal inherited, task argv appended — orca's supervised-subprocess
decision (ADR 0021 §2) ported as-is; while the child runs the shell ignores
SIGINT so Ctrl-C reaches the foreground process group and the menu survives.

**Project wins, shell is fallback** — the deliberate divergence from orca's
force-shell-version default. The child resolves modules normally, so a
repository with its own `@llm4ts/*` pin runs the flow against that pin. Only
when `@llm4ts/runner` is unreachable from the flow's own location (global
flows, built-ins, bare repositories — detected by the same `node_modules`
walk ESM resolution performs) does the shell add `--import` of its
`ResolveFallback` hook, which retries failed bare-specifier resolutions
anchored at the shell's own installation. Orca forces its version to
guarantee the session-manifest writer exists in the child; llm4ts defers
session manifests entirely (below), so the forcing motivation is absent and
npm's nearest-wins semantics are the less surprising default. Revisit when
session continuation lands.

### Coder selection

`LLM4TS_CODER` stays authoritative (`coderFromEnv`). The menu shows the
resolved connector and offers a per-run override chosen from the CLI coder
vocabulary, decorated with a PATH-probe `✓ found` (a pure PATH scan, no
subprocess — undetected agents stay selectable, orca ADR 0021 §4's stance).
The override travels to the child as `LLM4TS_CODER`; nothing is persisted —
persistence belongs to the future wizard/settings work.

## Deferred (with their orca ADR 0021 anchors)

- Welcome wizard and persisted settings (§4) — until then, env vars rule.
- Edit / create / fork flows and the authoring sandbox (§6, §9).
- Session manifests and continuation (§8) — the revisit trigger for the
  version policy above.
- Syntax highlighting and paging for `view`; Windows support beyond what
  Node provides.

## Consequences

- New published artifact `@llm4ts/shell`; `@llm4ts/runner` loses its bin
  (breaking, CHANGELOG'd) but keeps `Cli`/`Doctor` as library exports the
  shell composes.
- `flows/` doubles as the built-in tier; the sync script keeps package
  copies from drifting, and the pack smoke asserts the published bin lists
  them.
- Release tooling (`version:set`, pack smoke, release workflow's
  `packages/*` glob) covers six packages in lockstep.
- The `ask`/`doctor` verbs slightly exceed the spec's v1 verb list — the
  cost of not regressing the pre-existing bin surface during the move.
