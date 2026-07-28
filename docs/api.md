# API Guide

The packages expose explicit subpaths. The package manifests are the canonical
export list; the following modules are the main entry points.

## Core

- `@llm4ts/core/Models`: messages, chunks, responses, usage, configuration,
  connector identifiers, health.
- `@llm4ts/core/LlmService`: backend-neutral LLM service.
- `@llm4ts/core/ConnectorConfig` and `ConnectorRegistry`: connector selection.
- `@llm4ts/core/providers/*`: API and CLI connector implementations.
- `@llm4ts/core/Streaming`: collection, progress, timeout, buffering, fallback,
  and SSE helpers.
- `@llm4ts/core/tools/*`: tool declarations, registry, and bounded tool loop.
- `@llm4ts/core/eval/*`: checks, judges, evaluators, and suites.
- `@llm4ts/core/observability/*`: metrics, tracing, recording, logging,
  redaction.

## Flow

- `@llm4ts/flow/FlowContext` and `FlowEvents`: workflow dependencies and event
  protocol.
- `@llm4ts/flow/Chat`: atomic, serialized conversation history for coding
  agents.
- `@llm4ts/flow/Plan`, `Planner`, `PlanExecution`, and `Persistence`: structured
  planning and resumable work.
- `@llm4ts/flow/Workspace*`: contained filesystem access and workspace tools.
- `@llm4ts/flow/GitTool`, `GitHubTool`, and `AzureDevOpsTool`: audited repository
  and forge boundaries.
- `@llm4ts/flow/Reviewer`, `Pack`, `Review`, `SpecChecks`, and `Survey`:
  file-scoped review lenses, bounded review/fix loops, and discovery.
- `@llm4ts/flow/PrSummary`: structured pull-request titles and bodies.
- `@llm4ts/flow/Replay`, `Equiv`, and `EquivReport`: offline replay and
  behavioral proof.

## Runner

- `@llm4ts/runner/FlowRunner`: `runEmbedded`, `runNode`, and Node dependency
  presets.
- `@llm4ts/runner/Connectors`: API presets, source-compatible environment
  enrichment, immutable configuration transforms, and edit-capable CLI presets.
- `@llm4ts/runner/Cli`: command-line composition.
- `@llm4ts/runner/McpStdio`: JSON-RPC MCP stdio transport.

## Modernize

- `@llm4ts/modernize/Modernize`: six-phase state machine and approval
  composition.
- `@llm4ts/modernize/Model`: phase, checkpoint, outcome, and error schemas.
- `@llm4ts/modernize/Artifacts`: resumable per-program extraction and vector
  generation.
- `@llm4ts/modernize/Approval`: draft marker and human gate.

## JavaScript

`@llm4ts/js` and `@llm4ts/js/Client` export:

- `createClient(config)` and `mockClient()`;
- `LlmClient.complete(prompt, { signal? })`;
- `LlmClient.health({ signal? })`;
- stable completion, usage, health, and error values;
- `Llm4tsError.category` for exception-based branching.

The Effect packages preserve typed error channels. The JavaScript facade rejects
Promises with `Llm4tsError` because exceptions are its explicit compatibility
contract.
