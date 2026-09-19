---
name: using-pack-fork
description: Use when a target repository is already in production with its own real conventions (tech stack, naming, shared components, auth, design system) and you want a pack that captures them, so a later modernize-implement run reuses them instead of guessing.
---

# Using pack-fork

`pack-fork` (an llm4ts flow, `llm4ts run pack-fork`) analyzes a real,
already-in-production target repository and forks an existing pack into a
new one whose `conventions.md` describes that repository's own tech stack,
naming conventions, shared components, auth/permissions, and design system —
so a later `modernize-implement` run pointed at the fork writes new code
that reuses what's already there instead of inventing something new.

## When to use

- You have a target repository that's already in production, already built
  to real standards, and you want new business logic added to it via
  `modernize-implement` to stay inside those standards.
- NOT for a repository that doesn't exist yet — that's `modernize-seed`'s
  scaffold-based flow, unrelated to this one.
- NOT for writing a pack from scratch or extending `pack.md`'s own schema —
  that's the `authoring-llm4ts-packs` skill.

## How

```bash
LLM4TS_PACK=<source pack> \
LLM4TS_TARGET_KIND=frontend \
LLM4TS_FORK_AS=<new-pack-name> \
npx -y @llm4ts/shell run pack-fork --repo <path-to-target-repo>
```

- `LLM4TS_PACK` — the source pack to fork from, resolved the normal way
  (bare name, `kit/pack`, or a directory holding `pack.md`).
- `LLM4TS_TARGET_KIND` — `frontend` or `backend`; picks which fixed set of
  categories gets analyzed (tech stack always included either way).
- `LLM4TS_FORK_AS` — the new pack's name, lowercase kebab-case. The fork
  lands at `<repo>/.llm4ts/kits/forked/packs/<LLM4TS_FORK_AS>/` — always
  under a dedicated `forked` project-tier kit, never the source pack's own
  kit name, so it can never hide that kit's other packs.
- `LLM4TS_FEEDBACK` (optional) — free text. Re-running with the same
  `LLM4TS_FORK_AS` and this set revises the existing fork instead of
  starting over: the prior `conventions.md` plus your feedback feed every
  pass, including which files get selected as grounding.
- The chosen coder (`LLM4TS_CODER`) must be installed and authenticated,
  same as any other llm4ts flow.

Every run is a single batch invocation, same as any other llm4ts flow —
re-running with the same `LLM4TS_FORK_AS` clears and overwrites the
previous fork entirely (`LLM4TS_FEEDBACK` changes what goes into that
overwrite, not the batch mechanics). There is no incremental/partial mode
and no mid-run interactive prompt — if you're not happy with a fork, re-run
with feedback rather than expecting the flow to pause and ask.

## Forked pack contents

The fork is a full copy of the source pack's files (`pack.md` minus its
`scaffold:` line, `prompts/`, any existing `reviewers/*.md`,
`patterns/`, `lessons.md`), plus three new files this flow adds:

- `conventions.md` — the target repository's tech stack, naming
  conventions, shared components, auth/permissions, and design system,
  captured by four bounded analysis passes, each grounded on real files a
  separate selection step picked from the repository's actual file tree
  (not a fixed list — every pass gets real grounding, not just tech stack).
  Read directly by `modernize-implement`'s generation prompt (like
  `lessons.md` already is), so the coder sees these conventions before
  writing anything.
- `provenance.md` — which real files justified each category's findings,
  and why. Trace a rule in `conventions.md` back to the file that grounded
  it, without re-running anything.
- `reviewers/target-conventions.md` — a static, generated review lens
  checking new code against `conventions.md` as a post-hoc backstop.

The terminal shows real content as the flow runs, not just progress
markers — the file selection (with reasons) and each category's full
findings are published as they complete.

## After it runs

Exit codes: 0 success, 1 any failure (including a usage error like a
missing or invalid `LLM4TS_TARGET_KIND`/`LLM4TS_FORK_AS`) — `llm4ts run`
propagates the flow's own exit code.

On success, review `.llm4ts/kits/forked/packs/<name>/README.md`,
`conventions.md`, and `provenance.md` against what you actually know of the
target repository — the flow captures findings, it doesn't guarantee them.
Not satisfied? Re-run the same command with `LLM4TS_FEEDBACK=<what to fix>`
to revise the fork instead of starting over. Once you've confirmed it, flip
the marker (`- [ ] Approved` → `- [x] Approved`) — `modernize-implement`
enforces this: it refuses to run against a pack whose `README.md` still
carries the unapproved marker, failing fast before doing anything else. Then
run `modernize-implement` with `LLM4TS_PACK=forked/<name>` pointed at that
same repository, launched with its working directory inside the target
repository — project-tier kit discovery (which is how `forked/<name>`
resolves) is keyed off `cwd`, not `--repo`, so running it from anywhere else
will fail with `PackNotFound` even though the fork exists.

`pack.md`, `prompts/`, and any existing `reviewers/*.md`/`patterns/`/
`lessons.md` from the source pack carry over unchanged except for one
dropped line (`scaffold:` — the target repository already exists, so there
is nothing to seed).
