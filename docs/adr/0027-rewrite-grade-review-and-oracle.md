# ADR 0027: Rewrite-Grade Review And Oracle

Status: Accepted · Date: 2026-10-06
Research: `docs/research/rewrite-grade-loops-plan.md` and the two notes it
distils (`bun-zig-to-rust-rewrite.md`, `anthropic-agent-best-practices.md`).
Specs: `specs/pending/gate-baselines-and-triage.md`, `oracle-guard.md`,
`autonomy-contract-and-evidence.md`, `epic-light-fixture.md` (release A);
`adversarial-review-votes-and-fixer.md`, `stall-detection.md`,
`retro-rule-proposals.md` (release B).

## Context

llm4ts already runs the loop the Bun Zig→Rust port ran: plan, code, review,
judge, persisted and resumable, with gates after every task and after every
merge (ADR 0013), reviewers that see only the diff, a roster that keeps the
reviewer off the coder's executor (ADR 0019), and a retro that turns a red
run into fixes behind an approval (ADR 0023). What the port did harder, and
what Anthropic's harness guidance says in general, is three things this
library does softly:

- **The oracle is soft.** A story inherits every red gate on the base branch
  as its own failure; nothing distinguishes a failure the story caused from
  one it found. A gate has no timeout, so a hung test is a hung run. Nothing
  stops a coder deleting or skipping a test to go green; the Bun merge
  condition was "0 tests skipped or deleted".
- **Review is cooperative.** Every lens asks a scoped question once; none is
  told to assume the code is wrong. The implementer applies its own review
  in its own chat. A finding need not point at the diff to count.
- **The human's lever is missing.** The person running the loop could edit
  plans and stories but not the rules the reviewers apply; the Bun engineer
  "monitored workflows … prompting Claude to edit the loop", and the
  migration write-up says "you fix the process (loop) that produced the
  code". Coders claim verification the transcript shows never ran, and a
  task that loops without progress is only noticed by a person watching.

The two framing facts: every one of these is provider-agnostic, and none of
them depends on the model being Claude. The port's scale (64 agents) and its
orchestration runtime are not adopted; the posture is.

## Decision

Numbered as the specs implement them. Release A (2.31.0) is 1–6, release B
(2.32.0) is 7–12; 2.30.0 shipped the OpenTelemetry export (ADR 0026).

1. **Gates are a module with a baseline.** `gatesIn` leaves the epic-stories
   script for `flow/src/Gates.ts`. Before a story's first task the gates'
   result on the base is known: the post-merge epic gate run is reused, or
   the task checkpoint's, cached by base commit, gate command and app dir in
   the run's state folder, recomputed when the base moves, deleted on
   `--land`. A flow without a base keeps today's behaviour and says so.
2. **Failures are triaged before they block.** `reviewAndFixLoop` compares
   the gate's normalized failing lines (ANSI, durations, absolute paths and
   timestamps stripped) with the baseline: `new` blocks and feeds the fix
   round; `base` never blocks, is listed once in the findings and the
   report, and its growth is `new`; `flaky` is one deterministic rerun of
   the test gate, reported, never blocking. Per-tool parsers are kit
   material for a later phase (pack `diagnostics:`).
3. **Gates have a timeout and a class.** `lintCommand` kills a gate after
   `LLM4TS_GATE_TIMEOUT` (default 20 minutes); the result is class `red`,
   `hang` or `crash` and a hang is a gate failure that says so. Gate output
   is written to the run's state folder; the fix prompt carries a capped tail
   (`LLM4TS_GATE_TAIL_CHARS`, default 4000), the path for CLI coders, and
   the sentence that the file is the coder's only runtime evidence. On
   `--land` logs compact to their failing lines.
4. **The oracle guard.** Beside `checkPerimeter`, a deterministic check on
   the story diff and the gate output: deleted test files, added skip or
   focus markers, and a drop in the passed-test count when the output has a
   recognizable summary. A violation is a gate failure the fix round can
   undo. A story that may change tests says so with `testsChange: true` in
   its plan entry (hash-bearing, so the edit is the approval, as ADR 0013);
   `sdd` declares it for its red phase. Marker patterns default for Vitest,
   Jest, JUnit, pytest and Rust; a pack extends them in `## Oracle`.
5. **One autonomy contract.** `flow/src/AutonomyContract.ts` renders the
   paragraph every coder system prompt carries: nobody is watching; act,
   do not announce; the task is the scope, never narrowed or widened;
   minimal change; pre-existing bugs are findings, not fixes; scratch checks
   do not become tests; never edit or skip a test to pass; end with evidence,
   not a claim. Flows stop writing their own. A roster entry picks a profile
   (`full`, `minimal`, `off`) per executor.
6. **Evidence is cross-checked.** The task's `## Findings` trailer gains
   `verified: <command>` and `confidence: high|medium|low`. Code checks
   `verified:` against the transcript's `Tool` entries; a command that never
   ran is a `FabricatedStatus` Warning in the story's findings, visible to
   the judge, counted in the profile, a signature for the retro. API coders
   with no tool calls get an Info note, not a check.
7. **An adversarial lens, with votes.** `adversarialReviewer` joins the
   minimal set: its only job is reasons the diff does not work, it assumes
   the code is wrong, the diff is the whole subject. `reviewAndFixLoop`
   takes `votes` (default 1, `LLM4TS_REVIEW_VOTES`): votes multiply only the
   adversarial lens, prefer distinct executors and never require them. Code
   merges: any Critical blocks; Warnings are unioned and deduplicated by
   `file:line`; an Info survives when more than one vote raises it.
8. **A separate fixer, off by default.** `fixer: "separate"`
   (`LLM4TS_REVIEW_FIXER`) sends the fix to a fresh chat on a coder lease
   with the story's carried notes and the diag tail, briefed to apply the
   findings and nothing else, and to skip a wrong finding and say so. The
   implementer's chat never sees its own review.
9. **Rules with teeth, everywhere.** A shared preamble (no stubbed bodies,
   no skipped or deleted tests, no layering workaround, "if you need a
   paragraph-long comment to justify a workaround, the code is wrong") is
   prepended to every default lens, every pack reviewer and the judge
   rubric; a pack's `## Review rules` section extends it or sets
   `preamble: off`. `.llm4ts/review-rules.md` in the target repository loads
   as an extra lens so a run without a pack has a place for rules.
10. **Findings cite the diff.** A Critical without `file` is demoted to
    Warning; a finding whose `file` is not in the diff is demoted to Info;
    both publish `ReviewFindingDemoted`. Nothing is dropped.
11. **Stalls are typed.** Two consecutive review rounds over a byte-identical
    diff, or the same tool call with the same arguments five times in a row,
    end the task with `Stalled`; the story fails, dependents hold, the retro
    diagnoses. A silence timer exists (`LLM4TS_STALL_MINUTES`) and is off by
    default.
12. **The retro edits the loop.** `RetroFixKind` gains `rule`: structured
    operations (`append-rule`, `replace-section`) against a pack reviewer,
    its `## Review rules`, `lessons.md`, a kit pitfall card or
    `.llm4ts/review-rules.md`, rendered as a diff in the report and applied
    only from JSON behind `- [ ] Approved`, like `tasks` and `story`. The
    digest learns three signatures worth a rule: repeated gaming, the same
    reviewer finding across stories, and `FabricatedStatus`.

## Consequences

- Compatibility: every new Story, Pack and ReviewIssue field is optional and
  enters a hash only when set; plans and packs written by 2.29 parse and
  resume unchanged. Behaviours that add model calls (votes, the separate
  fixer) are off by default outside the later port flows; checks that cost
  no model call (triage, oracle guard, demotion, stall) are on.
- A story whose base was already red can now merge; the inherited reds are a
  report item for a cleanup story, not the story's fault.
- The preamble changes every reviewer prompt once, so the review cache
  misses once per lens after the upgrade.
- Every release in this line is compared on the light epic fixture
  (`examples/seed.sh epic`) before and after, with the same roster, reading
  the profile: explore calls before the first edit, review rounds, gate
  failures by origin, cost. The two runs are the first entries of a future
  harness-evals ledger.
- Divergences from the pinned llm4zio (which has none of these) are recorded
  in `docs/parity.md`.

## Not decided here

The work-queue primitive and the port flow family (ADR 0028, after release A
has run live); the differential equivalence tier; prompt caching and
context-prefix stability in the API connectors; a headless-isolation
capability column; per-tool gate parsers.
