# Work queue: shards across worktrees, and a `javac` diagnostics format

ADR 0028 amendments (decided 2026-10-06, after the first release).

## Decisions

| Decision   | Choice                                                                                                                                                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shards     | `RunQueueOptions.shards?: ReadonlyArray<Shard>` (`{ id, dir }`); `work(item, round, shard)` and `done(item, shard?)`; one in-flight item per shard; concurrency is capped at the shard count.                                                                                                                               |
| port-files | `LLM4TS_PORT_SHARDS=n` (default 0: one checkout) creates `n` git worktrees under `.llm4ts/port/shards/<i>` on `llm4ts/port-shard-<i>`, binds the seats there with `contextFor`, commits each shard's drafts after a round, merges every shard branch into the checkout, syncs the shards back, and removes them at the end. |
| javac      | `parseDiagnostics(text, "javac")` reads `path/File.java:12: error: message` and Maven's `[ERROR] /path/File.java:[12,5] message`; the unit is the path before `/src/` (the Maven module), else the file's folder.                                                                                                           |

## Tasks

- [ ] Queue shard pool with a test (two shards, five items: never two in flight on one shard).
- [ ] `port-files` sharded path; smoke test with `LLM4TS_PORT_SHARDS=2`.
- [ ] `javac` format in `Diagnostics.ts` and the pack's `## Diagnostics` literal; tests for both line shapes.
- [ ] Docs: `configuration.md` Ports section, ADR 0028 "Decided later", CHANGELOG.
