# REA ("Reverse Engineer Anything") and llm4ts: a gap analysis

Research note compiled 2026-10-12 for `llm4ts` (plan → code → review → judge
flows over Claude, Codex, Gemini, pi and local models, via API or CLI).

Scope and sources: primary sources only. The rea repository
(https://github.com/morluto/rea) was cloned with `--depth 50` into a scratch
directory and read as untrusted data; nothing in it was built, installed or
executed. The clone's HEAD is `0043d9b134c0a353e8bf85c0bde4492275f1f720`
(2026-10-13 02:36 +0800, "fix(browser): report mismatched event family
selection as unknown in capture comparison (#2239)"). The package is
`rea-agents` 6.4.0 (`package.json:2-4`), MIT (`LICENSE:1-3`, copyright
"2026 morluto"), published to npm and the MCP registry as
`io.github.morluto/rea` (`server.json:1-12`). The README claims "110,000
GitHub stars" (`README.md:322`); the star count was not verified
independently. All 50 commits in the shallow clone are dated 2026-10-12 or
2026-10-13 (36 and 14 respectively, `git log --date=short`), and the
changelog's 6.4.0 entry is dated 2026-10-11 with roughly forty linked PRs
(`CHANGELOG.md:3-40`): the project moves at several merged PRs per hour.
Paths written `rea:<path>` are relative to the clone root; paths written
without a prefix are in this repository. Each claim about llm4ts cites a
repository path or an ADR number.

The short version: rea is not an agent orchestrator and llm4ts is not an
analysis tool, so most of each surface has no counterpart in the other. The
overlap, and the place the gaps are real, is in three zones: how a claim is
graded and carried (evidence, unknowns, fail-closed verdicts), how a tool
surface is contracted to an agent (catalog, effects, errors, doctor, setup)
and how an agent's use of that surface is evaluated. In those zones rea is
further along than llm4ts on the first two and roughly level on the third;
llm4ts owns everything about loops, roles, verification of work and cost,
which rea refuses to have by design.

## 1. What rea is

### 1.1 Purpose and target user

rea is "One MCP for reverse engineering across binaries, applications, and
runtime behavior" (`rea:README.md:7`). The user is a person running a coding
agent (Claude Code, Codex, Cursor, Gemini CLI, pi, Qwen Code, Grok Build and
others, seventeen client ids in all, `rea:docs/installation.md:207`) who asks
the agent to explain or reconstruct a feature of a shipped artifact: "See a
feature in an app that you want in your own product? Ask your agent to
investigate it with REA" (`rea:README.md:50-52`). The same workflows are a
CLI: `rea analyze-javascript-application <dir> --json` (`rea:README.md:91`).
Targets range from native binaries through Hopper, Ghidra or IDA to Electron
apps, websites over CDP, HAR captures, .NET assemblies, APKs, firmware, WASM,
EVM bytecode, SQLite files, Linux core dumps and process captures
(`rea:README.md:155-173`).

rea does not call a model. The model is the agent's; rea answers tool calls
with evidence and leaves explanation, implementation and testing to the agent
(`rea:README.md:137-140`). Its design guide is explicit that it will not grow
an orchestration layer: "Custom orchestration languages, replay engines, or
separate prepare/execute plans need an observed requirement those primitives
cannot satisfy. A plan without execution does not establish runtime behavior"
(`rea:docs/tool-design.md:42-44`).

### 1.2 Architecture and runtime model

Size: 1,250 non-test TypeScript files under `rea:src/` (about 247k lines) and
961 test files; 35 runtime dependencies (`rea:package.json`), among them
`zod`, `@modelcontextprotocol/server` and `client`, `pino`, `playwright-core`,
`canonicalize`, `jsonc-parser`, `smol-toml`, `yaml`. Plain promise-based
TypeScript; no effect system.

Layers, from `rea:docs/architecture.mermaid:1-70` and `rea:AGENTS.md`
("Dependencies flow inward: domain semantics and contracts, provider
adapters, shared application workflows, then CLI/MCP adapters"):

| Layer              | Where                                                         | Role                                                                                                                    |
| ------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Domain             | `rea:src/domain/`                                             | Pure, side-effect-free: Evidence, residual unknowns, comparisons, application graphs, the error base                    |
| Contracts          | `rea:src/contracts/`                                          | Caller-visible zod schemas per tool, effects audit, prompt contracts, generated catalog identity                        |
| Application        | `rea:src/application/`                                        | Shared CLI/MCP workflows, session routing, the Evidence ledger, doctor, setup, client registration                      |
| Providers          | `rea:src/{hopper,ghidra,ida,jeb,browser,dotnet,android,...}/` | Engine adapters; "no fallback" selection (`SESSION`/`REGISTRY` nodes of the mermaid)                                    |
| Process foundation | `rea:src/process/`                                            | Owned process groups, run tokens, deadlines, bounded output, cleanup                                                    |
| Composition        | `rea:src/composition/`                                        | Fresh typed factories per provider; optional adapters that fail without taking peers down (`rea:CONTRIBUTING.md:13-17`) |
| Adapters           | `rea:src/server/`, `rea:src/cli/`, `rea:src/main/`            | MCP stdio server, one-shot CLI, dispatcher `scripts/rea.mjs`                                                            |
| Bridges            | `rea:bridge/`                                                 | Python inside Hopper, Java `HeadlessScript` inside Ghidra, Swift helpers for process ownership on macOS                 |

State is a session: one MCP connection owns one `BinarySession` with "one
immutable deep binding per target" and an `EvidenceLedger`
(`rea:src/application/investigation/EvidenceLedger.ts:47-51`) that retains
every Evidence record and every residual-unknown revision for the connection.
`close_binary` clears the ledger; a fresh connection has its own; a one-shot
CLI invocation cannot see another connection's records
(`rea:docs/mcp-contracts.md:195-211`). Bundles are exported atomically for
transfer and re-imported with integrity checks.

Concurrency is per request: provider calls receive the MCP request's
cancellation signal, progress notifications are rate-bounded and never
fabricate percentages, cancellation is distinct from timeout, and partial
observations are retained as Evidence on failure
(`rea:docs/mcp-contracts.md:285-332`). Every MCP result is prepared within the
pinned stdio client's 10 MiB receive buffer; a result that cannot fit returns
`resource_constraint` with a retained-evidence reference instead of a
document-sized string (`rea:docs/mcp-contracts.md:45-56`).

### 1.3 Agent loop and orchestration

None in code. What rea ships instead is instructions:

- A skill, `reverse-engineer-anything` (version 40,
  `rea:.agents/skills/reverse-engineer-anything/SKILL.md:1-6`), installed into
  the agent's skill directory by setup. It routes the first tool from the
  target type (`SKILL.md:41-110`), tells the agent to work summary-first and
  never repeat an identical call "without a changed input or resolved blocker"
  (`SKILL.md:142-151`), and prescribes a seven-step staged investigation:
  checklist of questions, reuse of session state, smallest useful overview,
  resources beside code, corroboration by the evidence type the claim needs,
  decomposition to parallel workers "when parallel workers are available",
  and "a concise finding ledger linking each conclusion to Evidence IDs,
  confidence/evidence type, search boundary, and remaining unknowns"
  (`SKILL.md:193-221`). It ends by revisiting the checklist and refusing to
  call a broad investigation complete while required questions stay open
  (`SKILL.md:223-226`).
- Six guided MCP prompts (`investigate_feature`,
  `compare_application_versions`, `verify_reconstruction`, `trace_crash`,
  `audit_residual_unknowns`, `prepare_bounded_process_capture`,
  `rea:docs/mcp-prompts.md:9-17`), each a typed contract with an `objective`,
  typed arguments and ordered `steps` that name the tools to use
  (`rea:src/contracts/promptContracts.ts:96-155`). Prompt arguments and
  completion choices "are rendered as untrusted selection data, not
  instructions or authorization" (`rea:docs/mcp-prompts.md:22-23`).

There are no retries, roles, reviewers, judges or human approval in the
request path: "REA does not require permission grants or per-call approval
flags. Setup still prints its plan and requires confirmation before changing
configuration or installing Hopper. MCP clients control their own confirmation
UI" (`rea:docs/mcp-contracts.md:349-351`).

### 1.4 The evidence model

This is rea's center of gravity. Every successful observation is an Evidence
record (`rea:src/domain/evidence.ts:110-129`):

| Field                                  | Meaning                                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `evidence_id`                          | `ev_` plus a SHA-256 of the record without the id; a record whose id does not match its content is rejected (`evidence.ts:158-168`) |
| `subject`                              | The artifact: name, `sha256`, format enum, architecture, local path                                                                 |
| `provider`, `analysis_profile`         | Which engine produced it and under which profile; profile provider must match the record provider (`evidence.ts:131-151`)           |
| `operation`, `parameters`              | What was asked                                                                                                                      |
| `raw_result`, `normalized_result`      | The engine's own report and the provider-neutral projection                                                                         |
| `confidence`                           | `observed`, `derived` or `inferred`                                                                                                 |
| `authority`                            | `shipped-artifact`, `controlled-replay`, `historical-reference`, `external-service`, `analyst-inference` (`evidence.ts:95-101`)     |
| `environment`                          | Platform, architecture, isolation (`none`, `process`, `container`, `virtual-machine`)                                               |
| `limitations`, `relationship_coverage` | Caveats and, for caller/callee reads, `complete`/`partial`/`unknown` (`rea:docs/tool-design.md:60-64`)                              |
| `locations`, `evidence_links`          | Addresses, ranges, artifact paths; links to parent records                                                                          |

Three further structures sit on top:

- Residual unknowns (`rea:src/domain/residualUnknown.ts:59-98`): a durable
  record with a stable id hashed from question, domain and scope digest
  (`residualUnknown.ts:22-35`), a revision chain with digests, status (`open`,
  `investigating`, `blocked`, `contradicted`, `resolved`), severity, domain,
  supporting and contradicting Evidence ids, the authority, confidence and
  environment a resolution would need, recommended probes, relationships to
  other unknowns, and a resolution that is `verified` only with at least one
  Evidence id (`residualUnknown.ts:45-56`). The agent records and updates
  them through `record_unknown`/`update_unknown` with optimistic revisions
  (`rea:.agents/skills/reverse-engineer-anything/references/evidence-workflows.md:26-32`).
- Obligation ledgers: static facts "create candidate obligations; they do not
  prove runtime or process behavior. A required obligation closes only when
  one manifest binding supplies a unique owner, any required
  parser/schema/domain type, every required case fixture, and a passing
  verifier whose authority is comparable to the original observation"
  (`rea:docs/reconstruction-obligation-ledgers.md:10-18`).
- Completion ledgers with five terminal statuses, `pass`, `fail`,
  `unsupported`, `truncated`, `unknown`
  (`rea:src/domain/evidenceCompletionLedger.ts:13-19`), and the rule that
  "`fail`, `unknown`, `unsupported`, `truncated`, and `skipped` never aggregate
  to `pass`" (`rea:docs/reconstruction-readiness.md:47-49`).

The epistemic rule the whole thing serves is stated in the first paragraph of
`rea:AGENTS.md`: "Distinguish observations, derivations, inferences, and
unknowns; preserve Evidence provenance and session semantics through both
adapters", and in the tool-design guide: "Missing coverage is unknown, not
absence" (`rea:docs/tool-design.md:55`).

### 1.5 Memory and context mechanisms

No memory across sessions beyond exported bundles. Within a session the
mechanisms are about context economy rather than recall:

- `detail: "summary"` on the big producers retains the complete Evidence and
  returns a derived summary with a `parent_evidence_id`; `inspect_analysis_view`
  then projects one section, module, symbol or stable page without re-running
  the producer (`rea:docs/mcp-contracts.md:97-135`).
- `get_evidence_bundle` with `detail: "summary"` and exact filters discovers
  retained records without their payloads (`rea:docs/mcp-contracts.md:69-79`).
- A compact input-schema profile renders every advertised schema under a
  13,312-byte budget for clients such as Kimi that reject large tool schemas,
  while canonical validation stays server-side
  (`rea:docs/mcp-contracts.md:547-588`). The client-configuration guide
  measures the cost of the full catalog: 172 tools, about 496 KB or roughly
  120k tokens when Claude Code has tool search off
  (`rea:docs/client-configuration.md:30-47`).
- The performance order in `rea:AGENTS.md` ("Performance") is agent tokens and
  context first, analysis time second, CPU and memory third, with a demand
  that changes be measured on "representative completed tasks" and that
  "Fewer bytes alone do not establish fewer tokens or faster analysis".

### 1.6 Evaluation and observability

Observability is `pino` logging per tool execution
(`rea:src/server/toolLogging.ts`) and the retained Evidence itself; there is
no tracing export.

Evaluation has two deterministic layers and one live lane:

- A release gate over an agent transcript
  (`rea:src/evaluation/AgentEvaluationReport.ts:5-39`): exit code 0, natural
  tool use, correct first tool, zero repeated identical calls, zero input
  validation failures, a required tool subsequence met, input tokens above
  zero, and either a passed closed fixture claim or, when no oracle exists,
  answer heuristics plus an "epistemic cue". The metrics are extracted from
  Codex JSONL transcripts (`rea:src/evaluation/CodexAgentEval.ts:21-46`).
- Known-answer fixtures (`rea:src/evaluation/KnownAnswerEvaluation.ts:9-57`):
  the agent must end with a strict JSON manifest of claim ids, values,
  Evidence ids, authority and confidence; each claim is checked against both
  the fixture oracle and the authenticated producer result, and "an Evidence
  ID by itself is insufficient" (`rea:docs/client-verification.md`, section
  "Agent evaluation and conformance records"). Fourteen distinct failure
  kinds are named, from `value_mismatch` to `source_authority_mismatch`.
- `npm run verify:agent` runs scenarios through a real local Codex CLI in a
  disposable HOME with the skill installed through public `rea setup`; it is
  opt-in and not part of CI (`rea:docs/testing.md`, "Agent evaluation and
  conformance records").
- A repository-only readiness verifier evaluates a nine-stage conformance
  report (`discover-classify` through `export-replay`,
  `rea:docs/reconstruction-readiness.md:35-45`) and fails closed on a list of
  thirteen conditions (`:51-69`); CI runs it on Linux and keeps the report
  (`rea:.github/workflows/ci.yml:436-463`).
- `rea:experiments/analysis-efficiency/measure.mjs` drives the MCP server
  through the SDK client to measure a question's tokens and time per
  revision, delivery mode and schema profile.

### 1.7 UX

CLI and MCP share one workflow layer; the CLI's default output is TOON with
`--json` for consumers, exit 0 "may include partial evidence, warnings or
unresolved questions", exit 1 is "could not complete", `128 + N` for signals
(`rea:docs/cli.md:252-270`). `rea setup` previews a plan, requires approval,
backs up with `.rea.backup`, replaces atomically and verifies
(`rea:docs/installation.md:4,47-59`); `--dry-run --json` returns `planned`.
`rea doctor` classifies each check as `healthy`, `missing_dependency`,
`unsupported_host`, `unsupported_target`, `missing_analysis_engine` or
`config_drift` with a remediation (`rea:src/application/Doctor.ts:44-58`), and
inspects every client's registration as aligned, stale, missing or invalid
(`rea:docs/mcp-contracts.md:215-219`). `rea update` exists. A website hosts
guides and showcases.

### 1.8 Extension points

Tools are named contracts bound to handlers by name through one shared
log/execute/record/deliver path
(`rea:src/server/contractToolHandler.ts:24-45`); "catalog ordering must never
select an operation or schema" (`rea:AGENTS.md`). Providers are added through
composition factories. The catalog's identity is a digest over sorted tool and
prompt contracts and CLI command names (`rea:src/catalogIdentity.ts:11-30`),
reported by `binary_session` and the CLI's `capabilities`, and the catalog is
generated into `docs/public/product-catalog.json` by `docs:generate`
(`rea:docs/mcp-contracts.md:617-628`). There is no plugin system, and the
contribution guide draws a fail-closed scope boundary: capabilities whose
"scope fit, target or authorization boundaries, side effects, or the
verification needed to establish those boundaries remain materially
unresolved" are not merged (`rea:CONTRIBUTING.md`, "Fail-closed integration").

### 1.9 Safety, sandboxing, permissions

rea says repeatedly that it is not a sandbox: process capture "is not a
sandbox. Filesystem observation paths select what REA snapshots; they do not
restrict what the process can read or write" (`rea:docs/process-capture.md:9-13`);
the security boundary is a per-session capability token over a current-user
Unix socket, "not a sandbox and does not protect against malicious processes
already running as the same operating-system user" (`rea:SECURITY.md`,
"Security boundary"). What it does instead:

- An explicit effects audit for every public tool,
  `rea:src/contracts/toolEffects.ts:2-22`: `mutatesTarget`, `mutatesSession`,
  `writesFilesystem`, `launchesProcess`, `accessesNetwork`, `changesUiState`,
  `mayDiscardData`, `executesForeignCode`, `mutatesDevice`, `idempotent`.
  MCP `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` are
  derived from these, never hand-set (`toolEffects.ts:24-30`), and the docs
  say annotations "are hints, not authorization controls"
  (`rea:docs/mcp-contracts.md:353-363`). Closed vocabularies are "true-only":
  a known flag omitted from the array is false, which "does not make an
  omitted tool, provider, mode, or limitation false"
  (`rea:docs/mcp-contracts.md:238-241`).
- Request scope: each call names its target and lifecycle and rea "does not
  infer a broader target or action from it" (`rea:docs/mcp-contracts.md:340-347`).
- Process ownership: a process group may be signalled only with identity
  proof (run id, leader pid, group id, expected command and parent, token
  sweep; `rea:src/process/ProcessOwnership.ts:15-33`), and "REA never kills a
  process it cannot prove it owns" (`rea:docs/mcp-contracts.md:338`). Cleanup
  failure is reported as `cleanup_incomplete` listing the owned resource kinds
  that remain; resources whose cleanup failed stay owned
  (`rea:src/process/OwnedCommand.ts:20-35`).
- Redaction of explicit transport credentials only, including a token cut by
  an output budget (`rea:src/process/ProviderDiagnosticRedaction.ts:3-31`);
  "do not infer secrecy from names or text patterns" (`rea:AGENTS.md`).
- A responsible-use disclaimer and a contribution scope that excludes DRM,
  anti-cheat and access-control bypass workflows (`rea:DISCLAIMER.md:5-19`,
  `rea:CONTRIBUTING.md`, "Contribution scope").

### 1.10 Testing

Seven behavioral depths are named and located (`rea:docs/testing.md:190-200`):
module, composition, boundary, MCP boundary, acceptance, conformance,
evaluation. The preference order is "real public CLI/MCP workflows, then
production-boundary integration, then goldens captured from real producers"
(`testing.md:157-159`). Vitest projects differ in pool and isolation per
depth (`rea:vitest.config.ts:31-120`); CI runs six shards
(`rea:.github/workflows/ci.yml:112-121`) and fifteen `real-*` workflows for
engines that cannot run in the default lane (`rea:.github/workflows/`).
Selection follows the import graph (`test:local`, `test:changed`) with the
warning that "An empty changed selection means no tests were selected, not
verified correctness" (`testing.md:65-67`). Conformance fixtures are compiled
from versioned source so no binary is committed
(`rea:tests/conformance/README.md:1-12`). Static gates: `oxlint`, `oxfmt`,
`knip` with every rule at `error` (`rea:knip.json`), `jscpd` at a 3% threshold
over src and tests (`rea:.jscpd.json`), module-boundary verification, a TODO
scan, and an audited table of 115 user-visible error messages with the risk
each exposed and its replacement (`rea:docs/user-visible-errors.csv`).

### 1.11 Error contract

Expected failures extend one `AnalysisError` base with a closed list of 28
stable tags (`rea:src/domain/analysisErrorBase.ts:1-29`) carrying optional
captured output with explicit truncation, a cleanup observation and a partial
observation (`:35-57`). The public projection is a discriminated union on
`code` with `category` (ten values: `invalid_input`, `unsupported_provider`,
`unsupported_target`, `integrity_mismatch`, `truncated`, `cancelled`,
`timeout`, `resource_constraint`, `unavailable`, `execution_failure`),
`message`, `retryable`, a `remediation.action` and `details`, published as
JSON Schema (`rea:docs/error-contract.schema.json`). Tool failures carry that
diagnostic as text with `isError: true` and omit `structuredContent`
(`rea:docs/mcp-contracts.md:24-31`).

### 1.12 Prompt-engineering techniques worth naming

1. The observation/inference/unknown triad as a reporting contract, repeated
   in the skill, every prompt and the final-answer manifest.
2. Progressive disclosure: the skill says "Read only the relevant guide" and
   links five references (`SKILL.md:228-239`); the prompts are "optional
   starting points" (`rea:docs/mcp-prompts.md:18-21`).
3. Route-first dispatch tables keyed by target type, not by tool name.
4. Negative-evidence discipline: "An empty call list with partial or unknown
   coverage is not proof that the function has no calls"
   (`rea:docs/mcp-contracts.md:38-43`); an empty completion list "does not
   establish that the target has no procedures" (`rea:docs/mcp-prompts.md:97-98`).
5. Anti-repetition: "Do not repeat an identical analysis or rejected call
   without a changed input or resolved blocker" (`SKILL.md:150-151`), scored
   as `repeatedCallCount === 0` in the gate.
6. Client-truncation awareness: a truncated successful result is "incomplete";
   use the retained parent id, "do not parse the preview as canonical JSON or
   repeat the producer" (`SKILL.md:174-178`).
7. "Never choose an example app on the user's behalf" (`SKILL.md:124-128`),
   enforced by the `missing-target` scenario whose `expectedFirstTool` is
   `null`.

## 2. Where llm4ts stands on the same dimensions

Size: 212 non-test source files under `packages/*/src` (about 58k lines) and
149 test files; Effect 4 throughout; 24 built-in flows (`flows/README.md`);
four kits (`kits/README.md`); five shipped skills (`skills/*/SKILL.md`);
37 ADRs. Velocity over the last two weeks runs 10 to 60 commits a day
(`git log --date=short`), with one maintainer.

| Dimension               | llm4ts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture            | `core → flow → runner → js/shell` (`docs/architecture.md:1-33`); Effect services and layers; `Schema.TaggedError` for expected failures (ADR 0001); 10 core and 30 flow error tags (`packages/core/src/Errors.ts`, `packages/flow/src/FlowError.ts`)                                                                                                                                                                                                                                                                  |
| Driving models and CLIs | `makeApiConnector`/`makeCliConnector` with `versionProbe` (`packages/core/src/Connector.ts:96,140,184`); identity table in `Models.ts`; 20 provider modules; capability matrix (`docs/provider-capabilities.md`)                                                                                                                                                                                                                                                                                                      |
| Loop and roles          | `implementPlanFlow` (`packages/flow/src/Flow.ts`); story executor with worktrees and a declared DAG (ADR 0013, `Stories.ts:1-6`); roster of executors by role with slots and clones (ADR 0019, 0033, `Roster.ts:1-6`); parallel tasks (ADR 0034); work queue (ADR 0028, `WorkQueue.ts:1-5`); retro behind approval (ADR 0023, `Retro.ts:1-11`); landing (`Landing.ts:1-6`)                                                                                                                                            |
| Review and judge        | Eight lenses incl. adversarial, screened by typed judgments (`Review.ts:157-230`, `Reviewer.ts:8-12`); `Judgment` service with probabilities and origin (ADR 0017, `packages/core/src/judgment/Judgment.ts:15-21`); policy bands by calibration and extraction method (`packages/flow/src/Judgment.ts:34-80`); rubric story judge (`flows/lib/epic-stories.ts:1469-1534`)                                                                                                                                             |
| Verification of work    | Gates with a baseline and `new`/`base`/`flaky` triage (ADR 0027, `GateTriage.ts:1-25`); oracle guard against deleted or skipped tests (`OracleGuard.ts:1-5`); perimeter (`Perimeter.ts:1-3`); `fabricated status` when a claimed command never ran (`Evidence.ts:1-45`, wired at `Stories.ts:1300-1317`); autonomy contract (`AutonomyContract.ts:1-45`); stall detection (`Stall.ts:1-3`); Node preflight (`NodePreflight.ts:1-13`)                                                                                  |
| Evidence and provenance | `Provenance` manifests with hashed specs, gate verdicts and recorded context truncations (`Provenance.ts:6-26`); `SurveyGraph` edges with `origin` (`scanner`, `llm`, `external`) and `confidence` (`exact`, `inferred`) (ADR 0030, `Survey.ts:17-27`); equivalence tiers `generated`/`captured` (`Equiv.ts:16-17`); `OpenPoint` questions in refine decisions (`Decisions.ts:61-100`); findings trailer with `verified:` and `confidence:` lines (`CarriedNotes.ts:12-23`)                                           |
| Memory and context      | Char-budgeted context with visible truncation (`Context.ts:8-11`); orientation digest, `readFirst` anchors, carried findings (ADR 0025, `Orientation.ts:1-5`); typed blackboard (ADR 0020); review cache by fingerprint (`ReviewCache.ts:8-16`); memory store design (ADR 0007)                                                                                                                                                                                                                                       |
| Observability           | OTLP traces and metrics with GenAI and OpenInference attributes (ADR 0026, `Spans.ts:1-5`, `docs/observability.md`); trace file and replay (`Replay.ts`); transcripts, redacted and capped (`Transcript.ts:12-18`); `llm4ts profile` with explore-before-edit, review rounds, gate origins, fabricated claims (`packages/runner/src/Profile.ts:17-24,1077`); cost ledger and budgets                                                                                                                                  |
| Evaluation              | Harness-evals protocol: same epic, same roster, before and after, `profile --against` (`docs/harness-evals/README.md`); judgment datasets and decision map (`docs/judgment-datasets.md`, `docs/judgment-decision-map.md`); `judge-suite` flow; the harness-evals ledger "is empty until the first release in the line runs it"                                                                                                                                                                                        |
| UX                      | `llm4ts run/list/kits/view/ask/refine/costs/watch/profile/roster/graph/gemini-bridge/doctor` (`packages/shell/src/Cli.ts:218-991`); agent tree and list-first dashboard (ADR 0022, 0033); doctor prints connectors, credentials, gates, prerequisites, OTLP (`packages/runner/src/Doctor.ts:18-45`, no flags at `Cli.ts:984-989`)                                                                                                                                                                                     |
| Extension points        | Flows as scripts in three tiers; kits and packs with declarative sections `Gates`, `Oracle`, `Review rules`, `Diagnostics`, `Ledger`, `Node`/`Edge`/`Join`/`Probe` (`Pack.ts:280-449`, ADR 0014, 0030); roster files; `McpServer.ts` with `ask_user` and `approve` tools (`McpServer.ts:48-93`); specs queue (`specs/README.md`)                                                                                                                                                                                      |
| Safety and permissions  | Capability grants audited before process and forge operations (`packages/core/src/Capability.ts:5-19`, `CapabilityGuard.ts`, `Classified.ts`); read-only as an allowlist, graded `enforced`/`advisory`/`ignored` (ADR 0010); `CoderPolicy` lists what it cannot enforce (`packages/runner/src/CoderPolicy.ts:7-10`); isolated headless (ADR 0029); delegation knob (ADR 0035); secrets `Redacted`, never in argv; `NodeProcessExecutor` ends a child with `SIGKILL` on the child pid (`NodeProcessExecutor.ts:95-98`) |
| Testing                 | Deterministic `@effect/vitest` with in-src fakes, no network or CLIs in CI (`CLAUDE.md`); `pnpm typecheck && lint && format:check && test`; pack smoke for consumers; live flows excluded from the suite (`flows/README.md`)                                                                                                                                                                                                                                                                                          |

## 3. Dimension-by-dimension comparison

Verdict codes: (a) llm4ts already has it; (b) llm4ts has a weaker or
different version; (c) llm4ts lacks it and should adopt; (d) llm4ts lacks it
and should not adopt.

### 3.1 Claims, evidence and unknowns

| Mechanism in rea                                                                                                                                      | llm4ts today                                                                                                                                                                                                                                                                          | Verdict and reasoning                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confidence` (`observed`/`derived`/`inferred`) and `authority` on every record (`rea:src/domain/evidence.ts:95-129`)                                  | Only the code graph grades edges (`origin`, `confidence: exact/inferred`, `Survey.ts:17-27`). `ReviewIssue` has severity only; judge findings and `Findings` trailers carry a self-reported `confidence: high/medium/low` (`CarriedNotes.ts:24`) that nothing checks against evidence | (b). llm4ts grades the diff's claims one way (did the command run, `Evidence.ts`) and the model's self-assessment another; it has no vocabulary for how a reviewer or judge finding was established (read the diff, ran a gate, inferred from a name). rea's two axes are cheap to add to `ReviewIssue` and `JudgmentObserved` and would make `profile` and retro able to separate observed red gates from inferred review opinions |
| Content-addressed `evidence_id` with authenticated records (`evidence.ts:158-168`)                                                                    | `fingerprintOf` for review and graph caches (`ReviewCache.ts:8-16`); `Provenance.hashFiles`                                                                                                                                                                                           | (a) for the caching use; (d) as a public identity scheme. llm4ts's artifacts are files in a git repository, which already gives them identity and history                                                                                                                                                                                                                                                                           |
| Residual-unknowns registry with stable ids, revisions, severity, required authority, probes and evidence-only resolution (`residualUnknown.ts:59-98`) | Scattered: `BLOCKED_ON:` sentinel (ADR 0013), `OpenPoint` in refine decisions (`Decisions.ts:61-100`), deferred findings file per story (ADR 0031, `Stories.ts:795`), `confidence: low` lines in trailers, judge Warnings                                                             | (c). Each llm4ts flow has a private way of parking what it could not settle, none is linked to the evidence that would close it, and none survives into the next run except by being re-read as prose. A typed, epic-scoped unknowns ledger that `profile`, `watch`, `epic-retro` and the next planner read is the single biggest idea to take from rea                                                                             |
| "Never aggregate to pass": `fail`/`unknown`/`unsupported`/`truncated`/`skipped` stay visible (`rea:docs/reconstruction-readiness.md:47-49`)           | Gates: a red gate never settles early (ADR 0031); oracle guard. Judge: a dimension below the bar fails. Truncation: `Provenance.contextTruncations` records it but a verdict rendered on a truncated spec still counts as a verdict (`Provenance.ts:17-21`)                           | (b). The truncation case is the hole: a judge that saw three quarters of a spec pack can clear a program. rea would call that `truncated`, not `pass`. The fix is a status enum on `ProgramJudge` and `modernize-verify` verdicts, not a new module                                                                                                                                                                                 |
| Obligation ledger: a required claim closes only with a verifier of comparable authority (`rea:docs/reconstruction-obligation-ledgers.md:10-18`)       | Coverage rules and `CoverageLedger`; equivalence tiers `generated` and `captured` (`Equiv.ts:16-17`); ADR 0012 forbids clean-room equivalence for the bank conversion                                                                                                                 | (b). llm4ts has the two tiers but no rule that says which tier a coverage unit requires. A `required_verifier_authority` per `## Coverage:` rule would let a pack declare that a payment rule needs a captured vector, not a generated one                                                                                                                                                                                          |
| Negative-evidence discipline: empty call list with partial coverage is not "no calls" (`rea:docs/mcp-contracts.md:38-43`)                             | `graph probe` reports unconnected flows; `unresolved` edges and `fills` exist on `SurveyGraph` (ADR 0030)                                                                                                                                                                             | (a) in the graph; (b) in prompts, where "no issues found" from a lens is treated as clean. The adversarial lens (ADR 0027) is the counterweight, not a coverage statement                                                                                                                                                                                                                                                           |

### 3.2 The agent-facing contract

| Mechanism in rea                                                                                                                                                                                            | llm4ts today                                                                                                                                                                                                                                                                                      | Verdict and reasoning                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 187 tools with input and output schemas, effects, derived annotations, availability groups with reasons and remediation (`rea:src/contracts/toolEffects.ts`, `rea:docs/mcp-contracts.md:221-245`)           | `McpServer.ts` answers `initialize`, `tools/list` (name, description, inputSchema only) and `tools/call`; two tools, `ask_user` and `approve` (`McpServer.ts:48-116`); the ACP bridge maps Anthropic tool definitions through the same type (`NodeGeminiAcpBridge.ts:123`)                        | (b), and mostly by design. llm4ts is the client of MCP-speaking harnesses far more than a server. Where it is a server (the bridge, `ask_user`, `approve`) the lack of `outputSchema`, annotations and effects is a real gap only if the tool list grows. Adopt the effects vocabulary on `core/tools/Tool` (see 3.3), derive annotations in `toolsListResult`, and stop there |
| Guided prompts with typed arguments and session-aware completion (`rea:docs/mcp-prompts.md`)                                                                                                                | Prompts are flow code; the five skills in `skills/` are the human-and-agent-facing instructions                                                                                                                                                                                                   | (d). llm4ts's prompts are consumed by seats it controls, not by a foreign agent choosing among them                                                                                                                                                                                                                                                                            |
| A skill shipped with the server and installed by setup, versioned (`SKILL.md:4-5`), with "read only the relevant guide" references                                                                          | `skills/using-llm4ts`, `authoring-llm4ts-flows`, `authoring-llm4ts-packs`, `using-pack-fork`, `configuring-soap-flows` (checked in; not versioned in frontmatter; installed by hand)                                                                                                              | (b). The content is comparable; the delivery is not. rea's doctor reports a stale skill (`rea:src/application/Doctor.ts:24-26`, `readInstalledSkillIdentity`). A `skillVersion` in frontmatter and a doctor line is small; an installer is not worth it until the skills change faster than the package                                                                        |
| Setup as a reviewed transaction: plan, approve, backup, atomic replace, verify, idempotent; never touches unrelated software (`rea:docs/installation.md:47-59`, `rea:AGENTS.md`)                            | llm4ts writes no harness configuration: `PiModels.ts:19` (its comment says it is read only and that llm4ts never writes it); `gemini-bridge` prints the `models.json` entry (`GeminiBridgeServe.ts:103`); the Gemini CLI seat uses an isolated settings file it owns (`GeminiCliProvider.ts:235`) | (a) in posture, (d) as a feature. Not writing is the stricter rule and matches CLAUDE.md. If a future verb ever does write a user file, rea's transaction shape is the template                                                                                                                                                                                                |
| Doctor with a classification per check, remediation, scoped readiness, exit 1 on required failures, `--json` (`rea:src/application/Doctor.ts:44-58`, `rea:docs/cli.md:268-270`)                             | `llm4ts doctor` prints a report (connectors, credentials, gates, prerequisites, OTLP) with marks and hints (`Doctor.ts:27-87`); no flags, no exit semantics, no JSON (`Cli.ts:984-989`)                                                                                                           | (c). Small and useful: a `DoctorCheck` schema with `classification` and `remediation`, `--json`, and exit 1 when a check the selected flow needs fails. It also gives the harness-evals protocol and CI something to assert on                                                                                                                                                 |
| Public error projection: `code`, `category`, `retryable`, `remediation.action`, published schema; audited user-visible messages (`rea:docs/error-contract.schema.json`, `rea:docs/user-visible-errors.csv`) | Tagged errors with stable messages (ADR 0001); `describeFlowError` for display; no category, retryable flag or remediation field; secrets kept out by rule                                                                                                                                        | (b). llm4ts's errors are typed for code, not for operators. A projection with `category` and `retryable` is the part worth taking: `RosterExhausted` and `UsageLimitError` are retryable, `PerimeterViolation` is not, and today only the reader of the source knows. The message audit is good hygiene but a separate, later exercise                                         |
| Catalog identity digest and version-pinned registration (`rea:src/catalogIdentity.ts`, `rea:src/identity.ts:6-19`)                                                                                          | Package versions in lockstep (`pnpm version:set`); pack `Provenance.llm4tsVersion`; `modernize-pack-upgrade` checks a pack against current rules                                                                                                                                                  | (a) for the problem llm4ts has (artifacts drifting from the engine); (d) for a catalog digest                                                                                                                                                                                                                                                                                  |
| Transport budget and summary-first delivery (`rea:docs/mcp-contracts.md:45-56,97-135`)                                                                                                                      | Character budgets with head/tail cap and visible truncation (`Context.ts:8-11`); story context and orientation budgets (ADR 0025); `llm4ts graph query/path/closure` (`Cli.ts:867-896`) as the selected-view primitive                                                                            | (b). Same idea at a different seam: llm4ts caps what it pushes into a prompt; rea lets the agent pull a view. The gap is that llm4ts's coders cannot pull: the graph verbs are shell commands, not a tool a coder seat can call. Whether to expose them through MCP to a seat was left out of ADR 0030 and stays a later question                                              |
| Compact input-schema profile for size-capped clients (`rea:docs/mcp-contracts.md:547-588`)                                                                                                                  | Not applicable                                                                                                                                                                                                                                                                                    | (d). llm4ts advertises two tools                                                                                                                                                                                                                                                                                                                                               |

### 3.3 Process, effects and safety

| Mechanism in rea                                                                                                                                  | llm4ts today                                                                                                                                                                                                                                                                            | Verdict and reasoning                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effects audit per tool, annotations derived from it, closed true-only vocabularies (`rea:src/contracts/toolEffects.ts:2-30`)                      | `ToolDescriptor` has `sandbox` (`WorkspaceReadWrite`/`WorkspaceReadOnly`/`Unrestricted`) and `requires: Capability[]` (`packages/core/src/tools/Tool.ts:65-96`); `Activity.ts` classifies harness tool calls after the fact into categories (`explore`, `edit`, `test`, `git`, `build`) | (c), small. `requires` says what a tool needs; nothing says what it does. An `effects` record with defaults on `ToolDescriptor` lets `toolsListResult` derive MCP hints, lets `CoderPolicy` reason about a tool's writes and network use, and gives `Activity` a declared source instead of a name-based guess for llm4ts's own tools. Additive with defaults, so parity needs a note, not an ADR                                               |
| Process ownership proof before any signal; cleanup failure keeps ownership (`rea:src/process/ProcessOwnership.ts:15-33`, `OwnedCommand.ts:20-35`) | `NodeProcessExecutor` kills the child pid with `SIGKILL` (`NodeProcessExecutor.ts:95-98`); scoped consumers finalize on interruption (`docs/architecture.md:67-72`); isolated headless mode per harness (ADR 0029)                                                                      | (b), with a real but narrow risk. A coding CLI spawns its own children (`pnpm test`, a dev server); killing the CLI's pid can orphan them, and a story that is cancelled mid-gate may leave a `vitest` running in a worktree the next story reuses. The fix is a process group (`detached` plus negative-pid signal) and a report of what remained, not rea's token sweep. Worth a spec; no ADR because llm4zio's executor made the same choice |
| Request scope declared per call; no broadening (`rea:docs/mcp-contracts.md:340-347`)                                                              | Perimeter on the diff (ADR 0013); `Owns:` per task (ADR 0034); `readOnly` allowlists (ADR 0010)                                                                                                                                                                                         | (a). llm4ts enforces scope on the outcome because it cannot enforce it on a harness's calls; rea enforces it on the call because it owns the tool                                                                                                                                                                                                                                                                                               |
| "Not a sandbox" stated wherever a reader could assume one (`rea:docs/process-capture.md:9-13`, `rea:SECURITY.md`)                                 | `readOnlyEnforcement` grades and `CoderPolicy.unenforceable` say the same thing in code (ADR 0010, `CoderPolicy.ts:7-10`)                                                                                                                                                               | (a). Both projects chose honesty over theater; llm4ts says it with types, rea with prose                                                                                                                                                                                                                                                                                                                                                        |
| Redact only explicit credentials; never infer secrecy from names (`rea:AGENTS.md`)                                                                | `Redaction.ts` redacts by key-name regex and Bearer/`sk-`-style patterns (`packages/core/src/observability/Redaction.ts:8-12`) plus known secrets                                                                                                                                       | (d). The opposite choices for opposite reasons: rea preserves analyst evidence; llm4ts ships transcripts and OTLP content off the machine (`--otel-content on`) and must over-redact. Keep llm4ts's rule                                                                                                                                                                                                                                        |
| Fail-closed integration scope for capabilities with execution or mutation authority (`rea:CONTRIBUTING.md`)                                       | ADR process; CLAUDE.md's "deep modules over parallel code"; capability grants                                                                                                                                                                                                           | (a) in spirit. The llm4ts equivalent of "do not merge while authority is unresolved" is the `readOnlyEnforcement` requirement that upgrading a connector to `enforced` needs evidence (ADR 0010)                                                                                                                                                                                                                                                |

### 3.4 Testing and CI

| Mechanism in rea                                                                                                                     | llm4ts today                                                                                                                                        | Verdict and reasoning                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Named behavioral depths with a location each (`rea:docs/testing.md:190-200`) and a "which check for which change" table (`:146-153`) | Tests live beside modules; `kits/test/packs.test.ts` states what flows require of a pack; `docs/parity.md` maps reference tests to llm4ts tests     | (b). llm4ts has the mapping to the reference, not a map from a kind of change to the check that proves it. One table in CLAUDE.md or `docs/parity.md` would do; it is documentation, not code                                                                                                                                                |
| Real-toolchain lanes as separate opt-in workflows; "simulated providers do not establish real-provider behavior" (`rea:AGENTS.md`)   | Live flows excluded from the suite; `vitest it.live` for SOAP (memory note); harness-evals protocol needs credentials and "Nothing here runs in CI" | (a). Same split. rea has fifteen such lanes in GitHub Actions on self-hosted runners; llm4ts has none automated, which is a resourcing fact, not a design gap                                                                                                                                                                                |
| Import-graph test selection and six CI shards (`rea:docs/testing.md:13-27`, `ci.yml:112-121`)                                        | `pnpm test` runs everything                                                                                                                         | (d) for now. 149 files run in minutes; rea has 961 and needs it. Revisit past roughly 500 test files                                                                                                                                                                                                                                         |
| `knip` at `error` for every rule, `jscpd` 3%, TODO scan, module-boundary verifier, user-visible-error audit                          | `pnpm lint` and `format:check`; CLAUDE.md forbids parallel one-off code by rule rather than by a duplication gate                                   | (c), small and mechanical: a `jscpd` gate is the one tool that makes "deep modules over parallel code" checkable, and the `vitest` or `tsc` project boundary check already exists as "no package imports another's `src`" (`docs/architecture.md:10-11`). `knip` would catch dead exports after the ADR 0026 deprecations. None needs an ADR |
| Conformance fixtures compiled from versioned source, never a committed binary (`rea:tests/conformance/README.md:1-12`)               | `flows/fixtures`, `kits/*/fixtures`, `examples/seed.sh epic` (light fixture, `docs/harness-evals/README.md`)                                        | (a)                                                                                                                                                                                                                                                                                                                                          |

### 3.5 Evaluation of agent behavior

| Mechanism in rea                                                                                                                                                                                                     | llm4ts today                                                                                                                                                                                                                                                                                | Verdict and reasoning                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A deterministic gate function over a transcript: first tool, repeated calls, validation failures, required subsequence, epistemic cue, closed-claim correctness (`rea:src/evaluation/AgentEvaluationReport.ts:5-39`) | `llm4ts profile` folds the trace into explore-before-edit, review rounds, gate origins, fabricated claims, inherited failures, cost (`Profile.ts:17-24`); `--against` prints a delta (ADR 0029); `Stall.ts` ends a turn on five identical tool calls but nobody counts how often that fires | (b). The measurements overlap by about half. What rea has and llm4ts does not: a single boolean `passed` over named thresholds, so a before/after can be red or green without a human reading two tables. What llm4ts has and rea does not: cost, wall time by role, gate triage. Add a `pass` predicate to the harness-evals protocol over the existing profile facts plus a repeated-call count read from the trace; no new seam |
| Known-answer fixtures with claim manifests checked against both oracle and producer (`rea:src/evaluation/KnownAnswerEvaluation.ts:9-57`)                                                                             | The light fixture plants three faults and a table of what a correct run shows (`docs/harness-evals/README.md`, "What the fixture plants"); checking is by eye                                                                                                                               | (c). The planted table is already a claim manifest in prose. Encode it as JSON beside the fixture (`inherited: ["src/platform/clock.test.ts"]`, `oracleMarkersRemoved: 1`, `storiesMerged: 4`) and let `profile --against` or a small `harness-check` read it; the fixture then grades itself                                                                                                                                      |
| Transcript metrics extracted from the agent client's own JSONL (`rea:src/evaluation/CodexAgentEval.ts:116-141`)                                                                                                      | llm4ts owns the stream: every CLI connector emits `tool_use` chunks (`CliSupport.ts:78`), recorded in the trace and transcripts                                                                                                                                                             | (a), and stronger: llm4ts does not depend on a client's log format                                                                                                                                                                                                                                                                                                                                                                 |
| Measurement protocol in AGENTS.md: cold vs warm, tokens, elapsed, CPU, peak process-family memory, "state unmeasured costs"                                                                                          | Harness-evals ledger: profile before and after, CHANGELOG names the model a prompt was tuned on                                                                                                                                                                                             | (a) for tokens and time; (b) for process-family memory, which nothing in llm4ts measures. Not a priority                                                                                                                                                                                                                                                                                                                           |

### 3.6 Orchestration (what rea has nothing of)

| Mechanism in llm4ts                                                                                                                                                | In rea                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| A persisted, resumable plan loop with per-task review and fix (`Flow.ts`), stories in worktrees over a declared DAG (ADR 0013), parallel tasks (ADR 0034), landing | Refused by design (`rea:docs/tool-design.md:42-44`); the skill delegates decomposition to "parallel workers" of the agent |
| Roles with independent executors, slots, clones, exclusion on infrastructure signals only (ADR 0019, 0033, `Roster.ts:1-6`)                                        | One agent; rea neither knows nor cares which model calls it                                                               |
| Typed judgments with probabilities, origin and calibration bands, review pre-screen, local scorer route (ADR 0017, 0036)                                           | No model calls; the "epistemic cue" heuristic in the eval gate is a keyword check (`CodexAgentEval.ts:41`)                |
| Gates with memory and triage, oracle guard, perimeter, fabricated-status, autonomy contract, stall (ADR 0027)                                                      | Nothing to gate; its verifiers run against artifacts, not against an agent's work                                         |
| Retro: a red run digested by code, proposed fixes behind approval (ADR 0023)                                                                                       | None                                                                                                                      |
| Cost: ledger, budgets, estimated usage, price list, `llm4ts costs`                                                                                                 | Token counts in the eval gate only                                                                                        |
| OTLP export with GenAI attributes (ADR 0026)                                                                                                                       | `pino` logs                                                                                                               |
| Kits and packs: declarative stack knowledge the engine consumes (ADR 0014, 0030), refine overlays (ADR 0015), pack fork (ADR 0018)                                 | Provider adapters in code; no user-authored knowledge layer                                                               |
| Work queue with ledger and `Stalled` (ADR 0028); port flows with pilot, votes, fixer                                                                               | None                                                                                                                      |
| A code graph with sub-file nodes, declarative joins and probes, cached by hash (ADR 0030)                                                                          | Application graphs for JavaScript and managed code, far deeper for its domain, engine-produced rather than pack-declared  |
| Human gates as markdown approval markers (`Approval.ts`), `ask_user`/`approve` over MCP                                                                            | Approval only at setup                                                                                                    |

Honesty check on this table: several of these llm4ts mechanisms are shipped
but unproven live. The harness-evals ledger is empty
(`docs/harness-evals/README.md`, last line), ADR 0027 and 0028's live pilots
"remain to run" (`docs/research/rewrite-grade-loops-plan.md:1-9`), and the
judgment evaluation baseline is `next`, not `done`
(`docs/judgment-decision-map.md`, Phase 1). rea's equivalent mechanisms are
exercised by its readiness verifier in CI on every relevant change. The
asymmetry is not in design but in the amount of closed-loop evidence each
project has about its own mechanisms.

## 4. What rea could take from llm4ts

Brief, because it is not this note's question, but the reverse gaps are
real and say something about where each project's strength lies:

- Cost and wall-time attribution per operation and per provider: rea measures
  tokens in an experiment script, llm4ts meters every seat call and exports it.
- Typed judgments: rea's `audit_residual_unknowns` prompt asks the agent to
  judge whether an unknown is resolved; a `Judgment`-style question with a
  probability would make that machine-checkable.
- Replay: rea's `export-replay` stage proves deterministic replay of its own
  verifier; llm4ts's `Replay.ts` replays model calls from a trace, which rea
  has no equivalent for because it makes no model calls.
- OTLP export: rea's per-call `pino` lines would map directly onto TOOL spans.

## 5. Real gaps in llm4ts, stated plainly

1. Nothing durable holds what a run could not settle. Blocked stories,
   deferred findings, low-confidence trailers and open points are four
   formats in four places (section 3.1).
2. A finding's grounds are invisible. A reviewer's opinion and a red gate
   both arrive as `ReviewIssue` with a severity; a judge verdict rendered on
   a truncated spec counts the same as one rendered on the whole.
3. `llm4ts doctor` is a printout. Nothing can assert on it, and it does not
   say whether the flow about to run will work.
4. Errors are typed for code, not for operators: no `retryable`, no
   `remediation`, no category.
5. `NodeProcessExecutor` can orphan a harness's children on cancellation.
6. The harness-evals protocol has no pass predicate and no machine-readable
   expectation for the light fixture, so it has not been run.
7. The duplication rule in CLAUDE.md has no gate.
8. llm4ts's own tools declare needs (`requires`) but not effects.

## 6. Prioritized adoption list

Every item is an idea to distill; none is a dependency. rea's domain (binary
analysis), schema library (`zod` against this repository's Effect `Schema`)
and size make a code dependency out of the question, which is the posture
ADR 0007 and ADR 0030 already took with gbrain and codegraph. The one
integration worth a sentence is operational, not code: a coder seat whose
story targets a shipped artifact can be given rea as an MCP server through
the harness's own configuration (`claude --mcp-config`, pi's `mcp.json`);
llm4ts need not know.

| #   | What                                                                                                                                                                                                                                                                                                                                                                                                                           | Why (llm4ts weakness or user pain)                                                                                                                                                                | Where it lands                                                                                                                                                                                                                                 | Size | Risk                                                                                                                 | ADR?                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | An epic-scoped unknowns ledger: `.llm4ts/epics/<id>/unknowns.jsonl`, one record per unresolved question with a stable id hashed from question, story and scope, status (`open`, `blocked`, `contradicted`, `resolved`), severity, the evidence it would take to close it (a gate, a captured vector, a human answer), links to the finding, verdict or `BLOCKED_ON` that raised it, and a resolution that cites a run artifact | Section 5, item 1. `epic-retro` digests prose to rediscover what the run already knew; the next planner starts without the previous run's open questions; `watch` cannot show "what is unsettled" | flow: a new `Unknowns.ts` beside `Decisions.ts`, written from `Stories.ts` (blocked, deferred findings), `CarriedNotes.ts` (`confidence: low`) and the judge; read by `Retro.ts`, `Profile.ts`, `Watch.ts` and the epic-stories planner prompt | M    | Scope creep into a general issue tracker; keep it append-only and run-scoped, never a board                          | Yes: a new persisted artifact and a change to what the planner sees                                                                                        |
| 2   | Grounds on findings: `confidence: observed / derived / inferred` and `source` (`gate`, `diff`, `transcript`, `model`) on `ReviewIssue` and on the judge's `JudgmentObserved`; gate and oracle issues are `observed`, fabricated-status is `derived`, a lens finding without a `file:line` is `inferred`                                                                                                                        | Section 5, item 2. Lets `profile`, retro and the fix prompt weigh a red gate above a reviewer's hunch, and makes ADR 0027's "findings should cite file:line" checkable                            | flow: `Review.ts` (`ReviewIssue`), `GateTriage.ts`, `OracleGuard.ts`, `Evidence.ts`, `ProgramJudge.ts`; `FlowEvents.ts` for the judge event                                                                                                    | S/M  | Prompt changes for the lenses so they state grounds; a tuned-on model line in the CHANGELOG per `docs/harness-evals` | Parity note: additive fields with defaults on a type llm4zio also has                                                                                      |
| 3   | Verdict statuses that never aggregate to pass: `pass`, `fail`, `truncated`, `unsupported`, `unknown` on `ProgramJudge` and `modernize-verify` results, with `truncated` forced whenever the judged context was capped (`Provenance.contextTruncations` non-empty) and `unsupported` when a coverage rule's required tier (`captured`) has no vector                                                                            | Section 3.1, rows 4 and 5: a judge that saw part of a spec can clear a program today; a generated vector can satisfy a rule that needed a captured one                                            | flow: `ProgramJudge.ts`, `Equiv.ts`/`EquivReport.ts`, `Pack.ts` (`required: captured` on `## Coverage:`), `Provenance.ts`                                                                                                                      | M    | Existing approved packs may turn from green to `truncated`; ship behind the pack field and a report line first       | Yes: verdict semantics of modernize-verify change                                                                                                          |
| 4   | `llm4ts doctor` as a typed report: a `DoctorCheck` schema with `name`, `ok`, `classification` (`healthy`, `missing_credential`, `missing_cli`, `cli_too_old`, `node_mismatch`, `otlp_unreachable`, `roster_invalid`), `remediation`; `--json`; `--flow <name>` scopes to that flow's needs; exit 1 when a required check fails                                                                                                 | Section 5, item 3; the first red story in a customer run is often a doctor finding nobody asserted on                                                                                             | runner: `Doctor.ts` (keep `makeDoctorProgram`, add the record); shell: `Cli.ts` flags                                                                                                                                                          | S/M  | None beyond the output change; keep the text format                                                                  | No                                                                                                                                                         |
| 5   | A pass predicate and a claim manifest for harness evals: `examples/epic-light.expect.json` with the planted facts (inherited failures listed once, oracle markers removed, stories merged, zero fabricated claims), and `llm4ts profile --check <expect.json>` printing pass/fail per claim over the facts `Profile.ts` already folds, plus a repeated-identical-call count read from the trace                                | Section 5, item 6: the ledger is empty because reading two profile tables is work; rea's `agentEvaluationPassed` shows a single predicate is what makes a lane run                                | runner: `Profile.ts`; `docs/harness-evals/README.md`; `examples/`                                                                                                                                                                              | M    | Over-fitting the predicate to the light fixture; keep the claims to what the fixture plants                          | No                                                                                                                                                         |
| 6   | Effects on llm4ts's own tools: `effects: { writesWorkspace, launchesProcess, accessesNetwork, mayDiscardData, idempotent }` with defaults on `ToolDescriptor`, MCP `readOnlyHint`/`destructiveHint` derived in `toolsListResult`, and `Activity.toolCategory` consulting declared effects before falling back to names                                                                                                         | Section 5, item 8; the bridge advertises tools with no hints, and `CoderPolicy` cannot reason about what a workspace tool does                                                                    | core: `tools/Tool.ts`; flow: `McpServer.ts`, `Activity.ts`                                                                                                                                                                                     | S    | None                                                                                                                 | Parity note                                                                                                                                                |
| 7   | Public error projection: `category` and `retryable` on `describeFlowError` and the core `LlmError` union (a pure function over the tag, not new fields), with a `remediation` string for the dozen errors an operator meets (`RosterExhausted`, `UsageLimitError`, `EpicCheckoutDirty`, `MergeConflict`, `PerimeterViolation`, `ContractConflict`)                                                                             | Section 5, item 4; `watch` and the report print the tag's message and nothing about what to do                                                                                                    | core: `Errors.ts`; flow: `FlowError.ts`; runner: `Terminal.ts`                                                                                                                                                                                 | S/M  | Message drift between the projection and `message` getters; derive one from the other                                | No                                                                                                                                                         |
| 8   | Process-group termination in `NodeProcessExecutor`: spawn `detached`, signal the group on close, report what remained as an `Info` event rather than claiming a clean stop                                                                                                                                                                                                                                                     | Section 5, item 5; cancelled gates and stalled coders can leave `vitest`, dev servers or `cargo` running in a worktree the next story reuses                                                      | runner: `NodeProcessExecutor.ts`; core: `ProcessExecutor.ts` if the shape gains a `remaining` report                                                                                                                                           | S    | Windows semantics differ (`WindowsCommand.ts` exists); a harness that expects to survive its parent (none known)     | No: llm4zio's executor had the same gap, this is a fix, recorded in `docs/parity.md`                                                                       |
| 9   | Duplication and dead-export gates: `jscpd` at a threshold measured on the current tree, `knip` for unused exports and dependencies, both in `pnpm lint`                                                                                                                                                                                                                                                                        | Section 5, item 7; the ADR 0026 deprecations and the `flows/lib` growth are where parallel code accumulates unseen                                                                                | repository root scripts and CI                                                                                                                                                                                                                 | S    | A first run will list existing duplication to triage; set the threshold at the measured baseline and ratchet down    | No                                                                                                                                                         |
| 10  | Summary-first context for seats: expose `graph query/path/closure` and the orientation digest as tools a coder seat can call (through the harness's MCP configuration that `McpServer.ts` already serves for `ask_user`), so a story pulls the view it needs instead of receiving a capped paste                                                                                                                               | Section 3.2, transport row: 40k characters of pasted story context is a push model; rea's measurements say pull models cost fewer tokens per completed task                                       | runner: an MCP tool set over `Graph.ts` and `Orientation`; flow: `McpServer.ts` gains `outputSchema`; the story prompt stops pasting what the tool can answer                                                                                  | L    | Only harnesses that take an MCP config benefit (Claude, Codex, pi, Gemini); API seats keep the paste; measure first  | Yes, and only after item 5 exists to measure it, since this is exactly the kind of harness change ADR 0029's discipline says must ship with a before/after |

Suggested order: 4, 6, 9 (mechanical, a day each); then 2 and 5 together,
because 2 produces the facts 5 asserts on; then 1 and 3 as ADRs; 7 and 8 when
a live run next trips over them; 10 last and only with numbers.

## 7. What not to take, and why

- rea's MCP surface (187 tools, schema profiles, transport budgets, prompts
  with completion): llm4ts is a client of harnesses, not a server to them.
- rea's content-addressed Evidence ids and bundle export: git and the
  `.llm4ts/` state directory already give llm4ts identity, history and
  transfer.
- rea's redaction policy (explicit credentials only): llm4ts ships content
  off-machine and must over-redact (ADR 0026, `--otel-content`).
- rea's setup transaction: llm4ts writes no user configuration and should keep
  it that way (`PiModels.ts:19`).
- Import-graph test selection and shards: not at 149 test files.
- `zod`, `pino`, promise-style adapters: Effect `Schema`, OTLP and typed
  effects are the house rules (CLAUDE.md), and `docs/parity.md` pins the
  reference.
- A plugin or provider registry: ADR 0014's kits and the connector factories
  are the extension seams; a third one would be the parallel code CLAUDE.md
  forbids.
