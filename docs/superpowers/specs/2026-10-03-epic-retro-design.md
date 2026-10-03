# epic-retro: a run's failures become proposed fixes behind an approval

Date: 2026-10-03. Status: approved in conversation, implementing.

## Intent

After an `epic-stories` run with failed stories, one command reads what the
run left behind (trace, transcripts when present, board, report, story
plans, findings, judge verdicts), explains each failure, proposes a fix the
next run can apply, and writes advice for llm4ts itself where the evidence
points at the library rather than the epic. The next `epic-stories` run
applies the fixes once a person ticks `Approved`. Nothing is applied
unreviewed, and nothing a retro writes is ever committed to the target.

Who acts on the output: the next epic-stories run (fixes), the user reading
one Markdown (report and library advice). The library advice is a note, not
a spec for the Ralph queue.

## Command

`llm4ts run epic-retro --repo <target> [--epic <id>] [--run <runId>]`

- `--epic` defaults to the one open epic, chosen as epic-stories chooses.
- `--run` defaults to the epic's latest `runs.jsonl` entry.
- The target is read, never written, except under
  `.llm4ts/epics/<epic>/retro/`.
- The seat is the run's judge seat (read-only reasoner, `LLM4TS_REASONER`).
  Its prompt says the digest is the whole subject; nothing is explored.
- A run that ended `completed` with no failed or waiting story: the retro
  says so and writes nothing.
- epic-stories prints, after any run with failed or waiting stories, the
  exact retro command for that epic.

## Evidence digest (code, deterministic)

Written first, to `retro/<runId>.digest.md`, so it can be read on its own.

Per story that failed, waited, or was active when the run ended:

- outcome, reason, board detail, executor, judge note
- the story's task plan with checkbox state (including `Revision n` tasks)
- the tail of `<id>.findings.md`; the last verdict from `<id>.judge.json`
- lane trace events: `StageFailed`, `Aborted`, `StoryJudged`,
  `ReviewFindings`, `CapabilityDenied`, `ExecutorExcluded`, `Timed` gate
  failures; retry lines (`⟳ … retry n/max`) counted by kind
- transcript, when the run had one: last call's role and input head, failed
  tool results, last reply head, tool-call counts by tool name

Run level: outcome, seats and roster, gates, the Node preflight line, halts,
retry totals, whether transcripts existed, versions where the trace has them.

Caps: per story and overall (`LLM4TS_RETRO_CHARS`, default 60 000); what was
cut is named in the digest.

## Proposal (one structured call)

Schema `RetroProposal`:

- `summary`: two or three sentences.
- `stories[]`: `{ id, diagnosis, fix }` with exactly one `fix`:
  - `tasks`: `[{ title, description }]` appended to the story's plan. Only
    for stories that already have a plan file.
  - `story`: changes to the story's `plan.md` entry (description, owned,
    sharedReadOnly, dependsOn, provides) plus `why`. Restarts the story.
  - `refine`: the story needs a new round; carries the feedback text.
  - `none`: nothing to change, with the reason.
- `runAdvice[]`: `{ finding, evidence }` for environment and configuration.
- `libraryAdvice[]`: `{ title, evidence, suggestion }` for llm4ts, only
  where the flow or a seat misbehaved rather than the epic.

Validation by code before anything is written: unknown story ids, owned
paths outside the repository, `tasks` for a story without a plan, `story`
with no actual change — each dropped with a note in the report.

## Outputs

Under `.llm4ts/epics/<epic>/retro/`:

- `<runId>.digest.md` — what the model saw.
- `<runId>.md` — the report: summary, per-story diagnosis and proposed fix,
  run advice, dropped items, then the approval block: `- [ ] Approved` and
  the list of what approval applies. Tick to approve.
- `<runId>.json` — the validated proposal; the apply step reads this.
- `<runId>-library.md` — advice for llm4ts, only when there is any.

## Applying (epic-stories, at the start of an implementing run)

Not on `--plan-only`, `--refine` planning, or `--land`. After the plan
loads, before scheduling: every `retro/<runId>.md` with `- [x] Approved` and
no `- [x] Applied`, oldest first, applied from its JSON:

- `tasks` → appended to `stories/<id>.plan.md` as unchecked tasks titled
  `Retro <runId>: <title>`. The story stays `failed`; the rerun resumes at
  the first unchecked task.
- `story` → the entry in `plan.md` rewritten through the existing render;
  the hash changes and the existing restart path recreates the worktree.
  Events say: "retro: story X edited, restarting from a fresh worktree".
- `refine` and `none` → nothing; a `refine` item is printed with the
  suggested `--refine` command.

Then `- [x] Applied <date> by <runId>` is appended to the report and an Info
names what changed. Unapproved reports are ignored. A report whose JSON is
missing or no longer matches the plan is skipped with an Info, never a
failure.

## Errors

`RetroNoRun` (no trace for the epic), `RetroNothingToDo` (clean run). A seat
failure fails the retro typed; the digest is already on disk.

## Tests (deterministic, memory store and fakes)

Digest from a synthetic trace, transcript and state; caps; validation
dropping bad fixes; render and approval parsing; apply for each fix kind
including the restart hash change; the end-of-run hint; `epic-retro` with a
structured fake seat.

## Docs and release

ADR 0023, `flows/README.md` section, parity note, CHANGELOG; released as
2.27.0.

## Not in scope

New or removed stories (a `--refine` round), automatic retro at the end of a
run, applying anything unapproved, editing the target's git history.
