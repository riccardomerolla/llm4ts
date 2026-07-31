# GitHubTool: work-queue operations

Extend `@llm4ts/flow/GitHubTool` so a GitHub repository can serve as an
agent work queue: list issues by label, transition label state, assign, and
close. Driver: the Nightcall dark-software-house program (an external
consumer of published `@llm4ts/*`) uses `factory:*` labels as its issue
state machine and needs these operations through llm4ts rather than a
parallel GitHub client.

This is an **extension beyond the pinned source**: llm4zio v4.2.0 `GhTool`
has no list/label/assign/close operations either. Per CLAUDE.md this
requires an ADR or a `docs/parity.md` note (see tasks).

## Decisions (agreed 2026-07-31)

| Decision   | Choice                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Seam       | Extend `makeGitHubTool` in `packages/flow/src/GitHubTool.ts`; no new module, no parallel client.                                                 |
| Protocol   | Same `gh` CLI process protocol via `ProcessExecutor`: pure `*Args` builders + schema-parsed `--json` output, testable with the process fakes.    |
| Capability | Reads guarded by `Caps.GhRead`, mutations by `Caps.GhWrite`, via the existing `guarded` helper and `read`/`write` wrappers.                      |
| Scope      | Minimal op set derived from the Nightcall label state machine; nothing speculative (no milestones, projects, reactions, or issue creation).      |
| Parity     | Additive extension; existing op behavior unchanged. Record as an intentional extension in `docs/parity.md` and an ADR noting llm4zio back-port intent. |

## Operations

- `listIssues(repo, filter)` — `gh issue list --repo <owner>/<repo> --state
  <state> [--label <l>]... [--assignee <login>] --limit <n> --json
  number,title,body,author,labels,updatedAt`. Needs a `RepoRef` schema
  (owner/repo without an issue number) and an `IssueSummary` schema class
  (number, title, body, author login, label names, updatedAt). `Caps.GhRead`.
- `editIssueLabels(ref, add, remove)` — `gh issue edit <n> --repo ...`
  with repeated `--add-label`/`--remove-label` flags. `Caps.GhWrite`.
- `assignIssue(ref, login)` — `gh issue edit <n> --repo ... --add-assignee
  <login>`. `Caps.GhWrite`.
- `closeIssue(ref, comment?)` — `gh issue close <n> --repo ...
  [--comment <body>]`. `Caps.GhWrite`.

Label values are data, never interpolated into shell strings; args stay
`ReadonlyArray<string>` exactly like the existing builders. No secrets in
args or errors (`--repo` and labels are not secrets; tokens continue to
flow via the `gh` CLI's own auth).

## Tasks

- [ ] `RepoRef` and `IssueSummary` schema classes plus `parseIssueList`
      (schema-decoded from `--json` output, `ProcessError` on mismatch).
- [ ] Pure args builders: `issueListArgs`, `issueEditLabelsArgs`,
      `issueAssignArgs`, `issueCloseArgs`, mirroring the existing builder
      style (`--repo` from the ref, no optional shelling).
- [ ] Wire the four ops into `makeGitHubTool` with `read`/`write` +
      capability guards; emit the same FlowEvents op names
      (`"gh issue list"`, `"gh issue edit"`, `"gh issue close"`).
- [ ] Deterministic tests in `GitHubTool.test.ts` with the process fakes:
      args construction, JSON parsing (including empty list and missing
      label arrays), capability denial, process failure mapping.
- [ ] `docs/parity.md`: note the four ops as an intentional additive
      extension beyond llm4zio v4.2.0 `GhTool`.
- [ ] ADR `docs/adr/0008-github-work-queue-extension.md`: why the work-queue
      ops live in llm4ts (deep module over parallel client in consumers),
      scope limits, and the intent to back-port to llm4zio.

## Non-goals

Issue creation, sub-issue/parent linking, GitHub Projects, milestones,
reactions, REST/GraphQL client (the `gh` process protocol stays), retry
policy changes, and any Nightcall-specific policy (label names, claim
semantics) — policy belongs to the consumer, mechanism belongs here.
