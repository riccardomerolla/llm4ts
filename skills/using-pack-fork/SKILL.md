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
- The chosen coder (`LLM4TS_CODER`) must be installed and authenticated,
  same as any other llm4ts flow.

One-shot: re-running with the same `LLM4TS_FORK_AS` overwrites the previous
fork entirely. There is no incremental/partial mode.

## After it runs

Exit codes: 0 success, 1 action failure, 2 usage error (missing/invalid
`LLM4TS_TARGET_KIND` or `LLM4TS_FORK_AS`).

On success, review `.llm4ts/kits/forked/packs/<name>/README.md` and
`conventions.md` against what you actually know of the target repository —
the flow captures findings, it doesn't guarantee them. Flip the marker
(`- [ ] Approved` → `- [x] Approved`) once you've confirmed them, then run
`modernize-implement` with `LLM4TS_PACK=forked/<name>` pointed at that same
repository.

`pack.md`, `prompts/`, and any existing `reviewers/*.md`/`patterns/`/
`lessons.md` from the source pack carry over unchanged except for one
dropped line (`scaffold:` — the target repository already exists, so there
is nothing to seed).
