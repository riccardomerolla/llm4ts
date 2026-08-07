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
