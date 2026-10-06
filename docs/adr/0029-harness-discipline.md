# ADR 0029: Harness Discipline For Every Provider

Status: Accepted · Date: 2026-10-06
Research: `docs/research/rewrite-grade-loops-plan.md` (phase 4: 4.4, 4.5,
4.7, 4.8) and `docs/research/anthropic-agent-best-practices.md`.
Spec: `specs/pending/harness-discipline.md`.

## Context

ADR 0027 and ADR 0028 made the loop harder: a mechanical oracle, adversarial
reviewers, a separate fixer, stall detection, a work queue. Four items of
the plan's phase 4 are about the harness around the loop rather than the
loop itself, and they are the ones that decide what a run costs and how far
it can be trusted on a repository nobody has read:

- every seat spends the same reasoning effort whatever its role, so the
  strongest model's deepest thinking goes to drafting a hundred mechanical
  files as readily as to judging a story;
- a CLI coder launched in a cloned repository loads that repository's hooks,
  MCP servers, settings and instructions, which is a prompt injection path
  the flow cannot see;
- the Anthropic API seat sends a fresh prompt every turn and reports no
  usage, so a long story pays full price for a stable prefix and the cost
  report estimates it from characters;
- a prompt edit, a new default or a cache header can change coding quality
  with every test green, and nothing in the repository asks the author to
  show a before and after.

Anthropic's own guidance names each of these (right-size the model per
stage, isolate the harness, keep a stable prefix for caching, evaluate every
harness change on the model it was tuned on); the Bun port ran its drafts
on the cheapest configuration and its rulebook audit on the strongest.

## Decision

1. **One effort vocabulary, mapped per harness.** `Effort` in core is
   `low | medium | high | max`. A connector maps it to its own flag and
   declares how in `ConnectorCapabilities.effort` (`mapped` or `ignored`):

   | Harness         | Mapping                                                       |
   | --------------- | ------------------------------------------------------------- |
   | Claude CLI      | `--effort <low\|medium\|high\|max>`                           |
   | Codex           | `-c model_reasoning_effort="<low\|medium\|high\|xhigh>"`      |
   | Pi              | `--thinking <low\|medium\|high\|xhigh>`                       |
   | Anthropic API   | `output_config.effort` (`low\|medium\|high\|max`)             |
   | OpenAI API      | `reasoning_effort` (`low\|medium\|high\|xhigh`)               |
   | everything else | ignored; a `CapabilityUnenforceable` event says so when asked |

   `max` becomes `xhigh` where the harness has no `max`. Nothing is sent
   when no effort is asked: the harness keeps its own default.

2. **Effort is a roster field, per role.** `ExecutorSpec.effort` is one
   effort or a record by role with a `default`, like `priority`; the runner
   configures each seat with the effort of the role it serves, so one
   executor can draft at `low` and judge at `high`. Flows set no effort of
   their own; the roster is the one place a run's spend is shaped.

3. **Spend is reported per role.** `llm4ts costs` groups the `TokensUsed`
   lines by their agent label (coder, planner, reviewer, judge, judgment,
   chat) beside the by-model table, so a run shows what the strongest model
   was spent on. No new event: the label was always there.

4. **A headless isolation grade.** `ConnectorCapabilities.isolatedHeadless`
   is `enforced`, `partial` or `ignored`, graded like `readOnlyEnforcement`
   (ADR 0010) on what the harness documents, not on the flag's name:

   | Harness    | When `isolated` is requested                                                                                                       | Grade    |
   | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------- |
   | Claude CLI | `--bare`: no hooks, skills, plugins, MCP, memory or CLAUDE.md                                                                      | enforced |
   | Codex      | `-c project_doc_max_bytes=0` (no AGENTS.md); project `.codex/config.toml` is already skipped unless the user trusted that path     | partial  |
   | Pi         | `--no-extensions --no-skills`; AGENTS.md is still read                                                                             | partial  |
   | Gemini CLI | `-e none`; `.gemini/settings.json` and GEMINI.md are still read (the ADR 0027 harness policy already denies llm4ts's own packages) | partial  |
   | others     | nothing reaches argv                                                                                                               | ignored  |

   `CliConnectorConfig.isolated`, `ExecutorSpec.isolated` and
   `LLM4TS_ISOLATED=1` request it; a request a connector cannot fully honour
   publishes `CapabilityUnenforceable` naming the grade, as `readOnly` does.
   Off by default: isolation also removes the repository's own instructions
   from the coder, which a trusted repository wants kept.

5. **A stable prefix, cached where the provider lets us.** The Anthropic
   API connector sends the system prompt as a content block with
   `cache_control: ephemeral` and marks the last message the same way, so
   every turn of a chat reads its history from the cache; it reports usage
   (input, output, cache read, cache creation) so the seat is measured, not
   estimated. `promptCache: false` on the connector turns the markers off.
   `Chat` keeps its invariant explicit and tested: a turn's request is the
   previous request plus the new exchange, byte for byte, except on the
   documented context-overflow retry.

6. **A harness change ships with its before and after.** `llm4ts profile
--against <trace|json>` prints the delta of two runs in the order the
   harness-evals ledger asks for (explore calls before the first edit,
   review rounds, gate failures, fabricated claims, model time, tokens),
   and `docs/harness-evals/README.md` states the rule: a change to a
   prompt, a default effort, a compaction window or a cache header is
   accompanied by that delta on the light fixture and a CHANGELOG line
   naming the model it was tuned on.

## Consequences

A roster with `effort` makes a run cheaper or deeper without touching flow
code; without it nothing changes. Isolation is a choice the operator makes
per executor or per run, with the grade visible on the run's events. The
Anthropic API seat becomes a measured, cached seat; other API providers
cache on their own or not at all. Profiles can be compared by a command
instead of by eye, which is what makes the harness-eval rule cheap enough
to keep.

## Not decided here

Per-flow effort overrides (a flow asking for `low` on a mechanical stage
regardless of the roster); an LLM compaction summariser for `Chat` (the
overflow path still retries with the current turn only); isolation for the
API seats (they run no tools, so nothing loads); automatic effort from the
judgment pre-screen.
