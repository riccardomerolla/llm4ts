# pack-fork: Real Grounding, Live Findings, and an Enforced Approval Gate

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:writing-plans
> to turn this design into an implementation plan, then
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to execute it.

**Status:** Approved by user, ready for planning · **Date:** 2026-09-19

## Context

`pack-fork` (`flows/pack-fork.ts`, `docs/adr/0018-pack-fork.md`, shipped in
`2.4.0`, crash-fixed in `2.4.1`/`2.4.2`) forks an existing kit pack into a new
project-tier pack whose `conventions.md` captures a real production target
repository's own conventions, via four fixed analysis passes
(`frontendPasses`/`backendPasses` in `flows/lib/pack-fork.ts`).

After the first real run (frontend, `j2ee-nextjs-spa`, via `pi` + the Gemini
ACP bridge, unblocked by `2.4.2`'s toolless-reasoning fix), the user reported:

1. The extracted rules in `conventions.md` were shallower than expected.
2. No detailed findings were visible while the flow ran — only terse
   per-stage `✔` markers, the real content only appearing once
   `conventions.md` was written.
3. No way to iterate: if the fork isn't good enough, there's no review/refine
   mechanism — just a one-shot dead end.
4. (Flagged as minor) The fork lands at
   `<repo>/.llm4ts/kits/forked/packs/<name>/` and gets committed into the
   target repo, which reads as surprising on first encounter.

Root cause of (1): only pass 1 (Tech Stack & Dependencies) ever received
grounding file content (`package.json`/`tsconfig.json` or
`pom.xml`/`build.gradle`). Passes 2–4 (Naming & Architecture, Shared
Components, Auth/Data) get **zero grounding** — they answer from prompt
phrasing alone. After `2.4.2` made the reasoning seat toolless (fixing the
"no text to parse as structured output" crash — see that release's
changelog entry), those three passes lost even the theoretical option of
reaching for a tool to look around. They were never actually reading the
repository.

## Goals

- Every pass grounds on real, relevant file content from the target
  repository — not just pass 1, not prompt-phrasing-only for the rest.
- The terminal shows real extracted content as the flow runs, not just
  stage markers.
- A transparency artifact (`provenance.md`) lets a human trace a rule in
  `conventions.md` back to the file that justified it.
- `modernize-implement` refuses to run against an unapproved fork — the
  approval marker becomes an enforced gate, not just a human signal.
- A human who isn't satisfied with a fork can re-run pack-fork with
  feedback and get a revised fork, without starting over conceptually.

## Non-Goals

- No change to where the fork lands (`<repo>/.llm4ts/kits/forked/packs/<name>/`,
  committed into the target repo) — this is load-bearing: project-tier kit
  discovery is keyed off `cwd` + `.llm4ts/kits`, so
  `LLM4TS_PACK=forked/<name>` only resolves from inside the target repo.
  Moving the fork elsewhere breaks that resolution unless
  `modernize-implement`'s kit discovery also changes, which is out of scope.
  This design's job here is documentation, not relocation.
- No genuinely agentic/tool-using discovery. The discovery step (below) uses
  a plain, deterministic file-tree enumeration plus one toolless structured
  LLM call — never gives the reasoning seat tool access. Reopening that
  reintroduces the exact "empty response" crash class `2.4.2` fixed.
- No automatic refine loop, no round cap, no interactive mid-flow approval
  prompt. Every pack-fork invocation remains a single batch run, matching
  every other flow in this codebase. A human decides when to stop
  iterating by simply not re-running.
- No override/bypass for the approval gate (no `LLM4TS_SKIP_APPROVAL_GATE`
  or similar). If a fork needs to ship unreviewed, that's a decision to
  revisit later, not a flag to add speculatively now.

## Architecture

```
pack-fork run (fresh or --feedback):
  open source pack
  [self-fork guard — unchanged from 2.4.2]
  if LLM4TS_FEEDBACK is set and the destination fork already exists:
    read its prior conventions.md now, before "clean" removes it → priorConventions
  ["clean" stage — unchanged from 2.4.2]
  discoverRepoFiles(repo)                    — plain code, no LLM
    → real file tree, common noise dirs excluded (node_modules, .git,
      dist, build, coverage, .next, target, ...)
  selectGroundingFiles(fileTree, targetKind) — ONE toolless structured call
    → GroundingSelection: which real paths matter, bucketed per category
  for each of the 4 category passes (frontend or backend):
    read selected files' content for this category (capped, budget())
    prompt = pass.instructions + category grounding
             + (priorConventions + feedback, when --feedback set)
    structuredAndPublish(...) → ConventionSection                — unchanged
                                                                    mechanism
    publish full section markdown to context.events (Info)       — NEW
    append selection rationale to provenance sections             — NEW
  write conventions.md, reviewers/target-conventions.md, README.md — unchanged
  write provenance.md                                              — NEW
  commit (commitPaths, scoped — unchanged from 2.4.1 fix)

modernize-implement run:
  open pack
  if pack has a README.md carrying the draft/approved marker
     and it is still unapproved:
    fail fast (requireApproval) — NEW, before anything else runs
  [unchanged from here]
```

Every LLM call in this design — the new discovery/selection call and the
four (unchanged in shape) category passes — stays one-shot, toolless, and
schema-validated via `structuredAndPublish`. Nothing here reopens tool
access anywhere in the reasoning seat.

## Components

### 1. `discoverRepoFiles` (new, `flows/lib/pack-fork.ts`)

Plain code, no LLM: `workspace.discover("**")` (or a narrower pattern set)
enumerates the target repo's real file paths, filtering out common noise
directories before the list ever reaches an LLM call. Output: a bounded,
deterministic list of candidate paths (capped by count and/or total
character length — reuse `Context.capped`/`budget()`, the same discipline
`2.4.1` used for the grounding-heavy prompt fix).

### 2. `selectGroundingFiles` (new, `flows/lib/pack-fork.ts` + `flows/pack-fork.ts`)

One `structuredAndPublish` call (toolless reasoning seat, same as every
other pass) given the candidate path list and asked to select which paths
are relevant to each of the four fixed categories for this target kind.

New schema, e.g.:

```ts
class GroundingSelection extends Schema.Class<GroundingSelection>("GroundingSelection")({
  selections: Schema.Array(
    Schema.Struct({
      category: Schema.String, // matches a pass.heading exactly
      path: Schema.String, // must be one of the candidate paths given
      reason: Schema.String // one line — feeds provenance.md
    })
  )
}) {}
```

The implementation plan should decide the exact bound on how many files per
category get selected/read, and how to handle a selection that names a path
outside the candidate list (reject/ignore it — never trust an
LLM-fabricated path straight into a file read).

### 3. Expanded, per-category grounding reads

Replace `techStackGroundingFiles(kind)` (currently pass-1-only) with a
per-category resolution: for each of the four passes, read the content of
that category's selected files (from step 2), capped the same way
`readGroundingFiles` already caps pass 1 today. Backend needs its own
category-to-file-kind mapping mirroring frontend's (e.g. Auth/Data → security
config + JPA entities, not the frontend's auth-provider/data-fetching
files).

### 4. Live findings streaming

Each pass — discovery/selection included — publishes its full result
(the selected files with reasons for discovery; the full markdown section
for each category pass) to `context.events` as an `Info` event immediately
on completion, not just the existing terse stage marker.

### 5. `provenance.md` (new output file)

Written alongside `conventions.md`/`reviewers/target-conventions.md`/
`README.md` in the fork. Structure: one section per category, listing the
files `selectGroundingFiles` chose for it and why, plus (on a `--feedback`
re-run) what feedback was given and what changed. This is the artifact a
human reads to trace a rule back to its evidence.

### 6. Approval gate in `modernize-implement.ts`

Wire `requireApproval` (`packages/flow/src/Approval.ts`, already used by
`modernize-extract.ts`/`modernize-seed.ts`) in at pack-load time: if the
loaded pack has a `README.md` carrying the draft/approved marker and it's
still `- [ ] Approved`, fail fast with a clear, actionable message before
anything else runs. Generic on the marker's presence, not pack-fork-specific
— but only pack-fork writes the marker today, so in practice this only
gates forked packs.

### 7. `LLM4TS_FEEDBACK` refine mechanism (`flows/pack-fork.ts`)

New optional environment variable, a free-text string. When set on a run
where `LLM4TS_FORK_AS` names a fork that already exists at the destination:
read its `conventions.md` **before** the existing "clean" stage removes it,
and inject both that prior content and the feedback text into every
pass's prompt (discovery/selection included — feedback might point at a
completely different part of the repo, not just reword an existing
finding). Without `LLM4TS_FEEDBACK` set, behavior is identical to today's
fresh-analysis path.

## Data Flow Summary

`open pack → self-fork guard → [prior conventions.md capture, if feedback
re-run — before clean] → clean → discoverRepoFiles → selectGroundingFiles →
per-category grounded passes (feedback-aware) → write
conventions.md/provenance.md/reviewers/README.md → commit`

Then separately, on the _next_ `modernize-implement` run:
`open pack → requireApproval gate → (existing generation flow)`.

## Error Handling

- `discoverRepoFiles` finding zero files, or `selectGroundingFiles`
  selecting nothing for a category: passes proceed with empty grounding for
  that category (matches today's behavior for passes 2–4) rather than
  failing the whole run — a category with nothing to ground on is a real,
  reportable finding ("no shared component library found"), not an error.
- `selectGroundingFiles` naming a path outside the candidate list: dropped,
  never read. A read failure on a selected path (permissions, race,
  workspace limit): treated like today's `readGroundingFiles` — caught and
  skipped, not fatal.
- The approval gate's failure is a normal typed flow failure
  (`ScriptUsage`-class, matching the self-fork guard's own pattern from
  `2.4.2`) with a message naming the exact file to edit and the marker to
  flip.
- `LLM4TS_FEEDBACK` set but `LLM4TS_FORK_AS` doesn't already exist at the
  destination: proceeds as a normal fresh run — feedback with nothing prior
  to refine against is simply ignored (or the plan may choose to surface
  this as a usage note; a decision for the implementation plan, not a
  blocking design question).

## Testing Strategy

- Offline smoke-test fixtures (`flows/test/support/smoke.ts` conventions)
  need a fixture target repo with a real, discoverable file tree across
  multiple categories (not just one `package.json`), so `discoverRepoFiles`
  and `selectGroundingFiles` have something real to exercise.
- Unit tests for `discoverRepoFiles`'s noise-directory filtering and
  bounding, in isolation from any LLM call.
- Unit tests for `GroundingSelection`'s schema and the "drop paths outside
  the candidate list" guard.
- A smoke test proving the approval gate: an unapproved forked pack fed to
  `modernize-implement` fails fast with the expected message; an approved
  one proceeds (matching `modernize-extract`/`modernize-seed`'s existing
  `requireApproval` test pattern).
- A smoke test proving the `LLM4TS_FEEDBACK` path: fork once, re-run with
  feedback, assert the prior `conventions.md` content and the feedback text
  both reached the passes' prompts (same "stub asserts on prompt content"
  pattern already used for the `2.4.1`/`2.4.2` regression tests).
- Existing pack-fork smoke tests (happy path, self-fork guard, stale-file
  clearing, round-trip `loadPack`) must keep passing with grounding now
  present on every pass, not just pass 1.

## Backward Compatibility

- `conventions.md`/`README.md`/`reviewers/target-conventions.md`'s shape is
  unchanged — only their _content_ gets deeper. `provenance.md` is a new,
  additive file; a pack forked before this change simply lacks it.
- `LLM4TS_FEEDBACK` is optional and additive; omitting it reproduces
  today's fresh-analysis behavior (now with real per-category grounding).
- The approval gate is a new, non-optional failure mode for
  `modernize-implement` when run against a pack carrying an unapproved
  marker. This is a deliberate behavior change (closing a documented gap in
  ADR 0018), not something to soften with a compatibility flag.

## Open Questions for the Implementation Plan

(Deliberately left for `writing-plans`, not blocking this design's
approval)

- Exact per-category file-selection caps (count and/or character budget).
- Exact noise-directory exclusion list for `discoverRepoFiles`.
- Exact backend category-to-file-kind mapping (mirroring the frontend one
  above).
- Whether `LLM4TS_FEEDBACK` with no prior fork present should be a no-op or
  a surfaced usage note.
