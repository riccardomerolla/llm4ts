# llm4ts Shell: discovery + run + CLI core

Build `@llm4ts/shell`, the interactive entry point and subcommand CLI for
llm4ts, modeled on orca's shell (orca ADR 0021) but deliberately scoped to
its v1 core: flow discovery, run-a-flow, view, and a non-interactive CLI.
The wizard, settings file, flow authoring/editing, and session
continuation are explicit non-goals here — each has its own orca ADR
section to port in a later spec.

Depends on `specs/pending/flow-scripts-restructure.md` (the flow-script
contract and the `flows/` directory that becomes the built-in tier).

## Decisions (agreed 2026-07-29)

| Decision        | Choice                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope v1        | Interactive menu (Run a flow · View a flow · Exit) + CLI verbs `run`, `list`, `view`, `--help`, `--version`. No wizard, no edit/create/fork, no session continuation.                                                                                                                                                                                                                                                       |
| Package         | New workspace package `@llm4ts/shell`, depending on `@llm4ts/runner` (graph: core → flow → runner → shell). Runner keeps zero knowledge of the shell.                                                                                                                                                                                                                                                                       |
| Bin             | The `llm4ts` bin moves from `@llm4ts/runner` to `@llm4ts/shell`; runner drops its `bin` field (breaking — CHANGELOG note). No args + tty → menu; args → CLI.                                                                                                                                                                                                                                                                |
| Distribution    | `npx -y @llm4ts/shell` is the documented zero-install path; global install optional. No curl installer.                                                                                                                                                                                                                                                                                                                     |
| CLI toolkit     | `effect/unstable/cli` (`Command`, `Flag`, `Prompt`) from the pinned Effect 4 beta — zero new dependencies, Effect services/layers throughout.                                                                                                                                                                                                                                                                               |
| Flow model      | Flows are single-file TS scripts per the flow-script contract; the shell runs them as child `node` processes with type stripping, terminal inherited.                                                                                                                                                                                                                                                                       |
| Discovery tiers | Project `{cwd}/.llm4ts/flows/*.ts` → global `${XDG_CONFIG_HOME:-~/.config}/llm4ts/flows/*.ts` → built-in (the `flows/` files shipped inside the shell package). Precedence project > global > built-in, keyed by filename, with a `shadows <tier>` annotation.                                                                                                                                                              |
| Descriptions    | First non-empty `//` comment line in the file's leading comment block (orca ADR 0021 §5 rule, minus scala-cli directives).                                                                                                                                                                                                                                                                                                  |
| Version policy  | Project wins: the child resolves modules normally, so a repo-local `node_modules` with pinned `@llm4ts/*` is honored; the shell injects its own installation as fallback resolution only when the flow could not otherwise resolve `@llm4ts/*` (global flows, built-ins, bare repos). Divergence from orca's force-shell-version default, motivated by npm semantics and the deferred manifest feature — record in the ADR. |
| Coder choice    | `LLM4TS_CODER` env stays authoritative (`coderFromEnv`). The menu shows the resolved connector and offers a per-run override via a select prompt over the connector identity table (`packages/core/src/Models.ts`), decorated with a PATH-probe `✓ found`. The override is passed to the child as `LLM4TS_CODER`; nothing is persisted.                                                                                     |
| CLI hygiene     | Data to stdout (`view` source, `list` rows / `--json`), diagnostics to stderr. Exit codes 0 success / 1 action failure / 2 usage error; `run` propagates the child's raw exit code. Menu requires a tty (clean exit 2 message otherwise); `run`/`list`/`view` work piped.                                                                                                                                                   |
| ADR             | Write `docs/adr/0006-llm4ts-shell.md` recording the divergences from orca ADR 0021: project-wins resolution, npx distribution, files-not-extraction built-ins, and the deferred sections (wizard §4, edit §6, authoring §9, sessions §8) with their revisit conditions.                                                                                                                                                     |

## Tasks

- [ ] Scaffold `packages/shell` (package.json with `bin`, `files` including
      the built-in `flows/` copies, subpath exports, tsconfig, publishConfig
      matching the other packages); bump the workspace/version tooling
      (`pnpm version:set`, release workflow) to cover the fifth→sixth
      package in lockstep.
- [ ] Move the `llm4ts` bin: shell gains `cli-main`, runner drops its `bin`
      field; CHANGELOG records the breaking move.
- [ ] Flow discovery module: enumerate the three tiers, apply
      filename-keyed precedence with shadow annotations, and extract
      descriptions per the leading-`//`-comment rule. Deterministic tests
      with temp/memory directories covering precedence, shadowing, missing
      dirs, and the description edge cases (blank `//` line skipped, no
      comment → no description).
- [ ] Runner (execution) module: spawn
      `node` with type stripping enabled for the resolved flow path, task
      argv appended, terminal inherited, SIGINT reaching the child via the
      shared foreground process group, child exit code propagated, and
      fallback module resolution pointing at the shell's own installation
      only when the project provides none. Deterministic test using a
      trivial fake flow script (no network, no provider CLIs).
- [ ] CLI: `run <flow> [task…] [--verbose]`, `list [--json]`,
      `view <flow>`, `--help`, `--version`, built on `effect/unstable/cli`;
      unknown command → stderr + exit 2. `list` output shows name,
      origin tier, description, and shadow annotations.
- [ ] Interactive menu (tty only): Run a flow (pick from discovery →
      show description → prompt for task text → per-run connector
      override → execute), View a flow (print source), Exit.
- [ ] `docs/adr/0006-llm4ts-shell.md` per the decisions table; update
      `plan.md`'s package graph, root `README.md` (install/quickstart via
      npx), and `docs/` entry points.
- [ ] `pnpm build && node scripts/pack-smoke.mjs` extended so the packed
      `@llm4ts/shell` resolves for an external consumer and its `bin` is
      wired.

## Non-goals (deferred, with their orca ADR 0021 anchors)

- Welcome wizard and persisted settings (§4) — arrives with a settings
  spec; until then env vars rule.
- Edit / create / fork flows, authoring sandbox (§6, §9).
- Session manifests and continuation (§8) — revisit the version policy
  when this lands.
- Windows support beyond what Node gives for free.
- Syntax highlighting or pager for `view` — plain print in v1.

## References

- orca ADR 0021: `/Users/riccardo/git/github/riccardomerolla/orca/adr/0021-orca-shell.md`
- `packages/runner/src/{Cli.ts,cli-main.ts,FlowArgs.ts,Connectors.ts,Terminal.ts}`
- `packages/core/src/Models.ts` (connector identity table),
  `packages/core/src/Connector.ts` (`versionProbe` seam for the ✓ probe)
- `effect/unstable/cli` in the pinned Effect 4 beta (`Command`, `Flag`, `Prompt`)
