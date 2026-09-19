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

It resolves a source pack the normal way (`LLM4TS_PACK`), and runs several
bounded, focused `structuredAndPublish` passes against the target repo — one
of two fixed category lists selected by `LLM4TS_TARGET_KIND=frontend|backend`
(tech stack/dependencies, naming/architecture, shared resources/design, and
auth/API/testing). Every pass grounds on real file content, not just the
first: `workspace.discover("**")` enumerates the target repo's actual file
tree (plain code, no LLM call, reusing `Workspace`'s existing
`excludeDirs`/`maxResults` limits), then one toolless structured call
(`GroundingSelection`) picks which of those _real_ paths matter per
category — never inventing a path — before the four category passes read
their own selection's content. Both this selection call and every category
pass publish their full findings to the flow's event stream as they
complete, and a new `provenance.md` (alongside `conventions.md`) records
which files justified which category, so a human reviewing the fork can
trace a rule back to its evidence. The fork's other files carry over
verbatim into `<repo>/.llm4ts/kits/forked/packs/<LLM4TS_FORK_AS>/` — always
under a dedicated `forked` project-tier kit name, never the source pack's
own kit name (kit discovery dedupes by name across tiers; reusing the
source kit's name would hide its other packs from the project).

An optional `LLM4TS_FEEDBACK=<text>` re-run revises an existing fork instead
of starting from zero: the prior run's `conventions.md` (captured before the
"clean" stage below removes it) plus the feedback text feed both the
selection call and every category pass, so the file selection can change,
not just the wording.

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

Trust: the forked pack's `README.md` carries the same
`- [ ] Approved` marker (`packages/flow/src/Approval.ts`) every
`modernize-extract` pack does — no judge rubric, since "did this correctly
capture our design system" has no checkable ground truth the way "does this
spec match the legacy source" does; a human who knows the repository reads
and confirms instead. `modernize-implement` calls `requireApproval` against
any pack whose own `README.md` carries the marker (draft or approved) —
enforced, no override: an unapproved fork stops the run before anything
else happens. A plain pack with no README.md, or one that never opted into
the marker convention, is unaffected — this check is generic on the
marker's presence, not pack-fork-specific.

One-shot per run, not resumable — every invocation is a single batch run,
same as every other flow; there is no mid-run interactive approval prompt.
Re-running clears and overwrites the previous fork under the same name
(`LLM4TS_FEEDBACK` revises the _content_ of that overwrite, not the
one-shot-per-run mechanics — it is still a fresh, complete run start to
finish). Before that clear runs, the flow resolves the source pack's own
directory and the fork's destination directory and fails fast
(`ScriptUsage`) if they're the same path — the guard that keeps a re-fork
rooted inside its own target repository (`LLM4TS_PACK=forked/<name>`) from
deleting itself before it's read. Coder-agnostic, like every other flow.

## Consequences

- `packages/flow/src/Pack.ts` gains one new optional field and its loader;
  no other `pack.md` section changes.
- `flows/modernize-implement.ts` gains one new line in its system-prompt
  assembly, mirroring the existing `pack.lessons` line exactly, plus the
  approval-gate check described above.
- A forked pack is a full, independent copy of the source pack's files —
  not a diff or an overlay — so the source pack (and any other pack in its
  kit) is never mutated by forking.
- `provenance.md` is new, additive output — a pack forked before this
  change simply lacks it; nothing reads it back programmatically today, it
  is for a human reviewing the fork.
- If a target repository's conventions later need a category `pack-fork`'s
  two fixed lists (`frontend`/`backend`) don't cover, that's a v2
  configurability question, deliberately deferred rather than reopening
  `pack.md`'s schema now.
