# Domain Glossary And Rename Policy

## Rename Policy

The original project name and source-language-specific terms are not part of this CSP. The CSP uses neutral terms that a Rust build team can implement without seeing the source.

| CSP Term | Meaning | Rename Note |
| --- | --- | --- |
| Rust LLM Flow Library | The target Rust implementation described by this pack. | Replaces the source project's branded library name. |
| LLM client | Backend-neutral interface for prompting, streaming, tool-calling, and structured output. | Neutral replacement for source-specific service naming. |
| Connector | A concrete backend adapter implementing the LLM client contract. | Generic and kept. |
| Provider | External LLM backend or local model backend. | Generic and kept. |
| Flow | A user-authored async workflow over a flow context. | Generic and kept. |
| Plan | Ordered work list with epic id and tasks. | Generic and kept. |
| Task | A single unit of work in a plan. | Generic and kept. |
| Coder | LLM backend permitted to edit the target repository. | Generic role name. |
| Reasoning backend | LLM backend used for planning, review, and structured judgments. | Neutral role name. |
| Reviewer | A review lens that produces structured findings from a diff. | Generic and kept. |
| Runtime-owned Git | Rule that the flow runtime, not the coding agent, performs branch/commit/push operations. | Neutralized from source wording. |
| Usage limit | Provider quota or capacity exhaustion that can be waited out. | Generic and kept. |
| MCP bridge | JSON-RPC bridge that exposes user interaction and approval tools to a CLI agent. | MCP is an external protocol term and is kept. |
| Workspace tool | Tool constrained to a configured filesystem root. | Generic and kept. |

## External Names Kept

External provider and tool names are kept only where they select a real integration or protocol:

- OpenAI, Anthropic, Gemini, LM Studio, Ollama, OpenCode, Claude, Codex, Copilot, Pi.
- Git, GitHub, GitHub CLI, Azure DevOps, Azure Boards, Azure Repos.
- MCP and JSON-RPC.

These names are not source implementation identifiers; they are interoperability surfaces.

## Neutral Environment Names

The source uses a project-branded environment prefix. The CSP uses neutral names for behavior:

| Neutral Name | Behavior |
| --- | --- |
| `LLM_FLOW_CODER` | Selects the default CLI coder backend. |
| `LLM_FLOW_RETRIES` | Sets transient retry count; zero means fail fast. |
| `LLM_FLOW_USAGE_WAIT` | Enables/disables waiting for usage caps and may set max wait. |
| `LLM_FLOW_FORMAT` | Optional formatter command for review loops. |
| `LLM_FLOW_LINT` | Optional lint/build command for review loops. |
| `LLM_FLOW_AZURE_DEVOPS_*` | Local overrides for Azure DevOps organization URL, project, repository, and token. |

A product owner may choose target-branded aliases for these names. The behavior, not the original prefix, is the contract.

## Core Terms

- API connector: connector that calls an HTTP API or local HTTP-compatible model server.
- CLI connector: connector that drives a local command-line coding agent.
- Availability: health state of a connector: healthy, degraded, unhealthy, or unknown.
- Auth status: whether connector credentials appear valid, missing, invalid, or unknown.
- Token usage: prompt token count, completion token count, total token count, and optional cached token count.
- Chunk: incremental streamed response item, optionally carrying finish reason, token usage, and metadata.
- Structured output: typed decoding of model output against a JSON schema or equivalent schema description.
- Tool call: model request to execute a named tool with serialized arguments.
- Tool result: tool execution outcome, either JSON data or an error message.
- Tool sandbox: declared permission scope for a tool: workspace read/write, workspace read-only, or unrestricted.

## Flow Terms

- Epic id: stable short identifier for the overall plan, commonly used as a branch name.
- Brief: optional context text prepended to each task prompt.
- Stage: named unit of flow work that emits started/completed/failed events.
- Review issue: one structured finding with severity, title, description, optional file/line/suggestion, and confidence.
- Review result: list of findings plus optional summary; empty finding list means clean.
- Lint gate: non-LLM review step that can short-circuit LLM reviewers when it fails.
- Formatter step: optional best-effort command that runs before review rounds and does not fail the flow.
- Flow context: bundle of reasoning backend, coder backend, Git/GitHub tools, event sink, extra reviewers, capabilities, prompt, and work directory.
- Interaction: capability for asking a human a question during a flow.
- Approval policy: capability for approving or denying agent tool calls.

## External Tool Terms

- Recoverable outcome: expected result returned as data, such as branch already exists or nothing to commit.
- Process failure: unexpected failure to launch or run an external command, represented as a typed flow error.
- Pull request summary: generated title and body derived from a diff plus optional context.
- Build outcome: success, failure, pending, or timed out state for PR checks.
- Work item: Azure DevOps card with title, description, acceptance criteria, state, and tags.
- Acceptance criteria: human-editable spec field used as the contract in Azure DevOps flows.

## Observability Terms

- Request labels: provider, model, optional agent name, run id, and workflow step.
- Provider health summary: request count, success rate, average latency, p95 latency, and estimated cost for one provider.
- Trace span: timed operation record with correlation id, parent span id, attributes, status, and optional error message.
- Cost estimate: non-authoritative calculation from token usage and a pricing table. It must be visibly presented as an estimate.
