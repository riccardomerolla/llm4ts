# Test Contracts

These scenarios are black-box contracts. They intentionally do not preserve source test names, source assertion wording, or framework structure.

## Core LLM And Streaming

Scenario: collect streamed text and metadata.
Given a stream with multiple chunks, usage on the final chunk, and metadata on chunks.
When the stream is collected.
Then response content is the ordered concatenation of deltas, usage is preserved from the latest chunk that supplies it, and metadata maps are merged.

Scenario: collect an empty stream.
Given a stream with no chunks.
When the stream is collected.
Then content is empty, usage is absent, and metadata is empty.

Scenario: progress tracking reports token progress.
Given a stream of text chunks and a progress callback.
When chunks pass through tracking.
Then each output chunk is preserved and progress reports increasing token count, elapsed time, and throughput.

Scenario: stream timeout.
Given a stream that emits no item before a configured timeout.
When timeout wrapper is applied.
Then the stream fails with a typed timeout error.

Scenario: cancellation.
Given a cancellable stream.
When the cancel action is invoked.
Then later stream items are interrupted.

Scenario: fallback stream.
Given a primary stream that fails and a fallback stream.
When fallback wrapper is applied.
Then the fallback stream supplies the result. If primary succeeds, fallback is not used.

Scenario: SSE roundtrip.
Given chunks converted to server-sent event text.
When the text is parsed back.
Then the original chunk data is recovered and terminal done markers are ignored.

Scenario: partial JSON parsing.
Given a text stream that cumulatively forms a complete JSON object.
When partial JSON parser runs.
Then it emits the decoded value once enough text has arrived.

## Structured Output

Scenario: direct JSON structured output.
Given model output that is a valid JSON object matching the target type.
When structured parsing runs.
Then the typed value is returned.

Scenario: JSON embedded in text.
Given model output containing explanatory text and a fenced JSON object.
When structured parsing runs.
Then the JSON object is extracted and decoded.

Scenario: JSON after command-line preamble.
Given model output with non-JSON preamble followed by a JSON object.
When structured parsing runs.
Then the JSON object is found and decoded.

Scenario: parse failure reports the relevant candidate.
Given model output with JSON-looking text that does not match the expected shape.
When structured parsing fails.
Then the error category is parse failure and includes the raw output for diagnostics.

Scenario: schema hint policy.
Given an empty or unconstraining schema.
When a prompt hint is prepared.
Then the prompt is unchanged. Given a meaningful schema, the prompt includes instructions to return matching JSON.

## Connectors And Providers

Scenario: connector registry resolution.
Given a registry with known connector factories.
When a known connector config is resolved.
Then the matching connector is returned. When an unknown id is resolved, a configuration error is returned.

Scenario: connector kind checks.
Given API and CLI configs.
When resolving through API-only or CLI-only functions.
Then kind mismatches fail with configuration errors.

Scenario: health checks.
Given a connector whose backend probe succeeds.
When health is checked.
Then availability is healthy and auth is valid or unknown according to backend capability. Given a failing probe, availability is unhealthy or unknown without throwing.

Scenario: hosted API missing credentials.
Given a hosted API connector without an API key.
When an operation requiring auth is executed.
Then it fails with authentication error.

Scenario: missing base URL.
Given an API connector with no base URL and no default available.
When a request is attempted.
Then it fails with configuration error.

Scenario: OpenAI-compatible success.
Given an OpenAI-compatible JSON response with choices, content, model/id metadata, and token usage.
When a non-streaming request completes.
Then the connector returns content, usage, and metadata.

Scenario: OpenAI-compatible SSE.
Given SSE payload lines with chat deltas.
When streaming executes.
Then non-empty deltas become chunks and terminal markers are ignored.

Scenario: tool-call normalization for hosted providers.
Given provider-specific tool-call response blocks.
When `executeWithTools` returns.
Then tool calls are normalized into id, name, JSON arguments, optional content, and finish reason.

Scenario: Gemini API safety/empty response.
Given a Gemini API response without usable text content.
When content extraction runs.
Then a parse error explains that no text candidate was available.

Scenario: local model server without cloud key.
Given a local model connector whose backend does not require an API key.
When a prompt succeeds.
Then the connector returns content without requiring a key. If a key is supplied, it may be passed as an authorization header.

Scenario: unsupported tool calling.
Given a backend whose contract does not support native tool calling.
When `executeWithTools` is called.
Then it fails with invalid request, not provider crash.

Scenario: CLI prompt via standard input.
Given a CLI connector and a large prompt.
When completion or streaming completion is invoked.
Then prompt text is fed through standard input where supported and is not placed in argv.

Scenario: CLI JSONL normalization.
Given CLI event lines for assistant text, command/tool use, usage, and failure.
When stream parsing runs.
Then text becomes delta chunks, tool events become metadata chunks, usage becomes terminal usage chunks, and errors become typed provider or usage-limit errors.

Scenario: read-only overrides edit flags.
Given edit-capable CLI config with read-only enabled.
When argv is built.
Then read-only flags override edit-capable flags for that backend.

Scenario: connector capabilities.
Given supported connectors.
When capabilities are inspected.
Then Claude-style CLI declares interactive, ask-user, approval, and resumable session support; Gemini/Codex/Pi-style CLIs declare interactive support without ask-user/approval; continuation-only CLIs declare no interactive sessions; API connectors declare streaming, structured output, and usage reporting without interactive capabilities.

Scenario: usage-limit classification.
Given provider messages with a reset wall-clock time.
When classified.
Then usage-limit error contains reset instant, rolling to the next day if the time has passed. Given short reset durations, rate-limit errors contain retry duration. Given quota/capacity messages without reset time, usage-limit error contains no reset instant. Given ambiguous generic text, classifier returns no usage-limit classification.

Scenario: HTTP status mapping.
Given generic HTTP requests.
When response status is 2xx.
Then the body is returned. When status is auth failure, rate limit, client error, or server error, the corresponding typed error is returned.

Scenario: slow local backend.
Given a live HTTP client config.
When no response bytes arrive for longer than a default idle period but before the request timeout.
Then the client should not close the connection for idleness alone.

## Tools And Workspace Safety

Scenario: register and list tools.
Given distinct tools.
When they are registered and listed.
Then lookup succeeds and listing is sorted deterministically.

Scenario: duplicate tool name.
Given an existing tool name.
When another tool with the same name is registered.
Then registration fails and the original registry remains valid.

Scenario: argument validation.
Given a tool schema with required and typed fields.
When arguments omit a required field or use the wrong JSON kind.
Then validation fails before execution.

Scenario: tool execution result.
Given a valid tool call.
When execution succeeds.
Then a tool result contains the call id and JSON output. When the tool body fails, the result carries a string error.

Scenario: prompt-based tool selection.
Given tools with names, descriptions, and tags.
When a prompt overlaps those words.
Then positive-scoring tools are returned in score order up to the limit.

Scenario: tool loop.
Given an LLM that first requests a tool and later returns final text.
When the tool loop runs.
Then the tool executes, its result is fed back, and final response contains final text and iteration metadata.

Scenario: workspace path escape.
Given a workspace root.
When a file tool receives a path that normalizes outside the root.
Then the tool fails with sandbox violation.

Scenario: bounded file operations.
Given configured read/write byte limits.
When a file or content exceeds the limit.
Then the operation fails with invalid parameters.

## Conversation And Context

Scenario: conversation thread roundtrip.
Given a thread with messages and metadata.
When exported to JSON and imported back.
Then the thread is equivalent.

Scenario: thread fork.
Given an existing thread.
When it is forked.
Then the new thread has a new id, parent id set to the original, preserved messages, cleared checkpoints, in-progress state, and updated timestamps.

Scenario: prompt template lifecycle.
Given versioned prompt templates.
When registered, resolved, rendered, composed, rolled back, and listed.
Then duplicate versions are rejected, latest active version resolves by default, variables render, composition joins parts, rollback activates the chosen version, and listing is ordered.

Scenario: deterministic variant.
Given a template name, variant names, and a key.
When variant choice is requested repeatedly.
Then the same variant reference is returned.

Scenario: context FIFO trimming.
Given messages exceeding token budget.
When FIFO strategy is applied.
Then the most recent messages that fit are retained.

Scenario: context sliding window.
Given system and non-system messages exceeding budget.
When sliding-window strategy is applied.
Then system messages are preserved first and recent non-system messages fit the remaining budget.

Scenario: priority trimming.
Given messages with system/tool/important markers.
When priority strategy is applied.
Then higher-priority messages are preferred and final output remains chronological.

Scenario: summarization strategy.
Given older and recent messages exceeding budget.
When summarization strategy applies.
Then older messages are replaced by an important summary and the result fits budget.

Scenario: clarification retry.
Given a parser that rejects the first model answer and accepts a later answer.
When clarification execution runs.
Then the LLM is asked again up to the attempt cap and the accepted value is returned.

## Flow Planning And Persistence

Scenario: plan roundtrip.
Given a plan with mixed completion state and optional brief.
When rendered and parsed.
Then epic id, tasks, completion flags, descriptions, and brief are preserved.

Scenario: next incomplete task.
Given a plan with some completed tasks.
When next incomplete is requested.
Then the first incomplete task is returned, or none if all are complete.

Scenario: complete task.
Given a plan and a task title.
When completion is applied.
Then matching tasks are marked complete and the result roundtrips through persistence.

Scenario: deterministic plan path.
Given the same prompt and state directory.
When the default path is computed twice.
Then the same path is returned under the hidden state directory.

Scenario: save/load/delete.
Given a plan and path.
When saved then loaded.
Then the loaded plan matches. Loading an absent path returns none. Deleting an absent path succeeds.

Scenario: recover existing plan.
Given an existing persisted plan and a creation function.
When recover-or-create is called.
Then the existing plan is returned and the creation function is not run.

Scenario: create absent plan.
Given no persisted plan.
When recover-or-create is called.
Then the creation function runs, the result is saved, and the plan is returned.

Scenario: planner success and failure.
Given a reasoning backend returning structured plan data.
When planning runs.
Then that plan is returned. Given an LLM or parse failure, the error is wrapped as a flow LLM error.

Scenario: assessment verdicts.
Given a reasoning backend returning proceed or blocked verdict.
When assessment planning runs.
Then the matching verdict is returned.

Scenario: plan review and brief.
Given a draft plan with an existing brief.
When reviewed.
Then the improved plan preserves the brief. Given a generated brief, briefed planning stores it and task prompts include it.

Scenario: interactive planning.
Given a planner that asks a question before proposing.
When interaction supplies an answer.
Then the final plan is returned. If no proposal arrives before max turns, planning aborts.

Scenario: triage decoding.
Given structured bug-triage output.
When decoded.
Then testable, untestable, and not-a-bug verdicts are represented with their branch-specific fields.

## Flow Execution And Review

Scenario: task loop happy path.
Given a plan with incomplete tasks.
When every task action succeeds.
Then tasks run in order, each completed task is persisted, and final plan is complete.

Scenario: task loop failure.
Given a task action fails after earlier tasks succeeded.
When the loop runs.
Then the loop stops, the error is returned, and completed-so-far progress remains persisted.

Scenario: resumable rerun.
Given a persisted plan with completed tasks.
When execution is run again.
Then completed tasks are skipped and execution resumes at the first incomplete task.

Scenario: stage events.
Given a successful staged body.
When it runs.
Then start and completion events are emitted and the body value is returned. Given a failing body, start and failure events are emitted and the original error is preserved.

Scenario: abort.
Given a flow abort request.
When it runs.
Then an abort event is published and an aborted flow error is returned.

Scenario: chat history.
Given a chat with previous turns.
When a new prompt is asked.
Then the backend receives accumulated history and both user and assistant turns are recorded.

Scenario: review loop clean after fix.
Given reviewers that first return findings and then clean.
When review-and-fix loop runs.
Then the coder receives a fix prompt once and the loop returns clean.

Scenario: review max rounds.
Given reviewers that never return clean.
When max rounds is reached.
Then the final dirty result is returned and no extra fixes occur beyond the round limit.

Scenario: lint short-circuit.
Given a lint gate that returns findings.
When review round starts.
Then LLM reviewers are skipped for that round and lint findings drive the fix.

Scenario: file-scoped reviewers.
Given changed files and reviewer scopes.
When selection runs.
Then reviewers whose scope misses the changed files are not invoked; an empty file list keeps scoped reviewers eligible.

Scenario: selector fallback.
Given a model-driven selector that fails or chooses none.
When selecting reviewers.
Then all file-matching reviewers are used.

Scenario: formatter best effort.
Given a formatter command that succeeds, fails, or is missing.
When formatter step runs.
Then success is reported, failures are surfaced as info events, and the step never fails the flow.

Scenario: transient retry.
Given a transient coder stream failure followed by success.
When retry wrapper is enabled.
Then the call is retried with visible retry notices and the task completes. Given persistent transient failure, retries are exhausted. Given zero retries, it fails fast.

Scenario: usage-limit reentry.
Given a flow that first fails with a usage cap and later succeeds.
When usage-limit retry is enabled.
Then the runner sleeps, re-enters the flow, and returns success within caps.

## External Development Tools

Scenario: Git branch creation.
Given a repository.
When a branch is created twice.
Then first result is created and second result is already-exists.

Scenario: Git commit-all.
Given a repository with changes.
When commit-all runs.
Then changes are committed. When run again on a clean tree, result is nothing-to-commit.

Scenario: Git diffs.
Given tracked and untracked changes.
When tracked diff runs.
Then only tracked changes are visible. When all diff runs, untracked files are included and later commit-all still succeeds.

Scenario: Git base diff.
Given a branch with changes relative to base.
When diff-vs-base and changed-files-vs-base run.
Then the branch delta and changed file names are returned.

Scenario: Git default base fallback.
Given no remote default branch.
When default base is requested.
Then a local mainline fallback is returned.

Scenario: GitHub PR and issue parsing.
Given PR URLs and issue JSON from the GitHub CLI.
When parsed.
Then owner, repo, number, title, body, and author are extracted.

Scenario: GitHub check status.
Given check command exit statuses.
When mapped.
Then success, pending, and failure outcomes are returned according to exit status; wait polls pending until terminal or timeout.

Scenario: Azure DevOps requests.
Given work item, WIQL, field update, comment, PR create, thread, and link inputs.
When request builders run.
Then method, URL, content type, auth header, and body shape match the Azure DevOps REST contract.

Scenario: Azure DevOps parsing.
Given work-item, WIQL, or PR JSON.
When parsed.
Then work item fields/tags, ids, repository id, project id, and PR URL are extracted.

## Runner And Terminal

Scenario: prompt resolution.
Given CLI args and optional default prompt.
When resolving prompt.
Then the first non-blank arg wins, else default wins, else a usage error is returned.

Scenario: script without prompt.
Given no prompt and no default.
When script starts.
Then it fails with usage before building connectors.

Scenario: reasoning default.
Given a coder config and no explicit reasoning config.
When script config is built.
Then reasoning is the coder config with read-only enabled.

Scenario: event rendering.
Given each flow event type.
When rendered in plain mode.
Then stage, failure, info, tool, and assistant lines are readable, token events render no inline line, and multi-line assistant text keeps internal line breaks.

Scenario: terminal sanitization.
Given text containing terminal control sequences.
When rendered.
Then cursor movement, screen clearing, title setting, and disallowed control bytes are removed while ordinary text, tabs, and newlines remain.

Scenario: drain on failure.
Given a final failure event published just before shutdown.
When the listener drains.
Then the failure line is rendered before teardown.

Scenario: process executor.
Given a valid command.
When run executes.
Then stdout lines and exit code are captured. Given a missing command, the effect fails. Given bidirectional mode, queued stdin lines appear in stdout stream.

Scenario: MCP protocol handler.
Given initialize, tools/list, tools/call, notification, unknown method, unknown tool, and failing tool requests.
When handled.
Then responses follow JSON-RPC semantics, notifications produce no response, unknown method/tool return protocol errors, and failing tools return an error result rather than failing the transport effect.

Scenario: MCP HTTP binding.
Given an HTTP POST to the MCP endpoint with a valid tool call.
When served over a real socket.
Then the JSON-RPC response contains the tool's text result. Invalid JSON returns parse error. Unsupported GET returns method-not-allowed.

Scenario: connector env selection.
Given neutral coder environment values.
When selecting default coder.
Then known values select their backend and missing/unknown values choose the primary CLI coder.

Scenario: usage/cost summary.
Given token events for agents and models.
When cost tracker summarizes.
Then usage totals are grouped by agent and model, cached tokens are included when present, unknown model has no cost, and known model costs are estimates.

Scenario: end-to-end example flow.
Given a repository, a plan with tasks, a deterministic coder, and a local remote.
When the example workflow runs.
Then it creates a branch, processes each task, persists task outputs, commits per task, pushes the branch, and returns a completed plan.
