# Improving llm4ts after studying oh-my-claudecode

Date: 2026-10-22. Status: research findings and proposed delivery order;
not an accepted architecture decision or implementation plan.

## Scope and agreed direction

The user selected **reliability of unattended runs** as the primary outcome
and **agent-agnostic flows with selected mechanisms adopted through the
existing CLI and skills** as the product direction. Those choices determine
the ordering below. They do not authorize implementing every suggestion.

Local baseline: `98f9b7dc7691d45156236cd55bb1e665d4857f5a`, plus the
existing untracked MCP operator-server design and plan observed in the
workspace. Upstream baseline: OMC `5.7.7`, commit
`e252e55e34bc3d86fa5d02149688b316eea954f5`. Primary sources:
[website](https://oh-my-claudecode.dev/),
[pinned repository](https://github.com/yeachan-heo/oh-my-claudecode/tree/e252e55e34bc3d86fa5d02149688b316eea954f5),
and the [source evidence note](oh-my-claudecode-source-notes-2026-10-22.md).
Upstream was inspected, not installed or executed. This is a source review,
not a runtime comparison or proof that either product is more reliable.

The useful lesson is operational completeness: check the exact workers
before starting, bound ongoing work, retain recoverable state, and make
human intervention explicit. llm4ts already has the orchestration spine.
Adding another scheduler or copying OMC's collection of execution modes
would be a poor first investment.

## Capability overlap: avoid duplicate projects

| Capability                                 | llm4ts evidence                                                                                                                               | Consequence                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Multiple coding agents and role allocation | [Roster](../../packages/flow/src/Roster.ts), [roster seats](../../packages/flow/src/RosterSeats.ts), [configuration](../configuration.md)     | Improve selection and readiness; do not propose adding multi-agent support.              |
| Plan, code, review, gates, resumable work  | [Flow](../../packages/flow/src/Flow.ts), [Stories](../../packages/flow/src/Stories.ts), [persistence](../../packages/flow/src/Persistence.ts) | Improve failure boundaries and recovery; do not add a competing execution loop.          |
| Live tree, replay, costs, profiles, OTel   | [README](../../README.md), [observability](../observability.md)                                                                               | Improve decisions based on the telemetry; another dashboard is secondary.                |
| Findings carried between tasks             | [CarriedNotes](../../packages/flow/src/CarriedNotes.ts)                                                                                       | Persistent memory is a broader scope, already specified separately.                      |
| Learning from completed epics              | [Retro](../../packages/flow/src/Retro.ts)                                                                                                     | Keep approval and evidence around improvements; generic self-improvement is not missing. |
| Human approval and capability checks       | [Approval](../../packages/flow/src/Approval.ts), [CapabilityGuard](../../packages/flow/src/CapabilityGuard.ts)                                | Improve durable waits and control surfaces; do not introduce a second approval policy.   |

## Ranked findings

Priority is a recommendation, not a measured impact estimate. “Existing”
means specified or proposed, not shipped. Validation below describes the
evidence a future implementation should provide; these checks were not run.

| ID  | Priority | Improvement                                                    | Relationship to current work                                   |
| --- | -------- | -------------------------------------------------------------- | -------------------------------------------------------------- |
| F01 | P0       | Enforce spend limits while work is running                     | New extension of existing budget and usage tracking            |
| F02 | P0       | Preflight the effective roster and flow requirements           | Deliver typed doctor spec; extend readiness coverage           |
| F03 | P0       | Terminate complete process trees on stop                       | Deliver existing process-group termination spec                |
| F04 | P0       | Make restart recovery reconcile state before doing work        | Existing memoization and operator draft, plus recovery checks  |
| F05 | P1       | Persist human waits and expose actionable run control          | Existing wait spec and operator draft; steering is later scope |
| F06 | P1       | Make harness limits and delegation bounds explicit             | Existing turn-limit spec and proposed ADR 0035                 |
| F07 | P1       | Evaluate reliability through executable failure scenarios      | Existing evaluation predicate spec, extended scenarios         |
| F08 | P1       | Admit expensive work according to host capacity                | New, optional resource policy                                  |
| F09 | P2       | Preserve decisions across overflow, resume and task boundaries | Existing session, pull-context and memory proposals            |
| F10 | P2       | Provide project-local setup and configuration explanation      | New adoption improvement after typed doctor                    |
| F11 | P2       | Detect repeated failure cycles beyond identical tool calls     | New extension of current stall guard                           |
| F12 | P3       | Experiment with task-sensitive executor selection              | New opt-in routing experiment after a quality baseline         |

### F01. Enforce budgets before admitting more work

**Observed locally:** [FlowRunner.ts](../../packages/runner/src/FlowRunner.ts)
constructs `enforceBudget` at lines 1005–1023 and invokes it after the body
succeeds at line 1081. [CostLedger.ts](../../packages/flow/src/CostLedger.ts)
already defines token and USD limits. The current boundary can reject a
finished run for overspending; it cannot prevent subsequent calls during
the run. Missing prices also require an explicit policy: the USD check
currently substitutes zero when no total cost is available.

**OMC stimulus:** its reference documents warn/stop budget guidance at
iteration boundaries, explicitly advisory because the model reads it
([reference](https://github.com/yeachan-heo/oh-my-claudecode/blob/e252e55e34bc3d86fa5d02149688b316eea954f5/docs/REFERENCE.md#environment-variables)).
That is motivation for a stronger llm4ts mechanism, not evidence of a hard
OMC spending ceiling.

**Recommendation:** one shared run budget consulted before new model
calls and task leases; track in-flight work, publish approaching/exhausted
events, checkpoint, and stop admitting work at the limit. Define treatment
of estimates, unavailable prices, harness usage reported only at turn end,
and parallel overshoot. Never promise an exact dollar ceiling where the
harness cannot expose or cap its ongoing spend.

**Acceptance:** two parallel workers cannot each spend the entire remaining
allowance; exhausting a budget prevents another call; a resumed run retains
the intended accounting scope; unpriced usage is visible rather than green.

### F02. Check the roster that will actually execute the run

**Observed locally:** [Doctor.ts](../../packages/runner/src/Doctor.ts)
returns display text; [Cli.ts](../../packages/shell/src/Cli.ts) exposes
`doctor` without flow-scoping or JSON flags. The
[typed doctor spec](../../specs/pending/doctor-typed-report.md) already
addresses structured checks, required/advisory classification, remediation
and exit codes. The operator draft already includes preflight.

**OMC stimulus:** team startup resolves effective worker allocations and
executable paths before creating runtime state; see source-note item 1.

**Recommendation:** deliver that existing spec, then ensure preflight uses
the resolved roster, executor filters, actual models and role independence
requirements. Where available, probe authentication readiness through
supported harness checks. Distinguish executable presence from a usable
model; don't make paid trial calls silently. Reuse this report in CLI and
operator tools.

**Acceptance:** an unavailable required executor fails before planning or
workspace mutation; an irrelevant unavailable provider stays advisory; the
reported allocation matches the first leased executors.

### F03. Make cancellation own every child process

**Observed locally:** [NodeProcessExecutor.ts](../../packages/runner/src/NodeProcessExecutor.ts)
spawns at line 85 and kills the direct child at line 95. The existing
[process-group spec](../../specs/pending/process-group-termination.md)
describes POSIX process groups, Windows tree termination and grace periods.

**OMC stimulus:** source-note item 5 shows process-group termination in
the graph command executor. This comparison supports lifecycle work; it
does not establish that every OMC subsystem cleans up every descendant.

**Recommendation:** prioritize the existing fix before increasing
parallelism or adding detached operation. Preserve final trace and usage
where possible, and report uncertain cleanup explicitly.

**Acceptance:** cancel a fixture worker that spawned a test runner and a
server; all owned descendants exit and release their port. Repeated stop
requests are safe, and unrelated processes survive.

### F04. Reconcile interrupted runs before resuming them

**Observed locally:** file-backed task resume already exists. Planner reuse
is separately specified in
[activity memoization](../../specs/pending/activity-memoization.md).
The [operator-server draft](../superpowers/specs/2026-10-22-mcp-operator-server-design.md)
already proposes owned run processes and lifecycle records.

**OMC stimulus:** upstream recovery checks ownership/version/checkpoint
identity and records recovery phases (source-note item 6); its
[watchdog](https://github.com/yeachan-heo/oh-my-claudecode/blob/e252e55e34bc3d86fa5d02149688b316eea954f5/src/factory/watchdog.ts)
also detects stalled chain ledgers. These are narrower mechanisms than
universal crash recovery.

**Recommendation:** consolidate around the operator design: reconcile
recorded run identity, actual process ownership, branch/worktree state,
last durable task and artifact validity. Explain whether work is alive,
interrupted, waiting, complete or unsafe to resume. Reuse unchanged planner
results and avoid repeating durable side effects. A stale timestamp alone
must not authorize killing or restarting a process.

**Acceptance:** crash between task commit and status write, restart twice,
and observe one task completion and no duplicated merge or planner call.
A live slow worker is distinguished from an abandoned run.

### F05. Make required human intervention durable and discoverable

**Observed locally:** [typed human waits](../../specs/pending/typed-human-wait.md)
already specifies question/approval records and resume. The operator draft
includes status, wait and stop, but explicitly excludes in-run retry, skip,
add-story and steering. It also excludes push notifications.

**OMC stimulus:** the website highlights remote graph approval with
checkpoints; the source note distinguishes those workflow claims from the
verified graph journal and approval machinery (source-note item 7).

**Recommendation:** first deliver typed waits and the planned pull-based
operator surface. Then consider an optional subscriber for failure,
completion and required human action. Scheduler steering should be a
separate design with idempotent commands and explicit task boundaries.
Do not quietly expand the current operator project.

**Acceptance:** a headless approval request becomes a visible persisted
wait, survives a restart, and consumes one answer. Denial remains denial;
the coder cannot convert its own statement into approval. Any optional
notification delivers once per meaningful event and excludes secrets.

### F06. Enforce the limits already exposed by configuration

**Observed locally:** the pending
[turn-limit spec](../../specs/pending/cli-turn-limit-enforcement.md)
records that `turnLimit` does not reach native CLI caps. Proposed
[ADR 0035](../adr/0035-harness-delegation-and-pi-sessions.md) defines
delegation controls and their varying enforceability. Those are existing
commitments to evaluate, not new competitor discoveries.

**OMC stimulus:** its
[reference](https://github.com/yeachan-heo/oh-my-claudecode/blob/e252e55e34bc3d86fa5d02149688b316eea954f5/docs/REFERENCE.md#environment-variables)
documents budget guidance while explicitly qualifying it as advisory.
That distinction reinforces the need to report actual enforcement grades.

**Recommendation:** wire supported native limits, expose unsupported bounds
as capability facts, and account harness-owned Sub-agents to their parent
Lease. Implement ADR 0035's proposed non-delegating reasoning seats only
through the agreed proposal process. Prompt instructions alone must not be
reported as hard enforcement.

**Acceptance:** argv tests prove each advertised cap reaches the harness;
unsupported caps are visible; a capped run ends with a resumable reason.

### F07. Give reliability changes an executable pass condition

**Observed locally:** [harness-evals](../harness-evals/README.md) describes
before/after profiles but says its ledger is empty. The
[pass-predicate spec](../../specs/pending/harness-evals-pass-predicate.md)
already turns those observations into checkable claims.

**Recommendation:** deliver that predicate and add deterministic failure
scenarios for budget exhaustion, expired authentication, child cleanup,
resume reconciliation and human waits. Keep credentialed live rehearsals
separate from offline CI. For changes to prompts, sessions or routing,
compare completion quality before accepting token or latency savings.
OMC's reviewer benchmark includes clean examples and false-positive scoring
(source-note item 10); it is not a measured llm4ts baseline.

**Acceptance:** every P0 change ships with a scenario that fails under the
old behavior and passes under the new behavior; harness-sensitive changes
also include before/after live evidence with the same fixture and roster.

### F08. Add optional host-capacity admission for expensive operations

**Observed locally:** roster slots limit executor concurrency, but source
search found no host CPU/memory admission policy. Several executors can
still launch heavyweight builds simultaneously.

**OMC stimulus:** [host-load-gate.ts](https://github.com/yeachan-heo/oh-my-claudecode/blob/e252e55e34bc3d86fa5d02149688b316eea954f5/src/lib/host-load-gate.ts)
offers resource checks, but the verified worker-launch path proceeds even
when saturated. OMC is therefore inspiration for signals, not proof of
enforced backpressure; see source-note item 4.

**Recommendation:** start with optional limits on simultaneous heavy gates
and builds, then consider resource signals if needed. Bound waits, expose
the reason, and define behavior when metrics are unavailable. Avoid an
extra scheduler or holding resources needed by the operation being awaited.

**Acceptance:** a fake saturated host queues a heavy gate while lightweight
work continues; cancellation releases admission; unavailable metrics never
produce an unexplained indefinite wait.

### F09. Preserve useful decisions when context no longer fits

**Observed locally:** [Chat.ts](../../packages/flow/src/Chat.ts), lines
84–114, replays history and recovers from overflow by retaining system
instructions and the current turn. Carried notes are bounded per story.
Native sessions, pull context and durable memory already have proposals:
[ADR 0035](../adr/0035-harness-delegation-and-pi-sessions.md),
[ADR 0040](../adr/0040-pull-model-story-context-over-mcp.md),
[memory store](../../specs/pending/flow-memory-store.md), and
[memory recall/promotion](../../specs/pending/memory-query-tool-and-promotion.md).

**OMC stimulus:** project memory and compaction reinjection illustrate
retention beyond a transient transcript (source-note item 9). Artifact
descriptors also avoid duplicating large bodies (item 8).

**Recommendation:** deliver and measure those existing proposals. For
connectors without native sessions, evaluate bounded summaries that retain
decisions, unresolved findings and artifact references before discarding
history. Persisted lessons need source and scope; a coder's claim must not
be promoted into an observed fact. Reconcile the older memory spec's
retired `@llm4ts/modernize` paths before implementing it.

**Acceptance:** an overflow fixture retains a prior constraint and open
finding; a stale lesson does not override newer repository evidence;
quality stays stable across at least two harnesses.

### F10. Turn configuration discovery into a project-local setup path

**Observed locally:** llm4ts has an interactive menu, agent skills, roster
configuration and a mock quick start. [CoderChoice.ts](../../packages/shell/src/CoderChoice.ts)
uses PATH detection for decoration, explicitly not readiness.

**OMC stimulus:** explicit local/global setup, CLI versus in-session
documentation and routing diagnostics reduce ambiguity about which surface
is active (source-note item 1 and its interpretation limits).

**Recommendation:** after typed doctor, offer setup that produces a
reviewable project roster and validates it through the same report. Add an
explanation of effective configuration: source, precedence, roles, limits
and unavailable capabilities. Keep environment overrides and custom flows
as the existing mechanisms; avoid inventing another workflow mode system.

**Acceptance:** starting with one authenticated CLI, a user reaches one
verified fixture run and can explain which executor will code and review.
Setup preserves unrelated configuration and its second run is idempotent.

### F11. Recognize failure cycles that vary their tool calls

**Observed locally:** [Stall.ts](../../packages/flow/src/Stall.ts) already
supports silence and repeated identical tool calls. A different call resets
the repeat counter, so alternating actions can evade that guard.

**OMC stimulus:** its persistent modes and watchdog emphasize continuity,
but persistence alone does not demonstrate progress. This is an inferred
llm4ts improvement, not a claim that OMC solves arbitrary cycles.

**Recommendation:** test a bounded cycle detector using unchanged gate
failures and relevant artifact changes. Avoid equating tool activity or
elapsed time with progress. Emit a structured stop reason with evidence.

**Acceptance:** repeated A/B calls with the same failed validation stop;
an edit followed by a useful retry continues; a genuinely slow tool is not
misclassified solely because time elapsed.

### F12. Route by task needs only after measuring the static baseline

**Observed locally:** [Roster.ts](../../packages/flow/src/Roster.ts),
lines 615–630, selects eligible free executors by role priority and recency,
with continuity as a tie-breaker. Model routing already exists in this
static form.

**OMC stimulus:** explicit delegation routes coexist with
[complexity-tier selection](https://github.com/yeachan-heo/oh-my-claudecode/blob/e252e55e34bc3d86fa5d02149688b316eea954f5/src/features/model-routing/router.ts).
The source note's interpretation limits explain why routing claims must
be assessed separately for each OMC runtime.

**Recommendation:** evaluate opt-in selection using required capabilities
and task characteristics within the existing roster. Preserve independent
review requirements, pinning and operator priorities. Begin with explainable
rules; a learned router needs labeled outcomes and a demonstrated benefit.

**Acceptance:** compare against static allocation on the same tasks and
roster; accept only with stable completion/review quality and useful cost
or latency gains. Trace the choice so the operator can explain it.

## Proposed delivery sequence

1. **Stop predictable failures:** F01–F03, F06's native turn-limit wiring,
   and the existing evaluation predicate supporting F07.
2. **Make recovery operational:** F04–F05, building on the operator draft
   and typed waits. Add fault-injection scenarios before detached use.
3. **Reduce waste without degrading completion:** F08–F09, then F10.
4. **Run measured experiments:** F11–F12 after collecting a baseline.

No time estimates are assigned: implementation scope and rehearsal access
need to be settled first. New specs should be created only for genuinely
new work; existing pending specs should be updated rather than duplicated.

## Design frontier for a follow-up implementation discussion

The two product-level decisions are settled. These independent decisions
remain open before implementation:

| Decision                                     | Recommended starting position                                                                                    | Why it matters                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Budget exhaustion with calls already running | Stop admitting calls and checkpoint; interrupt active calls only where usage and safe cancellation are supported | Determines enforceable bounds and overshoot semantics |
| First delivery scope                         | Budgets, typed roster preflight, process cleanup and executable failure checks                                   | Produces a coherent reliability increment             |
| Human intervention transport                 | Deliver the planned pull-based operator tools before adding optional push delivery or steering                   | Keeps the current operator project bounded            |

Dependent questions about recovery records, reservation accounting and
control commands belong to later interview rounds. No ADR is created until
a consequential implementation trade-off is actually chosen.

## Vocabulary guardrails

Use existing [CONTEXT.md](../../CONTEXT.md) terms: an **Executor** is a
harness/model entry, a **Clone** is one concurrent instance, and a **Lease**
holds it. A harness-owned **Sub-agent** is not a roster Clone. OMC's generic
“worker” must be translated according to ownership, not copied as a new
llm4ts concept. Distinguish **Gate**, **Reviewer**, **Judge** and **Judgment**.

This report's improvement findings are research recommendations; they are
not runtime findings carrying the code-assigned **Grounds** classification.
No new domain term was settled, so the glossary is unchanged.
