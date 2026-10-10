# Provider Capability Matrix

This matrix records the stable capabilities a flow may inspect before running a
connector. Runtime availability and authentication are reported separately by
`healthCheck`.

| Connector family              | Kind | Streaming | Structured output | Usage reporting | Interactive stdin | Resumable | Ask user | Approval | Read-only | Effort                                     | Isolated headless |
| ----------------------------- | ---- | --------: | ----------------: | --------------: | ----------------: | --------: | -------: | -------: | --------: | ------------------------------------------ | ----------------- |
| OpenAI, Anthropic, Gemini API | API  |       yes |               yes |             yes |                no |        no |       no |       no |  enforced | OpenAI, Anthropic: mapped; Gemini: ignored | ignored           |
| LM Studio, Ollama, Mock       | API  |       yes |               yes |             yes |                no |        no |       no |       no |  enforced | ignored                                    | ignored           |
| mlx-lm                        | API  |       yes |               yes |             yes |                no |        no |       no |       no |  enforced | ignored                                    | ignored           |
| Claude CLI                    | CLI  |       yes |               yes |             yes |               yes |       yes |      yes |      yes |  enforced | mapped                                     | enforced          |
| Codex, Pi CLI                 | CLI  |       yes |               yes |             yes |               yes |        no |       no |       no |  enforced | mapped                                     | partial           |
| Gemini CLI                    | CLI  |       yes |               yes |             yes |               yes |        no |       no |       no |  enforced | ignored                                    | partial           |
| Antigravity CLI               | CLI  |       yes |               yes |              no |               yes |        no |       no |       no |  advisory | ignored                                    | ignored           |
| OpenCode, Grok CLI            | CLI  |       yes |               yes |             yes |                no |        no |       no |       no |  advisory | ignored                                    | ignored           |
| Copilot, Cursor CLI           | CLI  |       yes |               yes |              no |                no |        no |       no |       no |   ignored | ignored                                    | ignored           |

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
measure nothing of their own. The runner meters every seat with
`EstimatedUsage`, so those runs still accrue — from character counts, under
the model label `estimated:<model>`, which no report mixes with a measured
total. A budget therefore trips on estimates for such a seat; turning the
meter off (`estimateUsage: false`, or `LLM4TS_ESTIMATE_USAGE=0`) restores the
older behavior, where those runs accrue nothing at all and their cost summary
states that usage was not reported.

Read-only (`capabilities.readOnlyEnforcement`) grades how honestly a
connector's `readOnly` mapping restricts its harness (ADR 0010):

- **enforced** — a real capability removal: the write tools are absent from
  the harness's advertised surface. Claude gets a `--tools Read,Grep,Glob,Skill`
  allowlist (plan mode removes no tools, and a denylist misses `Bash` and MCP
  tools by construction); Codex runs under an OS-level `read-only` sandbox; Pi's
  `--tools read --no-mcp` is its documented tool-name allowlist with the MCP
  tools kept out of it, taken only on `piReadOnlyFloor` (1.0.4, the release
  that added `--no-mcp`) or newer and refused, typed, before the first turn on
  anything older. Gemini read-only runs
  headless in `--approval-mode default`: Gemini's own write policy denies the
  shell, `write_file`, `replace`, `activate_skill` and `web_fetch` when
  non-interactive, unmatched tools default to deny, and the file tools refuse
  paths outside the workspace, while the model keeps its agent prompt. (Plan
  mode denies the same tools but replaces the prompt with a planning
  workflow — explore the codebase, consult the user, save a plan — which a
  judge answering JSON cannot follow; it is used only under a sandbox, where
  default mode pre-approves `cat`/`ls`/`grep`.) llm4ts takes a read-only
  Gemini seat only on `geminiReadOnlyFloor` or newer and refuses it, typed,
  before the first turn on anything older. API providers execute no tools at
  all, so read-only holds vacuously.
- **advisory** — an approval/permission MODE the harness may not treat as a
  capability gate (Grok `--permission-mode plan`, OpenCode `--agent plan`,
  Antigravity `mode: plan`). Upgrading a connector to enforced requires
  observing the harness's advertised tool list, or its policy, with and
  without the flag, not the flag's name.
- **ignored** — the flag reaches no argv (Copilot), or maps only to an
  approval default indistinguishable from ignored in headless runs (Cursor).

Requesting `readOnly` from a non-enforced connector publishes a
`CapabilityUnenforceable` flow event naming the connector and its grade, so
runs never silently trust a request-shaped restriction. Reviewer seats that
must not write should be picked on this capability.

## Effort

`ConnectorCapabilities.effort` says whether a connector maps the llm4ts
effort vocabulary (`low`, `medium`, `high`, `max`; ADR 0029) to anything the
harness reads. Nothing is sent when no effort is asked, so every seat keeps
its harness's default until a roster entry sets one.

| Connector     | Mapping                                                  |
| ------------- | -------------------------------------------------------- |
| Claude CLI    | `--effort low\|medium\|high\|max`                        |
| Codex         | `-c model_reasoning_effort="low\|medium\|high\|xhigh"`   |
| Pi            | `--thinking low\|medium\|high\|xhigh`                    |
| Anthropic API | `output_config.effort` (`low\|medium\|high\|max`)        |
| OpenAI API    | `reasoning_effort` (`low\|medium\|high\|xhigh`)          |
| every other   | ignored; the request publishes `CapabilityUnenforceable` |

`max` becomes `xhigh` where the harness's top level is called that. Whether a
given model accepts a given level is the backend's business: a level the
model rejects fails the call with the backend's own words.

## Isolated headless

`ConnectorCapabilities.isolatedHeadless` grades how completely a CLI
connector's `isolated` request (`CliConnectorConfig.isolated`, a roster
entry's `"isolated": true`, or `LLM4TS_ISOLATED=1` for the run) keeps the
target repository's own harness material — hooks, MCP servers, settings,
extensions, instruction files — out of a headless run (ADR 0029):

- **enforced** — Claude Code's `--bare` (2.1.81+) loads none of it: no
  hooks, skills, plugins, MCP servers, auto memory or CLAUDE.md discovery.
- **partial** — some is kept out, the rest still read. Codex: the project's
  `.codex/config.toml` is skipped unless the user trusted that path, and
  `-c project_doc_max_bytes=0` turns the project's AGENTS.md off; MCP
  servers from the user's own config still load. Pi: `--no-extensions
--no-skills`; AGENTS.md is still read. Gemini CLI: `-e none`;
  `.gemini/settings.json` and GEMINI.md have no off switch (the harness
  policy of 2.35.4 already denies reading llm4ts's own packages).
- **ignored** — nothing reaches argv (every other CLI); API providers run
  no tools, so nothing loads and the question does not arise.

Requesting `isolated` from a connector below `enforced` publishes a
`CapabilityUnenforceable` event naming the grade, as `readOnly` does. It is
off by default: isolation also removes the repository's own instructions
from the coder, which a trusted repository wants kept.

## Label probabilities

`ConnectorCapabilities.labelProbabilities` says how a connector answers
`scoreLabels` (ADR 0017):

| Connector family                  | Label probabilities | Note                                                                                                                                                                     |
| --------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| mlx-lm                            | logprobs            | One forward pass, `max_tokens: 1`, top 11 token log-probabilities; also answers a shared-prefix sequence natively, reading each `<n>: <label>` line's log-probabilities. |
| Every other API and CLI connector | verbalized          | Schema-constrained JSON in which the model writes the numbers itself.                                                                                                    |
| Mock                              | verbalized          | Deterministic: the first label gets 0.6, the rest share 0.4.                                                                                                             |

Neither path is calibrated. `logprobs` distributions from a greedy instruct
model are almost fully peaked (a spike on 2026-09-19 measured probability
1.00 on the chosen label for 20 of 20 questions, including the one wrong
answer), so a threshold on their confidence rarely triggers.

LM Studio structured output is schema-constrained (`response_format:
json_schema` on `/v1/chat/completions`, grammar-enforced by the server) since the
typed-judgments release (ADR 0017); before that it was prompt-coerced through the native endpoint.
