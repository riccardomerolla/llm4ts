# Clean Specification Pack: Rust LLM Flow Library

## Purpose

This pack describes a Rust implementation of an LLM orchestration library for software-development automation. The library exposes a reusable async LLM client abstraction, backend connectors for API and CLI providers, a tool-calling layer, observability hooks, and a flow runner for agentic development workflows such as plan, implement, review, commit, push, and pull-request creation.

The pack is written for a build team that must not inspect the original implementation. It specifies public behavior, data shapes, error semantics, and black-box test contracts. It does not prescribe the source implementation's language, module layout, helper names, prompts, control flow, or dependency choices.

## Target Orientation

The Rust implementation should expose idiomatic Rust boundaries while preserving the observable contracts:

- crates or modules should separate LLM core behavior, provider adapters, tool calling, flow orchestration, and runner UX;
- async functions should return typed results rather than panicking for expected failures;
- streaming responses should be represented as asynchronous streams of typed chunks;
- CLI processes, HTTP clients, terminal surfaces, clocks, filesystem access, and user interaction should be injectable or otherwise testable;
- flow progress should be visible as events that can feed terminals, logs, tests, and other listeners.

## Covered Behavior

The CSP covers the whole library surface:

- core LLM client operations, messages, responses, streaming helpers, structured output, retry, rate limiting, conversation threads, context windows, and agent sessions;
- provider adapters for API services, local model servers, CLI coding agents, deterministic mocks, and the connector registry;
- JSON tool schema, tool registry, tool execution loop, provider-specific tool declaration mapping, and workspace-safe built-in tools;
- flow orchestration: plans, tasks, review loops, chat state, stages, events, persistence, usage-limit recovery, approvals, interaction, MCP bridging, Git, GitHub, and Azure DevOps facades;
- runner behavior: script and embedded entrypoints, connector presets, environment configuration, terminal rendering, log handling, live CLI process execution, and example workflow semantics.

## Deep Modules

The CSP is organized around these deep modules:

1. LLM core and streaming client.
2. Connector registry and provider adapters.
3. Tool-calling and workspace tools.
4. Observability and cost reporting.
5. Agentic flow engine.
6. External development tools: Git, GitHub, and Azure DevOps.
7. Runner and terminal UX.
8. Example workflow contracts.

## Files In This Pack

- `00-overview.md`: purpose, scope, module summary, and handoff rules.
- `01-architecture.md`: deep modules, boundaries, and data flow.
- `02-public-api.md`: public shapes and operation signatures in neutral pseudo-notation.
- `03-behaviors.md`: required behavior, state transitions, and invariants.
- `04-domain-glossary.md`: terms and rename policy.
- `05-effects-and-errors.md`: required effects, typed errors, retry and cancellation behavior.
- `06-data-model.md`: entities, relationships, and serialized data shapes.
- `07-test-contracts.md`: black-box acceptance scenarios derived from observed tests.
- `08-non-functionals.md`: reliability, security, performance, and UX constraints.
- `09-out-of-scope.md`: what the Rust build team must not recreate from the source.

## Handoff Rule

The Rust build team should work only from this CSP. They should not inspect the original source repository, its tests, its generated build artifacts, or its private implementation notes.

This pack reduces contamination risk, but it is not legal advice. A formal clean-room program also needs documented team isolation, audit logs of who saw what, and review by qualified counsel.
