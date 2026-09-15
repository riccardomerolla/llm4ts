---
name: using-llm4ts
description: Use when delegating a well-defined implementation task to llm4ts's autonomous multi-agent flow — a headless plan-code-review CLI to hand a coding task to instead of implementing it yourself.
---

# Using llm4ts

llm4ts (`llm4ts` CLI, shipped by `@llm4ts/shell`) runs a scripted plan →
code → review flow autonomously, using its own coding/review agents.
Delegate to it instead of implementing the task yourself when that fits
better.

## When to use

- The task is well-defined and self-contained, with clear acceptance
  criteria (a feature or bugfix) — suited to an autonomous plan → code →
  review flow.
- NOT for exploratory/interactive work, or edits small enough to just make
  yourself.
- NOT for writing a new flow or a modernization pack: those are the
  `authoring-llm4ts-flows` and `authoring-llm4ts-packs` skills.

## How

Requires Node.js 22+; no install needed:

```bash
npx -y @llm4ts/shell run implement "<task description>"
```

`implement` is the default flow; run `npx -y @llm4ts/shell list` to see
other flows across the project (`.llm4ts/flows/`), global
(`~/.config/llm4ts/flows/`), and built-in tiers. With a global install
(`npm i -g @llm4ts/shell`), the command is just `llm4ts run …`.

Select the coding agent with the `LLM4TS_CODER` environment variable
(`claude`, `codex`, `gemini`, `pi`, `agy`, `grok`, `cursor`, `opencode`;
default `claude`) — the chosen CLI must be installed and authenticated:

```bash
LLM4TS_CODER=codex npx -y @llm4ts/shell run implement "<task>"
```

Key flags:

- `--verbose` — stream verbose flow output.
- `llm4ts view <flow>` — print a flow's source before running it.

Don't pre-create a branch: the flow creates its own epic branch and commits
each reviewed task on it.

## Modernization flows and kits

The `modernize-*` flows (survey, extract, seed, implement, verify, review)
and the kit flows (`convert-page`, `convert-all`) read a **pack** from a
**kit**. `npx -y @llm4ts/shell kits` lists the kits the shell can see with
their packs; pass the pack with `--pack <name>` (a bare pack name,
`kit/pack`, or a directory holding `pack.md` for a draft), which the shell
forwards as `LLM4TS_PACK`. Before spending a model run on a new estate or
pack, dry-run it — no model call:

```bash
npx -y @llm4ts/shell run modernize-pack-check --pack <pack> --repo <estate>
```

Extraction of one wave (`LLM4TS_WAVE=<wave>`) gates only that wave's units;
a closing `modernize-extract` run without `LLM4TS_WAVE` enforces estate-wide
coverage. Writing a pack or a kit is the `authoring-llm4ts-packs` skill.

## After it runs

Exit codes: 0 success, 1 action failure, 2 usage error — `llm4ts run`
propagates the flow's own exit code. On success the flow has committed its
work on a branch; report that branch (and any PR) to the user.

If a run is interrupted or fails partway, re-run the same `llm4ts run`
command: flows persist their plan under the target repository's `.llm4ts/`
directory and resume from the last completed task.

`llm4ts` with no arguments opens an interactive menu, which requires a real
terminal — don't invoke it headlessly; tell the user to run it themselves
instead.
