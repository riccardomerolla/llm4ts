# Memory query tool + global promotion (slice 2 of 2)

Builds on `flow-memory-store.md` (slice 1) and ADR 0007. Adds the two
agent/user-facing operations deferred from the tracer: iterative fine-grained
recall via a tool, and the explicit path from project memory to the
cross-project lessons-learned store.

**Blocked until slice 1 lands.**

## Decisions (ADR 0007, agreed 2026-07-31)

| Decision   | Choice                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool       | `query_memory` exposed to the in-flow agent where the connector supports tools; injection digest from slice 1 remains the baseline everywhere.                |
| Tool shape | Read-only: text query + optional kind/tag/scope filters → ranked entries. No write tool — writes stay distillation-only (ADR 0007 poisoning rationale).       |
| Promotion  | Explicit user-invoked operation copying selected project-scope entries to the global root (provenance recorded in `source`). Agents never write global scope. |
| Idiom      | Follow the existing flow tool seam (`WorkspaceTools`/`GitTool` pattern in `packages/flow/src/`); capability-gated like other tools.                           |
| Tests      | Offline and deterministic: memory fake from slice 1; tool contract tests; promotion round-trip including provenance.                                          |

## Tasks

- [ ] `query_memory` tool in flow following the existing tool seam: schema
      for parameters and results, read-only, scope-filterable; results framed
      as untrusted data.
- [ ] Wire the tool into modernize phase execution, active only when the
      connector/capability supports tool calling; injection baseline
      unchanged.
- [ ] Promotion operation: user-invoked (not reachable from agent code
      paths), copies chosen project entries to the global root with
      provenance in `source`; refuses when the global root is unset.
- [ ] Tests: tool query contract against the fake, capability gating
      (tool absent → injection-only behavior intact), promotion round-trip,
      agent-cannot-write-global invariant.
- [ ] Package exports, CHANGELOG entry.

## Non-goals

Semantic/embedding backends, gbrain MCP adapter, automatic promotion
heuristics, shell verbs for memory browsing (future spec if wanted).
