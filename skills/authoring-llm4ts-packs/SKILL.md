---
name: authoring-llm4ts-packs
description: Use when asked to create, extend, or fix a modernization pack for llm4ts's modernize-* flows — a pack.md manifest plus prompts/ and reviewers/ sidecars that teach the pipeline a legacy technology or a target stack — and to check it against an estate without calling an LLM.
---

# Authoring llm4ts packs

The `modernize-*` flows (survey, extract, seed, implement, verify, review)
read everything stack-specific from a **pack**: a directory with a `pack.md`
manifest and Markdown sidecars. `LLM4TS_PACK=<dir>` selects it, resolved
against the launch directory first, then against the built-in packs the
shell ships. Writing a pack is the whole job of supporting a new legacy
source or target.

## When to use

- The user names a legacy technology or target stack the shipped packs do
  not cover, or asks to tune an existing pack's rules, prompts, or gates.
- NOT for running the modernization phases on an estate: that is
  `using-llm4ts` with `llm4ts run modernize-<phase>`.

## Step 1: write the manifest

Create `packs/<name>/pack.md` from [references/pack-template.md](references/pack-template.md).
Every field and section is listed with its meaning and default in
[references/manifest.md](references/manifest.md). Only `source:` is
required; everything else has a default. The regexes are the load-bearing
part:

- `sources:` selects the estate's files (repo-relative paths); `exclude:`
  removes some; `programs:` selects the units extract writes one spec for.
- `## Coverage: <name>` and `## Survey: <name>` each carry a `files:` regex
  and a `unit:` regex whose first capture group is the unit name. Coverage
  units must all appear in the traceability matrix; survey units are the
  edges of the dependency graph.

## Step 2: add the sidecars

- `prompts/<phase>.md`: the stack-specific paragraph each phase includes
  in its prompt. Phases read `analysis`, `spec`, `bdd`, `plan` (extract),
  `implement`, `review`, `vectors` (verify), and optionally `survey-refine`
  and `survey-triage`. Write what a senior engineer on that stack would tell
  a newcomer: naming, idioms, what to preserve, what to never invent.
- `reviewers/<lens>.md`: a review lens; optional front matter
  `---\nfiles: <regex>\n---` limits it to matching changed files, then the
  lens's system prompt.
- `lessons.md`: leave empty or absent; the review phase appends to it.
- `scaffold:` in the manifest points at a pack-relative directory copied
  into an empty target by seed.

Copy from the shipped packs when in doubt: `cobol-springboot`,
`jsp-nextjs`, `j2ee-nextjs-spa`, `ace-kafka`, and others live under
`flows/packs/` in the repository and inside the installed shell package.

## Step 3: check without an LLM, then iterate

```bash
LLM4TS_PACK=packs/<name> npx -y @llm4ts/shell run modernize-pack-check --repo <estate>
```

The check loads the pack exactly as survey and extract do, then prints the
manifest as parsed, the files `sources:` and `programs:` select, and every
rule's captured units with a sample. Read the samples and fix the regexes
until they capture real unit names. Exit 1 with `matched no file` means
`sources:` or `programs:` selects nothing; a `warning:` line names a rule
capturing nothing, a missing prompt sidecar, or a scaffold path that does
not exist. Run it after every edit; it costs nothing.

When the check passes, the last line names the next command
(`modernize-survey --repo <estate>`). Report it to the user rather than
launching a paid phase yourself.

## Rules

- Regexes are JavaScript `RegExp` source, matched against forward-slash
  repo-relative paths (`files:`, `sources:`) or single lines (`unit:`).
  Anchor `unit:` patterns to avoid capturing markup fragments such as `#`.
- Keep `sources:` narrow: discovery is capped (20 000 files) and version
  control, dependency, and build directories are never entered.
- Gates are `- name: command` lines under `## Gates`; implement and verify
  run each after every task. Use the target's real commands.
- Judge dimensions are `- name (0..max): rubric`; extract scores every spec
  with them before a human approves it. Two to four precise dimensions beat
  many vague ones.
- Never copy legacy source into the pack: the pack teaches the stack, the
  estate stays where `--repo` points.
