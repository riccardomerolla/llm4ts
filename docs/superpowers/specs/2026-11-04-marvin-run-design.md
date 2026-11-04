# Marvin, second cut — the run is the talk

Date: 2026-11-04. Status: decided by the builder, on the presenter's "decide
everything" brief; built the same day.

## The decision

No slides. The talk is a time-lapse of the real kind of run the method is
about: an epic-stories run that produced an IBM ACE project from a spec in
about two hours, replayed in nine minutes at 14× speed, on one screen. The
presenter never clicks. The run advances the talk.

Why this and not the deck: the deck (`marvin-deck.html`, 2026-11-03) explains
the method one idea at a time, and each idea is a small staged card. A talk
whose subject is "a flow you can leave unattended" is more convincing when the
audience watches one actually being left unattended for nine minutes, and sees
the ideas appear at the moment the run demonstrates them. The deck remains the
backup and the hand-out; this is the stage version.

## What the audience sees

A 1280×720 stage, scaled to the window, in the in-motion idiom (dark zinc,
Geist, nodes whose colour is their state).

- **Top bar.** The run clock (large, the only big number on screen), the
  speed (`14×`), the talk clock (small), a progress bar of the run.
- **Epic row.** `spec → plan → you → integrate → 8/8`. The yellow node is the
  one place a person acts.
- **Eight story lanes.** Each lane: story name, the coder seat
  (Claude, Codex, Gemini, a local model), then
  `coder → checks → review → judge → merge`. Three run at a time; a lane
  starts when a slot frees. Nodes turn blue, green, red, orange as the run
  goes; a short bubble carries the one-line reason ("3 tests red",
  "merge? 0.31", "context lost", "resumed · 2/3 kept").
- **Callout.** One idea at a time, at the bottom, in words the run has just
  earned. It replaces itself at the next beat and dims after 25 s so the
  graph stays the subject.

## The seven beats

Run time → talk time at 14×.

| #   | run  | talk | what happens on screen                      | the idea                                            |
| --- | ---- | ---- | ------------------------------------------- | --------------------------------------------------- |
| 1   | 0:03 | 0:13 | plan node turns yellow, waits 3 min         | The plan is a document. One person approves it.     |
| 2   | 0:21 | 1:30 | S2 coder says done, checks go red           | Done is not an opinion.                             |
| 3   | 0:43 | 3:04 | S3 judge answers `merge? 0.31`, story loops | The judge answers a question, it does not write.    |
| 4   | 1:03 | 4:30 | S5 coder drops, resumes with 2/3 tasks kept | Long runs lose the thread. Checkpoints do not.      |
| 5   | 1:24 | 6:00 | S8 starts on a local model                  | The agent is a seat. Four seats wrote this project. |
| 6   | 2:04 | 8:51 | epic node: `8/8 merged`                     | Two hours. Two decisions by a person.               |
| 7   | —    | 9:16 | graph stays                                 | What it is not.                                     |

The opening line is spoken before pressing space, over a black stage with the
title: "This is a two-hour job. I will run it in the next nine minutes. Count
the decisions a person makes. There are two." The close is beat 6's words
read off the screen, then beat 7, then Marvin's last line.

## Honesty line

The timeline is a **reconstruction**: the shape of the real run (eight
stories in waves, a rejected story, an interrupted coder, mixed seats, about
two hours) with illustrative minute marks. The stage says `reconstruction`
in the footer. When the real run's event log is exported
(`llm4ts profile` already has the events), the embedded `EVENTS` table is
the only thing to replace.

## Controls

- Space: start; then pause/resume (for a question).
- ← →: jump to the previous/next beat. R: restart. L: English/Italian.
- P: export. Each beat becomes one page: the graph frozen at that moment,
  with its callout. Esc leaves export.

## Files

- `docs/presentation/marvin-run.html` — the stage, bilingual (L key,
  `#it` opens in Italian).
- `docs/presentation/marvin-run-sheet.md` — the presenter's run sheet:
  minute marks, what is on screen, what to say, what not to say.
  `marvin-run-sheet.it.md` is the same sheet in Italian.

## Non-goals

No commands on screen, no product names other than the coder seats, no
numbers other than the clock and the judge's probabilities.
