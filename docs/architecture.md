# Architecture

The workspace follows one dependency direction:

```text
core → flow → runner → js
          └────→ modernize
```

`modernize` also consumes `core` and `runner` through their exported subpaths.
No package imports another package's `src` directory.

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
CLI parsing, and MCP stdio. Protocol stdout is isolated from terminal output.

## Modernize

`@llm4ts/modernize` orchestrates six ordered phases:

```text
survey → extract → seed → implement → verify → review
```

The state document is versioned and written after each transition. Completed
predecessors are not repeated after failure or interruption. Existing program
specifications and verification vectors are artifact-level checkpoints, while
implementation reuses the flow package's task-level plan persistence.
Extraction requires an approved wave plan; seeding requires an approved
specification pack.

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
