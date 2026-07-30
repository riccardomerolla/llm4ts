# llm4ts Source-Informed Implementation Plan

## Goal

Build `llm4ts`, an idiomatic Effect-TS counterpart of the owned `llm4zio`
library. Preserve the library's LLM concepts, supported integrations, observable
behavior, project boundaries, configuration semantics, prompts, and useful test
cases while translating Scala/ZIO implementation choices into native
TypeScript/Effect designs.

The target is a reusable library and runner, not the accounting application that
originally occupied this repository.

## Implementation Authorities

When sources disagree, use this order:

1. Explicit decisions recorded in this plan or later accepted ADRs.
2. The pinned original source: `llm4zio` tag `v4.2.0`, observed at commit
   `adf23e11`.
3. The behavioral and non-functional contracts in `docs/csp/`.
4. Idiomatic Effect-TS behavior and the locally pinned Effect source.

The original source may be inspected and reused as a behavioral oracle. Public
concepts, provider mappings, configuration keys, prompts, fixtures, and test
semantics may be retained when that improves parity. Algorithms and APIs should
still be adapted where TypeScript or Effect has a clearer native model.

Every intentional divergence from the pinned source must be recorded in a short
ADR or parity note. `docs/CSP_STATUS.md` is historical extraction metadata, not a
completion checklist.

## Pinned Baselines

- Reference implementation: `/Users/riccardo/git/github/riccardomerolla/llm4zio`
- Reference release: `v4.2.0`
- Reference commit observed during planning: `adf23e11`
- Effect reference checkout: `.repos/effect`
- Effect reference commit: `504343b0cdf9a0306191c069c31b7d569eba0ed7`
- Effect package line: `4.0.0-beta.102`
- Runtime baseline: Node.js 22 and pnpm 10

Source movement after these pins does not silently expand the scope. A later
source release is adopted through an explicit parity update.

## Target Workspace And Dependency Graph

The accounting package split is replaced by the same semantic boundaries as the
current source library:

```text
@llm4ts/core
      │
      ▼
@llm4ts/flow
      │
      ▼
@llm4ts/runner
   ┌──┴──────────┬─────────────┐
   ▼             ▼             ▼
@llm4ts/modernize  @llm4ts/js  @llm4ts/shell
```

`modernize` may also consume `flow` and `core` directly. `js` is a thin
Promise/exception facade analogous to the source Java facade and must not become
a second implementation. `shell` is the interactive terminal entry point and
subcommand CLI (ADR 0006); the runner keeps zero knowledge of it.

### `@llm4ts/core`

- Backend-neutral messages, responses, chunks, usage, health, and connector
  models.
- `LlmService`, streaming utilities, structured output, retries, limits, and
  connector registry.
- HTTP and process abstractions, providers, tool declarations and execution.
- Evaluation, judges, checks, variance, observability, and tracing primitives.
- Capability vocabulary and dynamic grant enforcement shared by higher layers.

### `@llm4ts/flow`

- `FlowContext`, plans, execution policies, review cycles, and workflow events.
- Plain-file persistence, conversations, templates, provenance, and reports.
- Git, GitHub, Azure DevOps, workspace tools, and static capability-aware APIs.
- Trace recording/replay, Mermaid rendering, pricing/cost ledger, benchmarking,
  review cache, packs, specification checks, clean-room wall, survey, and
  equivalence workflows.

### `@llm4ts/runner`

- Script and embedded entry points.
- Node layers, connector presets, terminal rendering, and operator interaction.
- MCP/JSON-RPC server and CLI entry points.
- Examples that exercise the public library rather than private internals.

### `@llm4ts/modernize`

- The source product's modernization workflow and its six phases.
- Assessment artifacts, migration plans, execution, verification, and reporting.
- Composition over public `core`, `flow`, and `runner` services.

### `@llm4ts/js`

- Promise-returning and exception-based wrappers for JavaScript consumers.
- Stable DTOs and minimal configuration builders.
- No duplicated provider, flow, or runtime logic.

## Effect-TS Design Rules

- Follow the locally vendored Effect 4 guides and source before relying on memory
  of Effect 3 APIs.
- Express reusable dependencies with `Context.Service` and compose live/test
  implementations with `Layer`.
- Define public data with `Schema.Class`, `Schema.TaggedClass`, branded schemas,
  and readonly collections where they improve invariants.
- Define serializable expected failures with `Schema.TaggedErrorClass`; keep them
  in the typed error channel.
- Use `Effect.fn` for named reusable operations and `Effect.gen` for readable
  orchestration.
- Use `Stream`, `Scope`, `Queue`, `PubSub`, `Ref`, `Semaphore`, `Clock`,
  `Duration`, `Schedule`, and interruption instead of unmanaged promises or
  mutable global state.
- Decode JSON, configuration, process output, provider responses, and persisted
  data at their boundaries with schemas.
- Keep pure request builders, parsers, classifiers, renderers, and state
  transitions separate from live effects.
- Never use `any`, unchecked `as` casts, namespaces, or global `Error` as the
  normal domain-error model.
- Provide layers at application boundaries. Library operations should retain
  their requirements in the `R` type.
- Publish explicit subpath exports. A package root may expose a small curated API,
  but must not become an indiscriminate barrel.
- Secrets must use redacted configuration and must never appear in argv, logs,
  traces, events, plan files, or error messages.

## Testing And Parity Strategy

Implementation is test-first at behavior boundaries. The parity ledger will map:

| Reference                                   | llm4ts evidence           |
| ------------------------------------------- | ------------------------- |
| Original Scala production type or operation | TypeScript module/subpath |
| Original Scala test or integration scenario | Vitest test name          |
| Applicable CSP section                      | Contract citation         |
| Intentional difference                      | ADR/parity note           |

Tests use `@effect/vitest`, `it.effect`, test layers, deterministic clocks, and
fake HTTP/process/filesystem services. Normal tests do not manually call
`Effect.runPromise`.

CI never requires installed provider CLIs, network access, cloud credentials, or
live Git hosting. Separate opt-in integration jobs may exercise those systems.

## Delivery Phases

Each phase leaves typecheck, lint, formatting, and all accumulated tests green.

### Phase 0 — Honest Library Scaffold

1. Rebrand the workspace and package aliases from `accountability` to `llm4ts`.
2. Replace the accounting `core/persistence/api/web` split with
   `core/flow/runner/modernize/js`.
3. Remove accounting specs, PostgreSQL/Testcontainers, TanStack/React,
   Playwright, Docker, and generated application assumptions.
4. Retain strict TypeScript project references, pnpm, ESLint, Prettier, Vitest,
   Effect language-service diagnostics, Node 22, and GitHub Actions.
5. Align `effect` and all `@effect/*` packages to one Effect 4 beta release.
6. Add package metadata, explicit exports, build/test scripts, and source/test
   project references.
7. Document the pinned source and Effect baselines.

Exit criteria:

- fresh install, typecheck, lint, formatting check, and empty test suite pass;
- no active accounting domain or browser/database dependency remains;
- the target package graph is cycle-free.

### Phase 1 — Typed Core LLM Contract

Implement in `core`:

- providers, connector identifiers/kinds, roles, messages, usage, responses,
  chunks, progress, tool calls, connector capabilities, and health schemas;
- the source `LlmError` hierarchy plus flow/tool/context errors needed at the
  package boundary;
- the backend-neutral `LlmService`;
- collection helpers and structured-output contracts;
- deterministic mock service and test layer.

Exit criteria:

- public models round-trip through their schemas where applicable;
- error variants remain typed and serializable;
- service tests cover streaming, history, structured output, tools,
  availability, and identity without Node dependencies.

### Phase 2 — Capability Foundation

Implement before filesystem, Git, and tools:

- capability identifiers and grant sets;
- classified values and taint/flow checks;
- dynamic fiber-local grant enforcement;
- static TypeScript capability tokens/generics for APIs where compile-time
  evidence is useful;
- coder policy and capability audit events.

Dynamic checks remain the security boundary; static evidence improves API
guidance but cannot replace runtime enforcement.

Exit criteria:

- missing grants fail before effects execute;
- nested/scoped grants restore correctly after success, failure, or interruption;
- classification cannot be silently weakened;
- parity tests cover the source capability suite.

### Phase 3 — Streaming, Structured Output, Retry, And Limits

- Stream collection, progress, snapshots, merge, buffering, batching, timeout,
  heartbeat, SSE, cancellation, and bounded parallelism.
- Robust JSON candidate extraction and schema decoding.
- Retry classification and bounded schedules.
- Token-bucket rate limiting, metrics, and usage-limit policy.
- Context window calculation, truncation, and provider constraints.

Exit criteria:

- resources close on failure and interruption;
- retry zero means exactly one attempt;
- partial JSON and fenced JSON behavior matches the source/CSP cases;
- usage caps stay distinct from transient rate limits.

### Phase 4 — Runtime Boundaries And Connector Registry

- Connector configuration/factories, fallback ordering, capability lookup,
  health aggregation, and model resolution.
- Backend-neutral HTTP and process services.
- Node live layers supporting captured, streamed, stdin-fed, and scoped
  bidirectional processes.
- Deterministic fakes for contract tests.

Exit criteria:

- missing commands and transport failures are typed;
- non-zero process exit remains data unless a fail-on-exit operation is chosen;
- timeouts and cancellation release resources;
- connector resolution matches source precedence.

### Phase 5 — Provider And CLI Connectors

Deliver isolated slices for every connector present at the pinned source:

- OpenAI, Anthropic, Gemini API, LM Studio, Ollama, Grok, and compatible HTTP
  variants;
- Claude, Gemini, Codex, Pi, OpenCode, Copilot, Cursor, and Antigravity CLI
  families where present;
- continuation-only and held interactive session modes;
- deterministic mock connector.

Each slice includes pure request/argv builders, response/event parsers, error and
usage-limit classification, structured output/tool support where available,
credential/config decoding, and mocked contract tests.

Source inspection fixes the implementation order and prevents false protocol
sharing:

1. OpenAI first, including its wire schemas, authenticated chat-completions
   request builder, SSE parser, JSON-schema response format, tool-call mapping,
   and source-compatible availability semantics.
2. Anthropic and Gemini API next as separate native protocols. Anthropic uses
   `/messages`, `x-api-key`, and typed SSE event variants; Gemini uses
   `generateContent`/`streamGenerateContent`, `x-goog-api-key`, native schema
   configuration, and function declarations.
3. LM Studio and Ollama as local-provider slices. LM Studio deliberately mixes
   its native `/api/v1/chat` response model with OpenAI-compatible streaming;
   Ollama uses newline-delimited `/api/generate` and `/api/chat` payloads. They
   must not be reduced to a generic OpenAI-compatible alias.
4. The OpenCode HTTP implementation remains a distinct compatibility adapter,
   while the registry's `opencode` connector ID continues to select the CLI
   connector exactly as the pinned source does.
5. CLI work starts with a shared deterministic flag/argv builder and JSON-line
   decoding helpers, then implements the smaller continuation-only connectors
   before Codex, Claude, and Gemini session-specific behavior.
6. Registry wiring and runner presets come last, once every advertised
   capability is backed by a contract test.

Protocol DTOs remain provider-local. Only transport mechanics, JSON boundary
decoding, usage-limit classification, deterministic CLI flags, and common
health/process helpers may be shared.

Exit criteria:

- normalized behavior and capability declarations match the source matrix;
- prompts use stdin wherever the CLI supports it; the few CLIs whose public
  headless interface requires a positional prompt retain that source behavior,
  while secrets never enter argv or diagnostic output;
- no live credentials or installed CLI are required by default CI.

### Phase 6 — Tools, Evaluation, And Observability

- Tool catalog, JSON-schema declarations, validation, selection, execution,
  concurrent execution, and bounded tool loops.
- Provider-specific tool declaration/result mappings.
- Judges, checks, evaluation suites, variance analysis, and reports.
- Trace spans/events, metrics, logging, and correlation identifiers.

Exit criteria:

- invalid arguments never execute tool bodies;
- tool loops enforce turn and concurrency limits;
- evaluation aggregation and failure behavior match source tests;
- secret redaction is tested.

### Phase 7 — Flow Context, Persistence, And Workspace Safety

- `FlowContext`, plan state machine, review cycles, policies, and event stream.
- Versioned plain-file stores for plans, conversations, templates, traces,
  ledgers, caches, and reports.
- Workspace read/write/append/discovery/search/validation operations.
- Provenance and clean-room wall artifacts.

All path operations normalize and verify containment under the configured root,
including symlink-sensitive operations.

Exit criteria:

- restart/resume behavior is deterministic;
- atomic writes and schema-version failures are tested;
- traversal, oversize content, and result limits fail as typed values;
- event order and plan transitions match the source.

### Phase 8 — Git And Hosted Repository Integrations

- Git query and mutation capabilities, diffs, worktrees, checkpoints, and
  rollback.
- GitHub and Azure DevOps operations used by source workflows.
- Review cache, specification checks, packs, survey, and equivalence reports.
- Capability enforcement for every read/write/network/process boundary.

Exit criteria:

- disposable local repositories cover Git behavior;
- hosted APIs use mocked HTTP fixtures in CI;
- read-only and mutation capabilities cannot be confused;
- partial failures preserve actionable typed context.

### Phase 9 — Trace, Replay, Cost, Bench, And Reports

- Recorder and replay with schema versioning and deterministic ordering.
- Mermaid rendering and human-readable summaries.
- Pricing catalog, usage cost calculation, cost ledger, and budgets.
- Benchmarks, comparisons, and report codecs.

Exit criteria:

- recorded scenarios replay without provider access;
- corrupted or unsupported recordings fail explicitly;
- cost math and rounding match pinned source tests;
- renderers remain pure and snapshot-tested.

### Phase 10 — Runner, MCP, And Examples

- Script and embedded runner APIs.
- Node layer presets and connector selection.
- Terminal progress/cost/approval/ask-user rendering.
- MCP JSON-RPC over stdio and optional HTTP/SSE transport where supported.
- Example workflows equivalent to the source examples.

Exit criteria:

- the runner is a thin composition edge;
- protocol behavior passes black-box transport tests;
- stdout remains protocol-clean in stdio mode;
- cancellation stops child work and closes transport resources.

### Phase 11 — Modernize Product

Port the pinned modernization workflow as a consumer of public library APIs:

- discovery and assessment;
- target architecture and migration planning;
- staged implementation and review;
- verification, equivalence, and final reporting.

Exit criteria:

- six-phase state transitions and resume behavior match source tests;
- fixtures do not require external providers;
- product code does not reach through package-private boundaries.

### Phase 12 — JavaScript Facade, Documentation, And Release

- Promise/exception facade in `@llm4ts/js`.
- API reference, architecture guide, provider/capability matrix, configuration
  guide, examples, migration notes, and source-parity ledger.
- npm publishing metadata, exports, generated declarations, provenance, and
  release automation.
- Decide explicitly whether OCI artifacts add value; do not retain Docker merely
  because the sample used it.

Exit criteria:

- a plain JavaScript consumer can configure and run a mock workflow;
- package tarballs contain only intended build artifacts;
- documentation examples typecheck;
- all accepted parity rows are complete or marked with an approved divergence.

## Cross-Cutting Definition Of Done

A slice is complete only when:

1. Its public contract is schema-defined and exported intentionally.
2. Expected failures remain typed; defects are not disguised as domain errors.
3. Live dependencies are services/layers and have deterministic test
   implementations.
4. Resources close on success, failure, and interruption.
5. Capability and secret boundaries have negative tests.
6. Original-source test behavior and applicable CSP contracts are represented in
   the parity ledger.
7. Typecheck, Effect diagnostics, lint, formatting, and tests pass.
8. Any source divergence is documented and accepted.

The project is complete when the accepted public behavior of pinned `llm4zio`
v4.2.0 is available through the Effect-TS package graph, the complementary CSP
contracts pass, the modernize and runner products work through public APIs, and
release artifacts can be built reproducibly.
