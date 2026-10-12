# ADR 0039: Grounds On Findings, And Verdicts That Never Aggregate To Pass

Status: Proposed · Date: 2026-10-12 · Extends ADR 0027, ADR 0012, ADR 0017

## Context

Every finding in llm4ts arrives as a `ReviewIssue` with a severity, whether
it came from a red gate, the oracle guard, a reviewer lens reading a diff, or
a judge reading a spec. The fix prompt, the retro digest and the profile
cannot tell a measured failure from a model's opinion. ADR 0027 asks lenses
to cite `file:line`; nothing checks that they did. `ReviewIssue.confidence`
is a number the model wrote about itself.

A verdict has the same blindness one level up. `Provenance.contextTruncations`
records that a judge saw a capped spec (`Provenance.ts`), and the comment on
that field says the visibility is the whole reason truncation is allowed;
but the verdict rendered on the capped spec still counts as a verdict, and a
green `modernize-verify` run can rest on it. A coverage rule is satisfied by
any passing vector, so a `generated` vector (`Equiv.ts`) can close a rule
that needed a `captured` one; ADR 0012 forbids exactly that for the bank
conversion, by rule rather than by type.

rea's evidence model (`docs/research/rea-gap-analysis.md`, section 1.4)
grades every record `observed`, `derived` or `inferred`, and its completion
ledgers hold that `fail`, `unknown`, `unsupported`, `truncated` and `skipped`
never aggregate to `pass`. Those two rules are portable; nothing else of the
model is.

## Decision

1. **Grounds, not confidence.** `ReviewIssue` gains `grounds: observed |
derived | inferred` and `via: gate | oracle | diff | transcript | model |
human`, both optional with no default so old results decode unchanged.
   The words are `grounds` and `via`: `Confidence` is already the
   glossary's name for a Judgment statistic (`CONTEXT.md`), `source` is a
   word the glossary avoids, `origin` is taken by gate triage, and
   `ReviewIssue.confidence` is the model's self-report, which stays as it
   is.
2. **Code sets grounds where it can.** Gate and oracle-guard issues are
   `observed` from `gate` or `oracle`; a fabricated-status finding is
   `derived` from `transcript`; a lens finding with a `file:line` that
   exists in the diff is `derived` from `diff`; one without is `inferred`
   from `model`. A lens may state its grounds in its structured reply; code
   downgrades, never upgrades, what the model claims.
3. **Grounds order findings.** The fix prompt, the retro digest and
   `profile` list `observed` before `derived` before `inferred`, and a
   judge's `JudgmentObserved` event carries the grounds of the finding it
   scored.
4. **Five verdict statuses.** `ProgramJudge` results and `modernize-verify`
   rule verdicts gain `status: pass | fail | truncated | unsupported |
unknown`. `truncated` is forced when the judged context carries a
   truncation; `unsupported` when a coverage rule declares `required:
captured` in its pack section and no captured vector exercised it;
   `unknown` when the judge or the comparison did not run. Only `pass`
   aggregates to pass; the report prints every other status by name and
   `modernize-verify` exits non-zero on any of them, as it does on `fail`.
5. **Packs opt in to `required`.** A `## Coverage:` rule without `required`
   keeps today's meaning. The bank packs under `kits/` set `required:
captured` where ADR 0012 already demands it.

## Considered options

- Reuse `ReviewIssue.confidence` with a three-level scale. Rejected: it
  would overload a number the model writes with a grade the code assigns,
  and collide with the glossary.
- Fail the whole verify run on truncation instead of a status. Rejected: a
  partial verdict is still evidence; what must not happen is counting it as
  a full one.
- A separate `Evidence` record type as in rea. Rejected: `ReviewIssue` is
  the finding seam every consumer already reads (CLAUDE.md: no parallel
  result type).

## Consequences

- Behavior divergence from llm4zio v4.2.0: a `modernize-verify` that was
  green on a truncated judge or a generated vector turns `truncated` or
  `unsupported`. Recorded in `docs/parity.md`; existing approved packs are
  re-verified once with the report line before any pack sets `required`.
- Lens prompts change to state grounds; a harness change under ADR 0029,
  shipped with a light-fixture profile and a tuned-on model line.
