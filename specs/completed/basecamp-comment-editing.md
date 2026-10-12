# BasecampTool: comment editing for living work-log comments

`writeCardComment` returns the created `CardComment` (it was void), and
the new `editCardComment(commentId, body)` updates a comment in place via
`basecamp comments update`. Driver: Dunder Mifflin's ongoing-work trace
(grilling 2026-08-06) — one WORK-LOG comment per card, created at claim
and edited throttled (~60s) with the live run's activity, each seat run
freezing an outcome line. The exact evolution `GitHubTool.writeIssueComment`
took in 0.7.4 for Nightcall's living checklists.

Additive under ADR 0009; parity note only. `comments create` gains
`--json --quiet` so the created comment is parseable; `comments update`
takes the comment id and new body, project-flag-free like all comment
ops.

## Tasks

- [ ] `cardCommentCreateArgs` emits `--json --quiet`; new
      `cardCommentUpdateArgs(commentId, body)`; `parseCardComment` for a
      single comment payload.
- [ ] `writeCardComment` returns the created `CardComment`;
      `editCardComment` wired with the `BasecampWrite` guard.
- [ ] Tests: argv, single-comment decode, tool round-trip with fakes.
- [ ] `docs/parity.md` note; verification chain; release 0.10.0.
