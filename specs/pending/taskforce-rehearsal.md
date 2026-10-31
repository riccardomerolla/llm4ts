# Rehearsal: `taskforce` on a real goal

Parked on 2026-10-31. `taskforce` shipped in 2.54.0 (ADR 0047): a Chief of
Staff card plans briefs, specialists work them in waves with hands by card,
a Reviewer interrogates the deliverables, the Doc Writer delivers, the
Memory Manager writes the run note. It has only run against scripted seats,
a fake process executor, a fake worktree and a stub CLI. Every prompt, the
plan a Chief of Staff proposes, the briefs' quality, whether the Engineer's
worktree and REPORT line behave with a real coder, whether the Operator's
command log is read as evidence, and whether `result.md` is an answer an
owner would act on are unproven against a live model.

This is a **live rehearsal**, run by the user with an authenticated
reasoning seat and coder; it is not work for the autonomous loop. The
checklist is what the run must establish; findings become fixes or ADR
notes, not edits to this file.

## Why it matters

The flow exists because a goal that needs hands — reading, building,
running, reviewing, writing — had no runnable form beside the roundtable's
conversation. Unit tests prove the loop: what is ready, what is final, when
the Chief of Staff checks, when the review runs, how the owner's answer
reopens a brief. They cannot say whether a model writes briefs a stranger
could execute, whether the routed Operator brief verifies what the
Engineer built, or whether the fix wave fixes. The risks ADR 0047
accepted, measurable only live:

- **The plan is the product.** A vague brief fails quietly. Code checks
  shape, not sense.
- **One REPORT line.** The Engineer's status comes from the last line of a
  free-text coder reply; a coder that forgets it is BLOCKED.
- **VERIFY under `--no-pause`.** Only declared commands run; a plan that
  names `make e2e` is blocked, by design, and the owner must notice.
- **Findings judged by one truth question.** Act-on versus consider rests
  on the Judgment service's probability; the lead turn sorts the rest.
- **Recall by keyword overlap.** A note that shares no word with the goal
  is never recalled, however relevant.

## Setup the run needs

- A repository with code to read and a test script in `package.json`, and
  a `docs/standards/` folder (or three stand-in documents).
- A goal with a checkable deliverable. Placeholder:
  `"Can the auth module move behind the new gateway without breaking sessions? Outline and plan."`
- Global `llm4ts` at 2.54.0 or later; the reasoning seat and coder of the
  last green rehearsal (`LLM4TS_REASONER`, `LLM4TS_CODER`), and once with a
  `roster.json` that puts the Engineer on a different executor.
- Commands:
  `llm4ts run taskforce --repo <dir> "<goal>" -- --context docs/standards --ui tree`
  (edit `plan.md`, rerun with `-- --run <id>`), then once with `--no-pause`,
  once with `--agents "Researcher,Reviewer"`.

## What the rehearsal must establish

- [ ] The proposed plan against the one an engineering lead would have
      written: the deliverables, the briefs, their owners, the dependency
      order, and whether every ACCEPTANCE line is checkable.
- [ ] How many proposals were refused by code and why; whether the retry
      fixed the fault.
- [ ] Per brief: the report status, whether the evidence paths resolve,
      whether the summary says what the body says; which BLOCKED reports
      were retried and what the second attempt changed.
- [ ] The Engineer: whether the coder stayed in its worktree, whether the
      diff is the evidence, whether the REPORT line was there; the turn cap
      (`--turns`) hit or not.
- [ ] The Operator: the routed verifying brief, the commands run in the
      Engineer's worktree, the log read back as evidence; what `--no-pause`
      refused.
- [ ] The goal check: whether "reached" matched a human reading of the
      reports; the second wave's briefs when planned.
- [ ] The review: findings per lens, the judged probabilities from the
      judgment log, whether a human agrees with each act-on, the lead's
      dismissals; whether the fix wave addressed each act-on (diff the
      deliverables before and after).
- [ ] `result.md` against the reports: the answer first, sources that
      resolve, assumptions stated where a question was parked. Whether the
      owner would act on it.
- [ ] One answer under `## Answers` and one `## Feedback` after done: the
      rework brief and the fix brief, and the redraft's diff.
- [ ] `decisions.tsv`: every row maps to something that happened; the
      evidence column resolves.
- [ ] Memory: which notes were recalled for the goal and whether they
      helped; the run note's four sections against the run.
- [ ] The dashboard: specialist lanes, the brief as the stage, the report
      line, waves as run stages.
- [ ] Cost and time per specialist and per wave, from the cost summary;
      wall time of a full run, with `--parallel` 1 and 3.
- [ ] A roster with a different executor for the Engineer: the seat it
      took, and whether the diff differs in kind.
- [ ] A recommendation: what to change in the cards, the brief template,
      the prompts, the caps or the review before the flow is offered to a
      team.

## Follow-ups this rehearsal is expected to feed

- `--arena N` on Engineer briefs.
- A brief owned by a roundtable.
- Web research for the Researcher.
- The cross-model audit of the trail.
- `--interactive`.
- A flow that promotes run notes into topic notes.

## Out of scope

Changing the cards, the prompts or the loop before the first run: the
rehearsal measures 2.54.0 as shipped.
