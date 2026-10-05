# ADR 0025: Story Context — Orientation, Anchors, Acceptance, Carried Findings

Status: Accepted · Date: 2026-10-05

## Context

A customer runs `epic-stories` with the Gemini CLI as its only executor and an
epic takes days. Watching `llm4ts watch --tail`, the coder spends its time
listing and grepping the repository, then struggles with the task it gave
itself. `llm4ts profile` showed nothing: tool time is milliseconds, the
minutes are the model's turns between tool calls, and the profile never
showed turns.

Reading the executor explained the shape:

- every task runs in a fresh chat (ADR 0003), so a six-task story explores up
  to six times;
- the planner sees only CONTRIBUTING.md and the brief, so a story cannot name
  the exemplar feature, the contract it extends or the kit component to reuse;
- a story has `provides` but no acceptance criteria, so neither the coder's
  task plan nor the judge has a statement of done.

## Decision

1. **A deterministic orientation digest** (`flow/src/Orientation.ts`) of the
   epic checkout's tracked files — folders with counts, small folders in
   full, package scripts, where tests live — computed once per epic without a
   model call, under its own budget (`LLM4TS_ORIENTATION_CHARS`, default
   8000), given to the planner and to every coder's system prompt.
2. **Stories carry `readFirst` anchors** the planner names from the digest.
   Anchors no tracked file lies under are dropped mechanically with an Info
   note (`pruneReadFirst`); the rest open the coder's starting code, before
   the shared read-only files, under `LLM4TS_STORY_CONTEXT_CHARS`.
3. **Stories carry `acceptance` criteria**: observable outcomes the planner
   writes. The coder sees them as "Done when", its task plan names the
   criterion each task satisfies, and the judge's `provides` dimension scores
   against them (rubric judge and story-board alike).
4. **Findings are carried across tasks** (`flow/src/CarriedNotes.ts`,
   `implementPlanFlow({ carry })`): each task ends with a `## Findings`
   section, saved at `stories/<id>.notes.md` and prepended to the next task's
   prompt. ADR 0003's fresh chat per task stays; what travels is a note, not
   the history.
5. **The profile shows coder work per story**: tool calls by kind, the tasks
   the coder gave itself, and the explore calls and time before its first
   edit, with a finding when a story found its way instead of being told.
6. **Transcripts are on by default for epic-stories** (`LLM4TS_TRANSCRIPT=off`
   turns them off) and `--land` compacts them — shape kept, inputs, replies,
   tool arguments and outputs removed — instead of deleting them.
7. **A symbol-level code index is parked.** It is reconsidered only if the
   new profile still shows explore turns dominating; if so it is distilled
   (a cached index file), never a dependency, as ADR 0007 did for memory.

## Consequences

- Both new Story fields default to empty and enter `storyHash` only when set:
  a plan written before 2.29 parses and resumes with every hash intact.
- Each task prompt grows by the carried notes (at most 6000 characters) and
  each coder system prompt by the digest (at most 8000); each task reply
  grows by a ten-line section.
- The digest is generic (tracked files, package scripts, test files). What
  the exemplar is stays the planner's judgment, now made with the layout in
  front of it.
- Divergence from the pinned llm4zio (which has no story context of this
  kind) is recorded in `docs/parity.md`.

## Not decided here

A symbol index; acceptance criteria checked mechanically; GEMINI.md or any
Gemini-specific context file (the system prompt is already flattened into
Gemini's prompt).
