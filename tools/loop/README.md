# `@llm4ts/loop` — the dogfood loop

A Ralph-style autonomous development loop whose engine is `llm4ts` itself. Point
it at one spec and it plans the work, then implements each task under
runtime-owned git with a review-and-fix cycle gated on CI.

The loop is a **forcing function**, not a replacement: every friction point it
surfaces becomes a new spec in `specs/pending/`. `ralph-auto.sh` stays the
fallback until the loop has completed three specs end-to-end unattended (the
**trust bar** below).

## Why it is a separate project

This directory is a **stable-compiler bootstrap**. It has its own `package.json`
and `pnpm-lock.yaml` and is deliberately **not** part of the repository's pnpm
workspace. It depends on the latest **published** `@llm4ts/*` release (pinned to
`0.1.2`), so a broken change to the library-in-development can never break the
tool that develops it. Upgrading the pin is a deliberate act taken after a
release, not an automatic side effect.

## Install

```bash
cd tools/loop
pnpm install --ignore-workspace
```

`--ignore-workspace` keeps this project standalone; the lockfile here is the one
that matters, not the repository root lockfile.

## Usage

```bash
# from tools/loop, developing the repository two levels up
pnpm loop ../../specs/pending/flow-authoring-guide.md --repo ../..

# see the plan without touching the repository
pnpm loop ../../specs/pending/flow-authoring-guide.md --repo ../.. --dry-run
```

```text
usage: loop <spec-path> [--repo <path>] [--dry-run]
  spec-path        the specs/pending/*.md file to implement (one spec per run)
  --repo, -C       repository the loop develops (default: current directory)
  --dry-run        plan and print the tasks, then stop without touching the repo
```

### Environment

| Variable                 | Default                    | Meaning                                                       |
| ------------------------ | -------------------------- | ------------------------------------------------------------- |
| `LLM4TS_CODER`           | `claude`                   | coding agent: claude/codex/gemini/pi/agy/grok/cursor/opencode |
| `LLM4TS_LOOP_BUDGET_USD` | `5`                        | per-run cost ceiling; the run fails when exceeded             |
| `LLM4TS_LOOP_TURN_LIMIT` | (connector default)        | per-task turn limit handed to the coder                       |
| `LLM4TS_LOOP_GATE`       | typecheck+lint+format+test | CI gate command run as the review lint gate                   |
| `LLM4TS_LOOP_MAX_ROUNDS` | `3`                        | review-and-fix rounds before the task fails                   |
| `LLM4TS_VERBOSITY`       | `normal`                   | terminal verbosity: quiet/normal/verbose                      |

## What one run does

1. **Plan** — `planFrom(reasoning, spec)` produces a `Plan`, persisted under
   `.llm4ts/` in the target repo and recovered on re-run (resumable).
2. **Per task**, in order, with a **fresh chat** each time (Ralph parity):
   - `git.checkpoint` before touching anything;
   - `coder.ask(taskPrompt)`;
   - `reviewAndFixLoop` with the minimal reviewers and the CI command as the
     lint gate — the task only advances when the gate is green;
   - `git.commitAll` on success;
   - `git.rollback` to the checkpoint on any failure, then the run exits
     non-zero (fail fast). A re-run resumes at the failed task.
3. **Budget** — the accrued cost is checked against `LLM4TS_LOOP_BUDGET_USD`
   after each task; exceeding it rolls back and stops the run.
4. **Bookkeeping** — after the run the spec's `- [ ]`/`- [x]` checkboxes are
   synchronised from plan state deterministically (`CheckboxSync.ts`, no LLM).
   The loop is the only writer and never unchecks a box.
5. **Trace & cost** — a JSONL trace is always written under `.llm4ts/` and a
   cost summary is printed on exit.

The loop **owns git** and **never pushes**. It does not mutate the plan mid-run,
does not select specs on its own, and wires no approval/interaction path — those
are explicit non-goals for v1 (see `specs/pending/dogfood-loop.md`).

## Trust bar

Three specs completed end-to-end **unattended** before the loop takes over any
of `ralph-auto.sh`'s duties. Until then, run it as a forcing function and file
every gap it exposes as a spec in `specs/pending/`.

## Develop

```bash
pnpm typecheck   # tsc against the published @llm4ts/* types
pnpm test        # deterministic checkbox-sync tests (no network, no provider)
```
