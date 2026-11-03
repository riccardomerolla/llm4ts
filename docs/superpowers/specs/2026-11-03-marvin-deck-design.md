# Marvin deck — a ten-minute explanation of the method, in motion

Date: 2026-11-03. Status: approved in conversation; built the same day.

## Intent

A short deck that explains the _method_ behind llm4ts, not the library: an
agentic flow you can leave unattended that reaches the goal. It is used twice:

- a ten-minute online talk (slides shared from the presenter's screen);
- a first presentation to a team that is about to adopt the method.

The project is presented under the name **Marvin** (after the android in
_The Hitchhiker's Guide to the Galaxy_). The tone is explanation, not sales.

## Goals

- One idea per slide, carried by an animation rather than by bullets.
- Reuse the visual idiom of `docs/presentation/agentic-flows-in-motion.html`
  (dark zinc, Geist, nodes whose colour is their state, arrows, "left behind"
  artifacts). That idiom was judged clearer than an isometric factory scene
  and than a phosphor "Guide screen" treatment; both were mocked and parked.
- Animations survive a screen share: large, slow, and they replay on their own
  while the presenter talks.
- A backup export: the browser's "save as PDF" gives one page per slide with
  every card in its finished state.
- English and Italian versions with identical structure.

## Non-goals

- No product/brand pitch, no pricing, no roadmap, no feature list.
- Not a tutorial of the CLI. Commands do not appear.
- No slide-authoring framework; a single self-contained HTML file per
  language, like the existing presentation page.

## Anti-goals

- A deck that reads as "agents write code": the point is the gate and the
  checkpoint, not the generation.
- Numbers without a source: the only figure is the real IBM ACE run.

## The eight slides

1. **Cover.** "Agents do the volume. People make the decisions." State legend
   and the basic loop (plan, code, checks, review, commit) running underneath.
2. **Why unattended fails.** Two rows: a coder reports "done ✓" and the build
   goes red; a long task's timer climbs until it is interrupted at 1h 40m,
   having solved a different problem.
3. **Done is not an opinion.** Coder, checks, review seat, judge, commit. The
   checks reject the first "done"; the judge answers "merge? 0.91".
4. **The plan is a document.** Draft, you, build. The yellow node waits; the
   plan is sent back once (edits kept), then approved.
5. **Stop and resume.** Five tasks, the agent drops out on the third, rerun
   keeps the two already done.
6. **Swap the agent.** Same flow, the coder seat cycles Claude, Codex, Gemini,
   local model on each replay.
7. **One real run.** Eight stories in waves with two judge rejections, an
   elapsed clock to 2h 04m, the epic node ending "8/8 merged". Source: the
   epic-stories run that produced an IBM ACE project from a spec in about two
   hours, against days of human-only development.
8. **What it is not.** Three limits, and a line showing the only two yellow
   nodes a person touches.

Each slide carries one dry footnote in Marvin's voice, in muted grey so the
state colours remain the only colours.

Decided during the build: one deck serves both events (no separate "your first
week" ending; the team session continues in conversation after slide 8).

## How it is made

- `docs/presentation/marvin-deck.html` (English) and
  `docs/presentation/marvin-deck.it.html` (Italian).
- A 1280×720 stage scaled to the window; arrow keys, space and click advance;
  each slide's card auto-plays 0.5 s after it opens and replays after a pause.
  Choices a person would make (approve, send back, rerun) are made for them
  after a short wait unless the presenter clicks first.
- The node engine is a copy of the in-motion page's `makeNode`/`makeCard`
  with two additions: a timed auto-answer on `choose`, and a looping `play`.
- Press **P** to enter export mode: all cards jump to their final state, the
  slides stack one per page, and the print dialog opens. Esc leaves it.
- Fonts from Google Fonts, as in the existing page; nothing else external.
- Prettier formats the files (they are under the repository's check).

## Left to the builder

Exact copy per slide, Italian wording, durations inside each scenario, the
footnote wording, and the print stylesheet details.
