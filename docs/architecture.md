# Architecture

The workspace follows one dependency direction:

```text
core → flow → runner → js
                 └────→ shell
```

No package imports another package's `src` directory. `@llm4ts/runner`'s
root export is the flow author's barrel: re-exports of the runner and flow
verbs a flow script uses, with the subpath exports staying the contract for
everything else. `pnpm unused` fails when a package's source or tests import
a package above it in this order; `js` and `shell` share a layer, so the
runner knows nothing of the shell.

The public surface is decided in the sources (ADR 0050). A module whose
first line is `// @internal: <reason>` has no subpath; every other module
under `packages/<pkg>/src` has one. `pnpm unused` derives each `exports` map
from that and fails on drift, on an import of an internal module from outside
its package, and on `export *`; `pnpm exports:write` rewrites the maps.

## Core

`@llm4ts/core` owns backend-neutral contracts. Runtime values and expected
errors are Schema-backed. Provider implementations depend on injected HTTP,
process, and temporary-file interfaces, so normal tests never require a network
or installed provider CLI.

## Flow

`@llm4ts/flow` adds workflow vocabulary without selecting a runtime: flow
context, events, plans, persistence, capabilities, Git/forge tools, review
packs, replay, costs, benchmarking, and behavioral equivalence. Filesystem and
process effects remain injected.

## Runner

`@llm4ts/runner` is the Node composition edge. It provides live Node
implementations, connector registration, scoped terminal/trace/cost consumers,
and CLI parsing. Protocol stdout is isolated from terminal output.

## Modernization phases and kits

The six modernization phases are the `modernize-*` flow scripts shipped in
the shell's built-in tier, each resumable on its own artifacts:

```text
pack-check → survey → extract → seed → implement → verify → review
```

Existing program specifications and verification vectors are artifact-level
checkpoints (`@llm4ts/flow/Artifacts`), implementation reuses the task-level
plan persistence, and the human gates are markdown approval markers
(`@llm4ts/flow/Approval`): extraction requires an approved wave plan, seeding
an approved specification pack. Everything stack-specific — pack manifests,
scaffolds, pattern cards, and stack-only flows — comes from a kit (ADR 0014),
discovered in the project, global, and built-in tiers and shipped beside the
engine flows.

## Shell

`@llm4ts/shell` is the `llm4ts` CLI and interactive menu (ADR 0006). Its
package is the bin only: it exports no module (ADR 0050). It
discovers flows and kits across the three tiers and launches a flow as a
child `node` process with type stripping, resolving `@llm4ts/*` from its own
installation when the project pins none. It also owns the config files (ADR
0049): `Config.ts` layers `~/.config/llm4ts/config.env` and
`<repo>/.llm4ts/config.env` under the environment and the `run` flags, and
every launcher hands the child the `FlowEnvironment` it returns. The offline
readers of finished and running runs live here too:
`Costs`, `Profile`, `Watch`, `RunReaders` and `StoryReaders` back
`llm4ts costs`, `profile`, `watch` and the operator's run and story views.
They read traces and boards with `@llm4ts/flow` and present events with
`@llm4ts/runner/EventPresentation`.

## JavaScript facade

`@llm4ts/js` is the only intentional Effect-to-Promise collapse. It validates
plain configuration, delegates to the same connector registry, converts typed
failures to `Llm4tsError`, and supports `AbortSignal`. It contains no provider or
workflow implementation.

## Security and resources

Secrets use Effect `Redacted` values and are only revealed when constructing a
provider header. Capabilities are explicit and audited before process or
repository operations. Scoped consumers and child processes finalize on
success, typed failure, and interruption.

## OCI decision

No OCI image is published. The release contains libraries and a Node CLI, not a
long-running server with an image-level deployment contract. Adding Docker
would increase maintenance without improving npm consumers; it can be revisited
if the MCP HTTP transport becomes a deployable product.
