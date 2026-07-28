# Non-Functional Requirements

## Reliability

- Expected failures must be typed values, not process crashes or panics.
- Flow progress must be durable after each successful task so a rerun can resume.
- Transient provider failures should be retried under a bounded policy, with fail-fast available.
- Usage caps should be waitable only when explicitly enabled and bounded by max wait and max re-entry count.
- External commands must run non-interactively in headless contexts and fail fast on prompts they cannot answer.
- Terminal consumers should drain final events before teardown, within a bounded timeout.
- Live processes and terminal animation must be scoped and cleaned up on interrupt or failure.

## Security

- API keys, personal tokens, OAuth tokens, and environment credentials must never be written to logs, terminal output, argv, plan files, or generated summaries.
- Workspace tools must reject path traversal after normalization.
- Terminal output must strip control sequences from all untrusted backend, tool, and model text.
- Read-only reasoning mode must prevent edit-capable CLI behavior where the backend supports such controls.
- Runtime-owned Git should be the default safety boundary: coding agents edit files, while branch/commit/push are performed by runtime tools.
- MCP tools exposed to coding agents should be allowlisted explicitly.
- Approval decisions must be explicit data: allow or deny with reason.

## Performance

- Streaming must support backpressure through bounded buffering where requested.
- Review loops should allow concurrent reviewer calls by default and an explicit parallelism cap for rate-limited backends.
- Metrics snapshots should cap retained request rows/latencies to avoid unbounded memory growth.
- Terminal rendering should serialize writes without busy waiting. Animation tick should be modest and disabled in plain mode.
- Tool discovery/search should respect max result limits and file-size limits.
- Rate limiter should support burst capacity and time-based refill.
- Slow local model servers must not be disconnected by idle timeout before the configured request timeout.

## Operability

- Runner prints a startup banner with version and log path.
- Full diagnostic details should go to the file log; console output should remain concise and user-facing.
- Color/animation auto-disable in non-TTY or no-color contexts.
- Logs should receive plain text without color escape sequences.
- Usage and cost summaries should be clearly marked as estimates when prices are inferred from a local table.
- Provider health checks should be cheap where possible and should not require generating content if a model-list endpoint exists.
- Environment parsing should have safe defaults and clear behavior for invalid values.

## Compatibility

- API connectors should expose stable neutral behavior even when backend wire formats differ.
- The connector registry should preserve all supported provider categories: hosted APIs, local HTTP servers, CLI agents, and mock.
- The Rust implementation does not need to reproduce source-language module names, prompts, exact plan-file syntax, exact hash algorithm, or internal helper names.
- Public flow semantics, typed errors, data shapes, and black-box behavior are the compatibility target.

## Testability

- HTTP client, process executor, clock/timer, event sink, interaction channel, metrics collector, and conversation stores should be replaceable in tests.
- Request builders and parsers for external tools should be pure where practical.
- Tool execution should be testable with in-memory registries and bounded workspaces.
- Runner behavior up to process exit should have a pure or async-testable core separate from the top-level entrypoint.

## UX

- Flow scripts should read top-to-bottom: resolve plan, branch, code, review, commit, push/PR.
- Common context members should be easy to access from a flow body without ceremony, though exact Rust ergonomics are a build-team decision.
- Review findings should be structured enough for both humans and the coder agent.
- Missing prompts, missing config, unsupported connector capabilities, and usage-limit waits should produce actionable messages.
- Human-interaction prompts should suspend terminal status rendering so input is clean.
