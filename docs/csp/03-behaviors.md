# Behaviors

## LLM Core

- Streaming calls emit zero or more `LlmChunk` values. Concatenating chunk deltas produces the response content. Usage is usually absent until a terminal chunk.
- Collecting a stream returns content as the ordered concatenation of deltas, latest available token usage, and merged metadata.
- History-aware execution preserves message order and role information where the backend supports roles. CLI backends without native conversation support may flatten history into a text transcript, but the observable result must reflect all supplied turns.
- Structured output must parse valid JSON directly, from a fenced JSON block, or from a balanced JSON object embedded in surrounding text. If no candidate parses, the error must include the raw response and a parse failure category without exposing stack traces as the primary contract.
- A non-trivial schema hint may be appended for backends without native schema enforcement. Empty or unconstraining schemas should not alter the prompt.
- Tool-calling returns optional assistant content, zero or more tool calls, and a finish reason. Backend-specific tool-call responses must be normalized to the common `ToolCall` shape.
- Health checks return availability/auth/latency status and should not throw for ordinary unavailable backends.

## Provider Adapter Behavior

- API connectors require a base URL unless the runner can fill the provider default. API-key requirements follow the external backend: hosted providers require keys, local backends may not.
- API connectors map hosted HTTP failures into typed errors: authentication failures, rate limits, invalid requests, provider failures, parse errors, and timeouts.
- OpenAI-compatible endpoints use chat-completion style request/response semantics, including optional native JSON schema response format and optional tools where supported.
- Anthropic-style endpoints separate system prompt content from user/assistant messages, support text and tool-use response blocks, and expose token usage when returned.
- Gemini API endpoints use generate-content semantics, optional JSON schema response mode, streaming response chunks, and function-call tool declarations.
- Local model-server connectors must work without cloud credentials when the backend does not require them. Their availability checks target model-list or health endpoints, not generated content unless no lighter endpoint exists.
- Ollama-like connectors use generate/chat endpoints, support JSON-format structured output, and do not expose native tool calling in this contract.
- CLI connectors run in the configured working directory and pass large prompts through standard input when the backend supports it, to avoid command-line length limits.
- CLI connectors normalize backend JSONL events into text chunks, tool-use metadata chunks, terminal usage chunks, and provider errors.
- Claude-style CLI connector declares interactive sessions, ask-user support, approval support, and resumable session support.
- Gemini, Codex, and Pi-style CLI connectors declare interactive stdin support but not ask-user/approval unless a held-session integration explicitly provides it.
- Continuation-only CLIs declare no interactive session support.
- Read-only mode must override edit-capable flags: the backend should be configured so planning/review can inspect but not edit, commit, push, or switch branches.
- Usage-limit classification recognizes provider quota/capacity messages and wall-clock reset times when available. Ambiguous generic provider messages are not automatically classified as usage caps unless they contain quota/rate-limit evidence.
- The deterministic mock connector is always available, emits predictable streamed text with final usage, and returns simple structured JSON suitable for tests. Its canned demo data is not a required contract for the Rust port.

## HTTP Client

- `GET` and JSON `POST` return response bodies on success and typed errors on invalid URLs, authentication failures, rate limits, client errors, server errors, parse failures, and timeouts.
- Generic `send` supports arbitrary HTTP methods, optional request body, arbitrary content type, headers, and any 2xx response as success.
- Streaming helpers split line-oriented responses and SSE responses into payload lines, skipping empty data and terminal done markers.
- The live client used by the runner must not disconnect slow local backends merely because no bytes arrive for a while; the configured per-request timeout remains the intentional bound.

## Tools

- Tool registration rejects duplicate tool names.
- Tool lookup fails with a typed tool error when the name is absent.
- Tool selection scores registered tools by prompt overlap with tool name, tags, and description; only positive-scoring tools are returned, ordered by score and capped by the requested limit.
- Tool argument validation requires a JSON object, checks required fields, and checks basic JSON value kinds for declared properties.
- Tool execution returns `ToolResult` with either JSON success or string error. A failing tool should not crash the whole tool-loop transport; the failure is represented as data where possible.
- Provider mapping converts the neutral tool shape into the declaration format expected by OpenAI-compatible, Anthropic-style, or Gemini-style backends. Unsupported providers receive no tool declarations.
- The tool loop repeats LLM calls while tool calls are requested, feeds tool results back to the model, and stops with a final response when no more tool calls are requested or fails at the iteration cap.
- Workspace tools must reject paths that escape the configured root after normalization. File reads and writes are bounded by configured byte limits. Search and discovery are bounded by configured result limits.

## Conversations And Context

- Conversation messages can convert to and from core messages without losing role or content.
- System and tool messages are considered important by default when converted into conversation messages.
- Appending a message updates thread state and `updatedAt` to the message timestamp.
- Checkpoints record state, message count, creation time, and optional note.
- Forking a thread preserves history, sets the previous thread as parent, clears checkpoints, resets state to in-progress, and updates timestamps.
- JSON export/import roundtrips conversation threads.
- Prompt templates are registered by name and version. Duplicate name/version pairs are rejected. Resolving without an explicit version returns the latest active template, or latest version if none are active.
- Prompt rendering replaces named placeholders with provided values. Composition joins rendered templates with blank separation.
- Rolling back activates exactly the requested version for a template name and deactivates sibling versions.
- Variant selection is deterministic for a given template name and key.
- Context windows count or preserve message token counts, detect warning threshold, and trim only when total tokens exceed the configured maximum.
- FIFO trimming keeps the most recent messages that fit.
- Sliding-window trimming preserves system messages first and then keeps recent non-system messages within the remaining budget.
- Priority trimming prefers system, tool, important, and later messages, then returns selected messages in chronological order.
- Summarization trimming replaces older history with one important summary message when possible, then fits the result to budget.
- Clarification execution retries parse failures by asking for a corrected answer until the attempt cap is reached.

## Flow Engine

- A plan is an ordered set of tasks with an epic identifier and optional codebase brief.
- `nextIncomplete` returns the first task whose completion flag is false.
- Completing a task marks tasks with the matching title complete and leaves others unchanged.
- `taskPrompt` prepends a non-empty plan brief to the task description; without a brief it returns the description unchanged.
- Plan rendering and parsing roundtrip the library's own persisted format. Malformed documents return a parse error, not a partial plan.
- The default plan path is deterministic for the same prompt under a hidden state directory. The exact hash algorithm is not part of this CSP.
- Plan persistence creates parent directories on save. Loading an absent file returns `None`. Deleting an absent file succeeds.
- `recoverOrCreate` loads an existing plan without running the creation effect; otherwise it creates, saves, and returns the new plan.
- The task loop skips completed tasks, runs incomplete tasks in order, wraps each in a stage event, saves progress after each successful task, and stops at the first failure.
- A later run from the persisted plan resumes at the first incomplete task.
- `stage` emits started before running the body. It emits completed on success and failed on error while preserving the body result or error.
- `fail` publishes an abort event and returns an aborted flow error.
- Chat state appends a user turn before asking the backend, then appends the assistant response. LLM errors are wrapped in flow errors while retaining the typed cause where available.
- By default, chats seed coder sessions with a runtime-owned-Git instruction. An explicit manage-Git option omits that instruction.
- The review loop optionally runs a lint gate first. A failing lint gate becomes the review result for that round and skips LLM review for that round.
- Reviewer selection filters by changed-file scope when file information is known. If no file list is available, scoped reviewers remain eligible.
- Default reviewer selection runs every matching reviewer every round. A model-driven selector may choose a subset but must fall back to all matching reviewers if selection fails or yields none.
- Reviewer calls may run concurrently by default. A positive parallelism cap must throttle concurrent reviewer calls.
- Review results from multiple reviewers merge by concatenating findings and joining non-empty summaries.
- If review is clean or the maximum round is reached, the loop returns the final result. Otherwise, coder receives a fix request and the loop repeats against a fresh diff.
- Formatter steps are optional. Blank command means no-op. Formatter failures are reported as information events and do not fail the flow.
- Usage-limit aware calls wait until reset time plus a small buffer, or poll at the policy interval when no reset time is known, until the max wait is exceeded.
- Flow-level usage-limit retry re-enters the whole flow after sleeping and relies on plan persistence/session resumability to skip completed work.
- Transient retry retries timeouts, rate limits, provider failures that look transient, connection resets, and selected ambiguous provider failures. It does not retry invalid requests, parse errors, configuration errors, tool errors, or usage caps.

## Events And Terminal Output

- Flow events are publish-only from producers and consumed by listeners. A no-op sink is valid.
- A collecting sink records all events for tests.
- A hub broadcasts to subscribers and tracks total published events so shutdown can wait for consumers to drain.
- Token usage events are not rendered inline by the terminal listener; they feed cost summaries.
- Terminal rendering displays stage starts, completions, failures, aborts, info lines, tool uses, and assistant messages in a nested tree.
- Stage start opens a child indentation level. Stage completion, failure, and abort close one level before rendering.
- Assistant multi-line text preserves internal line breaks after sanitization and trims only at the ends.
- Terminal output must sanitize untrusted backend text by removing terminal control sequences while preserving ordinary text, tabs, and newlines.
- Color and animation are disabled when color is disabled or stdout is not a terminal. Plain output remains readable.
- The live terminal surface pins a status line for the active stage and serializes writes so animation and log lines do not interleave.
- The runner tees rendered tree lines to a file log after stripping color/style escapes.

## Git Behavior

- All Git operations run in the configured work directory and should be non-interactive. Credential prompts and SSH passphrase prompts must fail fast rather than blocking a headless run.
- Branch creation returns `Created` or `AlreadyExists` as data. Only unexpected Git failures are flow errors.
- Commit-all stages every file and returns `Committed` or `NothingToCommit` as data.
- `diff` shows tracked working-tree changes. `diffAll` must include untracked files by making them visible to the diff mechanism; later commit-all must still commit cleanly.
- Default base resolution prefers the remote default branch if known, then common mainline branch names, then a local fallback.
- Base diff supports merge-base style comparison by default and direct comparison when requested.
- Changed-files returns trimmed non-empty path strings.
- Push sets upstream and, for GitHub-hosted remotes, may append a fallback credential helper that uses environment tokens or the GitHub CLI. Token values must never be inlined into arguments or logs.

## GitHub Behavior

- Issue references parse from `owner/repository#number` text. Invalid text returns no reference.
- PR creation parses a pull-request URL from the CLI output and fails if none can be found.
- Issue reads are idempotent and retry transient read failures with bounded backoff.
- PR update uses a REST update path rather than a higher-level edit command that may depend on unrelated deprecated GitHub metadata.
- PR check exit codes map to success, pending, or failure. Waiting for build polls pending checks until a terminal state or timeout.

## Azure DevOps Behavior

- Configuration is built from pipeline environment variables, with local override variables available. Missing required values are reported clearly.
- Work-item reads return id, title, description, acceptance criteria, state, and tags.
- Field updates use JSON Patch set-or-replace operations.
- Acceptance criteria is the human-editable spec field for Azure DevOps flows.
- Adding a tag reads current tags, appends the new tag, removes duplicates, and writes the combined tag field.
- PR creation returns pull-request id, repository id, project id, and web URL.
- Linking a PR to a work item adds a development relation pointing to the PR artifact.

## Runner Behavior

- Script prompt resolution uses the first non-blank CLI argument, then the configured default prompt, otherwise a usage error.
- Missing prompt exits with the usage error before connectors are built.
- If no explicit reasoning connector is provided, the runner derives one from the coder configuration with read-only behavior enabled.
- Connector preparation fills API base URL from provider defaults and API keys from the environment when the caller left them unset. CLI connectors are rooted in the flow work directory.
- Runner builds an event hub, wraps connectors with transient retry, event tapping, and optional usage-limit waiting, then consumes events with terminal and cost listeners.
- On flow failure, the terminal drains trailing events, renders one final failure line, writes full diagnostic details to the file log, and exits with failure status.
- On interrupt, the running flow is interrupted and stage finalizers/events are allowed to unwind.
- Retry environment parsing uses a default retry count for unset/blank/invalid values, zero for fail-fast, and non-negative numeric values as explicit retry count.
- Usage-wait environment parsing disables waiting for unset/off/false, enables default patient waiting for on/true/unrecognized values, and accepts hour/minute caps.

## Example Workflow Behavior

- Implement workflow: create or recover a plan, create/check out a branch, start coder chat, run each incomplete task, review/fix if configured, commit per task, and optionally push/open a PR.
- Interactive implement workflow: same as implement but planner may ask clarifying questions before producing a plan.
- Enhanced implement workflow: planner can self-review the plan and attach a codebase brief before coding begins.
- Live implement workflow: each task opens a held interactive agent session that can stream events, ask the user questions, and request approvals through MCP.
- Issue-to-PR workflow: read an issue, assess whether it is actionable, create a branch, implement and review, push, and open or update a PR.
- Bugfix workflow: triage a bug report, require a failing test path for testable bugs, demonstrate red/green behavior, then publish the fix.
- Spec-driven workflow: write or read a spec, create tests first, implement against the spec, and verify through configured build/test commands.
- Local workflow: use a local model server for reasoning and a local or CLI coder, with no cloud key requirement.
- Azure DevOps workflow: use board states to draft acceptance criteria, wait for human review, implement approved work, create/link a PR, and update work-item state.
