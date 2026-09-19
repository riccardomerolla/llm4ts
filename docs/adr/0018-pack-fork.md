# ADR 0018: `pack-fork` — Adopting A Real Target Repository's Conventions Into A Pack

Status: Accepted · Date: 2026-09-19

## Context

`modernize-*`'s packs describe a legacy→target _translation contract_
(`Gates`, `Judge`, `Coverage`, `Survey`, `Consolidate` — all wired to
extracting and scoring against a legacy estate). A recurring real scenario
doesn't fit that shape: a customer already has a production repository built
to their own real standards (tech stack, naming, shared components, auth,
design system) and wants a later `modernize-implement` run to add new
business logic that reuses those standards — without hand-authoring a pack
that describes them, and without touching the shared, reusable builtin pack
every other project using that kit relies on.

## Decision

`pack-fork` is a new, kit-agnostic engine flow (`flows/pack-fork.ts`),
rooted at the target repository itself (`--repo`) — there is no legacy
repository in this flow, so it needs none of `modernize-refine`'s
`LLM4TS_TARGET_REPO`/`contextFor` dual-repo rebinding.

It resolves a source pack the normal way (`LLM4TS_PACK`), runs several
bounded, focused `structuredAndPublish` passes against the target repo (a
grounded tech-stack pass reading real manifest files, plus qualitative
passes for naming/architecture, shared resources/design, and auth/API/
testing — one of two fixed category lists selected by
`LLM4TS_TARGET_KIND=frontend|backend`), and forks the source pack's files
verbatim into `<repo>/.llm4ts/kits/forked/packs/<LLM4TS_FORK_AS>/` — always
under a dedicated `forked` project-tier kit name, never the source pack's
own kit name (kit discovery dedupes by name across tiers; reusing the
source kit's name would hide its other packs from the project).

`scaffold:` is dropped from the fork entirely: `modernize-seed` already
treats a non-empty target repository as adopted, not seeded, so there is
nothing for a scaffold pointer to do once a pack is describing a repository
that already exists.

The findings land as a new, optional `Pack.conventions` field
(`conventions.md`, loaded exactly like `lessons.md`) folded directly into
`modernize-implement`'s generation system prompt — the primary mechanism,
so the coder sees the repository's real conventions before writing
anything — plus a static `reviewers/target-conventions.md` lens as a
secondary, post-hoc backstop.

Trust: the forked pack's `README.md` carries the same unchecked
`- [ ] Approved` marker (`packages/flow/src/Approval.ts`) every
`modernize-extract` pack does — no judge rubric, since "did this correctly
capture our design system" has no checkable ground truth the way "does this
spec match the legacy source" does; a human who knows the repository reads
and confirms instead. Nothing currently calls `requireApproval` against a
forked pack's `README.md`; flipping the marker is a human signal for now,
not an enforced gate — wiring enforcement into `modernize-implement` is a
natural follow-up, not part of this change.

One-shot for v1, not resumable — re-running clears and overwrites the
previous fork under the same name. Before that clear runs, the flow
resolves the source pack's own directory and the fork's destination
directory and fails fast (`ScriptUsage`) if they're the same path — the
guard that keeps a re-fork rooted inside its own target repository
(`LLM4TS_PACK=forked/<name>`) from deleting itself before it's read.
Coder-agnostic, like every other flow.

## Consequences

- `packages/flow/src/Pack.ts` gains one new optional field and its loader;
  no other `pack.md` section changes.
- `flows/modernize-implement.ts` gains one new line in its system-prompt
  assembly, mirroring the existing `pack.lessons` line exactly.
- A forked pack is a full, independent copy of the source pack's files —
  not a diff or an overlay — so the source pack (and any other pack in its
  kit) is never mutated by forking.
- If a target repository's conventions later need a category `pack-fork`'s
  two fixed lists (`frontend`/`backend`) don't cover, that's a v2
  configurability question, deliberately deferred rather than reopening
  `pack.md`'s schema now.
