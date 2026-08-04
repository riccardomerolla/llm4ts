# Source Parity Ledger

This ledger tracks the Effect-TS implementation against the owned `llm4zio`
reference release.

- Reference tag: `v4.2.0`
- Reference commit observed during planning: `adf23e11`
- Effect reference commit: `504343b0cdf9a0306191c069c31b7d569eba0ed7`

| Reference source                                      | Reference test                                                  | llm4ts module                                          | llm4ts test                              | CSP                                  |
| ----------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------- | ------------------------------------ |
| `llm4zio/core/Models.scala`                           | `ModelsSpec.scala`                                              | `@llm4ts/core/Models`                                  | `Models.test.ts`                         | `02-public-api`, `06-data-model`     |
| `llm4zio/core/Errors.scala`                           | `ErrorsSpec.scala`                                              | `@llm4ts/core/Errors`                                  | `Errors.test.ts`                         | `05-effects-and-errors`              |
| `llm4zio/core/LlmService.scala`                       | `LlmServiceSpec.scala`                                          | `@llm4ts/core/LlmService`                              | `LlmService.test.ts`                     | `02-public-api`, `07-test-contracts` |
| `llm4zio/core/Streaming.scala`                        | `StreamingSpec.scala`                                           | `@llm4ts/core/Streaming`                               | `Streaming.test.ts`                      | `03-behaviors`, `07-test-contracts`  |
| `llm4zio/core/StructuredOutputs.scala`                | `StructuredOutputsSpec.scala`                                   | `@llm4ts/core/StructuredOutput`                        | `StructuredOutput.test.ts`               | `03-behaviors`, `07-test-contracts`  |
| `llm4zio/core/RateLimiter.scala`                      | `RateLimiterSpec.scala`                                         | `@llm4ts/core/RateLimiter`                             | `RateLimiter.test.ts`                    | rate limiting and metrics            |
| `llm4zio/providers/UsageLimits.scala`                 | `UsageLimitsSpec.scala`                                         | `@llm4ts/core/UsageLimits`                             | `UsageLimits.test.ts`                    | retry and usage-limit boundaries     |
| `llm4zio/core/Conversation.scala#ConversationMessage` | `ContextManagementSpec.scala`                                   | `@llm4ts/core/Conversation`                            | `ContextManagement.test.ts`              | `02-public-api`, `06-data-model`     |
| `llm4zio/core/ContextManagement.scala#applyWindow`    | `ContextManagementSpec.scala`                                   | `@llm4ts/core/ContextManagement`                       | `ContextManagement.test.ts`              | `02-public-api`, `06-data-model`     |
| `llm4zio/core/Capability.scala`                       | `GrantsSpec.scala`, `GrantsGateSpec.scala`                      | `@llm4ts/core/Capability`                              | `Capability.test.ts`                     | source capability addendum           |
| `llm4zio/flow/Classified.scala`                       | `ClassifiedSpec.scala`                                          | `@llm4ts/flow/Classified`                              | `Classified.test.ts`                     | secret-handling non-functionals      |
| `llm4zio/flow/TransientRetry.scala`                   | `TransientRetrySpec.scala`                                      | `@llm4ts/flow/TransientRetry`                          | `TransientRetry.test.ts`                 | retry and usage-limit boundaries     |
| `llm4zio/runner/CoderPolicy.scala`                    | `CoderPolicySpec.scala`                                         | `@llm4ts/runner/CoderPolicy`                           | `CoderPolicy.test.ts`                    | process and capability boundaries    |
| `llm4zio/core/Connector.scala`                        | `ConnectorSpec.scala`                                           | `@llm4ts/core/Connector`                               | `ConnectorRegistry.test.ts`              | connector and capability contracts   |
| `llm4zio/core/ConnectorCapabilities.scala`            | `ConnectorCapabilitiesSpec.scala`                               | `@llm4ts/core/Connector`                               | `ConnectorRegistry.test.ts`              | connector and capability contracts   |
| `llm4zio/core/ConnectorRegistry.scala`                | `ConnectorRegistrySpec.scala`                                   | `@llm4ts/core/ConnectorRegistry`                       | `ConnectorRegistry.test.ts`              | connector resolution and health      |
| `llm4zio/core/HttpClient.scala`                       | `HttpClientSendSpec.scala`                                      | `@llm4ts/core/HttpClient`                              | `RuntimeBoundaries.test.ts`              | HTTP transport boundary              |
| `llm4zio/core/HttpClient.scala`                       | `HttpClientStreamingSpec.scala`                                 | `@llm4ts/runner/NodeHttpClient`                        | `NodeHttpClient.test.ts`                 | HTTP streaming and cancellation      |
| `llm4zio/core/CliProcessExecutor.scala`               | `CliProcessExecutorSpec.scala`                                  | `@llm4ts/core/ProcessExecutor`                         | `RuntimeBoundaries.test.ts`              | process boundary                     |
| `llm4zio/core/LiveCliProcessExecutor.scala`           | integration process specifications                              | `@llm4ts/runner/NodeProcessExecutor`                   | `NodeProcessExecutor.test.ts`            | process lifecycle and streaming      |
| `llm4zio/providers/OpenAIModels.scala`                | `OpenAIProviderSpec.scala`                                      | `@llm4ts/core/providers/OpenAIModels`                  | `OpenAIProvider.test.ts`                 | OpenAI wire protocol                 |
| `llm4zio/providers/OpenAIProvider.scala`              | `OpenAIProviderSpec.scala`                                      | `@llm4ts/core/providers/OpenAIProvider`                | `OpenAIProvider.test.ts`                 | OpenAI streaming and health          |
| `llm4zio/providers/OpenAIProvider.scala`              | `OpenAIToolCallingSpec.scala`                                   | `@llm4ts/core/providers/OpenAIProvider`                | `OpenAIProvider.test.ts`                 | OpenAI tools and structured output   |
| `llm4zio/providers/AnthropicModels.scala`             | `AnthropicProviderSpec.scala`                                   | `@llm4ts/core/providers/AnthropicModels`               | `AnthropicProvider.test.ts`              | Anthropic wire protocol              |
| `llm4zio/providers/AnthropicProvider.scala`           | `AnthropicProviderSpec.scala`, `AnthropicToolCallingSpec.scala` | `@llm4ts/core/providers/AnthropicProvider`             | `AnthropicProvider.test.ts`              | Anthropic stream, tools, structure   |
| `llm4zio/providers/GeminiModels.scala`                | `GeminiApiProviderSpec.scala`                                   | `@llm4ts/core/providers/GeminiModels`                  | `GeminiApiProvider.test.ts`              | Gemini API wire protocol             |
| `llm4zio/providers/GeminiApiProvider.scala`           | `GeminiApiProviderSpec.scala`, `GeminiToolCallingSpec.scala`    | `@llm4ts/core/providers/GeminiApiProvider`             | `GeminiApiProvider.test.ts`              | Gemini stream, tools, structure      |
| `llm4zio/providers/OllamaProvider.scala`              | `OllamaProviderSpec.scala`                                      | `@llm4ts/core/providers/OllamaProvider`                | `OllamaProvider.test.ts`                 | Ollama generate/chat protocol        |
| `llm4zio/providers/LmStudioModels.scala`              | `LmStudioProviderSpec.scala`                                    | `@llm4ts/core/providers/LmStudioModels`                | `LmStudioProvider.test.ts`               | LM Studio native wire protocol       |
| `llm4zio/providers/LmStudioProvider.scala`            | `LmStudioProviderSpec.scala`                                    | `@llm4ts/core/providers/LmStudioProvider`              | `LmStudioProvider.test.ts`               | Native requests and OpenAI streaming |
| `llm4zio/providers/OpenCodeProvider.scala`            | `OpenCodeProviderSpec.scala`                                    | `@llm4ts/core/providers/OpenCodeProvider`              | `OpenCodeProvider.test.ts`               | Buffered SSE compatibility protocol  |
| `llm4zio/providers/MockProvider.scala`                | source deterministic behavior                                   | `@llm4ts/core/providers/MockProvider`                  | `MockProvider.test.ts`                   | Offline deterministic connector      |
| `llm4zio/providers/CliStreamJson.scala`               | CLI connector parser specifications                             | `@llm4ts/core/providers/CliSupport`                    | `CliSupport.test.ts`                     | JSON-line and metadata normalization |
| `llm4zio/providers/CopilotConnector.scala`            | `CopilotConnectorSpec.scala`                                    | `@llm4ts/core/providers/CopilotConnector`              | `CopilotConnector.test.ts`               | Copilot continuation-only CLI        |
| `llm4zio/providers/AntigravityConnector.scala`        | `AntigravityConnectorSpec.scala`                                | `@llm4ts/core/providers/AntigravityConnector`          | `AntigravityConnector.test.ts`           | Antigravity workspace and streaming  |
| `llm4zio/providers/PiConnector.scala`                 | `PiConnectorSpec.scala`                                         | `@llm4ts/core/providers/PiConnector`                   | `CliConnectorFamilies.test.ts`           | Pi stdin and JSONL stream            |
| `llm4zio/providers/OpenCodeCliConnector.scala`        | `OpenCodeCliConnectorSpec.scala`                                | `@llm4ts/core/providers/OpenCodeCliConnector`          | `CliConnectorFamilies.test.ts`           | OpenCode CLI JSON events             |
| `llm4zio/providers/GrokCliConnector.scala`            | `GrokCliConnectorSpec.scala`                                    | `@llm4ts/core/providers/GrokCliConnector`              | `CliConnectorFamilies.test.ts`           | Grok JSON events and quota errors    |
| `llm4zio/providers/CursorConnector.scala`             | `CursorConnectorSpec.scala`                                     | `@llm4ts/core/providers/CursorConnector`               | `CliConnectorFamilies.test.ts`           | Cursor JSON events                   |
| `llm4zio/core/AgentSession.scala`                     | `ClaudeAgentSessionSpec.scala`                                  | `@llm4ts/core/AgentSession`                            | `ClaudeCliConnector.test.ts`             | Held interactive session contract    |
| `llm4zio/providers/ClaudeAgentSession.scala`          | `ClaudeAgentSessionSpec.scala`                                  | `@llm4ts/core/providers/ClaudeAgentSession`            | `ClaudeCliConnector.test.ts`             | Scoped Claude bidirectional session  |
| `llm4zio/providers/ClaudeCliConnector.scala`          | `ClaudeCliConnectorSpec.scala`                                  | `@llm4ts/core/providers/ClaudeCliConnector`            | `ClaudeCliConnector.test.ts`             | Claude stream and capabilities       |
| `llm4zio/providers/CodexConnector.scala`              | `CodexConnectorSpec.scala`                                      | `@llm4ts/core/providers/CodexConnector`                | `CodexConnector.test.ts`                 | Codex JSONL and strict schemas       |
| `llm4zio/providers/GeminiCliProvider.scala`           | `GeminiCliProviderSpec.scala`                                   | `@llm4ts/core/providers/GeminiCliProvider`             | `GeminiCliProvider.test.ts`              | Gemini CLI event and error protocol  |
| `llm4zio/providers/ConnectorFactories.scala`          | `ConnectorCapabilitiesSpec.scala`                               | `@llm4ts/core/providers/ConnectorFactories`            | `ConnectorFactories.test.ts`             | Full registry and capability matrix  |
| `llm4zio/runner/Connectors.scala`                     | `ConnectorsSpec.scala`                                          | `@llm4ts/runner/Connectors`                            | `Connectors.test.ts`                     | Edit-capable connector presets       |
| `llm4zio/tools/Tool.scala`, `ToolRegistry.scala`      | tool schema, registry, and execution specs                      | `@llm4ts/core/tools/Tool`, `ToolRegistry`              | `Tools.test.ts`                          | tool declaration and execution       |
| `llm4zio/tools/ToolCallingExecutor.scala`             | bounded tool-loop specifications                                | `@llm4ts/core/tools/ToolCallingExecutor`               | `Tools.test.ts`                          | bounded tool calling                 |
| `llm4zio/eval/Eval.scala`, `Evaluator.scala`          | `EvalSpec.scala`, `EvaluatorSpec.scala`, `VarianceSpec.scala`   | `@llm4ts/core/eval/Eval`, `Evaluator`                  | `Eval.test.ts`                           | evaluation values and variance       |
| `llm4zio/eval/Checks.scala`, `EvalSuite.scala`        | `ChecksSpec.scala`, `EvalSuiteSpec.scala`                       | `@llm4ts/core/eval/Checks`, `EvalSuite`                | `Eval.test.ts`                           | deterministic checks and suite gates |
| `llm4zio/eval/Judge.scala`                            | `JudgeSpec.scala`                                               | `@llm4ts/core/eval/Judge`                              | `Judge.test.ts`                          | LLM-as-a-judge                       |
| `llm4zio/observability/StreamRecorder.scala`          | `StreamRecorderSpec.scala`                                      | `@llm4ts/core/observability/StreamRecorder`            | `Observability.test.ts`                  | ambient stream signals               |
| CSP observability contracts                           | clean-spec black-box contracts                                  | `@llm4ts/core/observability/*`                         | `Observability.test.ts`                  | metrics, tracing, logs, redaction    |
| `llm4zio/flow/Plan.scala`, `PlanStore.scala`          | `PlanSpec.scala`, `PlanStoreSpec.scala`                         | `@llm4ts/flow/Plan`, `Persistence`                     | `Plan.test.ts`, runner persistence       | Markdown plans and recovery          |
| `llm4zio/flow/Chat.scala`                             | `ChatSpec.scala`                                                | `@llm4ts/flow/Chat`                                    | `Chat.test.ts`                           | atomic serialized chat history       |
| `llm4zio/flow/Planner.scala`, `Verdict.scala`         | `PlannerSpec.scala`                                             | `@llm4ts/flow/Planner`                                 | `Planner.test.ts`                        | structured planning and readiness    |
| `llm4zio/flow/LlmReview.scala`, `Reviewer.scala`      | `LlmReviewSpec.scala`                                           | `@llm4ts/flow/Review`, `Reviewer`                      | `Review.test.ts`                         | bounded scoped review/fix loop       |
| `llm4zio/flow/PrSummary.scala`                        | `PrSummarySpec.scala`                                           | `@llm4ts/flow/PrSummary`                               | `PrSummary.test.ts`                      | structured PR summary                |
| `llm4zio/flow/ImplementLoop.scala`                    | `ImplementLoopSpec.scala`, plan failure specs                   | `@llm4ts/flow/PlanExecution`                           | `PlanExecution.test.ts`                  | resumable task transitions           |
| `llm4zio/flow/Workspace.scala`                        | `WorkspaceSpec.scala`                                           | `@llm4ts/flow/WorkspaceLayout`                         | `Plan.test.ts`                           | bookkeeping namespace                |
| `llm4zio/flow/Provenance.scala`                       | `ProvenanceSpec.scala`                                          | `@llm4ts/flow/Provenance`                              | runner persistence                       | clean-room evidence chain            |
| `llm4zio/flow/FlowRecorder.scala`                     | `FlowRecorderSpec.scala`                                        | `@llm4ts/flow/FlowRecorder`                            | `FlowRecorder.test.ts`                   | JSONL flight recorder                |
| CSP workspace and persistence contracts               | clean-spec black-box contracts                                  | `@llm4ts/runner/NodeWorkspace`, `NodePlainFileStore`   | `PersistenceWorkspace.test.ts`           | containment and atomic files         |
| `llm4zio/flow/GitTool.scala`                          | `GitToolSpec.scala`                                             | `@llm4ts/flow/GitTool`                                 | `GitTool.test.ts`                        | audited repository operations        |
| `llm4zio/flow/GhTool.scala`                           | `GhToolSpec.scala`                                              | `@llm4ts/flow/GitHubTool`                              | `GitHubTool.test.ts`                     | GitHub issue and pull-request bridge |
| `llm4zio/flow/AdoTool.scala`                          | `AdoToolSpec.scala`                                             | `@llm4ts/flow/AzureDevOpsTool`                         | `AzureDevOpsTool.test.ts`                | Azure DevOps HTTP bridge             |
| `llm4zio/flow/ReviewCache.scala`                      | `ReviewCacheSpec.scala`                                         | `@llm4ts/flow/ReviewCache`                             | `ReviewSurvey.test.ts`                   | content-addressed review cache       |
| `llm4zio/flow/SpecChecks.scala`, `Survey.scala`       | specification and survey specs                                  | `@llm4ts/flow/SpecChecks`, `Survey`                    | `ReviewSurvey.test.ts`                   | deterministic review evidence        |
| `llm4zio/flow/Pack.scala`, `Reviewer.scala`           | pack parser and reviewer specs                                  | `@llm4ts/flow/Pack`, `Reviewer`                        | `Pack.test.ts`, `Review.test.ts`         | review-pack configuration            |
| `llm4zio/flow/FlowTrace.scala`, `Replay*.scala`       | trace and replay specs                                          | `@llm4ts/flow/FlowRecorder`, `Replay`                  | `ReplayMermaid.test.ts`                  | versioned deterministic replay       |
| `llm4zio/flow/Mermaid.scala`                          | `MermaidSpec.scala`                                             | `@llm4ts/flow/Mermaid`                                 | `ReplayMermaid.test.ts`                  | pure flow visualization              |
| `llm4zio/flow/PriceList.scala`, `Cost*.scala`         | pricing, tracker, and ledger specs                              | `@llm4ts/flow/PriceList`, `CostTracker`, `CostLedger`  | `Cost.test.ts`                           | estimated cost and budgets           |
| `llm4zio/flow/Bench.scala`, `BenchReport.scala`       | benchmark and report specs                                      | `@llm4ts/flow/Bench`, `BenchReport`                    | `BenchReport.test.ts`                    | comparable benchmark artifacts       |
| `llm4zio/flow/Equiv.scala`, `EquivReport.scala`       | equivalence diff and report specs                               | `@llm4ts/flow/Equiv`, `EquivReport`                    | `Equiv.test.ts`                          | deterministic equivalence proof      |
| `llm4zio/runner/Llm4zio.scala`, `Flow.scala`          | script and embedding entry specs                                | `@llm4ts/runner/FlowRunner`, `Cli`                     | `FlowRunner.test.ts`                     | thin runner composition edge         |
| `llm4zio/runner/DefaultFlowContext.scala`             | default context and connector specs                             | `@llm4ts/runner/NodeRuntime`, `FlowRunner`             | `FlowRunner.test.ts`                     | Node boundary layer preset           |
| `llm4zio/runner/Terminal*.scala`, `FlowArgs.scala`    | terminal, verbosity, and argument specs                         | `@llm4ts/runner/Terminal`, `FlowArgs`                  | `Terminal.test.ts`, `FlowArgs.test.ts`   | safe interactive CLI                 |
| `llm4zio/flow/McpServer.scala`, runner MCP transport  | MCP protocol and transport specs                                | `@llm4ts/flow/McpServer`, `@llm4ts/runner/McpStdio`    | `McpServer.test.ts`, `McpStdio.test.ts`  | JSON-RPC stdio bridge                |
| `llm4zio/runner/ExampleFlow.scala`, source examples   | example integration specifications                              | `@llm4ts/flow/Flow`, `@llm4ts/examples`                | executable mock smoke example            | public API composition               |
| `examples/implement.sc`, `local.sc`                   | live connector integration behavior                             | `flows/implement.ts`, `flows/local.ts`                 | typed build + opt-in execution           | real coding-agent examples           |
| `examples/issue-pr.sc`, `sdd.sc`                      | issue delivery and executable SDD gates                         | `flows/issue-pr.ts`, `flows/sdd.ts`                    | typed build; live execution is opt-in    | persistent delivery examples         |
| `examples/modernize-*.sc` (7 scripts)                 | six-phase legacy modernization pipeline and its benchmark       | `flows/modernize-*.ts` (7 flows)                       | typed build; `flows/test/pack.test.ts`   | full modernization pipeline          |
| `examples/packs/*` (6), `examples/patterns/*`         | pack manifests, prompts, lenses, translation pattern cards      | `flows/packs/*` (6), `flows/patterns`                  | `flows/test/pack.test.ts`                | shipped reference packs              |
| `examples/fixtures/scaffolds/*` (4)                   | target-repository scaffolds seeded into an empty target         | `flows/fixtures/scaffolds/*` (4)                       | `flows/test/pack.test.ts`                | seeding a fresh target               |
| `llm4zio-flow/Wall.scala`, `Patterns.scala`           | clean-room wall enforcement, pattern-card selection             | `@llm4ts/flow/Wall`, `@llm4ts/flow/Patterns`           | `Wall.test.ts`, `Patterns.test.ts`       | target-phase safety and playbooks    |
| `examples/seed.sh`, `examples/starters/*`             | disposable runnable example repositories                        | `examples/seed.sh`, `examples/starters/*`              | Rust, Maven, and sbt starter builds      | example harness isolation            |
| `examples/judge-suite.sc`                             | repeated LLM-as-a-Judge example                                 | `flows/judge-suite.ts`                                 | typed build; live execution is opt-in    | evaluation example                   |
| `llm4zio-modernize/modernize/*.scala`                 | phase and artifact-resume behavior                              | `@llm4ts/modernize/Modernize`, `Approval`, `Artifacts` | `Modernize.test.ts`, `Artifacts.test.ts` | six-phase modernization product      |
| `llm4zio-java/javaapi/*.scala`                        | `JavaApiSpec.scala`, facade mock-flow behavior                  | `@llm4ts/js`, `@llm4ts/js/Client`                      | `Client.test.ts`, typed docs example     | language-friendly facade             |

## Accepted Adaptations

- Effect schema-backed tagged errors are yieldable JavaScript error values. This
  differs from Scala's non-`Throwable` ADT representation while preserving typed
  error-channel behavior, stable tags, fields, messages, and serialization.
- API keys are represented as `Redacted<string>` and JSON encoding is forbidden.
  This is stricter than the source `Option[String]` representation and implements
  the CSP secret-handling requirement.
- TypeScript optional properties represent Scala `Option` fields at public JSON
  boundaries. Missing values encode as absent keys rather than an `Option` ADT.
- Effect 4 `Context.Reference` provides the fiber-local ambient grant value. It
  replaces the source `FiberRef` while retaining lexical restoration, fork
  inheritance, and non-widening nested restrictions.
- Effect 4 `Stream.timeoutOrElse` supplies the source `timeoutFail` behavior;
  both timeout and heartbeat paths fail with the typed `TimeoutError`.
- Streaming rate configuration rejects non-positive or fractional rates with a
  typed `ConfigError` instead of allowing division-by-zero or invalid schedules.
- Transient retry is an Effect service decorator created from the underlying
  `LlmService` and `FlowEvents` service. It preserves the source's separate
  transient and flaky-stream budgets, visible notices, bounded retry-after
  handling, and whole-stream restart semantics.
- The token bucket is created as an unscoped Effect service because its `Ref`
  state owns no external resource or finalizer. Its acquisition, timeout, and
  metrics behavior remains source-compatible.
- Usage-limit wall-clock parsing accepts an IANA time-zone name and produces
  Effect `DateTime.Utc` values. This replaces the JVM `ZoneId`/`Instant`
  representation while retaining same-day/tomorrow rollover semantics.
- The default context summarizer declares an Effect `Crypto` requirement for
  UUID generation. Non-summary strategies require no crypto service, and callers
  can supply a deterministic summarizer for tests or alternate runtimes.
- Connector registrations are keyed by the stable `ConnectorId.value` string,
  rather than Scala object identity. Explicit fallback resolution walks the
  configured list from left to right and returns the first available connector;
  retry policy remains a separate concern.
- HTTP and process interfaces live in `core`, with recording implementations for
  deterministic tests. Node `fetch` and `child_process` integrations live in
  `runner`, preserving the backend-neutral dependency direction.
- The Node HTTP implementation uses `AbortSignal` cancellation and applies the
  configured timeout both to response acquisition and streaming pulls. GET and
  JSON POST require status 200, while the generic send operation accepts any 2xx
  response, matching the source distinction.
- Captured process execution preserves non-zero exit codes as result data.
  Streaming execution reports non-zero exits as typed provider failures with
  captured stderr, and early downstream termination kills the child process.
- Scoped process and HTTP test resources use Effect acquisition/finalization.
  Local integration tests bind only an ephemeral loopback port and require no
  external network or provider installation.
- OpenAI wire DTOs are schema-decoded at the HTTP/SSE boundary and remain in a
  provider-local module. Request builders are pure, API keys remain redacted
  until the authorization header is constructed, and secrets never appear in
  URLs or typed errors.
- OpenAI availability intentionally retains the pinned source behavior: a
  configured base URL reports available even when the `/models` probe fails.
  This surprising rule is protected by a parity test and may only change through
  an explicit divergence note.
- Anthropic messages and Gemini contents use provider-local schema classes even
  where the Scala source reuses a small `ChatMessage` DTO. This prevents their
  role and payload invariants from becoming accidentally coupled.
- Gemini response schemas apply decoding defaults for absent candidate arrays,
  preserving the source's safety-filtered empty-stream behavior. Gemini roles
  remain intentionally absent from history payloads because the pinned source
  sends content-only turns.
- Ollama preserves separate `/api/generate` and `/api/chat` paths. Final stream
  records carry usage only when both prompt and completion counts are present,
  and tool calling remains an explicit typed unsupported operation.
- LM Studio's input payload is a schema union of text and typed input arrays.
  Native structured requests use `/api/v1/chat`, while token streaming reuses
  only the genuinely shared OpenAI wire schemas at `/v1/chat/completions`.
- OpenCode deliberately preserves the source's buffered `postJson` SSE contract
  instead of silently changing it to the streaming HTTP primitive. Its parser is
  a named Effect operation and fails if no usable data records are present.
- Shared CLI helpers validate JSON lines with `Schema.Json`, sort passthrough
  flags deterministically, and produce the common tool/usage chunk metadata
  without unsafe casts.
- Codex strict output files use a scoped `TemporaryFiles` boundary in core and a
  Node implementation in runner. This preserves `--output-schema` while keeping
  filesystem ownership out of the backend-neutral connector package.
- Gemini CLI retains its provider-specific event ADT and executor boundary.
  Generic CLI settings project into its execution context, including the
  system-defaults turn cap; process execution stays injectable so tests require
  no installed Gemini binary.
- Positional prompt arguments remain only for source CLIs that expose no stdin
  prompt mode (Copilot, Antigravity, OpenCode, Grok, and Cursor). Claude, Codex,
  Pi, and Gemini process execution keep prompts on stdin.
- Tool method-schema derivation accepts both Scala-like and TypeScript-like
  signatures. Provider envelopes remain native, argument validation precedes
  body execution, capability denial is a tool-result value, and registry
  concurrency plus model/tool iterations are explicitly bounded.
- Evaluation values are Schema-backed immutable classes. Generic evaluation
  cases and reports remain structural TypeScript types because their arbitrary
  input parameter has no runtime schema; all values crossing the LLM judge
  boundary are schema-decoded.
- Effect 4 `Context.Reference` replaces the source `StreamRecorder` `FiberRef`
  and also carries correlation/span context. The richer metrics, tracing, and
  structured-log model comes from the CSP because the owned source currently
  exposes only the low-level stream-recorder hook.
- Observability sanitization recursively redacts sensitive field names, known
  secret values, and common credential patterns, then bounds message length.
  Metering and tracing finalizers preserve the original LLM result or typed
  failure.
- Plan paths use a stable FNV-1a identifier rather than Scala's JVM-specific
  `MurmurHash3`; determinism and per-prompt separation are the public contract.
  The bookkeeping directory is named `.llm4ts` while retaining the source's
  flat/local and namespaced/external-repository behavior.
- Filesystem effects are injected through `PlainFileStore` and `Workspace`
  services. The Node runtime supplies same-directory atomic replacement,
  SHA-256 hashing, lexical containment, physical symlink containment, bounded
  reads/writes/discovery/search, and sorted deterministic results.
- The generic versioned-document codec covers conversations, templates, traces,
  ledgers, caches, and reports without coupling their future domain schemas to
  Node I/O. Canonical source-compatible Markdown plans remain human-readable
  and independently resumable.
- Git tests use disposable real repositories. Read, write, and push operations
  require separate audited capabilities before process launch; checkpoints are
  commit identifiers and rollback is an explicit hard reset.
- GitHub preserves the source-compatible `gh` process protocol, while Azure
  DevOps uses the injected recorded HTTP boundary. Azure PATs remain redacted
  and are revealed only while constructing the authorization header.
- Review fingerprints are computed in the Node runtime with length-prefixed
  SHA-256 inputs. Backend-neutral cache logic receives only the digest, and
  corrupted entries are treated as misses rather than failed reviews.
- Trace lines now carry an explicit schema version and replay sorts by sequence
  before segmenting turns. Unlike the source's torn-line tolerance, malformed
  or unsupported recordings fail explicitly as required by the implementation
  plan; no provider service is involved during replay.
- Mermaid, benchmark, and equivalence reports are pure renderers. Base64url
  encoding uses web-standard byte primitives so the flow package remains
  independent of Node.
- Pricing preserves the pinned source rates and cached-input multiplier.
  Budget overruns are typed failures, while cost summaries and ledger values
  remain visibly marked as estimates with the pricing-table date.
- Equivalence observations use the public `type` discriminator from the source
  JSONL contract. Replay commands use the injected process boundary and require
  their exact `Exec` capability before launch.
- The embedded runner accepts explicit registry, process, file, terminal, and
  connector dependencies; the Node preset is only the outer composition edge.
  Scoped terminal, trace, and cost consumers drain before final output.
- MCP dispatch remains transport-free in `flow`. The Node runner makes stdio
  the baseline transport: notifications produce no line, every response is one
  compact JSON object, and no terminal or diagnostic text is written to protocol
  stdout.
- Terminal questions use stderr so they cannot contaminate protocol stdout.
  Control and ANSI sequences are stripped from dynamic event fields before tree
  rendering, and approval is an injected policy rather than ambient console I/O.
- The executable example is a separate workspace package and defaults to the
  deterministic mock connector, keeping examples runnable without credentials
  or installed provider CLIs.
- Runner composition now mirrors the source `DefaultFlowContext.prepare`
  boundary: API presets acquire missing default URLs and cloud credentials
  immediately before registry resolution, while CLI presets are rooted in the
  target repository. Explicit configuration wins, and keys become `Redacted`
  before entering provider code.
- Real examples are opt-in executable consumers of public APIs: HTTP streaming,
  resumable CLI implementation, issue-to-PR delivery, executable SDD gates, LM
  Studio plus pi local handoff, and repeated LLM-as-a-Judge scoring. Default CI
  still runs only mocked contract tests.
- The TypeScript reviewer model lives in its own dependency-free subpath and is
  re-exported by `Pack`. This avoids a runtime module cycle while preserving the
  source relationship between packs and reviewer lenses.
- Seeded example repositories keep the flow script in the llm4ts workspace and
  copy only the selected starter. Unlike the source harness, no local-publish
  mode is needed because pnpm workspace resolution supplies the implementation.
  Explicit destinations must be empty, and generated build artifacts are
  ignored before the baseline commit.
- Modernization persists an explicit versioned six-phase checkpoint document.
  A failed or process-interrupted phase is retried without rerunning completed
  predecessors; extraction specs, verification vectors, and implementation
  tasks retain their finer source-compatible resume units. The source exposes
  phases as separate commands, while the Effect product also supports a
  `through` boundary for deterministic orchestration and testing.
- The two owned-source human gates remain explicit: extraction requires an
  approved wave plan and seeding requires an approved specification-pack
  README. Modernization phase bodies are injected Effects, so provider,
  repository, and forge choices stay in public composition code and offline
  fixtures need no external services.
- All seven of the source's `modernize-*.sc` example scripts ship as runnable
  flows: `survey`, `extract`, `seed`, `implement`, `verify`, `review`, and
  `bench`. All six reference packs (`cobol-springboot`, `cobol-kafka`,
  `ace-integration`, `ace-kafka`, `jsp-bff-nextjs`, `jsp-nextjs`), all four
  scaffolds, the universal pattern cards, and `cobol-kafka`'s pack-local cards
  ship under `flows/`, validated per-pack by `flows/test/pack.test.ts`. The
  clean-room `Wall` and `Patterns` modules the target-side phases depend on
  are ported into `@llm4ts/flow` with their own deterministic tests.
  Remaining divergences:
  - Extraction artifacts come from one structured analyst call per program
    (`extractProgramsResumably`) rather than a free-roaming agent writing
    files itself. Resume, per-program commits, verdict caching, the
    shrinking-context judge ladder, pattern tagging, and turn-limit recovery
    all match the source.
  - Azure DevOps work-item creation (the source's optional "Boards" step in
    seed and review) is absent: `@llm4ts/flow/AzureDevOpsTool` reads and
    updates work items and opens pull requests, but has no create-work-item
    request. Both phases simply omit the step.
  - `modernize-bench` measures the extraction pipeline — the dominant cost of
    a wave, and what the survey's projection consumes — rather than also
    re-running implementation inside the harness as the source's 767-line
    script does. Its report and projection output are the same.
  - The source's per-phase model presets (a Gemini Pro/Flash split by seat)
    are replaced by the repository's own `LLM4TS_CODER` connector selection
    with a read-only derived reasoning seat, matching every other llm4ts flow.
  - The estate-reading phases (survey, extract, bench) open the legacy
    repository with `legacySourceWorkspaceLimits` — an 8 MiB per-file read
    cap instead of the 1 MiB workspace default, overridable with
    `LLM4TS_MAX_READ_BYTES`. The source scripts read files unboundedly; the
    Effect port keeps a cap but sizes it for real estates.
  - Pack resolution gains a fallback the source does not need:
    `LLM4TS_PACK` resolves against the launch directory first, then against
    the flow script's own directory (`@llm4ts/runner/Packs.openPack`), and an
    absolute path is used as-is. The built-in packs, universal pattern cards,
    and scaffolds ship inside `@llm4ts/shell`'s built-in flow tier, so
    `llm4ts run modernize-<phase>` works from any directory — the source's
    scripts are always launched from their own checkout.
- The JavaScript facade is asynchronous rather than a literal port of the
  source Java facade's blocking bridge. It is the single Promise/exception
  boundary, supports `AbortSignal`, delegates to the public connector registry,
  and rejects with a stable categorized `Llm4tsError`. Effect-facing packages
  retain typed errors.
- Published packages export generated JavaScript and declarations from `dist`
  only. npm provenance is enabled for tag releases. OCI publishing is omitted
  because this release has no image-level server contract.
- `@llm4ts/flow/GitHubTool` adds six work-queue operations with no source
  counterpart in llm4zio v4.2.0 `GhTool`: `listIssues`, `editIssueLabels`,
  `assignIssue`, `closeIssue`, and `createIssue` (added for consumer-side
  epic decomposition, where a triage agent turns one epic issue into child
  work items), `editIssueComment`, `viewOpenPr` (the open PR for the
  working directory's current branch), and `mergePr` (squash by default,
  optional branch deletion — the consumer-side continuous-delivery gate) —
  with `writeIssueComment` now
  returning the created comment's `IssueCommentRef` parsed from the gh
  output URL (undefined when absent; the source returned Unit) — so a
  consumer can keep a posted plan checklist up to date as tasks complete.
  This is an intentional additive extension (ADR 0008, as
  amended) using the same `gh` process protocol, args-builder style, and
  `GhRead`/`GhWrite` capability guards; existing operation behavior is
  unchanged. Back-porting the same operations to llm4zio is intended.
- `TokenUsage` carries an optional `costUsd` — the cost the backend itself
  reported (the Claude CLI's `total_cost_usd`, parsed by both the streaming
  connector and the agent session). The source models usage as token counts
  only. Cost consumers (`CostTracker` cells and summaries) prefer the
  reported figure over pricing-table estimates. The Claude result event's
  `modelUsage` single key also serves as a model-name fallback when no init
  line was observed.
- `implementPlanFlow` accepts `noopTaskPolicy: "fail" | "complete"`
  (default "fail", the source behavior): "complete" marks an unconfirmed
  no-change task complete with a notice instead of aborting, for pipelines
  whose final state is re-judged downstream (CI gate, fresh-context
  review). Driven by autonomous-loop runs repeatedly losing finished work
  to a coder that would not utter the confirmation token.
