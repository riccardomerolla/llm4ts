# ADR 0016: A Gemini-CLI ACP Bridge For CLI Connectors That Can't Carry Credentials

Status: Accepted · Date: 2026-09-17

## Context

A bank customer can run only `gemini-cli` for now (procurement allows a
Google AI Pro/Ultra subscription via `gemini-cli`'s own OAuth login; it
allows neither a `GEMINI_API_KEY` nor a Vertex service account). `gemini-cli`
itself is adequate for reasoning/analysis but a weak coding agent; `pi` is a
stronger coding agent the customer would rather use, but `pi` needs its own
model credential and this account has none to give it — its only paid
access to any model is the OAuth session already sitting inside `gemini-cli`.
`gemini-cli` itself is a stopgap the customer expects to retire once "agy"
ships.

llm4ts's CLI connectors (`makeCliConnector`, `packages/core/src/Connector.ts`)
already solve "don't manage tokens" for the reasoning/analysis half of this:
`GeminiCliProvider` shells out to the installed `gemini` binary per call and
inherits whatever OAuth session the environment has — llm4ts never sees a
credential. That part of the ask needed no new work.

The unresolved half is making `pi` draw its inference from that same OAuth
session instead of a model API key. `pi` (`packages/core/src/providers/PiConnector.ts`
already wraps this binary) supports a custom model provider via a static,
global config file (`~/.pi/agent/models.json`, `{"providers": {"name":
{"baseUrl", "api", "models"}}}`), not a per-invocation override. A prior-art
extension, `pi-gemini-cli-provider`, solves the same problem by spawning
`@google/gemini-cli-a2a-server` — a separate, pinned, patched npm package
speaking Google's A2A protocol over HTTP/SSE, built for gemini-cli to
delegate to _remote subagents_, not for a third party to impersonate a
client of gemini-cli's own service. A Google maintainer's comment (cited in
that project's README) treats that reuse as legally ambiguous.

Gemini CLI separately exposes ACP (Agent Client Protocol — `gemini
--experimental-acp`), a JSON-RPC 2.0 session over stdio built into the base
binary for exactly this purpose: third-party tool/editor integration
(Zed, IntelliJ). No extra package, no pinned/patched dependency, and the
maintainer comment above calls ACP-based integration "a legitimate use."

`packages/core/src/providers/ClaudeAgentSession.ts` already implements the
shape this needs: a long-lived, bidirectional, JSON-line stdio session
(`ProcessExecutorShape.runBidirectional`, scoped to `Scope.Scope`) driving a
generic `AgentSessionShape` (events, `sendUserMessage`, `respondToApproval`,
`awaitResult`, `cancel`). `packages/flow/src/McpServer.ts` already implements
a transport-agnostic MCP tool server (`McpTool`, `handleMcpRequest`) that
`packages/runner/src/McpStdio.ts` serves over stdio today.

## Decision

### Scope

Plumbing only. No new kit, no retuned prompts — `mainframe-java` and
`j2ee-nextjs` run unchanged. This is core/runner/shell infrastructure, not
stack-specific material under ADR 0014's kit contract (a kit is
`packs/`/`scaffolds/`/`patterns/`/`flows/`; there is no pack content here).
If gemini turns out to need retuned prompts, that is a separate, later kit.

llm4ts's own reasoning/analysis flow steps keep using the existing one-shot
`GeminiCliProvider`; `GeminiAcpSession` gets **no** `ConnectorId` and is not
selectable from a flow. It exists solely as machinery the bridge (below)
consumes internally. The "use gemini-cli directly for reasoning" half of the
business case was never broken and doesn't need ACP's complexity.

### Protocol: ACP, not A2A

`GeminiAcpSession` (`packages/core/src/providers/GeminiAcpSession.ts`)
extends the `ClaudeAgentSession.ts` seam: `runBidirectional` spawns `gemini
--experimental-acp`, and the session speaks the ACP JSON-RPC methods
(`initialize`, `session/new`, `session/prompt`, `session/update`
notifications, `session/request_permission`). It advertises
`clientCapabilities.fs: { readTextFile: false, writeTextFile: false }` so
gemini cannot read or write files directly — every action must go through
the MCP tool bridge (below), which routes execution back to `pi`. Any
`session/request_permission` for a tool call is auto-approved by default (an
optional policy hook exists for callers that want otherwise): the actual
safety decision belongs to `pi`'s own approval policy on the executing side,
not to gemini.

Field shapes are best-effort against public ACP docs
(`geminicli.com/docs/cli/acp-mode`, `agentclientprotocol.com`) — this
codebase's tests exercise the parsing/correlation logic against a scripted
fake peer, the same posture `ClaudeAgentSession.test.ts` already takes
against a fake `claude` process, not against the real `gemini` binary
(consistent with "CI must not need network access, provider credentials, or
installed provider CLIs"). The first live run against a real installed
`gemini` should be treated as an integration smoke test, not a substitute
for that determinism.

### The bridge: an Anthropic-Messages-shaped local HTTP proxy

`packages/runner` gains a bridge module (parallel to `NodeGeminiCliExecutor.ts`
and `NodeHttpClient.ts`, built on `node:http` — no new HTTP-framework
dependency) exposing two routes on one local server:

- `POST /v1/messages` — Anthropic Messages API shape. This is what `pi`'s
  `~/.pi/agent/models.json` custom-provider entry points at
  (`"api": "anthropic-messages"`). Anthropic's shape was chosen over
  OpenAI-completions because ACP's own tool-call events are already
  content-block-shaped, closer to Anthropic's `tool_use`/`tool_result`
  blocks than to OpenAI's `tool_calls` array, and this codebase already has
  a mature Anthropic-shaped vocabulary to extend (`AnthropicProvider.ts`).
  That route must stream. pi's bundled Anthropic SDK sets `stream: true` on
  every request with no compatibility flag to disable it, so a single JSON
  body — which is what the first implementation wrote — is unusable by the
  one client this bridge exists for. ACP resolves a turn as a whole rather
  than as a token stream, so the bridge emits a well-formed but coarse event
  sequence: `message_start` goes out before the turn resolves (keeping the
  connection live while gemini works), then one `content_block_delta`
  carrying the entire text, or a `tool_use` block whose arguments arrive as a
  single `input_json_delta`. A failure after `message_start` can only be
  reported as an in-band `error` event, never a status code.

- `POST /mcp` — MCP over HTTP, using `@llm4ts/flow/McpServer`'s
  transport-agnostic `handleMcpRequest`/`McpTool`. `gemini --experimental-acp`
  is told about this endpoint via `session/new`'s `mcpServers: [{"type":
"http", "url": "..."}]` (ACP's `session/new` schema supports both a
  spawned-stdio and an HTTP MCP server; HTTP means no extra subprocess).

`GeminiAcpSession` is core (no `@llm4ts/flow` dependency, per the package
graph); `McpServer`/`McpTool` are flow. The bridge module living in `runner`
is the only place that can see both, so it is also the only place that can
own the pause/resume coordination below — `GeminiAcpSession` itself stays
ignorant of MCP and of pi's tools.

### Tool-call pause/resume, and why it needs one shared outcome slot

pi's own tool loop (Read/Edit/Bash), not gemini's, must execute every tool
call — that is the entire point of "pi for coding, gemini's subscription
for the model". The bridge achieves this by registering pi's tool
definitions (translated from the Anthropic `tools` array on the first
`/v1/messages` request of the run, held static for the run) as `McpTool`s
whose `call` handler does not execute anything: it records the pending call
and blocks on a fresh `Deferred` until a result is supplied.

The Anthropic Messages API is stateless request/response (pi resends full
history each turn, there is no held-open stream from pi's side), so the
bridge coordinates across two unrelated-at-the-transport-level HTTP
requests using one shared `Deferred<AcpTurnOutcome, LlmError>` per turn,
created by the `/v1/messages` handler and reachable by the MCP handler
through a `Ref`:

- A fresh user turn calls `session.prompt`; when its ACP response resolves
  with final text, the handler resolves the turn's `Deferred` with
  `{ _tag: "Text", text }`.
- If gemini instead calls one of the bridged MCP tools mid-turn (which
  happens strictly before `session.prompt`'s own JSON-RPC response, since
  the tool call is part of processing that prompt), the MCP handler resolves
  the _same_ `Deferred` with `{ _tag: "ToolUse", id, name, input }` first —
  `Deferred` resolution is first-write-wins, so whichever side concludes the
  turn decides the HTTP response, with no explicit race needed.
- A continuation turn (pi's next request carries a `tool_result` block)
  resolves the pending tool's own per-call `Deferred` with that result
  (unblocking the paused MCP handler and letting gemini's reasoning
  continue), then creates a **new** turn `Deferred` and waits on it exactly
  as above — no new `session/prompt` call, because gemini's original prompt
  call is still in flight, blocked on the MCP tool it called.

### Lifecycle: scoped to the flow run, fixed port, fail fast

The bridge process is started and torn down within the Effect `Scope` of
the `pi`-coding flow run that needs it — not a detached daemon outliving any
one run, matching every existing long-lived-subprocess pattern in this
codebase (`runBidirectional`, `Effect.acquireUseRelease` in `McpStdio.ts`).
An env var (`LLM4TS_GEMINI_BRIDGE`, boolean-ish, matching the `truthy()`
convention in `Doctor.ts`) opts a `pi`-coder run into starting it.

Because `~/.pi/agent/models.json` is static and global, the bridge cannot
bind an ephemeral port per run — it binds a **fixed**, documented port
(`LLM4TS_GEMINI_BRIDGE_PORT`, default `8731`) that the user points pi's
config at once, outside any flow run. Concurrent flow runs sharing one
bridge are **unsupported in v1**: a run that finds the fixed port already
bound fails fast with a clear error rather than attempting refcounted
cross-process ownership. This is an accepted, documented limitation for a
single enterprise customer on a single subscription, not a general-purpose
service.

`llm4ts doctor` (`packages/runner/src/Doctor.ts`) gains a prerequisite check
that reads `~/.pi/agent/models.json` (when present) and reports whether a
provider entry's `baseUrl` matches the configured bridge port —
**detect-and-report only**. It never writes that file: it belongs to `pi`,
outside llm4ts's package graph and ownership, and auto-writing a global
config file another tool owns is a larger blast radius than anything else
in this design.

### Non-issues, satisfied by construction

- Credentials never touch llm4ts: ACP is just another mode of the same
  OAuth-authenticated `gemini` binary the one-shot connector already uses.
- Malformed/empty-response hardening reuses the existing classification
  machinery (`geminiQuotaDiagnostic`, `geminiLoopDiagnostic`,
  `failClassifiedCliError` in `CliSupport.ts`) rather than a parallel
  implementation for the ACP path.

## Consequences

- `packages/core` gains `providers/GeminiAcpSession.ts` (and its ACP
  message parsing) with no new `ConnectorId`, no `ConnectorFactories.ts`
  change, and no flow-visible selection surface.
- `packages/runner` gains the bridge module and its `node:http` server, and
  a new `geminiBridgePrerequisites`-style check in `Doctor.ts`.
- `makeFlowRunnerContext` acquires the bridge in the run's scope when
  `LLM4TS_GEMINI_BRIDGE` is set and a seat uses `pi`, and rewrites those
  seats' model. Reading pi's config lives in `PiModels.ts` rather than
  `Doctor.ts`, which imports the runner and so cannot be imported by it.
- The bridge's server implementation is written to be reusable as a
  standalone, longer-lived service later (a `shell` CLI entry point, e.g.
  `llm4ts bridge start`, for other Anthropic/OpenAI-API-shaped tools to
  point at) without changing its internals — only its caller changes. That
  entry point is explicitly deferred, not built now.
- Multi-run concurrency, if it turns out to be needed, is future work
  requiring real cross-process coordination (a refcounted lock/pidfile) —
  deliberately not built until there's evidence it's needed.
- If gemini's output quality genuinely requires retuned prompts for the
  existing packs, that becomes a real ADR-0014 kit at that point, sibling to
  `mainframe-java`/`j2ee-nextjs`, not a retrofit of this ADR.
