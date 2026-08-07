# CLI connectors: `readOnly` must be a capability removal, not a request

`CliConnectorConfig.readOnly` is trusted by real consumers — the runner's
`asReadOnly` builds every reviewer seat with it, and the dogfood loop's
review verdicts assume the reviewer could not have edited the tree it
judged. But most connectors map the flag onto approval/permission *modes*,
and orca proved (orca #73/#83/#84, fixed in #89) that at least for claude
those are requests, not restrictions: under `--permission-mode plan` the
`init` tool list is byte-identical to the default mode's — `Bash`, `Write`,
`Edit` included — and opus reviewers ran 199 `Bash` calls under it with
zero denials. Orca's fix, verified against claude 2.1.222/2.1.223: a
`--tools` **allowlist** is a real capability removal — the dropped tools
are absent from `init` and `ToolSearch` cannot resurrect them.

llm4ts today, per connector:

| Connector   | `readOnly` maps to                                             | Shape                                          |
| ----------- | -------------------------------------------------------------- | ---------------------------------------------- |
| claude      | `permission-mode: default` + `disallowed-tools: Write,Edit,NotebookEdit` | denylist — misses `Bash` and MCP write tools by construction; headless default-mode `Bash` behavior unverified and version-dependent |
| gemini      | `--approval-mode plan`                                         | mode — unverified as a gate                    |
| grok        | `--permission-mode plan`                                       | mode — unverified as a gate                    |
| opencode    | `--agent plan`                                                 | mode — unverified as a gate                    |
| antigravity | `mode: plan`                                                   | mode — unverified as a gate                    |
| cursor      | omits `--force`                                                | approval default — a request by definition     |
| copilot     | *(nothing — the flag is silently ignored)*                     | none                                           |
| codex       | `sandbox: "read-only"`                                         | OS-level sandbox — a real gate                 |
| pi          | `--tools read`                                                 | allowlist-shaped — verify what "read" includes |

This is inherited parity: pinned llm4zio maps claude the same denylist way
(its `CoderPolicy` scaladoc: "Claude expresses deny-lists via
`--disallowed-tools`"). Adopting the allowlist is therefore a deliberate
behavior divergence from the pinned source and gets an ADR.

Blast radius: argv builders in `packages/core/src/providers/` (claude
first, others as verified), one field on the connector capability record,
the capability matrix doc, deterministic argv tests, ADR. Sibling of
`specs/pending/cli-turn-limit-enforcement.md` — both are "the argv must
actually enforce the config" fixes and can share a verification pass.

## Decisions

| Question                  | Decision                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude allowlist          | Adopt orca's verified set verbatim: `--tools Read,Grep,Glob,Skill` (claude 2.1.222 yields an `init` list of exactly those four). Explicit `flags` win on conflict, same rule as the turn-limit spec. Drop the `permission-mode`/`disallowed-tools` pair from the `readOnly` branch — the allowlist subsumes it; `CoderPolicy`'s publish-grade `disallowed-tools` merging is a separate seam and stays. |
| The cost of losing `Bash` | Accepted, eyes open (orca #84, 87 reviewer sessions): 64% of reviewer `Bash` calls are search/read/list — covered by `Grep`/`Read`/`Glob` at more turns (75% of calls batched several ops); 34% touch git, mostly re-deriving a diff the prompt already carries. llm4ts reviewers get the diff in-prompt (`reviewAndFixLoop`), so the bet is the same one orca made. |
| Network access            | No new tier. `readOnly` stays a boolean and excludes web tools. Orca's NetworkOnly finding is recorded for whoever needs it later: `--tools` only *advertises* — a gated tool still needs `--allowedTools` on top, because headless stdin is closed and nobody can approve, so the call fails silently as a `tool_result`. |
| Connectors without a real gate | Honesty over theater: the capability record gains `readOnlyEnforcement: "enforced" \| "advisory" \| "ignored"` (codex/pi/claude-after-this-spec → `enforced`; the plan-mode family → `advisory`; copilot/cursor → `ignored`, cursor's approval default being indistinguishable from ignored in headless runs). Consumers pick reviewer seats on it; flows publish the existing `CapabilityUnenforceable` event when `readOnly` is requested from a non-`enforced` connector. Upgrading a connector to `enforced` requires the same evidence orca produced: the harness's advertised tool list observed with and without the flag. |
| Other harnesses           | Do not guess. Gemini/grok/opencode/antigravity keep their current flags but are labeled `advisory` until someone verifies their plan modes actually remove write tools; verification is a per-connector follow-up, not a blocker for this spec.       |

## Tasks

- [ ] `claudeCliExtraArgs` (`packages/core/src/providers/ClaudeCliConnector.ts`):
      `readOnly` emits `--tools Read,Grep,Glob,Skill` instead of the
      `permission-mode`/`disallowed-tools` pair; explicit `flags["tools"]`
      wins on conflict. Verify locally against the installed claude CLI that
      the flag composes with the flags `CoderPolicy` may add
      (`--disallowed-tools` deny patterns for ungranted push/PR writes) —
      orca verified `--tools` + `--allowedTools` compose on 2.1.223, but not
      this pair.
- [ ] Pi: confirm what `--tools read` expands to in the pi harness and
      record it; keep `enforced` only if the write tools are actually absent.
- [ ] Connector capability record (`@llm4ts/core/Connector` /
      `ConnectorFactories`): add `readOnlyEnforcement` with the values from
      the Decisions table; expose it through the registry so
      `asReadOnly`-built seats can assert on it.
- [ ] Runner/flow: requesting `readOnly` from a non-`enforced` connector
      publishes `CapabilityUnenforceable`
      (`packages/flow/src/FlowEvents.ts:63`) naming the connector and the
      mechanism it fell back to. Copilot stops being silent: it is `ignored`
      and says so.
- [ ] Deterministic argv tests per connector (existing per-connector test
      pattern): claude emits the allowlist; flags win on conflict; codex/pi
      unchanged; copilot emits nothing and its capability record says
      `ignored`.
- [ ] `docs/provider-capabilities.md`: new "Read-only" column carrying the
      enforcement grade, with a paragraph on what `advisory` means and what
      evidence upgrades it.
- [ ] ADR `docs/adr/0010-read-only-is-an-allowlist.md`: the divergence from
      pinned llm4zio's denylist mapping, orca #89 as the evidence base, the
      accepted `Bash` cost, and the deferred network tier with the
      `--allowedTools` composition note.
- [ ] `docs/parity.md` note pointing at the ADR.

## References

- orca (`/Users/riccardo/git/github/riccardomerolla/orca`): commit
  `d245756` "Give claude read-only turns a --tools allowlist, not plan
  mode (#89)" — the full evidence trail; research #73 (199 Bash calls under
  plan mode), #83 ("Plan mode is not a capability gate"), #84 (reviewer
  tool-surface measurements)
- `packages/core/src/providers/{ClaudeCliConnector,GeminiCliProvider,GrokCliConnector,OpenCodeCliConnector,AntigravityConnector,CursorConnector,CopilotConnector,CodexConnector,PiConnector}.ts`
- `packages/runner/src/Connectors.ts` (`asReadOnly`),
  `packages/runner/src/CoderPolicy.ts` (publish-grade deny patterns —
  unchanged by this spec)
- `specs/pending/cli-turn-limit-enforcement.md` (sibling argv-enforcement
  spec), `specs/pending/review-structured-robustness.md` (the reviewer seat
  that trusts `readOnly`)
- llm4zio pinned source: `modules/llm4zio-runner/.../CoderPolicy.scala`
  (the denylist stance this diverges from)
