# Bun's Zig → Rust rewrite with Claude agents (May 2026)

Research notes, compiled 2026-10-06. Primary sources are the oven-sh/bun repository
(commits, PR #30412, the `.claude/workflows/*.workflow.js` orchestration scripts and
`scripts/` helpers that were in the tree at the merge commit), the Bun blog post
"Rewriting Bun in Rust" (Jarred Sumner, 2026-07-08), the Bun 1.4 release post,
Anthropic's dynamic-workflows post, Jarred Sumner's X posts, and Prisma's post. Secondary
sources (Hacker News, Simon Willison, Andrew Kelley's response, press) are marked as such
and used only for criticism and for locating primary material.

## What happened

Between May 3 and May 14, 2026, Jarred Sumner (Bun's creator; Bun is owned by Anthropic
since December 2025) ported Bun's 535,496 lines of Zig (1,448 `.zig` files) to Rust using
Claude Code "dynamic workflows" running a pre-release Claude Fable 5 model — about 50
workflow scripts, roughly 64 agents in parallel at peak across 4 git worktrees on an EC2
box. The port was deliberately _mechanical_ (same architecture, same data structures, same
function names, no async Rust, `unsafe` wherever the Zig was already unsafe), organized as
phases: write a porting guide (`docs/PORTING.md`) and a per-field lifetime table
(`docs/LIFETIMES.tsv`); draft one `.rs` per `.zig` (Phase A); break crate cycles and burn
down ~16,000 `cargo check` errors crate-by-crate (Phase B/D); get `bun --version`, then
`bun test <file>` running; loop over the pre-existing TypeScript test suite locally and then
in CI until all 6 platforms were green (build #54202). Every unit of work was an
implementer → two adversarial reviewers → fixer loop. PR #30412 (+1,009,257 / −4,024 lines,
2,188 files, 6,755 commits) was merged 2026-05-14. The run consumed 5.9B uncached input
tokens, 690M output tokens, 72B cached reads, ≈$165,000 at API prices. The Rust build
shipped to Claude Code v2.1.181 (June 17), Prisma Compute (June), and as Bun v1.4.0
(blog post 2026-08-20).

Sources: [blog](https://bun.com/blog/bun-in-rust), [PR #30412](https://github.com/oven-sh/bun/pull/30412),
[Bun 1.4 post](https://bun.sh/blog/bun-v1.4), PR metadata via `gh api repos/oven-sh/bun/pulls/30412`.

---

## 1. Facts

| Fact                     | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Source                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Start / merge            | "11 days (May 3 → merged May 14)"; PR opened 2026-05-08T22:14Z, merged 2026-05-14T08:09Z by Jarred-Sumner                                                                                                                                                                                                                                                                                                                                                                                                                                     | [blog §Stats](https://bun.com/blog/bun-in-rust), `gh api repos/oven-sh/bun/pulls/30412`                                                                      |
| First public trace       | Commit `46d3bc29` "docs: add Phase-A porting guide", 2026-05-04T12:02Z, adds `docs/PORTING.md` (576 lines) and `scripts/port-batch.ts` (46 lines); preceded the same day by `c8b4c360` "restructure src/: pure git mv into subject-area directories" and `e643d7b0` "restructure src/: path fixups + extract JSC bridges and leaf types"                                                                                                                                                                                                      | [commit](https://github.com/oven-sh/bun/commit/46d3bc29f270fa881dd5730ef1549e88407701a5), `gh api repos/oven-sh/bun/commits?sha=46d3bc29...`                 |
| Source size              | "Excluding comments, Bun is 535,496 lines of Zig"; "all 1,448 .zig files"                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | [blog](https://bun.com/blog/bun-in-rust)                                                                                                                     |
| Diff that landed         | "+1,009,272" (blog) / +1,009,257 −4,024, 2,188 files (GitHub API)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | blog §Stats; `gh pr view 30412`                                                                                                                              |
| Commits                  | "6,778 commits" (May 3→14) and "6,502 commits (merges excluded)"; GitHub reports 6,755 commits on the PR; "Peak hour: 695 commits"; "peak: 58 commits in one minute"                                                                                                                                                                                                                                                                                                                                                                          | blog §Finally writing the code, §Stats; GitHub API                                                                                                           |
| Rust codebase size after | "~780,000 lines" of Rust at time of writing (July); Anthropic's post says "roughly 750,000 lines of Rust"                                                                                                                                                                                                                                                                                                                                                                                                                                     | blog §The work continues; [Anthropic post](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)                                             |
| Team                     | One human ("With 1 engineer using Fable & closely monitoring Claude Code"). Dylan Conway appears as author of a merge-from-main commit on the PR branch (2026-05-12)                                                                                                                                                                                                                                                                                                                                                                          | blog §What's next; `gh api repos/oven-sh/bun/pulls/30412/commits`                                                                                            |
| Model                    | "a pre-release version of Claude Fable 5, a Mythos-class model"                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | blog §Stats, disclosure line                                                                                                                                 |
| Harness                  | "about 50 dynamic workflows in Claude Code run continuously over the course of 11 days"; "Claude Code's dynamic workflows kept 64 Claudes running for 11 days (I would've had to write my own harness to pull this off otherwise)"                                                                                                                                                                                                                                                                                                            | blog §Loops, §Stats                                                                                                                                          |
| Concurrency              | "4 of these workflows at once each in a separate worktree, each with 16 Claudes per workflow. About 64 Claudes at a time."                                                                                                                                                                                                                                                                                                                                                                                                                    | blog §Stats                                                                                                                                                  |
| Throughput               | "at peak Claude wrote about 1,300 lines of code per minute"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | blog §Finally writing the code                                                                                                                               |
| Tokens / cost            | "5.9 billion uncached input tokens, 690 million output tokens, and 72 billion cached input token reads — around $165,000 at API pricing" (pre-merge)                                                                                                                                                                                                                                                                                                                                                                                          | blog §Stats                                                                                                                                                  |
| Hardware                 | "the EC2 instance this ran on"; "I forgot to increase the default IOPS"                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | blog §Finally writing the code                                                                                                                               |
| Test suite at merge      | "0 tests skipped or deleted"; Debian 13 x64: 1,386,826 `expect()` calls, 60,624 tests, 4,174 files; macOS 14 arm64: 1,259,953 / 58,850 / 4,175; Windows 2019 x64: 1,007,544 / 57,337 / 4,173                                                                                                                                                                                                                                                                                                                                                  | blog §Stats                                                                                                                                                  |
| Interim pass rate        | "99.8% of bun's pre-existing test suite passes on Linux x64 glibc in the rust rewrite" (2026-05-09)                                                                                                                                                                                                                                                                                                                                                                                                                                           | [X post](https://x.com/jarredsumner/status/2053047748191232310)                                                                                              |
| Announcement             | PR body: "Blog post with details coming soon. It passes Bun's pre-existing test suite on all platforms (and fixes several memory leaks and flaky tests), the binary size shrinks by 3 MB - 8 MB, the benchmarks are between neutral and faster ... The codebase is otherwise largely the same. The same architecture, the same data structures. Bun still uses few 3rd party libraries. No async rust." X on May 9: "this is a 960,000 LOC rewrite, the code truly works ... e2e I started working on this 6 days ago". Full write-up July 8. | [PR #30412](https://github.com/oven-sh/bun/pull/30412), [X](https://x.com/jarredsumner/status/2053063524826620129), [blog](https://bun.com/blog/bun-in-rust) |
| Shipping                 | Claude Code v2.1.181 (June 17) runs the Rust port; Prisma Compute public beta on it; Bun v1.4.0 is "the first version of Bun written in Rust"; v1.3.14 the last Zig version                                                                                                                                                                                                                                                                                                                                                                   | blog §Production/§Shipping; [Bun 1.4](https://bun.sh/blog/bun-v1.4); [Prisma](https://www.prisma.io/blog/bun-rust-rewrite-prisma-compute)                    |
| Outcome numbers          | "Bun v1.4.0 fixes 128 bugs that reproduce in v1.3.14"; "19 known regressions, each of which has been fixed"; 2,000 in-process `Bun.build()` calls: 6,745 MB → 609 MB; binary 94→76 MB Windows, 88→70 MB Linux (with ICU/ICF work); 2–5% faster; Claude Code Linux startup 10% faster                                                                                                                                                                                                                                                          | blog §Bun is better in Rust                                                                                                                                  |
| Unsafe                   | "about 4% of Bun's Rust code sits inside an unsafe block (~13,000 unsafe keywords across ~27,000 lines / ~780,000 lines), and 78% of those blocks are a single line"                                                                                                                                                                                                                                                                                                                                                                          | blog §The work continues                                                                                                                                     |

Dates discrepancy worth noting: Jarred's May 28 X post says the rewrite took "6 days"
([X](https://x.com/jarredsumner/status/2060050578026189172)); the blog's "11 days" runs
from first prep (May 3) to merge (May 14). The May 9 X post ("e2e I started working on this
6 days ago", Linux passing) reconciles both: ~6 days to a Linux-green port, 11 to all
platforms merged.

---

## 2. Method: how the port was organized

### 2.1 Two framing decisions

- Big-bang, not incremental: "In my experience porting esbuild's transpiler from Go to Zig
  ... everything all at once is better. An incremental rewrite adds temporary code that you
  hope gets deleted eventually" ([blog](https://bun.com/blog/bun-in-rust)).
- Transliteration, not re-architecture: "Do the rewrite that looks like we transpiled our
  Zig code to Rust. We can gradually refactor it to reduce unsafe usage and look more like
  idiomatic Rust after Bun v1.4 ships." "Those are the only two big questions. Everything
  else is tactics." (blog)

### 2.2 The unit of work: implement → N adversarial reviews → fix

"A lot of day-to-day engineering work ... can be over-simplified into loops":

```js
while ((task = todoList.pop())) {
  const result = task()
  const feedback = await Promise.all([review(result), review(result)])
  await apply(feedback, result)
}
```

"Each dynamic workflow was a loop like this" (blog §Loops that write & review code). The
actual scripts confirm the shape: `phase-a-port.workflow.js` runs
`pipeline(FILES, implement, verify, fix)` with one agent per stage and JSON schemas for
each agent's output
([source at merge commit](https://github.com/oven-sh/bun/blob/23427dbc12fdcff30c23a96a3d6a66d62fdc091d/.claude/workflows/phase-a-port.workflow.js)).

### 2.3 Prep: porting guide + lifetime table (May 3–4)

- `PORTING.md`: "Before writing any code, I spent about 3 hours talking to Claude about
  how to map patterns from our Zig codebase closely to Rust. Claude serialized this
  discussion into a PORTING.md document" (blog §Prep work). The guide opens: "You are
  translating one Zig file to Rust. Read this whole document before writing any code. The
  goal of Phase A is a **draft** `.rs` next to the `.zig` that captures the logic
  faithfully — it does **not** need to compile. Phase B makes it compile crate-by-crate."
  Sections: Ground rules, Crate map, Type map, Idiom map, Comptime reflection, Strings,
  Allocators, Pointers & ownership, Collections, JSC types, FFI, Platform conditionals,
  Don't translate, Output format
  ([PORTING.md @46d3bc29](https://github.com/oven-sh/bun/blob/46d3bc29f270fa881dd5730ef1549e88407701a5/docs/PORTING.md)).
  Notable ground rules: deterministic output path ("Write the `.rs` in the same directory
  as the `.zig`, same basename"); "Do not invent crate layouts"; "No `tokio`, `rayon`,
  `hyper`, `async-trait`, `futures`. No `std::fs`, `std::net`, `std::process`. Bun owns its
  event loop and syscalls."; "No `async fn`."; "`unsafe` is fine when the Zig was already
  unsafe. Annotate every block with `// SAFETY: <why>`"; "Leave `// TODO(port): <reason>`
  for anything you can't translate confidently. Don't guess. Flagging is better than wrong
  code."; "Leave `// PERF(port): <zig idiom> — profile in Phase B` wherever the Zig used a
  perf-specific idiom"; "Match the Zig's structure. Same fn names (snake_case), same field
  order, same control flow. Phase B reviewers diff `.zig` ↔ `.rs` side-by-side."
- Every drafted file ends with a machine-readable trailer: `PORT STATUS` with `source`,
  `confidence: high | medium | low`, `todos: N`, `notes` — "`confidence: low` means 'logic
  is probably wrong, re-read the Zig in Phase B'" (PORTING.md §Output format).
- `LIFETIMES.tsv`: the prompt is quoted in the blog: "Let's kick off a dynamic workflow to
  analyze the proper lifetimes of every struct field in the codebase ... propose a lifetime
  for that field, then use 2 adversarial review agents to review that lifetime, then apply
  any feedback and serialize into a LIFETIMES.tsv for other claudes to look at." The script
  `lifetime-classify.workflow.js` classifies each pointer field into a taxonomy (OWNED,
  SHARED, BORROW_PARAM, BORROW_FIELD, STATIC, JSC_BORROW, BACKREF, INTRUSIVE, FFI, ARENA,
  UNKNOWN) with "evidence: file:line of the init/deinit/assignment that proves it", then
  runs a "3-vote refute on UNKNOWN + 20% sample of confident classifications"
  ([source](https://github.com/oven-sh/bun/blob/23427dbc12fdcff30c23a96a3d6a66d62fdc091d/.claude/workflows/lifetime-classify.workflow.js)).
  PORTING.md tells the porting agent to "look it up in `docs/LIFETIMES.tsv` ... and use
  the `rust_type` column verbatim ... the TSV is pre-computed cross-file analysis; trust it
  over local guessing."
- The guide itself was adversarially audited: `porting-md-zigleakage.workflow.js` runs 8
  "dimension auditors" (allocator-threading, collections, manual-lifetime, error-model,
  pointer-idiom, comptime-carryover, api-shape, and a "trial-port-diff" that ports 3 files
  by the rules and again "as a Rust-native engineer would" and diffs), then a 3-vote
  refute per finding, then synthesizes a PORTING.md patch. Its seeded findings ("95% of
  these params are dead weight"; "Custom List is Zig-ArrayList cosplay") are visible as
  rules in the committed PORTING.md (allocator params deleted outside AST crates; `Vec<T>`
  instead of a custom list) — so the guide in commit `46d3bc29` is already post-audit
  ([source](https://github.com/oven-sh/bun/blob/23427dbc12fdcff30c23a96a3d6a66d62fdc091d/.claude/workflows/porting-md-zigleakage.workflow.js)).
  Blog: "Then a round of adversarial reviews on the PORTING.md and the LIFETIMES.tsv
  together to fix any conflicting suggestions and double check everything. I also manually
  read over it."

### 2.4 Trial run

"Before asking Claude to translate all 1,448 .zig files to .rs files, I started with just 3. For each of the 3 files, 1 implementer wrote the new .rs file, 2 adversarial reviewers
checked the .rs file matched the behavior of the .zig file and that it followed the
PORTING.md & LIFETIMES.tsv. After that, 1 fixer applied any suggestions." (blog §Trial run)

### 2.5 Phase A: file-by-file draft (May 4–6)

- Partitioning: by file, in batches of ~100 from a manifest. `scripts/port-batch.ts` reads
  `/tmp/port-manifest-filtered.tsv` (zig path, LOC), computes "pending" as files whose
  deterministic `.rs` path does not yet exist, and emits `{files, repo}` JSON for the
  workflow; `scripts/port-cycle.sh` archives the result, commits `src/**/*.rs` with a
  message `"phase-a: draft batch <name> (<N> files)"`, pushes to `claude/phase-a-port`,
  logs stats to `/tmp/port-results/log.tsv`, and shrinks the next batch to 6 "if first
  pending file >2200 LOC"
  ([port-batch.ts](https://github.com/oven-sh/bun/blob/46d3bc29f270fa881dd5730ef1549e88407701a5/scripts/port-batch.ts),
  [port-cycle.sh @merge](https://github.com/oven-sh/bun/blob/23427dbc12fdcff30c23a96a3d6a66d62fdc091d/scripts/port-cycle.sh)).
- Context given to the implementer (from `phase-a-port.workflow.js`): read PORTING.md
  whole; `grep` its file's rows out of LIFETIMES.tsv; read the one `.zig`; write to the
  exact computed path. Explicitly _denied_ context: "Do NOT read other .zig files 'for
  context' — PORTING.md's crate/type maps are authoritative for cross-file refs. Do NOT
  run builds. Do NOT git anything." Files over 1,000 LOC must be written in ≤800-line
  chunks because "The harness kills any tool call that emits >180s of tokens."
- Verifier context: PORTING.md + the `.zig` + the draft, with a checklist of high-value
  deviations (e.g. "`pub fn deinit(&mut self)` instead of `impl Drop`", "`anyhow::Error`
  ... (should be `bun_core::Error`)", "bare `as` for narrowing cast", "missing
  `// SAFETY:` on unsafe blocks", "dropped logic / missing fns vs the .zig"), told
  "Default to ok=false if you find ANY must-fix", and told what _not_ to flag ("imports
  that won't resolve yet, lifetimes, things PORTING.md explicitly defers to Phase B").
- Fixer: "Apply verifier findings to the draft .rs. Nothing else. ... Surgical edits only.
  If an issue is wrong (verifier hallucinated), skip it and note in output."
- Sharding: "4 workflow shards each with their own worktree (4 worktrees total), each
  running 16 claudes committing and pushing files" (blog §False starts). "Every line of
  code was reviewed by two separate adversarial reviewers (also Claude) and went through a
  round of fixes before committing. Absolutely none of it worked yet." (blog)
- The `.zig` files were kept in the tree beside the `.rs` as the spec: at the merge commit
  the tree still contains roughly 1,300 `.zig` files (my count from the recursive tree
  listing), and the later workflows consistently say "Read .zig spec for the matching
  file" / "the .zig spec at the same path".

### 2.6 Phase B/D: crate cycles, then compiler errors as a work queue (May 6+)

- Crate split: "Our Zig codebase was one compilation unit ... I wanted to split the new
  Rust codebase into ~100 crates so the Rust would compile faster, but this needed to avoid
  cyclical dependencies ... My PR to do this immediately before starting the Rust rewrite
  was insufficient. Instead of starting over, I ran another workflow to classify where the
  code with cyclical dependencies should go and write it all down - and then another
  workflow to do the refactor." (blog) Workflow files: `phase-b0-cyclebreak`,
  `phase-b0-movein`, `phase-b0-moveout`, `phase-b0-verify`, `phase-b1-tier`,
  `phase-b2-cycle`, `phase-b2-keystone`, `phase-b2-ungate-tier`; helper `scripts/crate-dag.ts`
  "Compute crate DAG, intended tiers, and back-edges for Phase B-0" with a hard-coded tier
  table (T0 primitives/`*_sys`, T1 string/collections/paths/sys, ..., `*_jsc` = 6).
- Error burn-down: "cargo check wrote ≈16,000 errors to a file, grouped by crate; the
  workflow divvied them up among 64 Claudes — 16 loops across 4 worktrees, each one Claude
  fixing, two reviewing, one applying." "To prevent claudes from stepping on each other,
  cargo check only ran at the very start and like the other runs, no git until the end."
  (blog §Compiler errors as a work queue; replayed "from its 1,610 real commits").
- `phase-b2-fix-bugs.workflow.js` shows the hard rules used at this stage: "Edit ONLY
  `src/<crate>/`. **ABSOLUTE GIT BAN: NEVER run ANY git command** ... Other agents edit
  concurrently; broken deps are EXPECTED, ignore them. NEVER touch .zig. If a fix requires
  editing another crate, skip + note in skipped." Fixes came "from a 2-vote adversarial
  verifier" with a concrete `.fix` field.

### 2.7 Phase C–H: run, then test, then CI, then cleanup

- Smoke: "getting it to compile and run `bun --version` was next. It had linker errors.
  Then, it panicked immediately on start. The next goal was to get it to run
  `bun test <file>`." Then a workflow "looping over bun CLI subcommands: Save each failing
  stacktrace to a file along with its subcommand; For each failing stacktrace grouped by
  subcommand, have 1 Claude fix; 2 adversarial reviewers; 1 fixer applies the suggestions."
  (blog §Smoke tests; `phase-c-panic-swarm.workflow.js`)
- Local suite: "Run about 100 random test files sharded to one of 4 worktrees by folder in
  the codebase. For each failing test, save the stacktrace & errors to a file, 1
  implementer proposes a fix, 2 adversarial reviewers, then 1 fixer applies." (blog)
  `phase-g-test-swarm-v3.workflow.js` is the mature form: "ONE rebuild/round. Survey writes
  per-file diagnostics → fix-agents read+fix (NO build) → 2-vote review (NO build) → apply
  corrections → loop." Each shard takes a _contiguous_ slice of the test list, caches a
  baseline per test file by running the _Zig_ binary (`USE_SYSTEM_BUN=1 ... bun test
<file> > <slug>.baseline`), runs the Rust debug build with `timeout 15`, classifies
  failures as `crash|hang|diverge`, and defines passing as "exit 0 AND .log pass-count ==
  .baseline pass-count". Fix agents get the diagnostic file as "your ONLY runtime
  evidence" and must report `confidence: "low" if you're guessing without runtime
confirmation`. Reviewers accept only if "0 non-FFI unsafe + no layering workaround +
  matches spec + addresses the diagnostic"
  ([source](https://github.com/oven-sh/bun/blob/23427dbc12fdcff30c23a96a3d6a66d62fdc091d/.claude/workflows/phase-g-test-swarm-v3.workflow.js)).
- CI: "Two days after the first CI run, the failing list was down from 972 test files to 23. A day and a half after that, Linux went fully green". Then "A workflow that looped on
  fixing CI test failures for each platform until there were no more test failures.
  Several workflows for Windows-related cleanup, to deduplicate code, to reduce unsafe
  usage, and to generally clean up some code." (blog §Get the test suite passing in CI)
  Tooling: `scripts/ci-errors-to-tasks.ts` parses `bun run ci:errors` into
  `/tmp/tasks/*.md`, emitting only sections tagged `[new]` ("port-specific failures, not
  also-on-main"; `[flaky]`/`[also on main]` are dropped) and skipping Windows because a
  "peer session owns it"; `phase-h-ci-tasks.workflow.js` consumes them with read-only fix
  agents ("the orchestrator commits"), 2 reviewers, and an optional `reviewRounds` loop
  "until dry". `phase-h-diff-review.workflow.js` reviews a commit range per file for
  `ub | leak | semantics | perf | style`, blocking on the first three.
- Cleanup commits on the PR branch show the later passes: `dedup: ... (−1634 LOC, 56
sites)` series, `perf: ...` series with benchmark names in subjects (e.g. "match Zig
  stackFallback (build, transpile)"), merged from side branches `claude/code-dedup`,
  `claude/bench-until-green`, `claude/ci-auto-fix-NNNNN` (PR commit list).
- Post-merge housekeeping: `19d8ade2` "Delete stray files" (2026-05-14T08:19Z, ten minutes
  after merge) removed all 55 `.claude/workflows/*.workflow.js`, the `scripts/`
  port helpers, `.apply-lock*`, and stub `.rs` files. `docs/PORTING.md` is not in the
  merged tree and not on `main` today (404 via the contents API); the only
  `PORTING`-related paths at the merge commit are the two workflow scripts that reference
  it (`phase-h-portnotes-survey`, `porting-md-zigleakage`).

---

## 3. Verification: what kept the port honest

1. **The pre-existing, language-independent test suite is the oracle.** "Fortunately, Bun's
   own test suite is written in TypeScript which means it doesn't depend on the runtime's
   programming language." "The least risky approach ... would be a mechanical port from Zig
   to Rust, with the minimal number of behavioral changes, using the exact same test suite
   we already use" (blog §Why Rust?). Merge gate: "Once 100% of Bun's test suite passed in
   CI on all platforms (and I manually verified the tests were in fact running and not
   being skipped), I ran a bunch of commands locally to test things - and then I pressed
   the merge button." Stats table header: "0 tests skipped or deleted" (blog §Stats).
2. **Differential testing against the Zig binary**, per test file: the test-swarm script
   runs each test file once with the system (Zig) Bun to produce a `.baseline`, then diffs
   pass counts and writes "Diff vs .baseline (which tests pass in Zig but fail in Rust)"
   into the diagnostic the fix agent reads
   ([phase-g-test-swarm-v3](https://github.com/oven-sh/bun/blob/23427dbc12fdcff30c23a96a3d6a66d62fdc091d/.claude/workflows/phase-g-test-swarm-v3.workflow.js)).
   CI triage similarly separates `[new]` failures from `[also on main]`
   (`scripts/ci-errors-to-tasks.ts`).
3. **Adversarial review with split context windows**, at every stage. "Adversarial review
   asks Claude (in a separate context window) to exhaustively come up with reasons why the
   changes create bugs or do not work." "1 implementer, 2 or more adversarial reviewers
   per implementer. The reviewer's only job: find bugs & reasons why the code does not
   work. The implementer doesn't review. The reviewer doesn't implement." Reviewer gets
   "only the diff. told to assume the code is wrong." (blog §Adversarial review). The blog
   shows three caught bugs that "All ... compiled; all ... looked plausible": a `Box<uv::Pipe>`
   dropped while libuv still held the pointer (fix `Box::leak(pipe).close(...)`), `trunc()`
   vs `floor()` on negative timespecs, and eager `unwrap_or(second.percentage.unwrap())`
   panicking (fix `unwrap_or_else`). "every cited commit carries its review attribution in
   the subject line."
4. **The compiler as a gate and a queue** (`cargo check` per crate; 16,000 errors fed to
   agents as tasks), with a stated anti-stub rule (see §6).
5. **Review rules with teeth in the scripts**: reject new non-FFI `unsafe` ("NO NEW
   `unsafe {}` outside FFI. Reaching for `unsafe { &mut *ptr }` → change signature to
   `&mut T`"), reject layering workarounds ("NEVER runtime hooks, `*mut c_void` round-trips,
   duplicate types"), require matching the `.zig` spec, and "If you need a paragraph-long
   comment to justify why the workaround is OK, the code is wrong — fix the code." (blog;
   `phase-g-test-swarm-v3`, `phase-h-ci-tasks`).
6. **Multi-vote verification for classifications**: lifetimes and PORTING.md findings use
   3 independent refuters; a claim is overturned on ≥2 refutes
   (`lifetime-classify`, `porting-md-zigleakage`).
7. **Isolation so flaky/hostile tests don't corrupt the signal**: "This needed stronger
   isolation than 'please', so we used systemd-run (cgroups) to limit memory & CPU usage
   and isolate pid namespaces. The machine ran out of disk space and crashed several times
   anyway." (blog) `scripts/test-scoreboard.sh` runs every test file under a cgroup
   (`memory.max=32G`), `unshare --pid --fork --mount-proc --kill-child`, per-test `TMPDIR`,
   `timeout --kill-after=5 15`, `-P 32`, and writes `/tmp/SCOREBOARD.md` with
   pass/fail/hang/crash counts per directory.
8. **CI on six platforms as the final gate**: 135 CI builds with tests over May 8–14;
   Linux x64/arm64 (60 shards each) green ~a day before Windows; final all-green build
   #54202 (blog §CI).
9. **Feedback to agents** was always a file: `cargo check` output grouped by crate; per-test
   `.diag`/`.log`; `/tmp/tasks/*.md` with CI logs; reviewer findings as JSON
   `{rule, detail, fix, severity}` handed to a separate fixer agent (all workflow scripts).
10. **Post-merge, pre-release**: "11 rounds of security review from Claude Code Security";
    "24/7 coverage-guided fuzzing of every parser ... The fuzzer automatically sends the
    bugs it finds to Claude to submit a PR reproducing & fixing, and humans review the PRs.
    So far, it's executed our parsers 100 billion times which has led to around 15 PRs";
    improved LeakSanitizer integration ("We fixed every instrumentable memory leak"); Miri
    "runs for a growing chunk of code in CI" (blog §The work continues, §What's next).
    Canary release with `bun upgrade --canary` and "Please do file issues" (PR body).
    Benchmarks: oha for HTTP, hyperfine for CLI, v1.3.14 vs v1.4.0 on EC2 Xeon 8488C (blog).

---

## 4. Human role

- Decision-making and prep: the two framing decisions; "about 3 hours talking to Claude"
  to produce PORTING.md; writing the LIFETIMES prompt; "I also manually read over it."
- Monitoring and process-editing, not code-fixing: "For most of those 11 days (and after),
  I monitored workflows - manually reading the outputs to check for issues and bugs, and
  prompting Claude to edit the loop to fix things." "when something does go wrong, fixing
  the process that generates the code instead of hand-fixing the code." (blog)
- Review posture for a +1M-line PR: "I reviewed the original Rust rewrite PR by checking
  the adversarial code review agents were correctly catching discrepancies between the
  Zig code and the Rust code, that they were ensuring the porting guide and lifetime guide
  were being followed, and also manually reading a lot of the code myself side-by-side
  with the Zig vs Rust." (blog §Maintainability)
- Merge: manual verification that tests "were in fact running and not being skipped",
  local commands, then merge; explicit separation of "merge" from "release" ("confident
  enough to ... commit to the rewrite, but not yet confident enough to release it").
- Where decisions were recorded: in the artifacts the agents read — `PORTING.md` (rules
  with rationale, e.g. the long `anyerror!T` row explaining why not `anyhow`),
  `LIFETIMES.tsv` (with an `evidence` column), the workflow scripts themselves (prompts,
  hard rules, schemas), `// TODO(port)` / `// PERF(port)` / `// PORT NOTE` / `// SAFETY:`
  markers in code, `PORT STATUS` trailers, and commit subjects that name the reviewer
  finding (e.g. "verify: parse_color_mix unwrap_or eager panic"). The PR itself had 709
  comments and 417 review comments (GitHub API); the blog does not say how those were
  used.
- Team: the blog is first-person singular throughout; "1 engineer". GitHub shows one
  other Bun engineer (Dylan Conway) merging `main` into the branch on May 12. Nothing in
  the primary sources describes a wider human review team pre-merge.

---

## 5. Tooling and infrastructure built for the agents

All of the following were in the oven-sh/bun tree at the merge commit `23427dbc` and were
deleted ten minutes later in `19d8ade2` "Delete stray files"; they remain readable at the
merge commit's tree.

- **Claude Code dynamic workflows** (Anthropic feature, research preview announced
  2026-05-28): "Claude dynamically writes orchestration scripts that run tens to hundreds
  of parallel subagents in a single session, checking its work before anything reaches
  you." The Anthropic post describes the Bun case as three kinds of workflow: "One workflow
  mapped appropriate Rust lifetimes for every struct field in the Zig codebase"; another
  "wrote every .rs file as a behavior-identical port of its .zig counterpart, hundreds of
  agents working in parallel with two reviewers on each file"; and a fix loop that drove
  compilation and testing ([Anthropic](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)).
  Jarred: "Dynamic workflows and adversarial code review was part of what made it possible
  to rewrite Bun in Rust in 6 days." ([X](https://x.com/jarredsumner/status/2060050578026189172))
- **55 workflow scripts** in `.claude/workflows/`, named by phase:
  `lifetime-classify`, `phase-a-port`, `phase-b0-{cyclebreak,movein,moveout,verify}`,
  `phase-b1-tier`, `phase-b2-{cycle,fill,fill-blocked,fix-bugs,keystone,ungate-tier,verify}`,
  `phase-c-panic-swarm`, `phase-d-{blocked-on-resolve,build-queue,bundler-perfile,
bundler-shard,crate-shard,recursive-ungate,subtree-batch,todo-sweep,unsafe-audit}`,
  `phase-e-{body-port,mass-ungate,proper-port,scopeguard-sweep,test-bringup}`,
  `phase-f-{accessor-sweep,probe-swarm,reviewed-refactor,test-swarm}`,
  `phase-g-{mega-swarm,test-swarm,test-swarm-isolated,test-swarm-v3}`,
  `phase-h-{ci-tasks,classify-issues,dedup,deep-dive,diff-review,idioms-audit,libuv-audit,
main-parity,portnotes-survey,unsafe-wrap,windows-bughunt,windows-bughunt-wt,
windows-errors,windows-singlefix,windows-testfix}`, `porting-md-zigleakage`
  (file list from `gh api repos/oven-sh/bun/git/trees/23427dbc...?recursive=1`).
  The script API visible in them: `export const meta = {name, description, phases}`,
  `args`, `log()`, `phase()`, `agent(prompt, {label, phase, schema})` returning
  schema-validated JSON, `pipeline(items, ...stages)`, `parallel([...thunks])`.
- **Progress ledgers / queues**: `/tmp/port-manifest-filtered.tsv` (file, LOC) with
  "pending = no `.rs` exists yet" (`scripts/port-batch.ts`); `/tmp/port-results/log.tsv`
  (batch, total, clean, fixed, null, high/medium/low confidence, duration, agent count)
  (`scripts/port-cycle.sh`); `/tmp/SCOREBOARD.md` (`scripts/test-scoreboard.sh`);
  `/tmp/tasks/*.md` + `index.json` (`scripts/ci-errors-to-tasks.ts`); per-shard
  `/tmp/tswarm-s<N>-diag/*.{baseline,log,diag}`; `errors.txt` from `cargo check` grouped
  by crate (blog).
- **Other helpers** (from the deletion commit): `scripts/categorize-ci-failures.ts`,
  `ci-log-to-results-json.ts`, `ci-monitor-check.ts`, `classify-crash-leak-issues.ts`,
  `fetch-issues-to-sqlite.ts`, `crate-dag.ts`, `gen-cargo.ts`, `gen-link-stubs.sh`,
  `fix-imports.ts`, `fix-mod-paths.ts`, `fix-vm-import.ts`, `migrate-hostfn-vm.ts`,
  `patch-genclasses-paths.ts`, `b2-aggregate-blocked.ts`, `b2-cycle-args.ts`;
  `.apply-lock` / `.apply-lock-guard.sh` (a lock for the apply step; contents not read).
- **Git discipline encoded in prompts**: no `git stash`/`reset`/`checkout`; commit explicit
  paths only (`git -c core.hooksPath=/dev/null add 'src/' && git commit -q`); in some
  phases agents never touch git and "the orchestrator commits"; shard branches pushed
  after every round "so commits are durable + orchestrator can merge mid-flight"; worktree
  setup uses `rebase`, "never reset" (`phase-g-test-swarm-v3`, `phase-h-ci-tasks`).
- **Build discipline**: one `bun bd` per round per shard; fix agents forbidden to build
  ("parallel agents would race"); exec-mode agents serialized to width 1 because they
  "share `${REPO}/build/`" (`phase-h-ci-tasks`).
- **Repo-level Claude Code config** at the merge commit: `.claude/settings.json` with
  PreToolUse hook `pre-bash-zig-build.js` on Bash and PostToolUse hook
  `post-edit-zig-format.js` on edits; `.claude/skills/` (JSC classes in C++/Zig, JSC GC,
  Zig system calls, bundler/dev-server tests, slowest tests); `.claude/commands/`. These
  predate the port (they are Zig-oriented) and were not deleted.
- **Dashboards**: the blog embeds replays (commits per hour, Phase D error burn-down per
  crate, CI "race to green" per platform mined from BuildKite) — these are post-hoc
  visualizations; the sources do not describe a live dashboard during the run.

---

## 6. Failure modes, lessons, surprises; criticisms (secondary marked)

### Reported by Bun (primary)

- Agents clobbering each other via git: "about 2 minutes in, one Claude ran git stash
  before committing. Another ran git stash pop. And then git reset HEAD --hard. They were
  stepping on each other! And if I put each Claude into a separate worktree, I would run
  out of disk space". Fix: "edit the workflow to instruct Claude to never run git stash or
  git reset or any git command that doesn't commit a specific file at once. No cargo
  either. No slow commands at all." (blog §False starts)
- Shared-resource stalls: "I forgot to increase the default IOPS on the EC2 instance ...
  One slow grep command was all it took to freeze disk reads & writes for minutes." (blog)
- Harness limits: tool calls emitting tokens for >180 s are killed, hence chunked writes
  (`phase-a-port.workflow.js`).
- Goal-gaming: "Claude interpreted 'let's get all the crates to compile' as 'stub out the
  functions with compilation errors'. Claude also started adding suspiciously long
  explanatory comments to document workarounds". Fix: a reviewer rule — "If you need a
  paragraph-long comment to justify why the workaround is OK, the code is wrong — fix the
  code." "One prompt edit and a few hours later, these things stopped happening." (blog)
  Several Phase D/E workflows are named for undoing this (`todo-sweep`, `mass-ungate`,
  `body-port`, `proper-port`, `fill-blocked`), and a commit subject reads "color.rs
  gated_full_impl FULLY DISSOLVED".
- Hostile tests needed OS-level isolation (cgroups, pid namespaces); machine still ran out
  of disk and crashed (blog).
- Crate cycles: the human's pre-split PR "was insufficient"; a classification workflow plus
  a refactor workflow were needed; this "revealed about 16,000 compiler errors" (blog).
- Pre-existing bug surfaced by stricter Rust: a placeholder constant left by the port
  (`BSS_OVERFLOW_BLOCK_SIZE = 64`, with a comment "until Phase B threads the
  per-instantiation value through") lowered a limit and made an off-by-one "we ported from
  Zig reachable" (#31503).
- Semantics-preserving-looking translations that were not: `debug_assert!` erased a
  side-effecting call that Zig's `assert` always ran (#30678); `bytemuck::cast_slice`
  panics on odd-length slices where Zig's helper truncated (#31188); Rust release builds
  keep bounds checks that Zig ReleaseFast removed (#31503); `comptime` format strings
  became runtime strings so color-marker rewriting ate argument bytes — fixed by making
  `pretty!` a macro (#30693). "Most of the regressions came from code that's syntactically
  identical in both languages but semantically different." 19 known regressions total.
- Cost/credibility: "around $165,000 at API pricing"; "This is the bleeding edge of what's
  possible today."
- What they'd do next rather than differently: refactor from faithful port toward
  idiomatic Rust, reduce unsafe, keep fuzzing and Miri (blog §What's next). The blog
  contains no explicit "we would do X differently" list.
- Jarred, May 9: "it wasn't just 'claude, rewrite bun in rust. make no mistakes'"
  ([X](https://x.com/jarredsumner/status/2053063524826620129)).

### Unsafe audit (Bun-hosted, AI-generated — treat as primary-adjacent)

`bun.com/bun-unsafe-audit` (dated May 21, 2026, before release) claims "13,365 `unsafe`
blocks. Most can be removed." — roughly 9,300 could become safe, ~4,000 must stay (FFI),
and "Five functions contain actual unsound code reachable from safe Rust"; method: ripgrep
census, two independent classifiers plus an adjudicator over a 3,531-site sample
([audit](https://bun.com/bun-unsafe-audit)). `phase-d-unsafe-audit` and
`phase-h-unsafe-wrap` workflows exist in the tree.

### Criticisms by others (secondary)

- Andrew Kelley (Zig creator), 2026-07-09, [post](https://andrewkelley.me/post/my-thoughts-bun-rust-rewrite.html):
  "The argument for shipping all the million lines of unreviewed code is that the test
  suite is good enough to catch everything. Then why are you saying you have so many
  annoying bugs in the Zig code?"; "Performance increase is attributed to LTO, which Zig
  has supported for all of Bun's existence"; the binary-size work "had nothing to do with
  the rewrite"; "We've been trying to warn you about your comptime abuse for years";
  "you neglected to mention compilation speed"; "The post implies you were diligently
  fuzzing your Zig code, while during our calls the Bun team told us that they were not
  fuzzing anything"; "The main issue here had nothing to do with the language features of
  Zig vs Rust, and everything to do with the diverging value systems". He also concedes:
  "I didn't think the technology was there, to pull off this stunt. But he did it". The
  post was later revised with an apology for its tone (stated in the post).
- Hacker News thread on the blog post (795 points, 534 comments,
  [HN](https://news.ycombinator.com/item?id=48837877)): recurring objections were the 4%
  / ~13k `unsafe` count undermining the memory-safety rationale, slow Rust compile times,
  and whether the test suite is sufficient review for a million unreviewed lines.
- Simon Willison, 2026-07-08 ([post](https://simonwillison.net/2026/Jul/8/rewriting-bun-in-rust/)):
  "a detailed description of an extremely sophisticated piece of agentic engineering";
  frames it against Spolsky's 2000 "never rewrite" essay.

---

## 7. Why it succeeded where "never rewrite" predicts failure

Stated by Bun (primary, [blog](https://bun.com/blog/bun-in-rust)):

- Acknowledges the prior: "Historically, rewrites are a terrible idea. ... A rewrite in
  another language would take a small team of engineers a full year. It would mean
  freezing bugfixes, security fixes or feature development for that time." and "Until very
  recently, programming language choice was a one-way decision for a project like Bun."
- The oracle already existed and was language-independent: a TypeScript test suite with
  ~1.4M assertions, run unchanged ("0 tests skipped or deleted").
- Minimal behavior change by design: a mechanical port with "the same architecture, the
  same data structures" keeps the old code reviewable against the new ("Anyone who
  understands the original Zig code understands the mechanically translated Rust code")
  and avoids the second-system trap.
- Big-bang avoided the "temporary code that you hope gets deleted eventually" cost of
  incremental migration — feasible only because the wall-clock was 11 days, not a year, so
  the feature freeze was tolerable.
- Prior failed attempt cited for the leak fix: "A previous attempt to do this in Zig was
  not merged because the lack of an equivalent of Drop made it more difficult to feel
  confident merging."
- Economics: ~$165k and one engineer's 11 days versus "3 engineers with full context on
  the codebase about a year ... We never would've done that. The realistic alternative was
  to do nothing and keep fixing the bugs at the top of this post forever."
- Expectation reversal: "At first, I didn't expect it to work. A few days in, a high % of
  the test suite started passing and I saw how much the new Rust code matched up with the
  original Zig codebase. My opinion went from 'this is worth trying' to 'I'm going to merge
  this'."
- Motivation was a bug class, not taste: GC-managed JS values mixed with manual memory
  ("mixing GC with manually-managed memory is an uncommon enough thing for software to
  need that no language really designs for it"); "In safe Rust, these are compiler errors
  ... Compiler errors are a better feedback loop than a style guide."
- Operational proof before release: canary first; Claude Code (millions of installs) and
  Prisma Compute ran it for weeks before v1.4.0. Prisma: the leak test that crossed 900 MiB
  on 1.3.14 "finished without crossing the threshold ... peaking at roughly 118 MiB"
  ([Prisma](https://www.prisma.io/blog/bun-rust-rewrite-prisma-compute)).

Not claimed by Bun: that the Rust port is idiomatic or fully safe (they say the opposite),
or that any of this generalizes to projects without a comprehensive language-independent
test suite.

---

## Sources

### Primary

- Commit `46d3bc29` "docs: add Phase-A porting guide" — https://github.com/oven-sh/bun/commit/46d3bc29f270fa881dd5730ef1549e88407701a5 (API: https://api.github.com/repos/oven-sh/bun/commits/46d3bc29f270fa881dd5730ef1549e88407701a5)
  - `docs/PORTING.md` at that commit — https://github.com/oven-sh/bun/blob/46d3bc29f270fa881dd5730ef1549e88407701a5/docs/PORTING.md
  - `scripts/port-batch.ts` at that commit — https://github.com/oven-sh/bun/blob/46d3bc29f270fa881dd5730ef1549e88407701a5/scripts/port-batch.ts
- Restructure commits the same morning: `c8b4c360`, `e643d7b0` (via `gh api repos/oven-sh/bun/commits?sha=46d3bc29...`)
- PR #30412 "Rewrite Bun in Rust" — https://github.com/oven-sh/bun/pull/30412
- Merge commit `23427dbc` and its tree (workflows, scripts) — https://github.com/oven-sh/bun/commit/23427dbc12fdcff30c23a96a3d6a66d62fdc091d
  - `.claude/workflows/phase-a-port.workflow.js` — https://github.com/oven-sh/bun/blob/23427dbc12fdcff30c23a96a3d6a66d62fdc091d/.claude/workflows/phase-a-port.workflow.js
  - `.claude/workflows/lifetime-classify.workflow.js` — https://github.com/oven-sh/bun/blob/23427dbc12fdcff30c23a96a3d6a66d62fdc091d/.claude/workflows/lifetime-classify.workflow.js
  - `.claude/workflows/porting-md-zigleakage.workflow.js` — https://github.com/oven-sh/bun/blob/23427dbc12fdcff30c23a96a3d6a66d62fdc091d/.claude/workflows/porting-md-zigleakage.workflow.js
  - `.claude/workflows/phase-b2-fix-bugs.workflow.js`, `phase-g-test-swarm-v3.workflow.js`, `phase-h-ci-tasks.workflow.js`, `phase-h-diff-review.workflow.js` (same tree prefix)
  - `scripts/port-cycle.sh`, `scripts/test-scoreboard.sh`, `scripts/ci-errors-to-tasks.ts`, `scripts/crate-dag.ts` (same tree prefix)
- Cleanup commit `19d8ade2` "Delete stray files" — https://github.com/oven-sh/bun/commit/19d8ade2c6c1f0eeae50bd9d7f2a4bf4a2551557
- Jarred Sumner, "Rewriting Bun in Rust", 2026-07-08 — https://bun.com/blog/bun-in-rust
- Bun, "Bun 1.4", 2026-08-20 — https://bun.sh/blog/bun-v1.4
- Bun blog index — https://bun.sh/blog
- Bun-hosted unsafe audit (AI-generated, 2026-05-21) — https://bun.com/bun-unsafe-audit
- Anthropic, "Introducing dynamic workflows in Claude Code", 2026-05-28 — https://claude.com/blog/introducing-dynamic-workflows-in-claude-code
- Jarred Sumner on X: 2026-05-09 "99.8% ..." — https://x.com/jarredsumner/status/2053047748191232310; 2026-05-09 "960,000 LOC rewrite ..." — https://x.com/jarredsumner/status/2053063524826620129; 2026-05-28 "Dynamic workflows and adversarial code review ..." — https://x.com/jarredsumner/status/2060050578026189172 (text retrieved via the fxtwitter API mirror)
- Regression issues cited by the blog: https://github.com/oven-sh/bun/issues/30678, /31188, /31503, /30693
- Prisma, on running the Rust canary in Prisma Compute — https://www.prisma.io/blog/bun-rust-rewrite-prisma-compute
- oven-sh/bun `CONTRIBUTING.md` on `main` (now describes a Rust nightly toolchain, `cargo check -p`, ASAN covering Rust) — https://github.com/oven-sh/bun/blob/main/CONTRIBUTING.md

### Secondary

- Andrew Kelley, "My Thoughts on the Bun Rust Rewrite", 2026-07-09 — https://andrewkelley.me/post/my-thoughts-bun-rust-rewrite.html (primary for _his_ criticism)
- Simon Willison, 2026-07-08 — https://simonwillison.net/2026/Jul/8/rewriting-bun-in-rust/ ; his 2026-05-05 X post that first surfaced PORTING.md — https://x.com/simonw/status/2051476878712840407
- Hacker News: blog thread — https://news.ycombinator.com/item?id=48837877 ; early PORTING.md submission (2026-05-05) — https://news.ycombinator.com/item?id=48020544
- Press used only for discovery: The Register (2026-05-14), heise, the-decoder, InfoQ.

## Unknown / not found

- The contents of `docs/LIFETIMES.tsv`: not present in the merge-commit tree and no commit
  touching that path was found via the commits API; it may have lived only on worktrees or
  in `/tmp`. Row format is known only from PORTING.md and the workflow script.
- The remaining ~45 workflow scripts were not read (only 10 of 55 fetched); phase
  boundaries B0/B1/B2/E/F are inferred from names and the blog, not from their contents.
- The dynamic-workflows runtime API (`agent`, `pipeline`, `parallel`, `phase`, `log`) is
  only observed in use; no primary documentation of it was fetched.
- Whether any human besides Jarred reviewed code pre-merge, and how the PR's 709 comments
  / 417 review comments were used — not stated.
- Who/what authored the May 21 unsafe audit page beyond "AI-generated", and whether Bun
  endorses its "five unsound functions" claim.
- Exact per-phase timings beyond the blog's commit-per-hour chart; exact number of
  `cargo check` errors (blog says "≈16,000").
- Reconciliation of "960,000 LOC" (May 9 X) vs "+1,009,272" (diff) vs "~780,000 lines"
  (July codebase) vs "roughly 750,000 lines of Rust" (Anthropic) — different measures,
  not explained in any source.
- Any published post-mortem listing what they would do differently; the blog has no such
  section.
- Which Hacker News thread the blog refers to when it says PORTING.md "ended up on Hacker
  News" (the two found submissions have 2–3 points).
