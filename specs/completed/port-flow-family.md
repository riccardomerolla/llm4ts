# Port flow family

Built-in flows that port a code base file by file the way Bun was ported
from Zig to Rust, on the work queue, with language pairs as kit material.
Design record: ADR 0028. `port-files` and `port-compile` built 2026-10-06;
`port-guide`, `port-ledger` and `port-tests` (the differential tier) wait
for a live run.

## Decisions (agreed 2026-10-06)

| Decision     | Choice                                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pack fields  | `target:` template, `comment:` marker, `## Diagnostics` (`- command:`, `- format: json \| cargo`), `prompts/porting.md`, `reviewers/*.md`, `patterns/pitfalls-*.md`.                            |
| Unit of work | One implementer (rulebook + pitfalls + exactly one source; no other sources, no build, no git) → two adversarial votes + pack lenses → a separate fixer → `PORT STATUS` trailer parsed by code. |
| Batches      | 100 files; 6 when the first file is over 2200 lines; a commit of the drafted targets per round.                                                                                                 |
| Pilot        | `LLM4TS_PORT_PILOT=n` → `.llm4ts/port/pilot.md` with rates and extrapolation behind `- [ ] Approved`; the full run refuses while it is unapproved.                                              |
| Compile      | One diagnostics run per round, grouped by unit; one fixer per unit, edit only that unit; votes; rebuild; commit; dry or `Stalled` after two rounds without a lower count.                       |
| Clean room   | Not applied: the source is the spec.                                                                                                                                                            |
| Knobs        | `LLM4TS_PORT_PILOT`, `LLM4TS_PORT_CONCURRENCY` (4), `LLM4TS_PORT_BATCH` (100), `LLM4TS_PORT_SOURCE_CHARS` (120000), `LLM4TS_PORT_COMPILE_ROUNDS` (6), `LLM4TS_REVIEW_VOTES` (2 here).           |

## Tasks

- [ ] `flows/port-files.ts`, `flows/port-compile.ts`, `flows/lib/port.ts`;
      `flow/src/Port.ts` and `flow/src/Diagnostics.ts` with tests; smoke
      tests with the stubbed coder.
- [ ] `kits/port/packs/zig-rust`: rulebook, lens, pitfall card, diagnostics.
- [ ] Docs: flows and kits READMEs, configuration, parity, CHANGELOG.
- [ ] Later: `port-guide` (dimension auditors + 3-vote refute + trial port
      diff → rulebook patch behind approval), `port-ledger` (classify → refute
      → `ledger.tsv` with evidence), `port-tests` (`EquivTier` `differential`:
      per test file baseline on the legacy build, run on the target,
      crash/hang/diverge), a `tsc`/`javac` diagnostics format, worktree
      sharding, a Scala→TypeScript pack for the llm4zio parity pilot.

## Non-goals

Idiomatic rewriting (the port is mechanical by design); editing the source
tree; any flow knowledge of a specific language.
