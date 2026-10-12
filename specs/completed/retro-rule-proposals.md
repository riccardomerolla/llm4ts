# epic-retro: proposing an edit to the loop, not only to the stories

`RetroFixKind` gains `rule`: a structured edit to a reviewer file, a pack's
`## Review rules`, `lessons.md`, a kit pitfall card or
`.llm4ts/review-rules.md`, rendered as a diff in the report and applied from
JSON behind `- [ ] Approved`. The digest learns three signatures that call
for a rule. Release B of ADR 0027 (decision 12).

Driver: the Bun engineer's main lever was editing the loop ("prompting
Claude to edit the loop to fix things"); Anthropic's modernization guidance
says "modify the workflow, not each change, when issues surface". ADR 0023's
retro can fix a story or add tasks; it cannot change what the reviewers
apply, so the same gaming pattern returns on the next story.

## Decisions (agreed 2026-10-06)

| Decision    | Choice                                                                                                                                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kind        | `rule`, one per story entry like the other kinds, or at run level (a rule is usually about the run, not a story): `proposal.rules: RuleEdit[]` beside `proposal.stories`.                                                                                       |
| Operations  | `append-rule { target, line }` and `replace-section { target, heading, body }`; validated by schema; a target outside the allowed set is dropped and listed, as ADR 0023 drops unusable fixes.                                                                  |
| Targets     | `reviewers/<name>.md`, `pack.md#Review rules`, `lessons.md`, `patterns/pitfalls-*.md` in the pack or kit; `.llm4ts/review-rules.md` in the target repository when the run has no pack. Built-in flow prompts are never a target.                                |
| Rendering   | The report shows each operation as a unified diff of the target file for the human; application uses the JSON operation, never the rendered diff.                                                                                                               |
| Application | The next implementing `epic-stories` run applies approved, unapplied rule edits before planning, marks them `- [x] Applied <date>`, and the review cache misses once for the affected lenses. `--land` and refine planning apply nothing (ADR 0023 decision 5). |
| Signatures  | The digest flags: (a) gaming across stories (stubbed bodies, skip markers, oracle-guard failures, long justifying comments); (b) the same reviewer finding (normalized title) in two or more stories; (c) `FabricatedStatus` in two or more stories.            |

## Modules

- `packages/flow/src/Retro.ts`: `RuleEdit` schema and JSON schema; digest
  signatures; prompt section "when a pattern repeats across stories, propose
  a rule, not a task"; report rendering; `applyRuleEdits`.
- `packages/flow/src/Pack.ts`: `allowedRuleTargets(pack)`; section replace
  and append helpers for `pack.md` and sidecars (atomic through the
  workspace).
- `packages/shell/flows/lib/epic-stories.js`: apply step before planning.

## Tasks

- [ ] `RuleEdit` schema, validation, drop-and-list of bad targets; tests.
- [ ] Digest signatures with tests over a fixture trace and findings files.
- [ ] Prompt and report rendering (diff view); snapshot tests.
- [ ] `applyRuleEdits` with the two operations; idempotent on rerun; tests
      on memory workspace.
- [ ] epic-stories apply step; cache miss noted in the run output.
- [ ] Docs: ADR 0023 addendum pointer, `docs/configuration.md`, CHANGELOG.

## Tests

A retro JSON with an `append-rule` to `reviewers/correctness.md` renders a
one-line diff and, once approved, appends exactly that line on the next
run and marks itself applied; a `replace-section` to a missing heading
appends the section; a target `flows/implement.js` is dropped and listed;
a trace with `it.skip` findings in two stories yields signature (a).

## Non-goals

Editing built-in flow prompts; applying anything unapproved; free-form
diffs; proposing new stories (that is `refine`).
