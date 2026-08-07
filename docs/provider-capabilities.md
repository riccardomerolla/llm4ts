# Provider Capability Matrix

This matrix records the stable capabilities a flow may inspect before running a
connector. Runtime availability and authentication are reported separately by
`healthCheck`.

| Connector family              | Kind | Streaming | Structured output | Usage reporting | Interactive stdin | Resumable | Ask user | Approval | Read-only |
| ----------------------------- | ---- | --------: | ----------------: | --------------: | ----------------: | --------: | -------: | -------: | --------: |
| OpenAI, Anthropic, Gemini API | API  |       yes |               yes |             yes |                no |        no |       no |       no |  enforced |
| LM Studio, Ollama, Mock       | API  |       yes |               yes |             yes |                no |        no |       no |       no |  enforced |
| Claude CLI                    | CLI  |       yes |               yes |             yes |               yes |       yes |      yes |      yes |  enforced |
| Codex, Pi CLI                 | CLI  |       yes |               yes |             yes |               yes |        no |       no |       no |  enforced |
| Gemini CLI                    | CLI  |       yes |               yes |             yes |               yes |        no |       no |       no |  advisory |
| Antigravity CLI               | CLI  |       yes |               yes |              no |               yes |        no |       no |       no |  advisory |
| OpenCode, Grok CLI            | CLI  |       yes |               yes |             yes |                no |        no |       no |       no |  advisory |
| Copilot, Cursor CLI           | CLI  |       yes |               yes |              no |                no |        no |       no |       no |   ignored |

The OpenCode HTTP compatibility provider exists as a direct API adapter, but the
stable `opencode` registry identifier deliberately resolves to the CLI connector
to match the reference release.

Prompt transport is provider-specific. Claude, Codex, Pi, and Gemini execution
use stdin. Copilot, Antigravity, OpenCode, Grok, and Cursor retain positional
prompts because their source-compatible headless commands require them. Secrets
remain in environment variables or HTTP headers and are never rendered into
argv.

Usage reporting means the connector parses token counts from its backend and
attaches them to streamed chunks; flows publish them as `TokensUsed` events,
which feed cost summaries and `CostBudget` enforcement. Connectors marked "no"
accrue nothing — a cost budget cannot trip for runs driven only by them, and
their cost summary states that usage was not reported.

Read-only (`capabilities.readOnlyEnforcement`) grades how honestly a
connector's `readOnly` mapping restricts its harness (ADR 0010):

- **enforced** — a real capability removal: the write tools are absent from
  the harness's advertised surface. Claude gets a `--tools Read,Grep,Glob,Skill`
  allowlist (plan mode removes no tools, and a denylist misses `Bash` and MCP
  tools by construction); Codex runs under an OS-level `read-only` sandbox; Pi's
  `--tools read` is its documented tool-name allowlist. API providers execute
  no tools at all, so read-only holds vacuously.
- **advisory** — an approval/permission MODE the harness may not treat as a
  capability gate (Gemini `--approval-mode plan`, Grok `--permission-mode
plan`, OpenCode `--agent plan`, Antigravity `mode: plan`). Upgrading a
  connector to enforced requires observing the harness's advertised tool list
  with and without the flag, not the flag's name.
- **ignored** — the flag reaches no argv (Copilot), or maps only to an
  approval default indistinguishable from ignored in headless runs (Cursor).

Requesting `readOnly` from a non-enforced connector publishes a
`CapabilityUnenforceable` flow event naming the connector and its grade, so
runs never silently trust a request-shaped restriction. Reviewer seats that
must not write should be picked on this capability.
