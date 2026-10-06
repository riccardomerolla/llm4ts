# Rewrite-grade loops: bringing the Bun port's method into llm4ts

Status: 2026-10-06. Phases 1, 2 and 4.1/4.2/4.3/4.6 shipped as 2.31.0 and
2.32.0 under ADR 0027; phase 3's queue primitive, `port-files`,
`port-compile` and the `zig-rust` pack shipped under ADR 0028 (the audited
rulebook, the ledger and the differential tier are still to come). Phases
4.4, 4.5, 4.7, 4.8 and the pilots remain proposals.

This plan distils two research notes written the same day from primary
sources, and maps them onto llm4ts's existing seams:

- [`bun-zig-to-rust-rewrite.md`](bun-zig-to-rust-rewrite.md) — how one
  engineer and ~64 parallel Claude agents ported Bun's 535k lines of Zig to
  Rust in 11 days (May 2026), with the orchestration scripts quoted from the
  merge commit.
- [`anthropic-agent-best-practices.md`](anthropic-agent-best-practices.md) —
  Anthropic's published guidance on agent harnesses, 2024-12 → 2026-09,
  reduced to 25 cross-cutting practices tagged portable vs Claude-specific.

The port is a story about **loops**, not about a model. llm4ts already has
the loop (plan → code → review → judge, persisted and resumable). What the
Bun run adds is a harder posture on three things llm4ts does softly today:
the oracle, the reviewers, and the human's job. The Anthropic material adds
the discipline that keeps such loops honest across providers.

## 1. The essence, in eight rules

Each rule names the source that owns it. The second column says what made
it decisive in the Bun run.

| #   | Rule                                                                                | Why it was decisive                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Verification is mechanical and pre-exists the agents.**                           | The TypeScript test suite (≈1.4M `expect()` calls) ran unchanged: "0 tests skipped or deleted". Merge waited for 100% green on six platforms, checked by a human that the tests really ran. Anthropic: "the verifier must be nearly perfect".                                                                               |
| R2  | **Review is adversarial, split-context, and separate from the fixer.**              | Every unit: 1 implementer → 2 reviewers who see only the diff and are "told to assume the code is wrong" → 1 fixer who applies findings "and nothing else". Three plausible, compiling bugs are shown caught this way.                                                                                                      |
| R3  | **The human writes the rulebook and edits the loop; they never fix code.**          | ~3 hours of conversation became `PORTING.md`; the human then "monitored workflows … prompting Claude to edit the loop". Anthropic's migration post: "Don't fix the code. You fix the process (loop) that produced the code."                                                                                                |
| R4  | **Rules and cross-file facts are precomputed, audited, and handed to every agent.** | `PORTING.md` was itself audited by 8 dimension auditors plus a 3-vote refute and a trial port of 3 files; `LIFETIMES.tsv` carried an `evidence: file:line` column and a 3-vote refute on unknowns. Agents were told to trust the table over local guessing.                                                                 |
| R5  | **Context is narrowed by denial, not just by supply.**                              | Implementers read the guide, their ledger rows and exactly one source file: "Do NOT read other .zig files for context. Do NOT run builds. Do NOT git anything."                                                                                                                                                             |
| R6  | **Failures write the queue; stubs and excuses are review failures.**                | `cargo check` once per crate → errors to a file grouped by crate → fanned out; CI failures split `[new]` from `[also on main]`/`[flaky]` before becoming tasks. When agents stubbed functions, one reviewer rule stopped it: "If you need a paragraph-long comment to justify why the workaround is OK, the code is wrong." |
| R7  | **Pilot, measure, extrapolate, then scale.**                                        | 3 files before 1,448; Anthropic's modernization post: "Measure token-usage from the pilot and extrapolate for the full run." Merge ≠ release: canary and two production users ran it for weeks.                                                                                                                             |
| R8  | **Every harness component encodes a model limitation; re-examine it per model.**    | Anthropic's harness-design post found context resets load-bearing on one model and dead weight on the next; the April 2026 postmortem showed a 25-word verbosity cap and a cache bug each silently cut coding quality.                                                                                                      |

## 2. Where llm4ts stands

What exists is cited by module; the last column is the gap this plan closes.

| Rule | llm4ts today                                                                                                                                                                                                                                                                                          | Gap                                                                                                                                                                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | Gates run after every task and on the epic branch after every merge (ADR 0013, `gatesIn` in `packages/shell/flows/lib/epic-stories.js`): sequential, stop at first red, no timeout. Clean-room equivalence vectors `generated`/`captured` (`flow/src/Equiv.ts`, `modernize-verify`). `nodePreflight`. | No baseline of the gates on the base branch, so a story inherits pre-existing reds as its own. No `[new]`/`[also on base]`/`[flaky]` triage. No per-gate timeout or hang/crash classification. Nothing stops a coder deleting or skipping tests. No differential oracle for non-clean-room ports (ADR 0012).           |
| R2   | Reviewers see only the diff ("The diff below is the whole subject", `Review.ts`); lenses by concern (correctness, test, structure, …); roster independence keeps the reviewer off the coder's executor (ADR 0019); `reviewAndFixLoop` caps rounds; judgment pre-screen (ADR 0017).                    | No adversarial lens ("assume it is wrong"). One pass per lens, no independent votes. The fix goes back to the same coder (`options.coder.ask(fixPrompt)`), not a separate fixer with a "nothing else" brief. Findings need not cite `file:line` to count.                                                              |
| R3   | `epic-retro` turns a red run into proposed fixes behind `- [ ] Approved` (ADR 0023): kinds `tasks`, `story`, `refine`, `none`. Library advice is a note. Packs carry `lessons.md` (`appendPackLesson`) and refine overlays (ADR 0015).                                                                | The retro cannot propose an edit to a reviewer rule or a prompt — the "edit the loop" move. Lessons are appended, never audited or promoted into rules.                                                                                                                                                                |
| R4   | Packs: `pack.md` + `prompts/` + `reviewers/` + `lessons.md` + `conventions` from `pack-fork` (ADR 0018); `modernize-pack-check` checks a pack against an estate without an LLM; orientation digest, `readFirst`, `acceptance` (ADR 0025); typed blackboard (ADR 0020).                                | No audited rulebook step (dimension auditors + refute + trial-port diff). No precomputed cross-file ledger with evidence and confidence that coders are told to trust. Judgment has `escalate`, not N-vote refute.                                                                                                     |
| R5   | Read-only enforcement grades (ADR 0010); `CoderPolicy` denies `git push/commit/add/checkout`, `gh`, `az` on Claude via `disallowed-tools` and lists what it cannot enforce elsewhere; perimeter checked on the diff (ADR 0013); orientation + anchors supply context.                                 | No "deny" posture in prompts or policy for build, `git stash/reset`, or reading beyond the unit; nothing detects after the fact that a coder ran git or a build (the `Activity` tool categories `git`/`build` already classify the calls).                                                                             |
| R6   | Judge findings become `Revision n` tasks; `modernize-verify` triages red vectors into fix specs and plan tasks; the coder's `## Findings` trailer is parsed (`CarriedNotes.ts`).                                                                                                                      | Gate output is pasted into the prompt, not written to a file the fixer is told is its "only runtime evidence". No parsing of errors by unit for fan-out. No anti-stub / anti-excuse rule. No confidence or todo count in the trailer.                                                                                  |
| R7   | `modernize-bench`, `llm4ts costs`, `llm4ts profile`, `EstimatedUsage`, `CostBudget`.                                                                                                                                                                                                                  | No `--pilot n` gate: an epic or a port runs everything or nothing. No pilot report that extrapolates cost and time.                                                                                                                                                                                                    |
| R8   | Replay (`flow/src/Replay.ts`), judgment eval datasets (`docs/judgment-datasets.md`), traces on by default.                                                                                                                                                                                            | Prompt and harness changes ship without a replayed before/after; the CHANGELOG does not say which model a prompt was tuned on. No autonomy contract shared by every flow prompt. No stall detection. The Anthropic provider sends no `cache_control`; whether `ContextManagement` keeps a stable prefix is unverified. |

## 3. The plan

Five phases. Phases 1, 2 and 4 are small changes to existing seams and can
ship in the next two minor releases; phase 3 is new flow material and needs
an ADR; phase 5 is the pilot that proves it. Every item names its seam,
because the rule in `CLAUDE.md` is deep modules over parallel code.

### Phase 1 — Make the oracle mechanical (R1, R6)

**1.1 Gate baselines and failure triage.** Lift `gatesIn` out of the
epic-stories lib into `flow/src/Gates.ts`. Before a story's first task, run
the gates once on the base checkout and cache the result by commit hash;
after each task, classify each failing gate line as `new`, `also on base`,
or `flaky` (one deterministic rerun of the red gate). Only `new` failures
become revision tasks and block the merge; the rest are reported in the
story's findings and the run report. Seam: `lintCommand` in `Review.ts`
returns a `ReviewResult`; extend `ReviewIssue` with an optional
`origin: "new" | "base" | "flaky"` rather than a parallel type.
_Acceptance_: a fixture repo with a pre-existing red test lets a story that
does not touch it merge, and says so.

**1.2 Per-gate timeout and class.** `lintCommand` gets a timeout (pack gate
line `test: 900s pnpm test`, default from `LLM4TS_GATE_TIMEOUT`), and the
result carries `class: "red" | "hang" | "crash"`. A hang is a gate failure
whose message says so, never a stuck run. Bun ran every test file under
`timeout 15` and classified `crash|hang|diverge`.

**1.3 Diagnostics are files.** Gate output goes to
`stories/<id>/gates/<task>-<gate>.log` in the run's state folder; the fix
prompt carries the path and a capped tail (`capped` in `flow/src/Context.ts`)
and the sentence "this file is your only runtime evidence; if you are
guessing, say `confidence: low`". The C-compiler post and the Bun swarm
scripts both moved test output off stdout for the same reason.

**1.4 Oracle guard.** A deterministic check on the story diff, alongside
`checkPerimeter`: deleted test files, new `.skip`/`.only`/`xit`/`@Ignore`
markers, and a drop in test count between base and story gate output are
gate failures unless the story's plan entry declares `testsChange: true`.
"0 tests skipped or deleted" was a merge condition for Bun; Anthropic's
practice 13 says tests are immutable from the agent's side. Seam:
`flow/src/Perimeter.ts` grows a sibling `OracleGuard.ts`; marker patterns
come from the pack (`## Oracle` section) with a default set for Vitest, Jest,
JUnit and Rust.

**1.5 Differential oracle tier.** `EquivTier` gains `differential`: the pack
names a test command and two checkouts (legacy, target); per test file the
flow records a baseline pass count on legacy, runs target, and a file passes
when exit 0 and pass count equals baseline. Red files are classified
`crash|hang|diverge` and written as `.diag` files for 1.3. This is Bun's
`.baseline` method and the oracle a non-clean-room port (ADR 0012) lacks
today. Seam: `Equiv.ts` + `EquivReport.ts`; `modernize-verify` gains a
`--tier differential` path that skips vector generation.

### Phase 2 — Make review adversarial (R2, R6)

**2.1 Adversarial lens, independent votes.** Add `adversarialReviewer` to
`minimalReviewers`: its only job is reasons the diff does not work; it
assumes the code is wrong; the diff is the whole subject. `reviewAndFixLoop`
gains `votes?: number` (default 1): each vote leases a reviewer from the
roster avoiding the coder's executor and, where possible, the other votes'
executors. Code merges votes deterministically: any Critical from any vote
blocks; Warnings survive when a majority agree on the same `file:line` or
title; Info is unioned. Default stays 1 vote everywhere except the port flows
(phase 3), which default to 2.

**2.2 Separate fixer.** `reviewAndFixLoop` gains `fixer?: "coder" | "separate"`.
`separate` sends the fix prompt to a fresh chat on a coder lease with Bun's
brief: "Apply the findings. Nothing else. Surgical edits only. If a finding
is wrong, skip it and say so." ADR 0003's fresh chat per task already makes
this cheap; what changes is that the implementer's chat never sees its own
review.

**2.3 Rules with teeth.** Every default lens and every pack reviewer gets a
shared preamble (`reviewRulesPreamble` in `Review.ts`): no stubbed bodies,
no skipped or deleted tests, no layering workaround, and "if you need a
paragraph-long comment to justify a workaround, the code is wrong". Packs
may extend it in a `## Review rules` section. The judge's rubric gets the
same text in its `provides` dimension.

**2.4 Findings cite the diff.** A finding whose `file` is not in the diff is
demoted to Info with a note; `file` and `line` become required in the
reviewer JSON schema for Critical. Anthropic's code-review guidance verifies
findings before posting; Bun's fixers were told to skip hallucinated ones.
Measure the effect with the existing review cache fingerprints before making
it the default.

### Phase 3 — A port flow family (R3, R4, R5, R6, R7) — needs ADR 0028

The Bun run's shape is not an epic of features; it is a mechanical work
queue over thousands of small units with a shared rulebook. llm4ts has the
feature shape (`epic-stories`, a DAG of stories) and the clean-room shape
(`modernize-*`). It lacks the queue shape. Build it once, deep, and compose
four flows on it.

**3.0 The queue primitive.** `flow/src/WorkQueue.ts`:
`runQueue(items, { implement, review, fix }, { concurrency, shards, done })`
where `done(item)` is a filesystem predicate ("the output file exists",
Anthropic's definition of done), resume is "pending = not done", items are
sharded into contiguous slices across worktrees, each stage returns a typed
result validated by schema, and failures become the next round's items.
Review votes and the separate fixer from phase 2 are its defaults. Events
and timing flow through `FlowEvents` so `llm4ts watch` and `profile` show
queues like stories.

**3.1 `port-guide`.** From a conversation (shell chat or a seed file) the
reasoning seat writes the rulebook into the pack as `prompts/porting.md`:
ground rules with rationale, type map, idiom map, "don't translate", output
format with a machine-readable trailer. Then the audit: N dimension auditors
(pack-declared, e.g. error model, ownership, collections, API shape) each
propose findings; a 3-vote refute drops any finding two voters reject; a
trial port of k sample files by the rules and again "natively" is diffed;
the result is a patch to the rulebook behind `- [ ] Approved`. Seam: packs
and overlays (ADR 0015), `Approval.ts`, votes from 2.1.

**3.2 `port-ledger`.** A precomputed cross-file table at
`docs/modernization/ledger.tsv`: unit, classification from a pack-declared
taxonomy, `evidence: file:line`, `confidence`. Classify → 3-vote refute on
unknowns and a 20% sample → synthesize. Coders are told to grep their rows
and trust them over local guessing. Seam: typed blackboard (ADR 0020) for
the rows; `Judgment` for the refute.

**3.3 `port-files`.** Manifest from the pack's `sources:` regex (path, LOC);
deterministic target path per source; batches sized by LOC with a smaller
batch when the first pending file is large; implementer context = rulebook +
its ledger rows + exactly one source file, with the denials in the prompt
and in `CoderPolicy` (no build, no git, no other sources). Two adversarial
reviewers, a separate fixer. Each draft ends with a `PORT STATUS` trailer
(`confidence`, `todos`, `notes`) parsed by code into the queue's result;
low-confidence files are the first items of `port-compile`. `--pilot 3`
runs three files, writes a pilot report (per-file time, tokens, confidence
mix, extrapolated totals) and stops behind an approval marker.

**3.4 `port-compile`.** One build per round per shard; errors parsed by a
pack-declared `diagnostics:` command into JSON grouped by unit; fixers edit
only their unit ("broken deps are expected; skip and note what needs another
unit"); reviewers refuse stubs and new unsafe/`any`; loop until dry or until
the error count stops falling for two rounds (a typed `Stalled` outcome).
Parsers for `tsc`, `cargo`, `javac` and `mvn` live in kits, not in flow.

**3.5 `port-tests`.** Phase 1.5's differential tier driven by the queue:
per test file baseline → run → diag → fix → review → one rebuild per round.
Then the retro.

**3.6 Pitfall cards.** `kits/<kit>/patterns/pitfalls-<src>-<dst>.md`: the
"syntactically identical, semantically different" list reviewers get as a
lens. Seed Zig→Rust from the four Bun regressions (assert side effects, cast
truncation on odd lengths, retained bounds checks, compile-time format
strings) and Scala/ZIO→TypeScript/Effect from llm4ts's own parity notes.
`epic-retro` learns to propose a new card from a regression (phase 4.6).

Scope note: the modernize flows keep the clean-room wall (ADR 0012 says the
bank conversion is not clean-room, and the port family is not clean-room
either: the source file is the spec, in the tree, as in Bun). The ADR must
say which flows run behind `checkWall` and which deliberately do not.

### Phase 4 — Harness discipline for every provider (R5, R8)

**4.1 One autonomy contract.** `flow/src/AutonomyContract.ts` renders the
paragraph every coder system prompt carries, provider-agnostic: nobody is
watching; act, do not announce; the task is the scope, never narrowed or
widened; minimal change; pre-existing bugs are findings, not fixes; do not
turn scratch checks into permanent tests; never edit or skip a test to pass;
end with evidence (command and exit), not a claim. Flows stop hand-writing
their own version. Per-executor overrides live in the roster entry so a
model that over-verifies can have scaffolding removed without touching flow
code (practice 18).

**4.2 Evidence, not assertion.** The `## Findings` trailer gains
`verified: <command>` and `confidence: high|medium|low`. Code cross-checks
`verified:` against the transcript's `Tool` entries: a claimed command that
never ran is a `FabricatedStatus` finding and the story is judged with that
in view. The Fable 5 guide reports this check "nearly eliminated fabricated
status"; it costs no model call because transcripts are already on.

**4.3 Stall detection.** From the transcript stream in the runner: N turns
without a tool call, the same tool call repeated M times, or two review
rounds with an identical diff end the task with a typed `Stalled` failure
that the retro can diagnose. Budget and turn caps exist; this is the
stopping condition the model does not control (practice 17). The pending
`cli-turn-limit-enforcement` spec is a prerequisite for the turn half.

**4.4 Context hygiene in API connectors.** Audit `ContextManagement` for a
stable prefix (static system first, dynamic last, trim whole turns from the
oldest end); add Anthropic `cache_control` on the system block and the last
stable turn in `AnthropicProvider` (the one Claude-specific item, behind the
`makeApiConnector` seam); the compaction prompt, where a connector compacts,
carries the preservation list from the Fable 5.1 guide (problems and how
resolved, options tried, decisions, current state, open items, exact
identifiers). Verify with a replayed trace that no earlier turn is mutated.

**4.5 Headless isolation column.** `provider-capabilities.md` gains
`isolatedHeadless`: whether the CLI can run without loading the target
repository's hooks, MCP servers and settings (Claude Code documents a bare
mode for headless runs; Codex and Gemini equivalents to be checked against
their current flags, not assumed). Coder seats on untrusted repositories
request it; the connector publishes `CapabilityUnenforceable` when it cannot
honour it, as `readOnly` does today (ADR 0010).

**4.6 Retro edits the loop.** `RetroFixKind` gains `rule`: a proposed patch
to a pack reviewer, the pack's `## Review rules`, a pitfall card, or a flow
prompt file, written as a diff behind `- [ ] Approved` and applied only from
JSON, like `tasks` and `story` today. The digest learns three signatures
worth a rule: repeated gaming (stubs, skips, long justifying comments across
stories), repeated identical reviewer findings across stories, and
`FabricatedStatus`.

**4.7 Harness change discipline.** Every change to a prompt, a compaction
window, a default effort or a cache header ships with a replayed before/after
over a recorded trace set (`Replay.ts`) and a CHANGELOG line naming the model
it was tuned on. `docs/harness-evals.md` keeps the ledger. The April 2026
postmortem is the argument: small harness edits degrade quality silently.

**4.8 Right-size by stage.** The roster entry gains `effort` per role,
mapped to each CLI's reasoning flag where one exists and ignored with a note
where none does; `llm4ts costs` reports spend per role so a run shows what
the strongest model is being spent on. Mechanical stages (port drafts,
compile fixes) default to the cheapest coder; judgment and the rulebook
audit to the strongest.

### Phase 5 — Pilots (R7)

**5.1 Internal pilot: llm4zio → llm4ts parity.** llm4ts is itself a port.
`docs/parity.md` is a hand-made manifest of source module → target module →
tests. Run `port-ledger` and `port-files --pilot 3` against the pinned
`llm4zio` v4.3.0 checkout with the parity ledger as the manifest and the
existing `@effect/vitest` suites as the oracle, to measure rulebook quality,
reviewer catch rate and cost per file with no customer code involved.

**5.2 Customer pilot: the bank conversion.** The `j2ee-nextjs` kit on the
demo fixtures, with phases 1 and 2 on: gate baselines, oracle guard,
adversarial votes, separate fixer. The success measure is the one Bun used:
stories merged with no human code edits, and the number of process edits
(retro `rule` proposals approved) it took to get there.

## 4. Sequencing and size

| Order | Items                        | Size                   | Depends on        |
| ----- | ---------------------------- | ---------------------- | ----------------- |
| 1     | 1.1, 1.2, 1.3, 1.4, 4.1, 4.2 | one minor release      | —                 |
| 2     | 2.1, 2.2, 2.3, 2.4, 4.3, 4.6 | one minor release      | 1.3 (diag files)  |
| 3     | ADR 0028, 3.0, 3.3, 3.4, 3.6 | one major feature      | 2.1, 2.2          |
| 4     | 1.5, 3.1, 3.2, 3.5           | second feature release | 3.0               |
| 5     | 4.4, 4.5, 4.7, 4.8           | ongoing, per release   | flag verification |
| 6     | 5.1 then 5.2                 | live runs              | 3 and 4           |

## 5. What not to copy

- **Dynamic workflows as a dependency.** Bun ran on Claude Code's own
  orchestration. llm4ts's value is being provider-agnostic; the queue
  primitive (3.0) is ours, over the roster, so a Codex, Gemini or local seat
  can take any stage.
- **Big-bang for the bank.** Bun could go big-bang because its oracle was
  complete and the port took days. The bank conversion stays strangler-fig
  (ADR 0012) until a differential oracle (1.5) exists for its flows.
- **Scale as a target.** 64 agents and $165k are consequences of the oracle
  being trustworthy, not goals. The roster already fills concurrency; the
  work is in trusting the gates enough to raise it.
- **Transliteration specifics.** `unsafe` policy and lifetimes are Zig→Rust
  facts; llm4ts keeps them as kit material (pitfall cards, ledger
  taxonomies), never in flow.

## 6. Decisions for the user

1. Does the queue shape (3.0) justify an ADR of its own, or is it an
   extension of `epic-stories` with one-task stories? The recommendation is
   its own module: a story is a feature with a DAG and a judge; a queue item
   is a file with a predicate.
2. Where does the port family live: built-in flows beside `modernize-*`, or
   a `kits/port` kit (ADR 0014)? Recommendation: the flows are built-in and
   generic; parsers, taxonomies and pitfall cards are kit material.
3. Default votes: 1 everywhere and 2 in port flows, or 2 everywhere once the
   review cache absorbs the cost? Recommendation: measure on 5.1 first.
4. Which of the pending specs this supersedes or absorbs:
   `cli-turn-limit-enforcement` (prerequisite of 4.3),
   `reviewer-prescreen-and-measurement` (its measurement feeds 2.4),
   `convert-all-orchestrator` (a queue in disguise; 3.0 may replace it).

## 7. Proposed spec files

For `specs/pending/`, one per line, in the order of §4; the user creates
them (ADR 0004):

- `gate-baselines-and-triage.md` (1.1, 1.2, 1.3)
- `oracle-guard.md` (1.4)
- `autonomy-contract-and-evidence.md` (4.1, 4.2)
- `adversarial-review-votes-and-fixer.md` (2.1, 2.2, 2.3, 2.4)
- `stall-detection.md` (4.3)
- `retro-rule-proposals.md` (4.6)
- `work-queue-primitive.md` (3.0, with ADR 0028)
- `port-flow-family.md` (3.1–3.6)
- `differential-equivalence-tier.md` (1.5)
- `context-hygiene-and-caching.md` (4.4)
- `headless-isolation-capability.md` (4.5)
- `harness-change-discipline.md` (4.7, 4.8)
- `pilot-llm4zio-parity-port.md` (5.1)
