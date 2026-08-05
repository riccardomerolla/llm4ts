# ADR 0009: BasecampTool — Card-Table Work Queue Beyond The Pinned Source

## Status

Accepted (2026-08-05). Implemented per
`specs/pending/basecamp-tool-card-queue.md`.

## Context

The Nightcall program runs its control plane on a GitHub repository:
issues carry work, labels form the task state machine, pull requests are
the deliverable (ADR 0008). Basecamp is now wanted as an alternative
control plane: less developer-shaped surface for non-code work, and a
kanban view humans already live in. The deliverable stays on GitHub —
Basecamp replaces only the queue.

Pinned `llm4zio` v4.2.0 has no Basecamp module, so any Basecamp support is
an extension beyond the pinned source. The alternative — a parallel
Basecamp client inside the consumer — would duplicate the process
protocol, capability guards, and schema parsing that the flow tools
already own, violating the deep-modules rule (CLAUDE.md).

A `basecamp` CLI with full API coverage and `--json` output already
handles auth, account resolution, and endpoint plumbing, exactly as `gh`
does for `GitHubTool` and `az` variants do for `AzureDevOpsTool`.

## Decision

Add `@llm4ts/flow/BasecampTool` as a **standalone third sibling** of
`GitHubTool` and `AzureDevOpsTool`, wrapping the `basecamp` CLI via
`ProcessExecutor` with pure args builders, schema-decoded `--json` output,
and capability guards (`BasecampRead`/`BasecampWrite`, a new `basecamp`
grant level in core).

Shape decisions, and why:

- **Card tables, not todos.** Columns model workflow states with a real
  state machine (move card = transition); todos offer only open/completed
  and would push intermediate states into naming conventions.
- **No shared WorkQueue abstraction.** Half of `GitHubToolShape` is PR
  operations with no Basecamp analogue, and forcing GitHub's label model
  and Basecamp's column model into one vocabulary now would be
  speculative. Flows compose the two tools explicitly; a queue interface
  can be extracted later, with its own ADR, when a flow genuinely needs
  backend-agnostic queueing.
- **One tool instance = one board.** `makeBasecampTool` binds a
  `BasecampProjectRef` at construction (mirroring how `GitHubTool` binds a
  repo via its working directory) and lazily discovers/caches the board's
  columns.
- **Columns are data, not literals.** Basecamp columns are user-defined;
  baking Nightcall's state names into the library would couple it to one
  board layout. `resolveColumn(title)` fails typed when a name is missing;
  flows declare the column names they expect in their own config.
- **HTML verbatim.** Basecamp bodies are rich-text HTML. Fields are named
  `contentHtml` and passed through unconverted; writes accept plain
  text/Markdown strings handed to the CLI unmodified. Conversion is a
  separate concern that earns its place only when a flow proves the need.

## Consequences

- Nightcall can run a Basecamp-queue + GitHub-PR flow with no parallel
  client, and the capability system governs Basecamp access like every
  other side effect.
- `Grants` grows a `basecamp` field; existing persisted grants decode via
  a `"None"` default, so old plans deny Basecamp access by definition.
- The module diverges from llm4zio v4.2.0 (recorded in `docs/parity.md`);
  back-porting to llm4zio is possible but not planned until the shape
  proves itself here.
- Tests never invoke the real CLI: checked-in `--json` fixtures + process
  fakes keep CI deterministic and credential-free.
