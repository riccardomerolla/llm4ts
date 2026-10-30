# Rehearsal: `roundtable` on a real topic

Parked on 2026-10-30. `roundtable` shipped in 2.53.0 (ADR 0046): given a
topic and a goal, personas chosen by card discuss the topic item by item
under a chair that is code, and a Scribe writes the solution outline and
the plan; the owner steers from `meeting.md`. It has only run against a
scripted seat and a stub CLI. Every prompt, the agenda a persona proposes,
the quality of the turns, whether rounds converge, and whether the drafts
are documents an architect would sign are unproven against a live model.

This is a **live rehearsal**, run by the user with an authenticated
reasoning seat; it is not work for the autonomous loop. The checklist is
what the run must establish; findings become fixes or ADR notes, not edits
to this file.

## Why it matters

The flow exists because the conversation before an epic — mandates
disagreeing, settling, and someone writing it up — had no runnable form.
Unit tests prove the protocol: what settles an item, who speaks next, when
the chair judges, the files and their round trips. They cannot say whether
six personas on one seat sound like six people, whether "silence is
consent" produces decisions a room would own, or whether the caps bite
before anything useful is said. The risks ADR 0046 accepted, measurable
only live:

- **One seat, six voices.** Every persona borrows the same reasoning seat
  and differs by card only. The risk is a room that agrees with itself.
- **Objections that never close.** The objector closes their own blocking
  objection; the chair judges only after the objector spoke past a reply.
  A model that passes instead of agreeing stalls the item to the cap.
- **Questions parked too eagerly.** `needsHuman` is cheap for a model to
  raise. Too many parked questions and the owner does the meeting's work.
- **The Scribe's fidelity.** The drafts are written once from the whole
  transcript under the context budget; a long meeting may be cut.
- **The review turn.** One review round and one fix pass: a blocking review
  objection the fix pass does not address stays in the documents.

## Setup the run needs

- A repository to run in, with a `docs/standards/` folder of real company
  standards (or a stand-in: three to five markdown documents on API,
  security and operations conventions).
- The topic of the user's own example: an architecture solution outline
  and a plan for a named software solution, within the company standards.
  Placeholder: `"Architecture outline for the payments hub"` with
  `--goal "An outline and a plan the steering committee can approve,
within our standards"`.
- Global `llm4ts` at 2.53.0 or later; the reasoning seat of the last green
  rehearsal (`LLM4TS_REASONER`, default claude).
- Commands:
  `llm4ts run roundtable --repo <dir> "<topic>" -- --goal "<goal>"
--context docs/standards --ui tree`, then `-- --meeting <id>` for every
  later run. One run with the default six attendees, one with three
  (`--agents "PO,Cloud Architect,SRE"`).

## What the rehearsal must establish

- [ ] The proposed agenda against the one an architect would have written:
      items, their order, and the question under each (name every miss and
      every item that is not a question).
- [ ] Per item: the rounds it took, how it closed (settled, capped), and the
      turn kinds by persona. Whether any persona only agrees or only passes.
- [ ] Distinct voices: for three turns on the same item, whether a reader
      can tell the PO from the SRE from the Cloud Architect with the names
      hidden.
- [ ] Blocking objections: how many, how each closed (objector, chair
      judgment, cap), and for each chair judgment whether a human agrees
      with it. The judgment's probabilities from the run's judgment log.
- [ ] Parked questions: how many, whether each needed the owner, and
      whether the stated assumption was the one the owner would have given.
- [ ] One owner answer and one feedback round: whether the reopened item
      changed its decisions, and whether the redraft reflects the answer
      without rewriting what it did not touch (diff the drafts).
- [ ] `decisions.md` against the transcript: every decision a proposal the
      room took, dissent recorded where it was voiced, nothing invented.
- [ ] `outline.md` and `plan.md` against the templates and the decisions:
      sections filled, standards cited where the context documents apply,
      assumptions stated where a question is parked. Whether an architect
      would sign the outline as a first draft.
- [ ] The review turn: the blocking objections raised, and whether the fix
      pass addressed each (reread the drafts).
- [ ] The dashboard: with `--ui tree`, whether the attendee lanes, the item
      stage and the session log make the meeting followable without the
      files.
- [ ] Caps: whether 3 rounds and 40 turns were reached, and if so on which
      items, and what was lost in `open-questions.md`.
- [ ] Cost and time: reasoning calls and tokens per run, per persona and
      for the Scribe, from the run's cost summary; wall time of a full
      meeting.
- [ ] Six attendees against three: whether the smaller room reaches a
      comparable outline in fewer turns.
- [ ] A recommendation with the evidence above: what to change in the
      cards, the prompts, the settlement rule or the caps before the flow is
      offered to a team.

## Follow-ups this rehearsal is expected to feed

- `--interactive`: answering a parked question inside the run.
- `--read-repo`: read-only attendees over the working tree, with the code
  graph.
- `--brief`: an approved-shape epic brief beside `plan.md`, so
  `epic-stories` plans from the meeting.
- An executor per persona through the roster, when one seat proves to be
  one voice.
- A tagged standards corpus, loaded per persona instead of one folder for
  all.
- Sanitizing text centrally in the agent tree's paint path, not per event.

## Out of scope

Changing the cards, the prompts or the protocol before the first run: the
rehearsal measures 2.53.0 as shipped.
