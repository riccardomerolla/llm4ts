# ADR 0047: taskforce — A Chief of Staff Plans, Specialists Work Their Briefs, a Doc Writer Delivers

Status: Accepted · Date: 2026-10-31 · Relates to ADR 0007, ADR 0017, ADR 0019, ADR 0033, ADR 0044, ADR 0046

## Context

The roundtable (ADR 0046) runs a flat conversation: equals speak in rounds
and code chairs. Some goals are not a conversation. "Find out whether the
auth module can move to the new gateway and write up the plan" is work
delegated to hands with different tools: someone reads the code, someone
builds a prototype, someone runs the checks, someone reviews, someone writes
it up, and someone keeps the whole thing pointed at the goal.

pstack (cursor/plugins) is the closest written practice: one coordinator
owns briefs and never writes code; a brief is a fixed template (GOAL, SCOPE,
CONTEXT, ACCEPTANCE, VERIFY, TIMEBOX, FORBIDDEN, REPORT); work fans out in
parallel and comes back as PASS, ISSUES or BLOCKED with evidence; reviewers
on different models try to break the result and a lead buckets their
findings; every decision lands in an append-only `decisions.tsv`; a human
is never blocked on — the run assumes, goes on, and says so. Lauren Tan's
reading of it as a cast — Chief of Staff, Researcher, Engineer, Reviewer,
Doc Writer, Operator, Memory Manager — is the shape of the team.

What exists here: persona cards and the file-as-state pattern (ADR 0046),
the executor roster with its five roles (ADR 0019), review lenses (ADR
0044), the Judgment service (ADR 0017), read-only enforcement grades, the
workspace tools and worktrees, and an accepted but unbuilt memory store (ADR
0007).

## Decision

A bundled flow, `taskforce`, that runs a delegation loop. A Chief of Staff
card writes a typed plan; code runs it; specialists work their briefs; a
Doc Writer delivers.

1. **Inputs.** The task text is the goal. `--context <dir>` gives every
   brief the same documents. `--agents` picks among Researcher, Engineer,
   Reviewer, Operator and Memory Manager (default all five); the Chief of
   Staff and the Doc Writer are always present and not selectable.

2. **The plan file is the state.** `.llm4ts/taskforce/<id>/plan.md` holds
   `Status`, `Goal`, `Deliverables`, `Cast`, one section per brief (`### B1.
   <title>` with `Owner`, `Depends on`, `Wave`, then the eight template
   fields), the goal checks, the questions for the owner under `## Answers`
   and free `## Feedback`. Status moves `planned → working → drafting →
   reviewing → fixing → distilling → done`. A rerun derives what to do next
   from the files alone. Reports land in `reports/<brief>.md` with a typed
   header (status, attempt, evidence paths, summary, questions) and the body
   below.

3. **The Chief of Staff plans; code runs.** The Chief of Staff's only output
   is the plan: the deliverables and two to twelve briefs with their
   dependencies. The run then halts for the owner to edit the plan, unless
   `--no-pause`. Code validates a plan before accepting it (count, owners in
   the cast, no dependency cycle, every deliverable named by a brief's
   REPORT, every field present, ACCEPTANCE non-empty); a failing proposal is
   retried once with the violations, then the run stops with `PlanInvalid`.
   The Chief of Staff speaks again only for goal checks: from the reports of
   a wave, either "reached" or a second wave of briefs, once. It never
   writes prose for the reader.

4. **Cards carry hands and seats.** A card gains two sections beside the
   roundtable's: `Tools` (`none`, `read-only`, `commands`, `workspace`) and
   `Seat` (a roster role). Code enforces the grade: a toolless card cannot
   read, a read-only card cannot write, a `commands` card has its commands
   run by code, a `workspace` card gets a throwaway git worktree of the
   repository per brief, removed when its dependents are done unless
   `--keep-work`. Defaults: Chief of Staff, Doc Writer and Memory Manager
   none on planner; Researcher read-only on planner; Reviewer read-only on
   reviewer; Operator commands on verifier; Engineer workspace on coder. A
   roster with different executors per role gives a multi-model team with
   no new concept; without one, every seat is the reasoning CLI, the
   Engineer the coder CLI.

5. **What code enforces in a brief.** TIMEBOX is a turn cap on a workspace
   brief (`--turns`, one cap for every Engineer brief in a run; the field's
   text is prose for the model); hitting it returns a BLOCKED partial
   report. VERIFY is a list of
   commands only a `commands` card may run: a brief owned by anyone else
   that names commands gets a verifying brief after it, owned by the
   Operator, run in the Engineer's worktree when the brief had one. A brief the
   owner had in the file before the run opened it is approved as written;
   any brief added later (a second wave, a fix, a rework), and every brief
   under `--no-pause`, runs only commands the project declares — a package
   script invoked exactly, whose body the worktree has not changed, or a
   line of `.llm4ts/taskforce/commands.md` — and any other is reported
   BLOCKED with the command named. Deliverables are plain file names in
   the run's folder. FORBIDDEN is prose for the model; the grade is the fence.

6. **Waves.** Independent briefs (by `Depends on`) dispatch together up to
   `--parallel` (default the seat's roster slots, one without a roster). A
   wave is done when every brief of it has a final report. A brief that
   comes back BLOCKED is dispatched once more with its report appended; a
   second BLOCKED is final and lands in `open-questions.md` with the
   assumption the run took. Caps: three waves and twelve briefs, both
   overridable; the fix wave counts as a wave.

7. **The Reviewer interrogates.** After the Doc Writer's draft, the review
   lenses under `.llm4ts/lenses/` (two bundled when none: evidence and
   risk) each read the deliverables and every Engineer diff on the
   Reviewer's seat and report findings. The Judgment service answers one
   truth question per finding — "this finding blocks the goal" — into
   act-on or consider; the Reviewer card's lead turn moves consider
   findings to noted or dismissed with a reason. `review.md` records all
   four buckets. Act-on findings become one fix wave, each finding a brief
   for the owner of the work it is about (the Doc Writer when it is about a
   deliverable); the Doc Writer then redrafts, and the run goes on to its
   end. No second review.

8. **Deliverables.** The plan names them; the Doc Writer writes every one
   from the reports once the last wave is in, `result.md` always among them
   (the answer, its sources, the next steps, in that order, from the
   template in its card). Code writes `decisions.tsv` (every row: a plan
   accepted or edited, a brief dispatched, a report with its status, a
   judgment with its probability, a goal check, a cap hit, an assumption
   taken; columns ts, phase, decision, why, evidence, result; append-only)
   and `open-questions.md`. The plan is written for people. It is not an
   epic brief. The flow makes no git commits in the repository.

9. **The owner is in the file.** A specialist's question for the owner lands
   under `## Answers` with the assumption the run took; the run goes on. An
   answer written there reopens the brief that asked, with the answer in its
   CONTEXT, for one more wave within the cap. Feedback written after `done`
   becomes an act-on finding for the Doc Writer: a fix wave, a redraft. No
   interactive prompt.

10. **Memory, first slice of ADR 0007.** `.llm4ts/memory/*.md` are topic
    notes the owner keeps. Recall is code: keyword overlap between the goal
    and each note's title and headings, the top five under a budget, folded
    into every brief's CONTEXT as what was learned before. The Memory
    Manager speaks once, at the end, and writes
    `.llm4ts/memory/runs/<id>.md` with Decisions, Preferences (what the
    owner changed in the plan or answered), Failed and Pointers. Promotion
    from `runs/` to a topic note is manual. `--no-memory` turns both off.

11. **Where the code lives.** The plan, brief, report, finding and trail
    schemas, the markdown parsers and renderers, the derived state and the
    `nextAction` of the loop are a pure module,
    `packages/flow/src/Taskforce.ts`; notes and recall are
    `packages/flow/src/Memory.ts`; both are tested without a model. The flow
    wires the seats, the worktrees, the process executor, the lenses and the
    events. A typed `BriefReported` event and a lane per specialist make the
    team visible in `llm4ts watch` (ADR 0033).

## Consequences

- A goal that needs hands — reading, building, running, reviewing, writing
  — gets a team that works it in parallel, a plan the owner edits before
  anything runs, a reviewed deliverable, a decision trail, and the questions
  nobody could answer, with the assumptions taken.
- The Chief of Staff is a persona, not the chair: code still decides what
  happens next, so every run ends and every run resumes.
- Cards grow two sections. A roundtable card without them is unchanged.
- The roster gains a second consumer of its role seats; nothing in it
  changes.
- The memory store of ADR 0007 exists as files and a recall function. Its
  scoping, distillation at phase boundaries and promotion remain open.
- No `llm4zio` parity impact: there is no counterpart.

## Not decided here

- `--arena N` on Engineer briefs: N candidates, a cross-judge, a graft.
- A brief whose owner is a roundtable: the Chief of Staff convenes a
  meeting as a step.
- Web research for the Researcher.
- The cross-model audit of `decisions.tsv`.
- `--interactive`: answering a question inside the run.
- A flow that promotes run notes into topic notes.
