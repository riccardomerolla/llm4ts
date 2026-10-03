# ADR 0023: A Run's Failures Become Proposed Fixes Behind An Approval

Status: Accepted · Date: 2026-10-03

## Context

A failed `epic-stories` run leaves a trace (`.llm4ts/trace-<ms>.jsonl`),
transcripts when started with `--transcript`, a board, a report, and per
story a task plan, a findings log and a judge verdict. Nothing read them
back. A person restarted the run, the failed stories were retried from
their first unchecked task, and the judge and reviewers were asked again
with no memory of what they had said. Live runs with the Gemini CLI made
the cost visible: judge seats failing the same way on every restart, with
the reason sitting in a transcript nobody opened.

The flow already has two inputs a rerun honors: the story's own task plan
(it resumes at the first unchecked task, and judge findings already land
there as `Revision n` tasks) and the epic `plan.md` (a changed story entry
restarts that story from a fresh worktree). It also has one human gate
pattern, the `- [x] Approved` marker the epic brief and the modernization
phases use.

## Decision

1. **`epic-retro` is a standalone flow**, run after a red run (which prints
   the command). A run that died mid-way never reaches its own end, so the
   retro cannot live inside epic-stories; and it is a model pass over a
   trace and transcripts, a cost not every red run deserves.
2. **Code builds the evidence** (`flow/src/Retro.ts`): a deterministic,
   capped digest of the run's artifacts, written first so a failed seat
   still leaves it to read, and so the digest is a tool on its own.
3. **One structured call, validated by code.** The seat is the run's judge
   seat (read-only) and its prompt says the digest is the whole subject. The
   reply is a typed `RetroProposal`: per story a diagnosis and exactly one
   fix of four kinds. Code drops what the plan cannot take and lists it in
   the report rather than failing.
4. **Two kinds are applied, two are reported.** `tasks` appends to a
   story's plan; `story` edits its `plan.md` entry so the existing restart
   path recreates it. `refine` (a new round) and `none` are only printed:
   adding or removing stories is what `--refine` already does with its own
   planner and approval.
5. **Nothing is applied unreviewed.** The report ends in `- [ ] Approved`.
   The next implementing epic-stories run applies approved, unapplied
   retros from their JSON (never from the Markdown, so a hand edit cannot
   drift from what is applied), marks them `- [x] Applied <date>`, and says
   what changed. A refine planning run and `--land` apply nothing.
6. **Library advice is a note, not a spec.** `retro/<runId>-library.md`
   is written only when the seat found the flow or a seat misbehaving, and
   it feeds nothing automatically: a person reads it and decides.

## Consequences

- A restart after a retro resumes at the fix, not at the beginning.
- Every retro costs one model call over at most `LLM4TS_RETRO_CHARS`
  characters (default 60 000), visible in the run's own trace and in
  `llm4ts costs`.
- Transcripts are the richest evidence and are off by default; the digest
  says when they were missing and the report advises `--transcript`.
- `--land` removes earlier runs' transcripts, so a retro after landing sees
  only the landing run's.
- Divergence from the pinned llm4zio (which has no post-run analysis) is
  recorded in `docs/parity.md`.

## Not decided here

An automatic retro at the end of a run, retros over several runs at once,
and turning library advice into a `specs/pending/` entry.
