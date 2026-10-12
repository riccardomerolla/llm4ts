# Grounds on findings

Let a finding say how it knows: `grounds: observed | derived | inferred`
and `via: gate | oracle | diff | transcript | model | human` on
`ReviewIssue`, set by code where code can tell, so the fix prompt, retro and
profile weigh a red gate above a reviewer's hunch. ADR 0039 decisions 1 to
3; item 2 of `docs/research/rea-gap-analysis.md` section 6.

Driver: a gate failure and a lens opinion both arrive as a `ReviewIssue`
with a severity; ADR 0027's "findings should cite file:line" is not
checkable; `ReviewIssue.confidence` is the model's self-report.

## Decisions (ADR 0039)

| Decision   | Choice                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fields     | `grounds` and `via`, optional, no default; old results decode unchanged.                                                                                                         |
| Name       | `grounds` and `via`, never `confidence` (a Judgment term in `CONTEXT.md`), `source` or `authority` (glossary avoids them); `origin` is taken by gate triage.                     |
| Gates      | `Gates.ts` and `GateTriage.ts` issues: `observed` / `gate`.                                                                                                                      |
| Oracle     | `OracleGuard.ts` issues: `observed` / `oracle`.                                                                                                                                  |
| Transcript | Fabricated-status findings (`Evidence.ts`): `derived` / `transcript`.                                                                                                            |
| Lenses     | A finding whose `file` and `line` fall inside the reviewed diff: `derived` / `diff`; otherwise `inferred` / `model`. A lens may state grounds in its JSON; code only downgrades. |
| Judge      | `ProgramJudge` and the story judge: `inferred` / `model` unless the finding cites a spec line that exists, then `derived`.                                                       |
| Human      | Findings entered through `ask_user` or a retro approval: `observed` / `human`.                                                                                                   |
| Order      | `fixPrompt`, the retro digest and `profile` render observed, then derived, then inferred; within a grade, by severity as today.                                                  |
| Event      | `JudgmentObserved` gains optional `grounds` for the finding it scored.                                                                                                           |

## Modules

- `packages/flow/src/Review.ts`: the two fields; `reviewJsonSchema` accepts
  `grounds` from a lens; `gradeIssue(issue, diff)` pure helper that assigns
  or downgrades; `fixPrompt` ordering.
- `packages/flow/src/Gates.ts`, `GateTriage.ts`, `OracleGuard.ts`,
  `Evidence.ts`: set the fields at construction.
- `packages/flow/src/ProgramJudge.ts`, `Stories.ts` (story judge): grade
  judge findings against the spec text.
- `packages/flow/src/FlowEvents.ts`: `JudgmentObserved.grounds`.
- `packages/flow/src/Retro.ts`, `packages/runner/src/Profile.ts`: ordering
  and a count per grade.
- Lens prompts under `packages/flow/src/prompts` (or wherever the lens
  text lives; check `Review.ts` imports): one sentence asking for
  `grounds` with the `file:line` rule.

## Tasks

- [ ] Fields and `gradeIssue`; decode test for a result without them.
- [ ] Gate, triage, oracle and fabricated-status issues carry grounds;
      existing tests extended with one assertion each.
- [ ] Lens output graded against the diff; a finding citing a line outside
      the diff is `inferred` even when the lens said `observed`.
- [ ] Judge findings graded against the spec text.
- [ ] `fixPrompt`, retro digest and profile order and count by grade.
- [ ] `JudgmentObserved.grounds`; judgment log and dataset writers pass it
      through.
- [ ] Lens prompt sentence; CHANGELOG `(tuned on <model>)`; light-fixture
      profile before and after.
- [ ] `docs/parity.md` additive note; `docs/flow-authoring.md` under
      review results.

## Tests

Pure: `gradeIssue` on a diff fixture; a gate `ReviewResult` from the
recorded vitest output has only `observed` issues; a mixed result renders
in grade order in `fixPrompt`. Replay: the light fixture's trace folded by
`profile` reports the three grades.

## Non-goals

Changing severity semantics; dropping `confidence`; a numeric trust score;
grounds on `Info` events.
