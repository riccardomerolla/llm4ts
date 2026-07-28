# Public API

Notation: `async` means the operation may perform asynchronous work. `Stream<Result<T, E>>` means an asynchronous sequence whose items may fail with `E`. Shape names are CSP terms for the Rust build; exact Rust identifiers are a build-team decision.

## Core LLM Shapes

```text
Provider = OpenAI | Anthropic | GeminiApi | GeminiCli | LmStudio | Ollama | OpenCode | ClaudeCli | Codex | Copilot | Pi | Mock
ConnectorKind = Api | Cli
MessageRole = System | User | Assistant | Tool

Message = record {
  role: MessageRole,
  content: Text
}

TokenUsage = record {
  prompt: Integer,
  completion: Integer,
  total: Integer,
  cached: Optional<Integer>
}

LlmResponse = record {
  content: Text,
  usage: Optional<TokenUsage>,
  metadata: Map<Text, Text>
}

LlmChunk = record {
  delta: Text,
  finishReason: Optional<Text>,
  usage: Optional<TokenUsage>,
  metadata: Map<Text, Text>
}

StreamProgress = record {
  tokensProcessed: Integer,
  tokensPerSecond: Decimal,
  elapsedMs: Integer,
  estimatedRemainingMs: Optional<Integer>
}
```

## Core LLM Client

```text
LlmClient.executeStream(prompt: Text) -> Stream<Result<LlmChunk, LlmError>>
LlmClient.executeStreamWithHistory(messages: List<Message>) -> Stream<Result<LlmChunk, LlmError>>
LlmClient.executeWithTools(prompt: Text, tools: List<Tool>) -> Result<ToolCallResponse, LlmError>
LlmClient.executeStructured<T>(prompt: Text, schema: JsonSchema) -> Result<T, LlmError>
LlmClient.executeStructuredWithUsage<T>(prompt: Text, schema: JsonSchema) -> Result<(T, Optional<TokenUsage>, Optional<Text>), LlmError>
LlmClient.isAvailable() -> Boolean
```

Default `executeStructuredWithUsage` may delegate to `executeStructured` and return no usage/model if the backend cannot expose them.

## Tool-Call Shapes

```text
ToolCall = record {
  id: Text,
  name: Text,
  arguments: Text
}

ToolCallResponse = record {
  content: Optional<Text>,
  toolCalls: List<ToolCall>,
  finishReason: Text
}
```

## Connector Configuration

```text
ApiConnectorConfig = record {
  connectorId: ConnectorId,
  model: Optional<Text>,
  baseUrl: Optional<Text>,
  apiKey: Optional<SecretText>,
  timeout: Duration,
  maxRetries: Integer,
  requestsPerMinute: Integer,
  burstSize: Integer,
  acquireTimeout: Duration,
  temperature: Optional<Decimal>,
  maxTokens: Optional<Integer>
}

CliConnectorConfig = record {
  connectorId: ConnectorId,
  model: Optional<Text>,
  timeout: Duration,
  maxRetries: Integer,
  flags: Map<Text, Text>,
  sandbox: Optional<CliSandbox>,
  turnLimit: Optional<Integer>,
  envVars: Map<Text, Text>,
  workingDir: Optional<Path>,
  readOnly: Boolean
}

ConnectorCapabilities = record {
  streaming: Boolean,
  resumableSessions: Boolean,
  interactiveSessions: Boolean,
  askUser: Boolean,
  approval: Boolean,
  structuredOutput: Boolean,
  usageReporting: Boolean
}

HealthStatus = record {
  availability: Healthy | Degraded | Unhealthy | Unknown,
  authStatus: Valid | Missing | Invalid | Unknown,
  latency: Optional<Duration>
}
```

## Connector Registry

```text
ConnectorFactory.create(config: ConnectorConfig) -> Result<Connector, LlmError>
ConnectorRegistry.resolve(config: ConnectorConfig) -> Result<Connector, LlmError>
ConnectorRegistry.resolveApi(config: ApiConnectorConfig) -> Result<ApiConnector, LlmError>
ConnectorRegistry.resolveCli(config: CliConnectorConfig) -> Result<CliConnector, LlmError>
ConnectorRegistry.available() -> List<ConnectorId>
ConnectorRegistry.healthCheckAll() -> Result<Map<ConnectorId, HealthStatus>, LlmError>
```

The built registry must include the supported API connectors, CLI connectors, and deterministic mock connector.

## CLI Process Executor

```text
ProcessResult = record { stdout: List<Text>, exitCode: Integer }

ProcessRunner.run(argv: List<Text>, cwd: Path, envVars: Map<Text, Text>) -> Result<ProcessResult, LlmError>
ProcessRunner.runStreaming(argv: List<Text>, cwd: Path, envVars: Map<Text, Text>) -> Stream<Result<Text, LlmError>>
ProcessRunner.runWithStdin(argv, cwd, envVars, stdin: Text) -> Result<ProcessResult, LlmError>
ProcessRunner.runStreamingWithStdin(argv, cwd, envVars, stdin: Text) -> Stream<Result<Text, LlmError>>
ProcessRunner.runBidirectional(argv, cwd, envVars) -> Result<(InputQueue<Text>, Stream<Result<Text, LlmError>>), LlmError>
```

## Agent Sessions

```text
SessionEvent =
  TextDelta(text)
  | ToolUse(tool, rawInput, id)
  | ToolResult(id, status, content)
  | AskUser(question)
  | ApprovalRequest(tool, rawInput, id)
  | Usage(usage, model)
  | Done(result)

SessionResult = record {
  text: Text,
  usage: Optional<TokenUsage>,
  model: Optional<Text>
}

InteractiveSession.events() -> Stream<Result<SessionEvent, LlmError>>
InteractiveSession.sendUserMessage(text: Text) -> Result<Unit, LlmError>
InteractiveSession.respondToAsk(answer: Text) -> Result<Unit, LlmError>
InteractiveSession.respondToApproval(id: Text, approved: Boolean) -> Result<Unit, LlmError>
InteractiveSession.awaitResult() -> Result<SessionResult, LlmError>
InteractiveSession.cancel() -> Unit
```

## Streaming Utilities

```text
collect(stream) -> Result<LlmResponse, LlmError>
trackProgress(stream, onProgress) -> Stream<Result<LlmChunk, LlmError>>
parsePartialJson<T>(textStream) -> Stream<Result<T, LlmError>>
retryStream(stream, retryPolicy) -> Stream<Result<LlmChunk, LlmError>>
buffered(stream, capacity) -> Stream<Result<LlmChunk, LlmError>>
batch(stream, maxSize, maxDuration) -> Stream<Result<List<LlmChunk>, LlmError>>
withTimeout(stream, timeout) -> Stream<Result<LlmChunk, LlmError>>
mergeAll(streams) -> Stream<Result<LlmChunk, LlmError>>
cancellable(stream) -> (Stream<Result<LlmChunk, LlmError>>, cancel: async Unit)
withSnapshots(stream, interval) -> Stream<Result<Text, LlmError>>
withFallback(stream, fallback) -> Stream<Result<LlmChunk, LlmError>>
rateLimit(stream, maxPerSecond) -> Stream<Result<LlmChunk, LlmError>>
toSse(stream) -> Stream<Result<Text, LlmError>>
fromSse(textStream) -> Stream<Result<LlmChunk, LlmError>>
withHeartbeat(stream, heartbeatTimeout) -> Stream<Result<LlmChunk, LlmError>>
parallelStream(inputs, parallelism, makeStream) -> Stream<Result<Item, LlmError>>
```

## Conversation And Context

```text
ConversationState = InProgress | WaitingForTool | Completed | Failed
PromptRole = System | User | Assistant | Tool

ConversationMessage = record {
  id: Text,
  role: PromptRole,
  content: Text,
  timestamp: Instant,
  tokens: Integer,
  model: Optional<Text>,
  costUsd: Optional<Decimal>,
  metadata: Map<Text, Text>,
  important: Boolean
}

ConversationState = record {
  id: Text,
  parentId: Optional<Text>,
  messages: List<ConversationMessage>,
  state: ConversationState,
  checkpoints: List<ConversationCheckpoint>,
  metadata: Map<Text, Text>,
  createdAt: Instant,
  updatedAt: Instant
}

ConversationState.append(message, newState) -> ConversationState
ConversationState.checkpoint(at, note) -> ConversationState
ConversationState.fork(newId, at) -> ConversationState
ConversationState.exportJson() -> Text
ConversationState.importJson(json) -> Result<ConversationState, Text>

ContextWindowing.apply(messages, provider, limits, strategy, tokenCounter, summarizer) -> Result<ContextWindow, ContextError>
```

Prompt templates support registration by name and version, resolution of active/latest templates, variable rendering, composition, rollback to a version, deterministic variant choice, and listing. Conversation stores support save, load, list, and delete.

## Tools

```text
ToolSandbox = WorkspaceReadWrite | WorkspaceReadOnly | Unrestricted

Tool = record {
  name: Text,
  description: Text,
  parameters: JsonSchema,
  execute: Json -> Result<Json, ToolExecutionError>,
  tags: Set<Text>,
  sandbox: ToolSandbox
}

ToolResult = record {
  toolCallId: Text,
  result: Result<Json, Text>
}

ToolCatalog.register(tool) -> Result<Unit, ToolExecutionError>
ToolCatalog.registerAll(tools) -> Result<Unit, ToolExecutionError>
ToolCatalog.get(name) -> Result<Tool, LlmError>
ToolCatalog.list() -> List<Tool>
ToolCatalog.select(prompt, limit) -> List<Tool>
ToolCatalog.validate(call) -> Result<(Tool, Json), LlmError>
ToolCatalog.execute(call) -> Result<ToolResult, LlmError>
ToolCatalog.executeAll(calls) -> Result<List<ToolResult>, LlmError>
ToolLoop.run(prompt, tools, client, catalog, maxIterations) -> Result<LlmResponse, LlmError>
```

Built-in workspace tools must include bounded file read, bounded file write/append, file discovery by path and glob, text search, and lightweight validation helpers for common starter examples. All workspace paths must be normalized under the configured root.

## Observability

```text
RequestLabels = record { provider, model, agent?, runId?, workflowStep? }
RequestMetrics = record { labels, tokenUsage?, latencyMs, success, errorType?, estimatedCostUsd }
ProviderHealth = record { provider, requestCount, successRate, avgLatencyMs, p95LatencyMs, estimatedCostUsd }
ObservabilitySnapshot = aggregate counters, token totals, latency percentiles, cost, provider summaries, and agent request counts
DashboardMetricsSnapshot = provider health list, total tokens, total cost, total requests, and error rate

MetricsCollector.markRequestStarted(labels) -> Unit
MetricsCollector.recordCompleted(metrics) -> Unit
MetricsCollector.snapshot() -> ObservabilitySnapshot
MetricsCollector.dashboardSnapshot() -> DashboardMetricsSnapshot

TracingService.withCorrelationId(id, effect) -> effect result
TracingService.correlationId() -> Text
TracingService.inSpan(name, attributes, effect) -> effect result
TracingService.recordedSpans() -> List<TraceSpan>
```

## Flow Data Shapes

```text
Task = record { title: Text, description: Text, completed: Boolean }
Plan = record { epicId: Text, tasks: List<Task>, brief: Optional<Text> }
Verdict<T> = Proceed(value: T) | Blocked(reason: Text)
Triage = NotBug(explanation) | Untestable(summary, reproductionSteps) | Testable(summary, branchName, failingTestPath)
PrSummary = record { title: Text, body: Text }
Severity = Critical | Warning | Info
ReviewIssue = record { severity, title, description, file?, line?, suggestion?, confidence }
ReviewResult = record { issues: List<ReviewIssue>, summary: Text }
FlowError = Persistence | PlanParse | Aborted | Process | Llm
```

## Flow Operations

```text
Plan.nextIncomplete() -> Optional<Task>
Plan.complete(title) -> Plan
Plan.taskPrompt(task) -> Text
Plan.render() -> Text
Plan.parse(markdown) -> Result<Plan, Text>
Plan.defaultPath(prompt, stateDir) -> Path

PlanPersistence.save(path, plan) -> Result<Unit, FlowError>
PlanPersistence.load(path) -> Result<Optional<Plan>, FlowError>
PlanPersistence.delete(path) -> Result<Unit, FlowError>
PlanPersistence.recoverOrCreate(path, create) -> Result<Plan, FlowError>

Planner.from(reasoning, prompt, instructions?) -> Result<Plan, FlowError>
Planner.reviewed(reasoning, plan, instructions?) -> Result<Plan, FlowError>
Planner.brief(reasoning, prompt, instructions?) -> Result<Text, FlowError>
Planner.briefed(reasoning, plan, prompt, instructions?) -> Result<Plan, FlowError>
Planner.assessThenPlan(reasoning, prompt, instructions?) -> Result<Verdict<Plan>, FlowError>
Planner.interactive(reasoning, prompt, interaction, maxTurns, instructions?) -> Result<Plan, FlowError>
Planner.triage(reasoning, title, body, instructions?) -> Result<Triage, FlowError>

Chat.start(client, system?, manageGit?) -> Chat
Chat.ask(prompt) -> Result<Text, FlowError>
Chat.messages() -> List<Message>

stage(name, effect, events) -> effect result
fail(message, events) -> Result<Never, FlowError>
implementTaskLoop(planPath, plan, perTask, events) -> Result<Plan, FlowError>
reviewAndFixLoop(reviewers, reviewerClient, coderChat, taskTitle, currentDiff, changedFiles?, maxRounds?, selector?, lint?, parallelism?, format?, events) -> Result<ReviewResult, FlowError>
implementTaskLoopLive(planPath, plan, interaction, openSession, onResult, events) -> Result<Plan, FlowError>
withUsageLimitRetry(policy, maxReentries, flow, events) -> flow result
```

## Flow Events

```text
FlowEvent =
  StageStarted(stage)
  | StageCompleted(stage)
  | StageFailed(stage, message)
  | Aborted(message)
  | Info(message)
  | ToolUse(tool, args)
  | AssistantMessage(text)
  | TokensUsed(agent, model?, usage)

FlowEvents.publish(event) -> Unit
FlowEvents.collecting() -> event sink with recorded events
FlowEvents.hub(capacity) -> publish/subscribe event hub with published count
```

## External Development Tools

```text
GitFacade.init() -> Result<Unit, FlowError>
GitFacade.initBare() -> Result<Unit, FlowError>
GitFacade.config(key, value) -> Result<Unit, FlowError>
GitFacade.addAll() -> Result<Unit, FlowError>
GitFacade.currentBranch() -> Result<Text, FlowError>
GitFacade.diff() -> Result<Text, FlowError>
GitFacade.diffAll() -> Result<Text, FlowError>
GitFacade.defaultBase() -> Result<Text, FlowError>
GitFacade.diffVsBase(base, threeDot?) -> Result<Text, FlowError>
GitFacade.changedFilesVsBase(base, threeDot?) -> Result<List<Text>, FlowError>
GitFacade.lsRemote(remote) -> Result<Text, FlowError>
GitFacade.addRemote(name, url) -> Result<Unit, FlowError>
GitFacade.checkout(name) -> Result<Unit, FlowError>
GitFacade.checkoutOrCreate(name) -> Result<Unit, FlowError>
GitFacade.createBranch(name) -> Result<Created | AlreadyExists, FlowError>
GitFacade.commitAll(message) -> Result<Committed | NothingToCommit, FlowError>
GitFacade.push(remote, branch) -> Result<Unit, FlowError>

IssueRef = record { owner, repo, number }
Issue = record { title, body, author }
PullRequest = record { owner, repo, number, url }
BuildOutcome = Success | Failure | Pending | TimedOut

GitHubFacade.createPr(title, body, base?, draft?) -> Result<PullRequest, FlowError>
GitHubFacade.readIssue(issueRef) -> Result<Issue, FlowError>
GitHubFacade.writeIssueComment(issueRef, body) -> Result<Unit, FlowError>
GitHubFacade.writePrComment(pr, body) -> Result<Unit, FlowError>
GitHubFacade.updatePr(pr, title, body) -> Result<Unit, FlowError>
GitHubFacade.prChecks(pr) -> Result<BuildOutcome, FlowError>
GitHubFacade.waitForBuild(pr, timeout) -> Result<BuildOutcome, FlowError>

AzureDevOpsConfig = record { orgUrl, project, repository, personalAccessToken, apiVersion }
WorkItem = record { id, title, description, acceptanceCriteria, state, tags }
AzureDevOpsPullRequest = record { id, repoId, projectId, webUrl }
AzureDevOpsFacade.readWorkItem(id) -> Result<WorkItem, FlowError>
AzureDevOpsFacade.wiqlIds(query) -> Result<List<Integer>, FlowError>
AzureDevOpsFacade.setFields(id, fields) -> Result<Unit, FlowError>
AzureDevOpsFacade.setState(id, state) -> Result<Unit, FlowError>
AzureDevOpsFacade.setAcceptanceCriteria(id, text) -> Result<Unit, FlowError>
AzureDevOpsFacade.addTag(id, tag) -> Result<Unit, FlowError>
AzureDevOpsFacade.comment(id, text) -> Result<Unit, FlowError>
AzureDevOpsFacade.createPr(sourceRef, targetRef, title, body) -> Result<AzureDevOpsPullRequest, FlowError>
AzureDevOpsFacade.linkPr(workItemId, pr) -> Result<Unit, FlowError>
AzureDevOpsFacade.prThread(prId, text) -> Result<Unit, FlowError>
```

## Runner

```text
flow(args, coder?, reasoning?, defaultPrompt?, reviewers?, usageLimit?, body) -> process exit
RunLibrary.run(workDir, reasoning, coder, reviewers?, usageLimit?, body) -> async Unit
RunLibrary.script(args, coder, reasoning?, defaultPrompt?, reviewers?, usageLimit?, workDir?, body) -> async Unit
resolvePrompt(args, defaultPrompt?) -> Result<Text, UsageText>
```

Runner connector presets should include edit-capable configurations for the main CLI coders and a local reasoning preset for a local model server. A helper should select the coder from an environment variable, defaulting to the primary CLI coder when unset or unrecognized.
