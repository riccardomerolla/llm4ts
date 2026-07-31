# Flow memory store + modernize distillation (slice 1 of 2)

Implement the memory mechanism in `@llm4ts/flow` and the phase-boundary
policy in `@llm4ts/modernize`, per ADR 0007. This slice is the complete thin
tracer: entries get written at phase end and read back via prompt injection.
The `query_memory` tool and global-scope promotion are slice 2
(`memory-query-tool-and-promotion.md`) — **out of scope here**.

## Decisions (ADR 0007, agreed 2026-07-31)

| Decision  | Choice                                                                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store     | One `MemoryStore` service in flow, beside `Persistence.ts`, built on `PlainFileStoreShape` (the `PlanStore` pattern).                                       |
| Scopes    | `project` (workspace `docs/modernization/memory/`) and `global` (caller-supplied root; never hardcode a home dir). Global is read-only during runs.         |
| Entry     | One markdown file per entry: schema-validated frontmatter (`id`, `kind`, `tags`, `phase`, `createdAt`, `source`) + markdown body. Effect Schema round-trip. |
| Kinds     | `Schema.Literals`: `fact \| lesson \| scaffold \| practice`.                                                                                                |
| Query     | Lexical only: kind/tag filters + full-text over frontmatter and body, deterministic ranking. Interface shaped so a semantic backend can implement it later. |
| Read path | Modernize injects a bounded digest (phase/tag-matched entries) into each phase prompt. No tool in this slice.                                               |
| Write     | Schema-gated distillation at phase completion: structured output → typed `MemoryEntry` list → store. No free-form agent writes.                             |
| Security  | Injected digests are framed as untrusted data, not instructions. Secrets rule applies to persisted entries.                                                 |
| Tests     | In-src memory fake in flow (like `makeMemoryPlainFileStore`); `@effect/vitest`, offline, deterministic.                                                     |

## Contracts and seams to extend

- `packages/flow/src/Persistence.ts` — `PlainFileStoreShape`, `PlanStore` as
  the service-on-store pattern to follow.
- `packages/modernize/src/Model.ts` — `ModernizePhase`, `PhaseCheckpoint`,
  `PhaseOutcome`: distillation hooks into phase completion.
- `packages/modernize/src/Artifacts.ts` — resumable-write idiom
  (skip-if-exists, `writeAtomic`).
- `docs/parity.md` — record the divergence (no llm4zio counterpart).
- Typed errors via `Schema.TaggedErrorClass`; explicit subpath exports.

## Tasks

- [ ] `MemoryEntry` schema in flow: frontmatter fields, kind union, markdown
      serialization/parsing with schema validation at the boundary.
- [ ] `MemoryStore` service in flow: `write`, `list`, and lexical `query`
      (kind/tag filters + full-text, deterministic ranking) over a
      `PlainFileStoreShape` root per scope; typed errors.
- [ ] In-src memory fake + `@effect/vitest` tests: round-trip, query
      filtering/ranking, malformed-entry rejection, scope separation.
- [ ] Modernize distillation step: on phase completion, structured output →
      validated `MemoryEntry` list → project-scope writes (resumable,
      skip-if-already-distilled for the phase).
- [ ] Modernize injection digest: deterministic selection (phase/tag match,
      bounded size) prepended to phase prompts, framed as untrusted
      reference data; digest-off when store is empty.
- [ ] Wire scope roots: project root from the workspace layout; global root
      as an optional caller-supplied config (read-only in this slice).
- [ ] Package exports, `docs/parity.md` note, CHANGELOG entry.

## Non-goals (this slice)

`query_memory` tool, promotion to global scope, semantic/embedding backends,
gbrain adapter, shell UX for memory, memory for Ralph/other flows.
