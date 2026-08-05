# BasecampTool: card-table work queue

Add `@llm4ts/flow/BasecampTool`, a standalone tool that lets a Basecamp
project's card table serve as an agent work queue: discover columns, list
and read cards, move cards between columns, comment, create/assign cards,
and tick card steps. Driver: the Nightcall program wants Basecamp as an
alternative control plane to GitHub issues — the queue lives on a card
table while pull requests (the deliverable) stay on GitHub via the
existing `GitHubTool`.

This is an **extension beyond the pinned source**: llm4zio v4.2.0 has no
Basecamp module. Per CLAUDE.md this requires an ADR (draft at
`docs/adr/0009-basecamp-card-table-work-queue.md`) and a `docs/parity.md`
note (see tasks).

## Decisions (agreed 2026-08-05)

| Decision    | Choice                                                                                                                                                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Role        | Work-queue tool in `packages/flow`, third sibling of `GitHubTool` and `AzureDevOpsTool`; same deep-module pattern (schemas + pure args builders + guarded service).                                                                                                     |
| Primitive   | Card tables. Columns are the workflow states; moving a card is the state transition. Todos/todolists are out of scope.                                                                                                                                                  |
| Abstraction | Standalone `BasecampToolShape` with card-native ops. No shared WorkQueue interface with `GitHubTool` — flows compose the two tools explicitly (Basecamp queue, GitHub PRs).                                                                                             |
| Protocol    | The `basecamp` CLI via `ProcessExecutor`: pure `*Args` builders + schema-parsed `--json` output, testable with the process fakes. Auth stays inside the CLI (no secrets).                                                                                               |
| Identity    | `makeBasecampTool(process, workDir, events, projectRef)`. `BasecampProjectRef` carries `project` (id or name) and optional `cardTable` id (CLI requires it only when a project has several tables). One tool instance = one board.                                      |
| Columns     | Columns as data: a `Column` schema class (id, title) discovered from the board and cached for the tool's lifetime; `resolveColumn(title)` fails with a typed error when the title is missing. No workflow-state literals in the library — flows name their own columns. |
| Content     | HTML verbatim: card/comment bodies read via `--json` are exposed as-is in fields named `contentHtml` — never pretend they are Markdown. Writes accept plain text/Markdown strings and pass them to the CLI unmodified. No converter in the library.                     |
| Capability  | Reads guarded by `Capabilities.BasecampRead`, mutations by `Capabilities.BasecampWrite`, via the existing `guarded` helper and `read`/`write` wrappers.                                                                                                                 |
| Parity      | Additive module beyond llm4zio v4.2.0. Record in `docs/parity.md` and ADR 0009.                                                                                                                                                                                         |

## Operations

Queue core (`BasecampRead` unless noted):

- `listColumns` — `basecamp cards columns -p <project> [--card-table <id>]
--json`; decoded to `ReadonlyArray<Column>` and cached.
- `resolveColumn(title)` — lookup over the cached columns,
  case-insensitive; typed `ColumnNotFound` failure naming the title and the
  available column titles.
- `listCards(column)` — `basecamp cards list` filtered to the column,
  decoded to `CardSummary` (id, title, assignee names, updatedAt, column).
- `readCard(id)` — `basecamp cards show <id> --json`; `Card` schema
  (id, title, `contentHtml`, assignees, column, url).
- `moveCard(card, column)` — `basecamp cards move` by column **id**
  (never by name at the process boundary). `BasecampWrite`.

Comments:

- `readCardComments(card)` — comment thread decoded to
  `CardComment` (id, author, `contentHtml`, createdAt).
- `writeCardComment(card, body)` — body passed verbatim. `BasecampWrite`.

Creation and assignment (`BasecampWrite`):

- `createCard(column, title, content, assignee?)` — `basecamp cards create
<title> [body] -c <columnId> [--assignee <name>] --json`; returns the
  created `Card`.
- `assignCard(card, assignee)` — `basecamp cards update`.

Steps (`BasecampRead`/`BasecampWrite`):

- `listSteps(card)` — `basecamp cards steps <id> --json`; `CardStep`
  schema (id, title, completed).
- `completeStep(step)` — `basecamp cards step` completion op.

All argument values are data, never interpolated into shell strings; args
stay `ReadonlyArray<string>` exactly like the existing builders. Project
and card ids are not secrets; tokens continue to flow via the `basecamp`
CLI's own auth store and must never appear in args, events, or errors.

## Core capability changes

`packages/core/src/Capability.ts`:

- `BasecampRead` / `BasecampWrite` tagged classes, added to the
  `Capability` union and the `Capabilities` table (mirroring `AdoRead` /
  `AdoWrite`).
- `Grants` gains `basecamp: GrantLevel`, wired through `allGrants`,
  `noneGrants`, `intersectGrants`, `unionGrants`, and `allows`.
- `Grants` is a persisted schema: the new field needs a decode default of
  `"None"` so existing serialized grants still decode.

## Non-goals

- Todos, message board, campfire chat, check-ins, webhooks, uploads —
  none of it until a flow needs it.
- No HTML↔Markdown conversion.
- No shared queue abstraction over GitHub/Basecamp; revisit with an ADR if
  a flow ever needs backend-agnostic queueing.

## Tasks

- [ ] Verify against one live `basecamp cards show --json` call what the
      content field actually contains (rich-text HTML assumed) and capture
      the JSON as test fixtures (columns, card list, card, comments,
      steps, create/move/update envelopes). Fixtures are checked in;
      CI never runs the real CLI.
- [ ] Core: `BasecampRead`/`BasecampWrite` capabilities and the `basecamp`
      grant field with `"None"` decode default; unit tests for
      intersect/union/allows over the new field.
- [ ] Flow: schema classes (`BasecampProjectRef`, `Column`, `CardSummary`,
      `Card`, `CardComment`, `CardStep`) and typed `ColumnNotFound` error
      in `FlowError`.
- [ ] Flow: pure args builders (`cardColumnsArgs`, `cardListArgs`,
      `cardShowArgs`, `cardMoveArgs`, `cardCreateArgs`, `cardUpdateArgs`,
      `cardCommentArgs`, `cardStepsArgs`, `cardStepCompleteArgs`) in the
      existing builder style.
- [ ] Flow: `makeBasecampTool` with lazy column discovery + caching,
      `read`/`write` capability guards, FlowEvents op names
      (`"basecamp cards list"`, `"basecamp cards move"`, …).
- [ ] Package plumbing: `./BasecampTool` subpath export in
      `packages/flow/package.json`.
- [ ] Deterministic tests in `BasecampTool.test.ts` with the process
      fakes: args construction, JSON decoding from fixtures (including
      empty lists), column cache behavior, `ColumnNotFound`, capability
      denial, process failure mapping.
- [ ] `docs/parity.md`: note the module as an intentional additive
      extension beyond llm4zio v4.2.0.
- [ ] Finalize ADR 0009 (status Proposed → Accepted) once the shape lands.
- [ ] Verification chain: `pnpm typecheck && pnpm lint && pnpm format:check
&& pnpm test`.
