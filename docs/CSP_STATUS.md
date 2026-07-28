# CSP implementation status

This status applies to the Effect-TS workspace. The repository owner authorized
the permissive clean-room strategy: the CSP remains the architectural contract,
and the owned `llm4zio` v4.2.0 source and tests may be consulted to refine
behavior and verify parity.

## Implemented

- Schema-backed public models and typed errors.
- Streaming, structured output, retries, limits, context management, and
  conversations.
- API providers for OpenAI, Anthropic, Gemini, Ollama, LM Studio, OpenCode, and
  the deterministic mock.
- CLI connectors for Claude, Codex, Gemini, Copilot, Pi, Antigravity, OpenCode,
  Grok, and Cursor, including held Claude sessions.
- Tool declaration/selection/execution, evaluation and judge layers, metrics,
  tracing, recording, structured logging, and redaction.
- Capability-aware workspaces, plans, persistence, Git, GitHub, Azure DevOps,
  review packs, surveys, provenance, replay, Mermaid, costs, benchmarks, and
  equivalence.
- Node runner, terminal, JSON-RPC MCP stdio, CLI, and executable examples.
- Six-phase resumable modernization product and its human approval gates.
- Promise/exception JavaScript facade.
- npm package metadata, generated declarations, documentation, CI, and release
  automation.

## Intentional boundaries

- MCP stdio is the baseline transport. An HTTP/SSE deployment transport is not
  part of the initial release.
- No OCI image is produced because the release is a library plus Node CLI, not a
  deployable server.
- Live-provider and live-forge checks remain opt-in; the deterministic suite
  requires no credentials, network, or installed provider CLI.

Detailed source mappings and adaptations are recorded in
[`parity.md`](parity.md).
