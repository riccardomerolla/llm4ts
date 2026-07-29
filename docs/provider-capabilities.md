# Provider Capability Matrix

This matrix records the stable capabilities a flow may inspect before running a
connector. Runtime availability and authentication are reported separately by
`healthCheck`.

| Connector family              | Kind | Streaming | Structured output | Usage reporting | Interactive stdin | Resumable | Ask user | Approval |
| ----------------------------- | ---- | --------: | ----------------: | --------------: | ----------------: | --------: | -------: | -------: |
| OpenAI, Anthropic, Gemini API | API  |       yes |               yes |             yes |                no |        no |       no |       no |
| LM Studio, Ollama, Mock       | API  |       yes |               yes |             yes |                no |        no |       no |       no |
| Claude CLI                    | CLI  |       yes |               yes |             yes |               yes |       yes |      yes |      yes |
| Gemini, Codex, Pi CLI         | CLI  |       yes |               yes |             yes |               yes |        no |       no |       no |
| Antigravity CLI               | CLI  |       yes |               yes |              no |               yes |        no |       no |       no |
| OpenCode, Grok CLI            | CLI  |       yes |               yes |             yes |                no |        no |       no |       no |
| Copilot, Cursor CLI           | CLI  |       yes |               yes |              no |                no |        no |       no |       no |

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
