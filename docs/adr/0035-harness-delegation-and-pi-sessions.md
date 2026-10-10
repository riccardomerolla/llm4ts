# ADR 0035: Harness Delegation, pi Sessions, And Staying On The pi CLI

Status: Proposed · Date: 2026-10-10 · Extends ADR 0010, ADR 0016 and ADR 0019

## Context

The three CLI harnesses llm4ts drives delegate to their own sub-agents by
default in headless mode: Claude Code's built-in agents under `-p`, Codex's
`features.multi_agent` (stable, on), Gemini CLI's `experimental.enableAgents`
(on). llm4ts neither asks for it nor sees it: the chunk and tool-use types
carry no parent id, the Codex parser drops `collab_tool_call` items, and
Gemini emits an agent as one tool call. Claude's read-only seats cannot
delegate because the tool allowlist (ADR 0010) excludes `Agent`; a Codex or
Gemini read-only judge can, inside its sandbox, with no cost bound.

pi moved to `@earendil-works/pi-coding-agent` (1.1.0 on 2026-10-07) and
llm4ts pins no version of it. Since 1.0.4 `--tools read` keeps MCP tools, so
a read-only pi seat can call any write tool in `~/.pi/agent/mcp.json`. Since
0.99.0 `--no-extensions` also disables the built-in llama.cpp provider. pi
also gained `--session-id` (create or resume), `--no-session`, priced usage
on every message, `agent_settled`, per-tool durations, `pi auth check`, and
an in-process SDK (`createAgentSession`). llm4ts runs every pi turn as a
fresh `pi -p` with the chat's history flattened into the prompt; the
streaming path already uses `--mode json`, the non-streaming `complete`
still parses plain text.

## Decision

0. **Patch first, before anything else here.** The pi read-only argv adds
   `--no-mcp`; `versionProbe` enforces a floor of 1.0.4 as it does 0.37.0
   for Gemini; `isolated` adds `-e builtin:llama.cpp` when the model's
   provider is `llama.cpp`; the prompt follows `--`. Docs point at the new
   repository and package. This ships as a patch release on its own.
1. **A typed delegation knob per executor.** The roster entry gains
   `delegation: { enabled?, maxConcurrent?, maxDepth? }`. The connector maps
   it to the harness: Claude `--disallowedTools Agent`,
   `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`;
   Codex `-c agents.enabled`, `-c agents.max_concurrent_threads_per_session`,
   `-c agents.max_depth`; Gemini `experimental.enableAgents` through the
   settings file llm4ts already injects, with per-agent turn limits. Where a
   harness has no knob for a bound, the bound goes into the prompt as one
   line. Reviewer, judge, verifier and planner seats always run with
   delegation disabled.
2. **Coder seats keep the harness default.** `enabled` unset means the
   harness decides, as today, so no run changes behavior; the dashboard now
   shows what happens (ADR 0033, decision 5). A tighter default is a later
   decision, taken from the ledger.
3. **Sub-agents are not leased and not slots.** The harness owns those
   processes; their tokens come from its usage report (Claude `modelUsage`,
   Codex `turn.completed`, Gemini `result.stats`) and land on the lease that
   spawned them in the cost ledger.
4. **One pi session per chat.** A pi call carries
   `--session-id llm4ts-<run>-<chat>` and `--session-dir` under the run's
   state, so every turn of a chat resumes the previous one instead of
   re-sending a flattened history: pi keeps the context, its compaction and
   the provider's prompt cache. The chat is still the unit (ADR 0003): a
   task's chat is one pi session, the next task's is another. Reviewer,
   judge and structured calls pass `--no-session`. The other CLI harnesses
   follow when their resume flags are wired, as a follow-up.
5. **The pi CLI stays the integration; the SDK is not adopted.** The SDK
   runs pi in llm4ts's process: pi's runtime and provider clients would
   become dependencies of `@llm4ts/core`, read-only and isolation would be
   enforced by code llm4ts calls instead of by the argv it can test, a pi
   crash would take the run down, and the SDK documents no stability
   guarantee. Everything the tree needs is on `--mode json`. If per-chat
   resume proves insufficient, the next step is pi's RPC mode (one
   long-lived process per chat with `steer` and `abort`), not the SDK.
6. **Smaller pi wins, in the same release as 4.** `complete` switches to
   `--mode json` so usage and errors are typed on both paths; `cost.total`
   and `cacheWrite` map to `TokenUsage`; `--thinking max` is passed through;
   `pi auth check --model` becomes the executor's readiness probe; headless
   seats set `--offline` and `PI_SKIP_VERSION_CHECK=1`.

## Consequences

- A read-only pi seat on pi older than 1.0.4 is refused, as Gemini is below
  0.37.0; the error names the floor.
- Delegation bounds differ per harness, and Gemini has no concurrency knob,
  so `maxConcurrent` is advisory there. The capability table in
  `docs/provider-capabilities.md` records the grade per harness.
- Per-chat sessions leave pi JSONL files under the run's state; they are
  llm4ts's to clean, not `~/.pi/agent/sessions`.
- The SDK decision is reversible: a connector over the SDK would sit behind
  the same `Connector` interface. It is recorded so the question is not
  reopened without the four reasons above being answered.
- Diverges from `llm4zio` v4.2.0 (no delegation knob, no pi sessions);
  this ADR is the record.
