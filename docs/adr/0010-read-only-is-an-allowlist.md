# ADR 0010: Read-Only Is An Allowlist, Not A Request

Date: 2026-08-07. Status: accepted.
Spec: `specs/pending/cli-read-only-enforcement.md`.

## Context

`CliConnectorConfig.readOnly` is trusted by real consumers: the runner's
`asReadOnly` builds every reviewer seat with it, and review verdicts assume
the reviewer could not have edited the tree it judged. But the flag's
per-connector mappings were mode-shaped, and orca (the Scala sibling,
research #73/#83/#84, fix #89) proved that at least for claude those modes
are requests, not restrictions: under `--permission-mode plan` the `init`
tool list is byte-identical to the default mode's — `Bash`, `Write`, `Edit`
included — and opus reviewers ran 199 `Bash` calls under it with zero
denials. llm4ts's claude mapping (inherited from pinned llm4zio's
`--disallowed-tools` stance) was a denylist that misses `Bash` and MCP write
tools by construction, on top of an unverified permission mode.

## Decision

1. **Claude read-only emits a `--tools Read,Grep,Glob,Skill` allowlist** —
   orca's verified set (claude 2.1.222: those flags yield an `init` list of
   exactly those four tools, and `ToolSearch` cannot resurrect the rest).
   The `permission-mode`/`disallowed-tools` pair is dropped from the
   `readOnly` branch; explicit `flags.tools` wins on conflict.
   `CoderPolicy`'s publish-grade `disallowed-tools` merging is a separate
   seam and is unchanged.
2. **Honesty over theater**: `ConnectorCapabilities` gains
   `readOnlyEnforcement: "enforced" | "advisory" | "ignored"`. Grades:
   claude/codex/pi and all API providers `enforced` (codex: OS sandbox; pi:
   documented tool-name allowlist; API: no tool surface exists), the
   plan-mode family (gemini, grok, opencode, antigravity) `advisory`,
   copilot/cursor `ignored`. Upgrading a connector to `enforced` requires
   orca-grade evidence — the harness's advertised tool list observed with
   and without the flag — not the flag's name.
3. **Requests are announced**: resolving a seat whose config asks for
   `readOnly` from a non-`enforced` connector publishes
   `CapabilityUnenforceable` naming the connector and its grade.

## The cost, accepted eyes-open

Read-only claude loses `Bash`. Orca measured (87 reviewer sessions): 64% of
reviewer `Bash` calls are search/read/list — covered by `Grep`/`Read`/`Glob`
at the cost of more turns (75% of calls batched several operations); 34%
touch git, mostly re-deriving a diff the prompt already carries. llm4ts
reviewers get the diff in-prompt (`reviewAndFixLoop`, and the modernize
review flow scopes each lens's diff), so the bet is the same one orca made.

## Deferred: network access

`readOnly` stays a boolean and excludes web tools. For whoever adds a
network tier later: `--tools` only _advertises_ — a permission-gated tool
still needs `--allowedTools` on top, because headless stdin is closed and
nobody can approve, so the call fails silently as a `tool_result` (orca
verified on 2.1.223 that the two flags compose).

## Divergence from the pinned source

Pinned llm4zio v4.3.0 still maps claude read-only via denylists. This is a
deliberate behavior divergence, recorded here and in `docs/parity.md`.

## Amendment (2026-10-02): Gemini is enforced from 0.37.0

A live `epic-stories` run showed a Gemini judge reading the llm4ts source
through `run_shell_command`. The hole was not plan mode: without a roster
the story judge was the reasoner seat itself, which runs `-y`. Two changes:

1. **The judgment seat is read-only by construction.** The runner derives
   it from a CLI reasoner as `asReadOnly(reasoning)` (an API reasoner has
   no tools to take, so it stays the reasoning service), and exposes it as
   `context.judge` for the rubric judges that predate ADR 0017. A roster's
   judge role was already read-only.
2. **Gemini's grade is `enforced`, behind a version floor.** Gemini CLI
   0.26.0 made `--approval-mode plan` a policy: `policies/plan.toml` denies
   every tool in plan mode at default-tier priority 40 and allows the
   read-only set at 50, `non-interactive.toml` denies `ask_user` headless,
   and the file tools refuse paths outside the workspace directories. The
   mode left `experimental.plan` in 0.37.0. The Gemini connector's one-time
   install check reads `gemini --version` and refuses a read-only seat on
   anything older (`InvalidRequestError`, before any turn), so the grade
   holds for every read-only seat that actually runs. Evidence: the bundled
   policy files of 0.47.0 and the plan.toml history (PRs #16849, #24282).

Admin-tier policies (`GEMINI_CLI_SYSTEM_SETTINGS_PATH` plus a `policies/`
directory) would outrank a user's own allow rules; not needed yet, noted for
whoever meets a machine with such rules.

### Amendment (2026-10-03): headless default mode, not plan mode

Plan mode turned out to do more than remove tools: Gemini CLI (checked on
0.47.0 and 0.62.0) replaces the system prompt with a planning workflow —
explore the codebase with search and read tools, consult the user, save a
plan as Markdown. A judge asked for JSON over a diff in its prompt explored
the worktree instead and often ended its turn without an answer. Read-only
Gemini seats now run headless in `--approval-mode default`: `write.toml`
denies `run_shell_command`, `write_file`, `replace`, `activate_skill` and
`web_fetch` outright when non-interactive, the policy engine's default for
unmatched tools is deny when non-interactive, and the file tools refuse
paths outside the workspace. Same enforcement tier as plan mode, with the
model's ordinary agent prompt. Plan mode stays only under a sandbox, whose
default-mode profile pre-approves `cat`, `ls` and `grep` in the shell. The
reviewer and judge prompts also say that the diff in the message is the
whole subject and nothing is to be explored.
