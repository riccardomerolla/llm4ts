# Rehearsal: `epic-design` on a real extract pack

Parked on 2026-09-30. `epic-design` shipped in 2.17.0: given an epic in a
sentence, a legacy repository holding a `modernize-extract` pack and a
target repository, it proposes an **epic brief**, settles open points with
the user in the file, and hands the approved brief to `epic-stories`
(design: `docs/superpowers/specs/2026-09-30-epic-design-design.md`). It has
only run against a scripted reasoning seat. Every prompt, the program
selection and the quality of a proposal are unproven against a live model
and a pack of real size.

This is a **live rehearsal**, run by the user with an authenticated
reasoning seat; it is not work for the autonomous loop. The checklist is
what the run must establish; findings become fixes or ADR notes, not edits
to this file.

## Why it matters

The flow exists because the full modernization pipeline is too big for most
bank engagements: conversion is never one-to-one, some legacy code is dead
and some features are bundled in the target. The brief is where those calls
are made and recorded. Unit tests prove the loop, the checks and the file
format; they cannot say whether a model selects the right programs, whether
it finds what the target really provides, or whether the brief it writes is
one an analyst would sign. The risks the 2.17.0 review named, measurable only
live:

- **Selection.** One call over the pack's index picks the programs. Too few
  and the brief is thin; too many and the completeness check forces a
  disposition for scenarios nobody cares about.
- **Evidence size.** Specs and features are capped per program by the
  context budget. Scenario titles always reach the model; their bodies may
  not, and the model cannot open the legacy repository (it is rooted at the
  target).
- **"Provided by the target".** The pointer is checked to exist, not to do
  what the legacy scenario did. Only a run shows how often the claim is
  right.
- **Revision discipline.** A revision is told to keep everything the
  feedback does not ask to change. The diff reports moves, changed reasons
  and renamed items; nothing stops a model from rewriting a hand edit.
- **Completeness as a burden.** Every scenario of every touched program
  needs a disposition. On a program with forty scenarios that may be the
  right rigour or an obstacle.

## Setup the run needs

- A legacy repository with an approved extract pack under
  `docs/modernization/`. Candidates: the demo-bank legacy J2EE fixture after
  `modernize-extract` (`kits/j2ee-nextjs`), or a customer-like estate. Run
  once without and once with `modernize-refine`'s `decisions.md`, so the
  refine-conflict path is exercised.
- A target repository with real code and a CONTRIBUTING.md: `~/demo/portal`
  (the internet-banking portal), at a commit before the epic being designed
  exists there.
- Global `llm4ts` at 2.17.0 or later; the reasoning seat of the last green
  rehearsal (`LLM4TS_REASONER`, default claude).
- Command:
  `LLM4TS_LEGACY_REPO=<legacy> llm4ts run epic-design --repo <target> "<epic>"`,
  then `-- --epic <id>` for every later run.

## What the rehearsal must establish

- [ ] A first run on a real pack writes a draft brief: the programs it
      selected, against the ones an analyst would have selected (list both,
      name every miss and every extra).
- [ ] The first proposal's check results: how many problems before the fix
      round, how many after, and which kinds. Whether `[check]` open points
      reach the user often, and whether they are actionable.
- [ ] "Provided by the target": for every such entry, whether the pointed
      file really covers the legacy scenario. State the precision.
- [ ] "Dropped": whether the reasons are evidence (no caller, deprecated
      flag, replaced by a named service) or guesses. A guess should have
      been an open point.
- [ ] Open points: whether they are the questions a human must answer, and
      whether any were answerable from the pack or the target.
- [ ] Two revision rounds with real feedback and one hand edit each: what
      the run's change summary reported against a `diff` of the file;
      whether any hand edit was lost or rewritten.
- [ ] A refine conflict: a scenario `decisions.md` dropped, put in scope by
      the model, overridden with `keep: <why>`, and the brief then
      validating as approved.
- [ ] Evidence budget: the largest program's spec and feature size against
      `LLM4TS_CONTEXT_BUDGET`; whether a truncated program produced
      dispositions that contradict its own scenarios.
- [ ] Completeness: the number of scenarios the brief had to dispose of,
      and how many of those dispositions the analyst considers noise.
- [ ] Hand-off: `epic-stories --epic <id> -- --plan-only` from the approved
      brief; whether the story plan reflects the brief (dropped behaviour
      absent, provided behaviour not rebuilt, constraints in the stories),
      compared with a plan generated from the one-line request alone.
- [ ] Cost and time: reasoning calls and estimated tokens per run (propose,
      revise), from the run's cost summary.
- [ ] A recommendation with the evidence above: what to change in the
      prompts, the checks or the brief's format before the flow is offered
      to a customer.

## Follow-ups this rehearsal is expected to feed

- A ledger of legacy coverage across several epics (which scenarios no epic
  has claimed yet).
- The chat front end over the same file (`llm4ts shell` verb).
- The deferred review minors: `Answer:` with a capital A, stray header text
  dropped silently, the `Legacy:` line rewritten on revise, `epic-stories
--list` not showing brief-only folders, and framing program summaries as
  data in the selection prompt.
- Pinning the pack revision a brief was designed against (the `Legacy:` line
  carries only the path today).

## Out of scope

Changing the prompts, the checks or the format before the first run: the
rehearsal measures 2.17.0 as shipped.
