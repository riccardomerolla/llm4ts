# 0007. Flow memory: scoped lexical store, distilled at phase boundaries

Status: Accepted · Date: 2026-07-31

## Context

Modernization runs over large legacy repositories accumulate far more
knowledge than fits in a phase prompt: per-program analysis, structural
findings, and — across runs — lessons learned, scaffolding patterns, and best
practices. Today that knowledge either bloats prompts or is lost between
phases and runs. The artifact corpus (`docs/modernization/` via
`PlainFileStore`, see `packages/modernize/src/Artifacts.ts`) persists outputs
but offers no retrieval seam.

Prior art considered: [gbrain](https://github.com/garrytan/gbrain) (MIT), an
agent "brain" with typed pages, embedding-based semantic recall, and
distillation. Taking it as a code dependency is not viable: it is a
Bun-runtime CLI/MCP daemon, not an npm library, with PGLite/Postgres storage
and markdown-skill logic — none of it composes as an Effect service, and an
optional dependency would be exactly the parallel code path CLAUDE.md
forbids. Its concepts, however, are worth distilling.

This is a divergence from pinned llm4zio v4.2.0, which has no memory
counterpart; hence this ADR.

## Decision

### One store, two scopes

A single `MemoryStore` service (flow package, beside `Persistence.ts`, built
on `PlainFileStoreShape` like `PlanStore`) with a `scope` axis:

- `project` — lives under the target workspace
  (`docs/modernization/memory/`), committed with the other artifacts and
  reviewed in PRs.
- `global` — cross-project lessons learned; root is **caller-supplied**. The
  library never hardcodes a home directory; shell/runner decide where global
  memory lives.

### Entry format

One markdown file per entry: schema-validated frontmatter (`id`, `kind`,
`tags`, `phase`, `createdAt`, `source`) plus a markdown body, round-tripped
through an Effect Schema at the persistence boundary. `kind` is a
`Schema.Literals` union: `fact | lesson | scaffold | practice`. Human-readable,
greppable, PR-reviewable — matching the existing artifact corpus.

### Retrieval: lexical first, semantic-ready interface

Queries are lexical (kind/tag filters + full-text over frontmatter and body)
and fully deterministic — no embeddings provider, no index lifecycle, no
network in CI. The query interface is shaped so a semantic backend
(embeddings connector, pgvector, or gbrain over the existing MCP seam) can
implement it later without an API change: text query + optional filters in,
ranked entries out. gbrain remains prior art only; no adapter is shipped.

### Read path: injection baseline, tool on top

The modernize flow injects a small bounded digest (entries selected by
phase/tag match) into every phase prompt — works uniformly across all
connectors, including CLI connectors with weak tool support. Where the
connector supports tools, a `query_memory` tool additionally gives the agent
iterative fine-grained recall. Injection is the guaranteed baseline; the tool
is the upgrade.

### Write path: distill at phase end, promote manually

Project scope is written only by a schema-gated distillation step at phase
completion: structured output produces a typed `MemoryEntry` list at a
deterministic point, reviewable in the artifact PR. The agent has no
free-form mid-phase write tool. Global scope is **read-only during runs**;
entries are promoted from project to global only by an explicit user-invoked
operation — mirroring ADR 0004's stance that agents propose and users
promote.

Rationale: memory entries are re-injected into future prompts, so a
free-writing agent is a persistence channel for prompt injection (poisoned
source file → fabricated "fact" → ingested by every later phase, or across
projects via global scope). Gating writes to schema-validated phase
boundaries and manual promotion bounds junk growth, poisoning, and secret
leakage (the CLAUDE.md secrets rule applies to persisted memory).

### Placement

Mechanism in flow (`MemoryStore` service, entry schema, lexical query, memory
fake for tests); policy in modernize (phase-end distillation, per-phase
injection digest, `query_memory` tool wiring, promotion operation). Mirrors
the existing split — the runner stays thin, policy lives above the mechanism.

## Consequences

- New public surface in `@llm4ts/flow` and `@llm4ts/modernize`; recorded in
  `docs/parity.md` as a deliberate divergence.
- Default CI stays offline: lexical retrieval plus the in-memory fake need no
  provider, no network, no external CLI.
- Semantic recall is deferred, not foreclosed: the query interface is the
  seam; embeddings-as-capability or a gbrain MCP adapter are future
  implementations behind it.
- Memory content is data, never instructions: prompts that consume injected
  digests must frame entries as untrusted context.
