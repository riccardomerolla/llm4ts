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

- `@llm4ts/flow/Flow`: the flow spine — `implementPlanFlow` recovers or creates
  a plan, checks out the epic branch, and runs the per-task coder + review +
  commit loop; `completeAndPublish` streams one prompt and publishes the
  response as an assistant message. See the
  [flow authoring guide](flow-authoring.md) for the rung-by-rung walkthrough.
  `ImplementPlanOptions.chatPerTask` opts into per-task chat isolation:
  - What it does: when `true`, each task gets a fresh `Chat` seeded with the
    system prompt plus the plan's current render (showing prior tasks'
    completion status), instead of one `Chat` shared across the whole plan.
  - Review-fix rounds: a task's review-fix rounds always share that task's
    `Chat` — isolation is between tasks, not within a task's fix loop.
  - Default: `false`/omitted, which preserves the original single-shared-
    `Chat` behavior.
  - When to use: long-running, dogfood-style plans where an ever-growing
    shared transcript would otherwise degrade context quality across many
    tasks.
- `@llm4ts/flow/FlowContext` and `FlowEvents`: workflow dependencies and event
  protocol.
- `@llm4ts/flow/Chat`: atomic, serialized conversation history for coding
  agents.
- `@llm4ts/flow/Plan`, `Planner`, `PlanExecution`, and `Persistence`: structured
  planning and resumable work.
- `@llm4ts/flow/Workspace*`: contained filesystem access and workspace tools.
- `@llm4ts/flow/GitTool`, `GitHubTool`, and `AzureDevOpsTool`: audited repository
  and forge boundaries. `GitTool.diffVsBaseScoped(base, paths)` is the
  path-scoped diff primitive: empty paths yield `""` (never the whole diff),
  and the capability guard runs either way.
- `@llm4ts/flow/Context`: context budgeting for LLM prompts, in characters
  (deterministic, no tokenizer). `cap(text, limit)` never returns more than
  `limit` chars (marker included; head ¾, tail ¼); `capped(label, text, limit)`
  additionally publishes a `FlowEvent` and records the truncation;
  `withShrink(label, f)` runs `f` at the budget and retries prompt-too-large
  failures at ½ then ¼ before failing with a message naming
  `LLM4TS_CONTEXT_BUDGET` (`LLM4TS_JUDGE_SOURCES_LIMIT` is the deprecated
  alias; default 400_000). `truncations` reads back what this run shortened —
  flows append it to `provenance.json` — and `isolateTruncations` scopes a
  private log.
- `@llm4ts/flow/ProgramJudge`: per-program spec-compliance judging.
  `groupFiles` partitions changed files by the pack's per-program regex;
  `judgeAllPrograms` judges each program against only its slice of the diff
  (cached per program, resumable), judges the unassigned remainder once, and
  reports every spec'd program with no matching changed file as a Critical
  finding.
- `@llm4ts/flow/Reviewer`, `Pack`, `Review`, `SpecChecks`, and `Survey`:
  file-scoped review lenses, bounded review/fix loops, and discovery.
  `Pack.programFiles`/`filesFor(program)` locate a program's implementation
  files; `Survey.closureFor(graph, program, maxFiles)` resolves the bounded
  breadth-first include closure extract hands its analysts.
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
