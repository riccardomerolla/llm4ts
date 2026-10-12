# Harness discipline: effort per role, headless isolation, a cached prefix, a profile delta

ADR 0029. Phase 4 of `docs/research/rewrite-grade-loops-plan.md` (4.4,
4.5, 4.7, 4.8).

## Decisions (agreed 2026-10-06)

| Decision  | Choice                                                                                                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effort    | `Effort = low \| medium \| high \| max` in core; `ConnectorCapabilities.effort: mapped \| ignored`; mapped for Claude CLI, Codex, Pi, Anthropic API, OpenAI API.                                      |
| Roster    | `ExecutorSpec.effort`: one value or `{ <role>: …, default: … }`; the runner configures each seat with its role's effort.                                                                              |
| Costs     | `llm4ts costs` gains a by-agent table (coder, planner, reviewer, judge, judgment, chat).                                                                                                              |
| Isolation | `ConnectorCapabilities.isolatedHeadless: enforced \| partial \| ignored`; `CliConnectorConfig.isolated`, `ExecutorSpec.isolated`, `LLM4TS_ISOLATED=1`; `CapabilityUnenforceable` when not `enforced`. |
| Caching   | Anthropic API: `cache_control: ephemeral` on the system block and the last message; usage parsed from `message_start`/`message_delta`; `promptCache: false` opts out.                                 |
| Prefix    | A `Chat` test proves each request extends the previous one byte for byte except on the overflow retry.                                                                                                |
| Delta     | `llm4ts profile --against <trace\|json>` renders the delta of two runs in the ledger's order.                                                                                                         |

## Tasks

- [ ] `Effort` + capability field; Claude/Codex/Pi argv mapping; Anthropic `output_config.effort`; OpenAI `reasoning_effort`; tests per connector.
- [ ] `ExecutorSpec.effort`, `effortOf(spec, role)`, roster validation, runner seat configuration and cache key; `CapabilityUnenforceable` for ignored harnesses; tests.
- [ ] `CostReport.byAgent` and its rendering; test.
- [ ] `isolatedHeadless` grades, `isolated` config and roster field, env override, runner announcement; tests.
- [ ] Anthropic cache markers and usage reporting; tests on the request body and the usage chunk.
- [ ] `Chat` prefix-stability test.
- [ ] `profileDelta`, `renderProfileDelta`, `--against`; test.
- [ ] Docs: `provider-capabilities.md` (two columns), `configuration.md`, `harness-evals/README.md`, `flow-authoring.md` (stable prefix rule), `parity.md`, CHANGELOG.

## Non-goals

Per-flow effort overrides; an LLM compaction summariser; isolation for API seats.
