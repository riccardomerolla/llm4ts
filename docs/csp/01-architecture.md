# Architecture

## System Shape

The system is an async library plus a runner. A flow author supplies a user request and a flow body. The runner builds a context containing a reasoning backend, a coding backend, version-control tools, issue-system tools, and an event sink. The flow body composes these capabilities to create a plan, execute tasks, review changes, persist progress, and optionally publish a pull request.

The main architectural rule is role separation:

- reasoning connectors are used for planning, review, structured output, and summarization;
- coder connectors are used to edit the working tree or run an interactive agent;
- Git and issue-system side effects are performed by the runtime tools, not by the coding agent, unless the caller explicitly opts out.

## Suggested Rust Crate Boundaries

The build team may choose exact crate names, but the behavior should fit these boundaries:

- `core`: LLM client trait, messages, chunks, responses, connector config, typed LLM errors, streaming helpers, context windows, conversations, retry, rate limiting, and agent session contracts.
- `providers`: API and CLI connector implementations, HTTP client abstraction, CLI process executor abstraction, usage-limit classifier, and connector registry factories.
- `tools`: tool metadata, JSON schema, registry, validation, execution loop, provider mapping, and workspace-safe built-in tools.
- `observability`: counters, metrics snapshots, traces, structured logs, metered client wrapper, optional external trace sink.
- `flow`: plans, task loops, planner contracts, chat, stages, events, review loops, retry/wait policies, Git/GitHub/Azure DevOps facades, interaction, approval, and MCP protocol handler.
- `runner`: script-style entrypoint, embedded run entrypoint, connector presets, terminal rendering, log files, live process executor, MCP HTTP binding, and example workflows.

## Deep Module Responsibilities

### LLM Core

Owns backend-neutral contracts. It does not know about concrete HTTP endpoints, CLI commands, terminal rendering, Git, or issue trackers. It defines:

- prompt and conversation messages;
- streamed chunks and collected responses;
- tool-call response shape;
- structured-output operation;
- health and capability reporting;
- typed errors;
- retry and rate-limit utilities;
- conversation thread and prompt-template storage contracts;
- long-lived agent session events.

### Provider Adapters

Translate external backends into the core LLM contract. They normalize provider-specific response formats into common chunks, token usage, metadata, tool calls, and errors. API adapters use an HTTP client abstraction. CLI adapters use a process executor abstraction and feed large prompts through standard input when necessary.

### Tool Calling

Owns tool metadata and execution. It validates tool arguments against JSON object schemas, runs registered tools, records either JSON results or string errors, and repeatedly asks the LLM for additional tool calls until a final answer or iteration limit is reached.

### Observability

Decorates LLM operations and flow events. It must not change the result of the underlying operation except for preserving the same errors. It records counters, token totals, latencies, estimated costs, provider health summaries, trace spans, and structured log events.

### Flow Engine

Owns the software-development workflow model. It treats LLM failures, process failures, persistence failures, and deliberate aborts as typed flow errors. It emits progress events. It persists plans after each completed task so a later run resumes from the first incomplete task.

### External Development Tools

Git, GitHub, and Azure DevOps integrations are thin facades around external services. Recoverable outcomes are returned as typed values. Unexpected launch failures, parse failures, or external command failures become typed flow errors.

### Runner UX

Owns process entry behavior, prompt resolution, connector construction, terminal output, logging, and shutdown behavior. It should be the only layer that performs top-level runtime execution for script use. Embedded applications should receive an ordinary async effect/future they can compose.

## Data Flow

1. Runner resolves a prompt from CLI args or a default.
2. Runner selects a coder connector and a reasoning connector; absent explicit reasoning, it derives a read-only reasoning configuration from the coder configuration.
3. Runner builds the flow context, wraps connectors with retry/event/cost behavior, and starts terminal/log consumers.
4. Flow creates or recovers a plan.
5. Each incomplete task is executed in order.
6. The coder edits or proposes changes while the runtime remains responsible for Git operations.
7. Reviewers inspect the current diff; if findings remain, the coder is asked to fix them and the diff is reviewed again.
8. Progress is persisted after each completed task.
9. Optional push and PR operations publish the result.
10. Terminal and log consumers drain final events, render a failure banner if needed, and show usage/cost summary.

## Boundary Guarantees

- Core APIs do not depend on flow-layer types.
- Provider adapters do not own flow orchestration.
- Flow code depends on the LLM client trait, not on a concrete provider implementation.
- Terminal rendering consumes flow events; it must not be required for headless tests.
- Process and HTTP execution are replaceable by test doubles.
- Plan persistence is plain-file based and contains no database dependency.
