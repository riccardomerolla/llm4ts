---
name: authoring-llm4ts-packs
description: Use when asked to create, extend, or fix a modernization pack for llm4ts's modernize-* flows — a pack.md manifest plus prompts/ and reviewers/ sidecars that teach the pipeline a legacy technology or a target stack — and to check it against an estate without calling an LLM.
---

# Authoring llm4ts packs

The `modernize-*` flows (survey, extract, seed, implement, verify, review)
read everything stack-specific from a **pack**: a directory with a `pack.md`
manifest and Markdown sidecars. `--pack` (or `LLM4TS_PACK`) selects it: a
directory holding `pack.md` while you write it, or a pack name once it is
in a kit — the directory that bundles packs with scaffolds and pattern
cards, discovered in the project, global, and built-in tiers. Writing a pack is the whole job of supporting a new legacy
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
  units must all appear in the traceability matrix; survey units are
  file-to-file edges of the dependency graph.
- `## Node: <kind>` (`files:`, `pattern:` with a `(?<name>…)` group; other
  named groups become attrs; `descriptor: yes` for wiring records such as a
  `web.xml` mapping; `anchor: <attr>` when the node stands for another unit),
  `## Edge: <kind>` (`pattern:` with `(?<to>…)`, optional `(?<thru>…)`,
  `from:`/`to:` node kinds, default `file`) and `## Join: <kind>` (`from:
<kind>.<attr>`, `to: <kind>.<attr>`, `match: exact | url`, `scope: estate
| app | file`) describe sub-file nodes and the links a single regex cannot
  see, such as an ajax URL to the servlet `web.xml` maps it to (ADR 0030).
- `## Probe: <name>` (`from:`, `to:` node references) names a flow that must
  be connected end to end. Pack-check fails when a probe is broken: write one
  per flow you know the estate has before you trust the graph.

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

Copy from the shipped packs when in doubt: `npx -y @llm4ts/shell kits`
lists the built-in kits (`mainframe-java`, `j2ee-nextjs`) with their packs;
they live under `kits/<kit>/packs/` in the repository and inside the
installed shell package. A finished pack joins a kit: a directory under
`.llm4ts/kits/<kit>/packs/` of the project, or `~/.config/llm4ts/kits/`.

## Step 3: check without an LLM, then iterate

```bash
npx -y @llm4ts/shell run modernize-pack-check --pack packs/<name> --repo <estate>
```

The check loads the pack exactly as survey and extract do, then prints the
manifest as parsed, the files `sources:` and `programs:` select, and every
rule's captured units with a sample. Read the samples and fix the regexes
until they capture real unit names. Exit 1 with `matched no file` means
`sources:` or `programs:` selects nothing; a `warning:` line names a rule
capturing nothing, a missing prompt sidecar, or a scaffold path that does
not exist. Run it after every edit; it costs nothing.

The check also builds the graph: one line per Node, Edge and Join rule with
counts and samples, the unresolved items by reason (`edge-target`,
`missing-attr`, `join-from`, `join-to`, `isolated`), and one line per probe.
`llm4ts graph query "<text>" --repo <estate>` and `llm4ts graph path <from>
<to> --format mermaid` show what a rule produced; `llm4ts graph probe` reruns
the probes alone.

When the check passes, the last line names the next command
(`modernize-survey --repo <estate>`). Report it to the user rather than
launching a paid phase yourself.

## Rules

- Regexes are JavaScript `RegExp` source, matched against forward-slash
  repo-relative paths (`files:`, `sources:`) or file contents with flags
  `gm` (`unit:`, `pattern:`), so `^` anchors a line and `[\s\S]*?` spans
  lines. Anchor `unit:` patterns to avoid capturing markup fragments such
  as `#`.
- Keep `sources:` narrow: discovery is capped (20 000 files) and version
  control, dependency, and build directories are never entered.
- Gates are `- name: command` lines under `## Gates`; implement and verify
  run each after every task. Use the target's real commands.
- `## Oracle` (optional) tells the oracle guard what a test file is
  (`- tests: <regex>`) and which extra skip or focus markers count
  (`- markers: @Flaky, @Retry`), merged over the defaults for Vitest, Jest,
  JUnit, pytest and Rust. A task that deletes a test file, adds a marker or
  lowers the passed-test count fails its gate round unless the plan says it
  may (`testsChange: true`).
- `## Review rules` (optional) holds rules every lens of this pack carries
  after the shared preamble (no stubs, no skipped tests, no layering
  workaround); `- preamble: off` leaves the shared preamble out. A target
  repository without a pack puts the same kind of rules in
  `.llm4ts/review-rules.md`.
- Judge dimensions are `- name (0..max): rubric`; extract scores every spec
  with them before a human approves it. Two to four precise dimensions beat
  many vague ones.
- Never copy legacy source into the pack: the pack teaches the stack, the
  estate stays where `--repo` points.
