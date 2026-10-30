# ADR 0046: roundtable — Personas Discuss a Goal, the Scribe Writes the Outline and the Plan

Status: Accepted · Date: 2026-10-30 · Relates to ADR 0017, ADR 0019, ADR 0020, ADR 0028, ADR 0033

## Context

Every document-writing flow so far starts from an artifact: `epic-design`
from an extract pack, `epic-retro` from a failed run, `soap-design` from a
sampled service. None starts from a question. What a team does before any of
those exists — "we need an architecture outline and a plan for solution XYZ,
within our standards" — is a meeting: a few people with distinct mandates
talk the goal through, disagree, settle, and someone writes it up.

The pieces exist but none fits as it is:

- `epic-design` runs one read-only reasoner, a deterministic checker and
  one fix round. There is no second voice and no critic.
- `port-guide` (ADR 0028) has dimension auditors and refuters voting on each
  finding: structured disagreement, but over code and with a fixed cast.
- The Blackboard (ADR 0020) decides within one run from write-once facts; it
  does not carry a conversation across rounds.
- The roster (ADR 0019) binds executors to a fixed role set (planner, coder,
  reviewer, judge, verifier) and has no notion of a persona.
- Review lenses (ADR 0044) are the only per-agent system prompt, and they
  review diffs.

## Decision

A bundled flow, `roundtable`, that runs a meeting. Code chairs it. Personas
speak. A Scribe writes the deliverables.

1. **Inputs.** A topic and a goal on the command line; attendees chosen by
   persona name (`--agents`), six bundled by default: PO, PM, Sr SW Eng,
   Cloud Architect, DevOps, SRE. A Scribe is always present and is not an
   attendee. `--context <dir>` gives every attendee the same documents
   (standards, existing architecture notes) under the context budget.
   Attendees are toolless: they read what the chair hands them and nothing
   else.

2. **Personas are cards, not roles.** A card has a name, an order, and
   sections: mandate, cares about, pushes back on, never decides alone,
   voice. Bundled cards ship as TypeScript constants; `--eject-personas`
   writes them to `.llm4ts/personas/*.md`, where a card of the same name
   overrides the bundled one. The executor roster still decides which model
   speaks; a card decides what the speaker is. Every persona borrows the one
   reasoning seat.

3. **The meeting file is the state.** `.llm4ts/meetings/<id>/meeting.md`
   holds `Status`, `Topic`, `Goal`, `Attendees`, the agenda, the questions
   for the room owner with their answers, and free feedback. Status moves
   `agenda-proposed → discussing → drafting → reviewing → done`. A rerun
   derives what to do next from the files alone, as `epic-design` does from
   the brief.

4. **The agenda is proposed, then edited.** The first attendee in order
   proposes three to seven items, each a title and the question to settle.
   The run then halts for the person to edit the agenda, unless
   `--no-pause`. A fixed closing item follows the proposed ones: does the
   solution, as settled, reach the goal?

5. **Turns are prose with a typed header.** Attendees speak in persona
   order, raise-hand style: each is asked once per round and may pass. A
   turn is `kind` (`position`, `question`, `objection`, `agreement`,
   `proposal`, `pass`), the agenda item, the turns it answers, `blocking`
   on an objection, `needsHuman` with a stated assumption on a question, and
   the body. The record is `turns.jsonl`, one schema-validated turn per
   line, appended as it happens; `discussion.md` is rendered from it after
   every turn and reads as meeting notes.

6. **What settles an item.** An item is settled when a complete round ends
   with no open blocking objection and no unanswered question that is not
   parked for the owner. Silence is consent: a proposal with no open
   blocking objection after a complete round is a decision; non-blocking
   objections are recorded as dissent. The objector closes their own
   objection with an agreement that answers it. When the objector has
   spoken again without closing it after a reply, the chair asks the
   Judgment service (ADR 0017) one truth question — does the reply resolve
   the objection? — escalating a held answer to the reasoning seat, and
   records the outcome as a Chair turn so the question is not asked twice.

7. **Caps.** Three complete rounds per item and forty turns in all, both
   overridable. An item that hits its cap is left open and moves on; what is
   still open goes to `open-questions.md`, never forced.

8. **What attendees read.** Decisions and parked questions of earlier items,
   the full turns of the current item, the context documents. The Scribe
   reads everything once, at drafting time.

9. **The owner is in the file, not in the room.** A `needsHuman` question
   does not halt the run: the asker states an assumption and the run goes
   on; the question lands under `## Answers` in meeting.md. The deliverables
   mark what depends on it. An answer written there, or text under
   `## Feedback`, becomes an Owner turn on the next run, which reopens that
   item for one more round and redrafts. No interactive prompt in this
   release.

10. **Deliverables and review.** When every item is settled or capped, the
    Scribe writes `outline.md` and `plan.md` from templates in its card, and
    code renders `decisions.md` (ADR-shaped, one entry per decision with its
    dissent) and `open-questions.md` from the turns. Every attendee then
    gets one review turn on a synthetic agenda item, with the same turn
    kinds; the Scribe makes one fix pass for the blocking objections, and
    the meeting is done. The flow makes no git commits.

11. **Where the code lives.** The meeting, persona, agenda and turn schemas,
    the markdown parsers and renderers, the derived state (open objections,
    open questions, decisions, settled or capped items) and the chair's
    `nextAction` are a pure module, `packages/flow/src/Roundtable.ts`,
    tested without a model. The flow file wires one read-only reasoning
    seat, the files and the events. A typed `RoundtableTurn` event and a
    lane per attendee make the room visible in `llm4ts watch` (ADR 0033).

## Consequences

- A team can run the conversation that precedes an epic, watch it, correct
  it from a file, and get an outline, a plan, the decisions with their
  dissent and the questions nobody in the room could answer.
- The chair is code, so a meeting always ends, every run is resumable, and
  the protocol is tested with the fake connector and the fake judgment
  backend.
- Personas are a new concept beside roles: cards describe a voice, roles
  describe a seat. Nothing in the roster changes.
- The plan is written for people. It is not an epic brief and
  `epic-stories` cannot plan from it yet.
- No `llm4zio` parity impact: there is no counterpart.

## Not decided here

- `--interactive`: pausing for the owner's answer inside a run.
- `--read-repo`: read-only attendees over the working tree, with the code
  graph.
- `--brief`: emitting an approved-shape epic brief beside `plan.md`.
- An executor per persona (a `executor:` field on the card is reserved).
- A tagged standards corpus loaded per persona instead of one context
  folder for all.
- A second review round, or a Facilitator persona chairing in prose.
