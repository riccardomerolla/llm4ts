# Data Model

## LLM Core Model

```text
MessageRole = System | User | Assistant | Tool
Message(role, content)

TokenUsage(prompt, completion, total, cached?)
LlmResponse(content, usage?, metadata)
LlmChunk(delta, finishReason?, usage?, metadata)
StreamProgress(tokensProcessed, tokensPerSecond, elapsedMs, estimatedRemainingMs?)
```

Relationships:

- `LlmResponse` is the collected form of a stream of `LlmChunk` values.
- `TokenUsage` may appear on a final chunk, collected response, session event, or flow event.
- `metadata` is a string map for backend-normalized fields such as provider name, model name, response id, tool event markers, or provider-specific token counters.

## Connector Model

```text
ConnectorId(value)
Provider = hosted API provider | local HTTP provider | CLI provider | mock
ConnectorKind = Api | Cli
HealthStatus(availability, authStatus, latency?)
ConnectorCapabilities(streaming, resumableSessions, interactiveSessions, askUser, approval, structuredOutput, usageReporting)
ApiConnectorConfig(...)
CliConnectorConfig(...)
FallbackChain(connectors)
CliContext(worktreePath, repoPath, envVars, sandbox?, turnLimit?)
```

Relationships:

- A connector id selects a factory.
- API configs convert into LLM configs with provider, model, base URL, credentials, timeout, retry, rate-limit, temperature, and token limit settings.
- CLI configs add flags, sandbox, turn limit, env vars, working directory, and read-only mode.
- A fallback chain preserves connector order for callers that implement failover.

## Tool Model

```text
Tool(name, description, parameters, execute, tags, sandbox)
ToolCall(id, name, arguments)
ToolCallResponse(content?, toolCalls, finishReason)
ToolResult(toolCallId, result)
ToolLoopConfig(maxIterations)
WorkspaceConfig(root, maxReadBytes, maxWriteBytes)
```

Relationships:

- `ToolCall.arguments` is serialized JSON text supplied by the model.
- `Tool.parameters` is a JSON object schema used to validate arguments.
- `ToolResult.result` is either JSON data or an error string.
- Workspace tools operate relative to `WorkspaceConfig.root` after path normalization.

## Conversation Model

```text
PromptRole = System | User | Assistant | Tool
ConversationState = InProgress | WaitingForTool | Completed | Failed
ConversationMessage(id, role, content, timestamp, tokens, model?, costUsd?, metadata, important)
ConversationCheckpoint(id, state, messageCount, createdAt, note?)
ConversationState(id, parentId?, messages, state, checkpoints, metadata, createdAt, updatedAt)
PromptTemplate(name, version, template, description?, tags, createdAt, active)
PromptTemplateRef(name, version?)
ToolConversationResult(thread, response)
```

Relationships:

- A thread contains ordered messages and checkpoints.
- A thread fork points to its parent id and preserves message history.
- A checkpoint records a state snapshot by message count.
- Prompt templates are grouped by name and ordered by version.
- Tool conversations append user, assistant, and tool messages to a thread while preserving state transitions.

## Context Window Model

```text
ContextLimits(maxTokens, warningThresholdPct)
ContextWindow(messages, totalTokens, approachingLimit, trimmed)
ContextTrimmingStrategy = DropOldestFifo | SlidingWindow | PriorityBased | SummarizeOldMessages(summaryTargetTokens)
```

Relationships:

- A context window is computed from conversation messages, provider-specific token counting, limits, and a trimming strategy.
- `approachingLimit` is true when total tokens meet or exceed the warning threshold percentage.
- `trimmed` indicates whether any input messages were dropped or summarized.

## Observability Model

```text
LlmPricing(inputUsdPer1k, outputUsdPer1k)
RequestLabels(provider, model, agent?, runId?, workflowStep?)
RequestMetrics(labels, tokenUsage?, latencyMs, success, errorType?, estimatedCostUsd)
ProviderHealth(provider, requestCount, successRate, avgLatencyMs, p95LatencyMs, estimatedCostUsd)
ObservabilitySnapshot(totalRequests, totalErrors, activeRequests, token totals, estimatedCostUsd, latency percentiles, byProvider, byAgentRequests)
DashboardMetricsSnapshot(providerHealth, totalTokens, totalCostUsd, totalRequests, errorRate)
TraceAttributes(...)
TraceSpan(traceId, spanId, parentSpanId?, correlationId, name, status, startedAt, endedAt, attributes, errorMessage?)
StructuredLogEvent(level, message, correlationId, timestamp, fields)
```

Relationships:

- Request metrics roll up into provider health and snapshots.
- Trace spans are correlated by correlation id and parent span id.
- Cost estimates derive from token usage and configured pricing.

## Flow Model

```text
Task(title, description, completed)
Plan(epicId, tasks, brief?)
Verdict<T> = Proceed(value) | Blocked(reason)
PlanningStep = AskUser(question) | Proposed(plan)
Triage = NotBug(explanation) | Untestable(summary, reproductionSteps) | Testable(summary, branchName, failingTestPath)
Severity = Critical | Warning | Info
ReviewIssue(severity, title, description, file?, line?, suggestion?, confidence)
ReviewResult(issues, summary)
Reviewer(name, systemPrompt, files?)
ReviewerPick(reviewers)
PrSummary(title, body)
```

Relationships:

- A plan owns ordered tasks.
- A plan can carry a brief used to enrich task prompts.
- Reviewers can be scoped to changed files using a pattern.
- Review results are clean when the issue list is empty.
- Planner and reviewer outputs are structured LLM responses.

## Flow Event Model

```text
FlowEvent = StageStarted | StageCompleted | StageFailed | Aborted | Info | ToolUse | AssistantMessage | TokensUsed
FlowRunContext(reasoning, coder, git, github, events, reviewers, coderCapabilities, userPrompt, workDir)
```

Relationships:

- A flow context owns one event sink used by stage/fail/review/runner behavior.
- Token events feed cost tracking rather than terminal tree lines.
- Tool-use and assistant-message events are derived from normalized LLM chunk metadata and text.

## External Tool Model

```text
GitCreateBranch = Created | AlreadyExists
GitCommit = Committed | NothingToCommit
IssueRef(owner, repo, number)
Issue(title, body, author)
PullRequest(owner, repo, number, url)
BuildOutcome = Success | Failure | Pending | TimedOut
AdoRequest(method, url, body?, contentType)
WorkItem(id, title, description, acceptanceCriteria, state, tags)
AzureDevOpsPullRequest(id, repoId, projectId, webUrl)
```

Relationships:

- Git recoverable outcomes are value results.
- A GitHub issue reference points to one issue by owner/repo/number.
- A pull request can be parsed from its URL and used for comments, updates, checks, and build waits.
- An Azure DevOps pull request can be linked to a work item through a development artifact relation.

## Runner Model

```text
UsageLimitPolicy(enabled, maxWait, pollInterval)
Retry count = Integer >= 0
Palette(enabled)
TerminalOutputSurface(log, setStatus, suspend)
UsageCostAccumulator(byAgent, byModel)
```

Relationships:

- Runner parses environment values into retry count and usage-limit policy.
- Palette controls color only; glyph/text semantics are independent of color.
- Terminal surface handles output serialization and status-line behavior.
- Cost tracker aggregates token events by agent and model.
