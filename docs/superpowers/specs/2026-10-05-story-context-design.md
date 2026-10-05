# Story context: why epic-stories takes days, and what changes

Date: 2026-10-05 · Status: implemented in 2.29.0 (ADR 0025)

## The problem as observed

A customer runs `epic-stories` with the Gemini CLI as the only executor. An
epic takes days. Watching `llm4ts watch --tail`, the coder spends most of its
time listing and grepping the repository, then struggles to solve the task it
gave itself. `llm4ts profile` told the user nothing useful.

## Diagnosis (from the code, not from a run)

1. **Explore turns, not explore time.** Every Gemini `tool_use`/`tool_result`
   pair is already timed and categorized (explore/edit/test/…), but grep takes
   milliseconds. The minutes go to the model thinking between tool calls, which
   the profile books as model time. The profile shows tool _time_; the symptom
   is tool _turns_, which it never shows.
2. **Every task is a cold start.** The coder writes its own task list, then each
   task runs in a fresh chat (ADR 0003, `chatPerTask: true`). Nothing learned in
   task 1 reaches task 2, so a six-task story explores up to six times.
3. **The planner cannot name files.** It sees only CONTRIBUTING.md (24k cap) and
   the brief, so a story cannot point at the exemplar feature, the contract it
   extends or the kit component to reuse. "Imitate the exemplar feature" is
   given to the coder without the exemplar's path.
4. **Nothing says what done looks like.** The Story schema has `provides` but
   no acceptance criteria; the judge sees only the diff and a rubric.

## Decisions

1. **Profile per story**: tool calls by kind (explore/edit/test/other), tasks
   the coder gave itself, time and explore calls before its first edit, and a
   plain-words finding when a story wandered. Transcripts are on by default for
   `epic-stories` (`LLM4TS_TRANSCRIPT=off` turns them off) and are **compacted**
   on `--land` instead of deleted: shape kept (calls, tools, timings), content
   removed (inputs, replies, tool arguments and outputs).
2. **Findings carried across tasks**: each task's reply ends with a short
   `## Findings` section; it is saved beside the story
   (`stories/<id>.notes.md`) and prepended to the next task's prompt.
3. **Per-epic orientation digest**: deterministic, no model call, computed once
   from the epic checkout's tracked files: folders with file counts (small
   folders listed in full), package scripts, where tests live. Own budget
   (`LLM4TS_ORIENTATION_CHARS`, default 8000, 0 disables), given to the planner
   and to every coder's system prompt.
4. **Story anchors**: a `readFirst` field the planner fills from the digest;
   paths that do not exist in the checkout are dropped mechanically with an
   Info note; their contents join the starting code first, under the existing
   `LLM4TS_STORY_CONTEXT_CHARS` budget.
5. **Acceptance criteria**: an `acceptance` field the planner fills with 2–6
   observable outcomes. The coder sees them as "Done when", its task plan must
   name the criterion each task satisfies, and the judge's `provides` dimension
   scores against them (rubric judge and blackboard story-board alike).
6. **CodeGraph / symbol index: parked.** Revisit only if the new profile still
   shows explore turns dominating after 1–5; then distil (a cached index file),
   never depend (ADR 0007's stance).
7. **No GEMINI.md**: the system prompt is already flattened into Gemini's
   prompt. No new Gemini flags.

## Constraints

- Existing plans keep their story hashes: `readFirst`/`acceptance` enter the
  hash only when non-empty, so an upgrade restarts no story.
- Everything is executor-agnostic prompt/context shaping; pi, codex and claude
  benefit the same way.
- Deterministic tests only; no network, no provider CLIs.
- One ADR (0025), one `docs/parity.md` note, release 2.29.0.
