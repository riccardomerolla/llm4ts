# Effects And Errors

## Effect Capabilities

The Rust implementation should expose or internally provide these capabilities:

- HTTP client: async GET, JSON POST, arbitrary method request, line streaming, and SSE streaming.
- Process runner: async command execution, streaming stdout lines, stdin-fed execution, bidirectional held sessions, working directory, and environment overlay.
- Filesystem: bounded plan persistence, temporary files for schemas or MCP config, workspace-safe tool access, and log files.
- Clock/timer: timeouts, retry backoff, rate limiting, usage-limit sleeps, latency metrics, timestamps, and terminal animation.
- Random/id generation: conversation message ids, checkpoint ids, trace/span ids, correlation ids when none are supplied.
- Terminal I/O: optional user prompts, sanitized output, color detection, plain fallback, and serialized writes.
- Event hub: bounded broadcast queue with subscriber support and published-count tracking.
- JSON codec/schema: encode/decode public shapes and derive or accept JSON schemas for structured output.
- Environment reader: connector selection, retry settings, usage-wait policy, provider credentials, Azure DevOps config, and optional formatter/lint commands.

## LLM Error Union

Expected LLM failures should be values, not panics:

```text
LlmError =
  ProviderError(message, cause?)
  | UsageLimitError(resetAt?, provider, message)
  | AuthenticationError(message)
  | InvalidRequestError(message)
  | ParseError(message, raw)
  | ToolError(toolName, detail)
  | ConfigError(message)
  | RateLimitError(retryAfter?)
  | TimeoutError(duration)
  | TurnLimitError(limit?)
```

Rules:

- Every variant must expose a non-empty human-readable message.
- The error union itself should not be implemented as an exception class hierarchy. Underlying runtime exceptions may be attached as causes only at the boundary.
- Parse errors retain the raw response for diagnostics, but raw content should not be rendered to the terminal without sanitization.
- Usage-limit errors carry provider name and optional reset instant. Rate-limit errors carry optional retry duration.
- Tool errors name the tool and describe the failure.

## Flow Error Union

Flow-level failures should be values:

```text
FlowError =
  Persistence(message, cause?)
  | PlanParse(message)
  | Aborted(message)
  | Process(message, detail)
  | Llm(message, cause?)
```

Rules:

- Persistence covers plan/file read/write/delete failures.
- Plan parse covers malformed persisted plan documents.
- Aborted means deliberate user/library abort, not infrastructure failure.
- Process covers external process or CLI failures that are not recoverable outcomes.
- LLM wraps LLM-layer failures and should preserve the typed cause when available.

## Tool Execution Errors

```text
ToolExecutionError =
  InvalidSchema(message)
  | InvalidParameters(message)
  | DuplicateToolName(name)
  | SandboxViolation(message)
  | ExecutionFailed(message)
  | SchemaGenerationFailed(message)
```

Rules:

- Duplicate registration fails before mutating the registry.
- Invalid arguments fail before executing the tool body.
- Workspace path escape attempts fail with a sandbox violation.
- Execution failure is used for filesystem/process failures inside a tool.

## Context Errors

```text
ContextError =
  InvalidInput(message)
  | ParseFailed(message)
  | SummarizationFailed(message)
  | ToolLoopFailed(message)
```

Invalid max token limits and attempts to summarize empty message sets must fail with invalid input.

## Rate Limiting

- Token-bucket rate limiting has `acquire`, `tryAcquire`, and `metrics`.
- Invalid configuration means non-positive request rate, burst size, or acquire timeout.
- `tryAcquire` returns false for invalid config or unavailable token and does not fail.
- `acquire` waits until a token is available or fails with acquire timeout.
- Metrics track total requests, throttled requests, and current token count.

## Retry Semantics

- Retry policy has max attempts, base delay, maximum delay, and jitter factor.
- Retryable LLM errors: timeout, rate limit, and provider errors that may be transient.
- Non-retryable LLM errors: authentication, invalid request, parse, tool, config, and usage cap.
- Flow-level transient retry emits an information event for each retry after a transient stream failure.
- Retry count zero means exactly one attempt and no retry notice.
- Persistent transient failures fail after the configured retry budget.

## Usage-Limit Waiting

- Disabled policy fails fast with the original usage-limit error.
- Enabled policy with a reset instant sleeps until reset plus a small buffer, unless that would exceed max wait.
- Enabled policy without a reset instant sleeps by poll interval and retries until success or max wait.
- Flow-level usage-limit retry can re-enter the whole flow a bounded number of times.
- Waiting emits an information event that identifies the provider and approximate wait duration without exposing secrets.

## Cancellation And Resource Lifetimes

- Async streams must be interruptible or cancellable.
- Cancellable stream helper returns both the stream and a cancel action; invoking cancel interrupts future stream output.
- Held bidirectional processes are scoped. Closing the scope kills the child process and closes stdin/stdout resources.
- Live agent sessions expose explicit cancel and should also clean up on scope closure.
- Terminal animation fibers and event consumers are scoped; shutdown clears the status line and drains final events within a timeout.
- Temporary schema/config files should be deleted when their scope exits where practical. Log files are intentionally persistent for inspection.

## Process And Command Effects

- External commands run in the configured working directory.
- Environment overlays merge onto the inherited environment, with explicit overlay values winning.
- `run` captures stdout, stderr, and exit code without failing on non-zero exit. Failure to launch fails the effect.
- `runOrFail` fails on non-zero exit and includes a useful problem detail.
- CLI LLM prompts should be passed through stdin where implemented to avoid command-line length limits.
- Git commands must run non-interactively and fail fast on credential/passphrase prompts.

## HTTP Effects

- HTTP requests fail with typed errors, not panics, on invalid URLs, auth failure, rate limits, client errors, server errors, body parse errors, and timeout.
- Generic method requests accept any 2xx status as success.
- Hosted provider credentials must be passed as headers, not logged or embedded in errors.
- Slow local backends must be allowed to remain silent up to the per-request timeout.

## Observability Effects

- Metrics and tracing wrappers must preserve the underlying result/error.
- A metered LLM client records request count, latency, and errors for all operations; token usage is recorded when chunks/responses expose usage.
- Structured logging must use correlation ids and sanitize or redact large payloads based on configuration.
- Terminal rendering must sanitize all untrusted text before display.

## Secrets

The CSP intentionally contains no API keys, tokens, credentials, internal URLs, customer data, account ids, or private fixture data. The Rust implementation must ensure secrets read from environment or config are never printed in argv, logs, flow events, terminal output, or generated plan files.
