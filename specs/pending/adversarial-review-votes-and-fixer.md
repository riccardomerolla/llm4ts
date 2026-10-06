# Adversarial review: a lens that assumes the code is wrong, independent votes, a separate fixer, rules with teeth

An `adversarialReviewer` lens in the minimal set, `votes` on
`reviewAndFixLoop` that multiply only that lens, a `separate` fixer on a
fresh chat, a shared rules preamble for every lens and pack reviewer plus
`.llm4ts/review-rules.md`, and demotion of findings that cannot be placed
in the diff. Release B of ADR 0027 (decisions 7–10).

Driver: the Bun port ran every unit through two reviewers who saw only the
diff and were "told to assume the code is wrong", then a fixer who applied
findings "and nothing else"; one reviewer rule ("a paragraph-long comment
justifying a workaround means the code is wrong") stopped agents stubbing
functions. llm4ts's lenses each ask a scoped question once, and the
implementer applies its own review.

## Decisions (agreed 2026-10-06)

| Decision   | Choice                                                                                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lens       | `adversarialReviewer`: only job is reasons the diff does not work; assume it is wrong; the diff is the whole subject; default `ok=false` on any must-fix. Joins `minimalReviewers`.                                                                                                                                      |
| Votes      | `votes?: number` (default 1; `LLM4TS_REVIEW_VOTES`); multiplies only the adversarial lens; concern lenses run once. Each vote prefers an executor distinct from the coder and the other votes; never required (ADR 0019 decision 2 posture).                                                                             |
| Merge      | Any Critical from any vote blocks; Warnings unioned, deduplicated by `file:line`; Info kept only when raised by more than one vote. Pure function, tested.                                                                                                                                                               |
| Fixer      | `fixer?: "coder" \| "separate"` (default `coder`; `LLM4TS_REVIEW_FIXER`): `separate` takes a coder-role lease, fresh chat, receives the carried notes and the diag tail only, brief: "Apply the findings. Nothing else. Surgical edits only. If a finding is wrong, skip it and say so."                                 |
| Preamble   | `reviewRulesPreamble` prepended to every default lens, every pack reviewer and the judge rubric: no stubbed bodies, no skipped or deleted tests, no layering workaround, "if you need a paragraph-long comment to justify a workaround, the code is wrong". Pack `## Review rules` extends it; `preamble: off` opts out. |
| Repo rules | `.llm4ts/review-rules.md` in the target repository (pack-reviewer format: optional `files:` frontmatter, body) loads as one extra lens in every `reviewAndFixLoop`; absent means nothing.                                                                                                                                |
| Demotion   | Critical without `file` → Warning; any finding whose `file` is not in the diff → Info; each publishes `ReviewFindingDemoted { lens, from, to, reason }`. Nothing dropped.                                                                                                                                                |
| Cache      | The preamble enters the review fingerprint, so the cache misses once per lens after upgrade; documented.                                                                                                                                                                                                                 |

## Modules

### `packages/flow/src/Review.ts`

- `adversarialReviewer`, `reviewRulesPreamble`, `withPreamble(lens, pack?)`.
- `ReviewAndFixOptions` gains `votes`, `fixer`, `fixerChat?: Effect<Chat>`
  (the runner supplies a fresh coder chat on a lease), `repoRules?`.
- `mergeVotes(results): ReviewResult` and `demoteUnplaced(result, changedFiles)`.
- `reviewOnce` runs the adversarial lens `votes` times through the roster's
  `forRole("reviewer")` with an avoid-list; concern lenses once.

### `packages/flow/src/Pack.ts`

- `## Review rules` section: free text appended to the preamble, or
  `preamble: off`.
- `loadRepoReviewRules(workspace)` for `.llm4ts/review-rules.md`.

### `packages/flow/src/ProgramJudge.ts` and the story-board judge

- The preamble text joins the rubric's `provides` dimension.

### `packages/runner`

- `contextFor`/seat rebinding provides `fixerChat` from a coder lease with a
  fresh `Chat`; the fixer's system prompt is the autonomy contract plus the
  fixer brief.

## Tasks

- [ ] Lens, preamble, pack section, repo rules file; snapshot tests of the
      prompts; cache fingerprint test shows one miss.
- [ ] `votes`: roster leasing with avoid-list, `mergeVotes` with the dedup
      rules; tests with three fake votes.
- [ ] `fixer: separate`: fresh chat, brief, carried notes and diag tail;
      test proves the implementer chat receives no fix prompt.
- [ ] `demoteUnplaced` and the event; tests for both demotion cases.
- [ ] epic-stories and `implementPlanFlow` wire the env overrides; port
      flows (later) default `votes: 2`, `fixer: separate`.
- [ ] Docs: `docs/configuration.md`, `docs/flow-authoring.md`, pack
      authoring skill, CHANGELOG, `docs/parity.md` note.

## Tests

Two fake votes where one reports a Critical block the round; two Warnings
on the same `file:line` merge into one; an Info raised by one vote is
dropped and by two is kept; a Critical without a file becomes a Warning
with a `ReviewFindingDemoted` event; `.llm4ts/review-rules.md` present adds
one lens; `preamble: off` removes the preamble from that pack's lenses only.

## Non-goals

Majority rules on fuzzy titles; requiring distinct executors; changing the
default number of votes in existing flows; rewriting the concern lenses.
