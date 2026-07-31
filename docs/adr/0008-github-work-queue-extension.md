# ADR 0008: GitHubTool Grows Work-Queue Operations Beyond The Pinned Source

## Status

Accepted.

## Context

The Nightcall program — an external consumer of published `@llm4ts/*`
packages — runs a virtual software company whose entire control plane is a
GitHub repository: issues carry work, `factory:*` labels form the task state
machine, and pull requests are the deliverable. Operating that state machine
needs four operations neither pinned `llm4zio` v4.2.0 `GhTool` nor
`@llm4ts/flow/GitHubTool` provided: list issues by label, add/remove labels,
assign an issue, and close an issue.

The alternative was a parallel GitHub client inside the consumer. That
violates the deep-modules rule this repository already enforces internally
(CLAUDE.md: extend the existing seams instead of writing one-off variants)
and would duplicate the `gh` process protocol, capability guards, and JSON
schema parsing that `GitHubTool` already owns.

## Decision

`GitHubTool` gains `listIssues`, `editIssueLabels`, `assignIssue`, and
`closeIssue` as an intentional additive extension beyond the pinned source:

- Same seam and style: pure `*Args` builders, schema-decoded `--json`
  output (`RepoRef`, `IssueSummary`), the `gh` CLI process protocol via
  `ProcessExecutor`, reads guarded by `GhRead` and mutations by `GhWrite`.
- `editIssueLabels` with two empty label sets is a no-op that never spawns
  `gh` — an empty edit is not an error for a polling orchestrator.
- Scope is deliberately minimal and mechanism-only. Issue creation,
  sub-issue linking, GitHub Projects, milestones, and any work-queue
  _policy_ (label vocabularies, claim semantics) stay in consumers.
- Existing operations are byte-for-byte unchanged; parity for the original
  `GhTool` surface is unaffected. The ledger records the extension, and
  back-porting the same four operations to llm4zio is intended so the two
  libraries converge again.

## Consequences

- Consumers can drive a GitHub-issues work queue through llm4ts alone; the
  first such consumer is Nightcall's claim transition
  (`factory:ready` → `factory:wip` + assign) and its heartbeat poll.
- The deterministic tests extend `GitHubTool.test.ts` with the process
  fakes: argv construction, list decoding (including malformed payloads),
  the empty-edit no-op, and capability denial before process launch.
- Divergence bookkeeping: this ADR plus a `docs/parity.md` note; future
  `GhTool` changes upstream must be reconciled against the extended
  surface.
