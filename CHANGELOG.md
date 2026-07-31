# Changelog

## 0.6.0

- Modernization pack discovery no longer requires launching from a directory
  that holds `packs/`. The new `@llm4ts/runner/Packs` seam (`openPack`,
  `locatePack`, `loadUniversalPatternCards`) resolves `LLM4TS_PACK` (default
  `packs/cobol-springboot`) against the launch directory first, then against
  the flow script's own directory; an absolute `LLM4TS_PACK` is used as-is,
  and a missing pack fails with a `PackNotFound` error naming both searched
  roots instead of an opaque `pack.md` read error. All seven modernize flows
  route through the seam, and pack-relative reads (prompts, pack patterns,
  `lessons.md`, the scaffold) follow the directory the pack was actually
  found in.
- `@llm4ts/shell` now ships the modernization resources its built-in flows
  need: `sync-shell-flows` copies `packs/`, `patterns/`, and `fixtures/`
  alongside the flow scripts, and `@llm4ts/modernize` joins the shell's
  dependencies so the built-in modernize flows resolve. Together with the
  discovery fallback, `llm4ts run modernize-survey --repo <estate>` works
  from any directory.
- `llm4ts run` accepts `--repo <path>` directly and forwards it to the flow,
  matching `llm4ts ask`; previously only the `run <flow> -- --repo <path>`
  spelling reached the flow.
- `flows/README.md` documents the pnpm workspace footgun the discovery
  fallback cannot fix: `pnpm --filter @llm4ts/flows …` invoked outside the
  llm4ts checkout prints pnpm's `No projects found in "<dir>"` and exits 0
  without running anything — a message easily mistaken for the Gemini
  "No project found" credential error that `llm4ts doctor` explains.

## 0.5.0

- `@llm4ts/flow/GitHubTool` gains `createIssue` (title, body, labels;
  returns the parsed `IssueRef`), completing the work-queue surface for
  consumer-side epic decomposition — a triage agent splitting one epic
  issue into child work items. Same `gh` process protocol, `GhWrite`
  guard, and args-builder style; ADR 0008 amended accordingly.

## 0.4.0

- `@llm4ts/flow/GitHubTool` gains four work-queue operations so a GitHub
  repository can serve as an agent work queue: `listIssues` (label, state,
  and assignee filters, schema-decoded into the new `IssueSummary` via the
  new `RepoRef`), `editIssueLabels` (repeated add/remove flags; an edit
  with no labels on either side is a no-op that never spawns `gh`),
  `assignIssue`, and `closeIssue`. All four follow the existing `gh`
  process protocol and are guarded by `GhRead`/`GhWrite`. This is an
  intentional additive extension beyond the pinned llm4zio v4.2.0 `GhTool`
  surface, recorded in ADR 0008 and the parity ledger; the first consumer
  is the Nightcall work-queue orchestrator.

## 0.3.1

- `llm4ts doctor` gains a prerequisites section: environment a connector needs
  before a run starts, as opposed to whether its CLI is installed. The first
  check covers the Gemini CLI, which resolves credentials during auth setup and
  fails a Workspace or enterprise account with "No project found" when neither
  `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_PROJECT_ID`, `GEMINI_API_KEY`, nor a
  Vertex AI configuration is present — a message that names nothing about
  llm4ts. A personal OAuth login needs no environment at all, so an
  unconfigured environment is reported as a caveat rather than a failure, and
  the hint names the shell-startup trap that commonly hides the variable from
  non-interactive shells and IDE terminals. Key values are never echoed.

## 0.3.0

- Legacy modernization reaches full parity with the pinned source's example
  suite. The four target-side phases ship as flows —
  `modernize-seed` (deterministic clean-room seeding with a provenance
  manifest), `modernize-implement` (per-task implementation behind the pack's
  gates, plus a branch-level spec-compliance judge), `modernize-verify`
  (generated equivalence vectors, replay, rule coverage, failure triage into
  plan tasks), and `modernize-review` (lens review distilled into fixes,
  improvements, and pack lessons) — alongside `modernize-bench`, which
  measures an extraction run and feeds the survey's per-wave cost projection.
- New `@llm4ts/flow/Wall` enforces the clean-room boundary every target-side
  phase checks, and `@llm4ts/flow/Patterns` loads the translation pattern
  cards extraction tags and implementation injects. Both are covered by
  deterministic tests.
- `modernize-extract` closes its remaining fidelity gaps: per-program judge
  verdicts are cached and fingerprinted (`gate/<NAME>.json`), an empty judge
  response retries at half then quarter context, traceability fragments are
  tagged with the pattern cards their source matches, and a turn-limit trip
  after the artifact landed keeps the work.
- All six reference packs ship under `flows/packs/` — `cobol-springboot`,
  `cobol-kafka`, `ace-integration`, `ace-kafka`, `jsp-bff-nextjs`, and
  `jsp-nextjs` — with the four target scaffolds they seed
  (`spring-boot-service`, `kafka-streams-service`, `spring-bff`, `nextjs-spa`),
  25 universal COBOL pattern cards, and `cobol-kafka`'s pack-local
  event-streaming cards. `flows/test/pack.test.ts` validates every pack:
  manifest fields, gates, judge rubric, compilable coverage/survey regexes,
  prompt sidecars, reviewer lenses, and that each declared scaffold and replay
  script actually ships. `@llm4ts/flow/Package` now exposes `packageVersion`
  for provenance manifests.

- Every modernization phase is covered by an offline end-to-end smoke: the
  flows, runner, pack loader, gates, replay harness, and git all run for real
  with only the coding-agent binary stubbed. Three bugs surfaced and were
  fixed: `${dir}/**/*` never matched files directly under a directory, so
  `modernize-seed` silently copied zero specs and still reported success (the
  same glob was gathering spec text in `-implement` and `-review`);
  `modernize-verify` built its provenance update as a plain object, which the
  schema encoder rejected at the end of an otherwise successful run; and
  `modernize-implement` left the final task's plan update uncommitted.
- `modernize-bench` now measures tokens, not just wall-clock: structured calls
  report their usage through the event tap, and the evaluator's seat is
  wrapped so judge tokens are attributed too.
- `modernize-seed` aborts when a spec pack contributes no specs instead of
  seeding an empty target.

## 0.2.2

- New modernization flows, porting `llm4zio`'s legacy-rooted phases:
  `flows/modernize-survey.ts` (deterministic dependency graph, LLM
  graph-refine with evidence, triage, human-approved wave plan) and
  `flows/modernize-extract.ts` (per-program resumable spec extraction,
  layered SpecChecks + LLM-judge gate, bounded fix rounds, approval-gated
  spec pack). Both ship as shell built-ins; the target-side phases are
  queued in `specs/pending/modernize-flow-suite.md`, with divergences
  recorded in `docs/parity.md`.

## 0.2.1

- Republish: `@llm4ts/shell@0.2.0` reached npm with unrewritten
  `workspace:*` dependency ranges (published with `npm publish` instead of
  `pnpm publish`) and was uninstallable. 0.2.1 is identical in content
  across all packages and published via the release workflow.

## 0.2.0

- **Breaking:** the `llm4ts` bin moves from `@llm4ts/runner` to the new
  `@llm4ts/shell` package (ADR 0006). The old bin's behavior survives as
  explicit verbs: `llm4ts ask "<prompt>" [--repo <path>]` (one-shot
  streaming) and `llm4ts doctor`. `@llm4ts/runner` keeps `Cli` and `Doctor`
  as library exports.
- New `@llm4ts/shell`: three-tier flow discovery
  (`.llm4ts/flows/` > `~/.config/llm4ts/flows/` > built-ins), `run` /
  `list --json` / `view` verbs, an interactive menu with a per-run coder
  override, and child-process flow execution with project-wins module
  resolution. Try it with `npx -y @llm4ts/shell`.
- The runnable agent flows moved from `examples/` to a top-level `flows/`
  directory and now double as the shell's built-in flows; each flow's first
  line is a `//` description the shell lists. `examples/support.ts` is gone —
  flows import the published `@llm4ts/runner` subpaths directly.

## 0.1.4

- `implementPlanFlow` gains `chatPerTask`: each task can run in a fresh
  `Chat` seeded with the configured system prompt plus the plan's current
  completion state, with review-fix rounds sharing that task's chat
  (ADR 0003). `implementTaskLoop` threads the progressing plan into its
  per-task callback.
- No-change tasks are no longer inferred complete: the coder is asked to
  confirm with a literal `TASK_ALREADY_SATISFIED`, and a silent no-op fails
  the task instead of marking it done. Commit-refusal messages now carry
  the tail of the failing gate's output.
- New `docs/flow-authoring.md` — the rung-by-rung guide from one-shot
  prompts to custom spines — pinned to real sources by sync tests.
- Specs are read-only for autonomous agents (ADR 0004).

## 0.1.3

- Review-loop robustness at the structured-output boundary: decoding-side
  defaults for reviewer/judge/plan schemas (a model omitting an optional
  field no longer hard-fails the flow), one bounded reviewer retry on parse
  errors, review diffs switched to `git diffAll` so untracked new files are
  visible to reviewers, empty-diff tasks skip review and commit, and
  `implementPlanFlow` refuses to commit while a configured lint gate is
  still failing after review settles.
- Ralph-grade terminal observability: run header with seats and trace path,
  per-stage durations, `LLM4TS_TIMESTAMPS=1` line timestamps, honest cost
  summary (no empty sections; explicit note when a backend reports no token
  counts), and a closing line with total duration and stage counts.

## 0.1.2

- No library changes. Added `pnpm version:set` for lockstep version bumps,
  the Ralph autonomous-loop tooling (`ralph-auto.sh`, `RALPH_AUTO_PROMPT.md`,
  `specs/`), and engineering-guide updates.

## 0.1.1

- No functional changes. Releases now publish through npm trusted publishing
  (OIDC) instead of a long-lived token, with provenance attestation retained.

## 0.1.0

- Added `@llm4ts/flow/Flow` with `implementPlanFlow` (the plan → branch →
  per-task coder/review/commit spine) and `completeAndPublish`; examples now
  compose it instead of hand-assembling the loop.
- Added the `llm4ts` CLI `--help`, `--version`, and `doctor` (connector and
  credential health report); errors now name the environment variable or
  missing binary that fixes them.
- Promoted `LLM4TS_PROVIDER`/`LLM4TS_MODEL` resolution
  (`apiConnectorFromEnvironment`) and script helpers (`resolveFlowInput`,
  `runFlowMain`) from the examples into `@llm4ts/runner`.
- Introduced `makeApiConnector` and CLI `versionProbe` factory seams; the six
  API providers and eight CLI connectors now share health, structured-output,
  and capability derivation.
- Consolidated connector identity (`connectorProvider`,
  `connectorDefaultBaseUrl`) and removed a silent OpenAI base-URL fallback for
  unknown API connector ids.
- Shipped in-memory `PlainFileStore`/`Workspace` fakes in `@llm4ts/flow` for
  deterministic tests; flow behavior tests moved into the flow package.
- Removed unused `LlmService` accessor functions, per-provider layer
  constructors, and pass-through streaming aliases (ADR 0002); `effect` is now
  a pinned peer dependency and packages ship LICENSE, README, and source maps.

- Recreated the public LLM, connector, provider, streaming, tool, evaluation,
  observability, flow, repository, replay, cost, benchmark, and equivalence
  contracts from the owned `llm4zio` v4.2.0 baseline.
- Added Node runtime composition, CLI and MCP stdio entry points, terminal
  rendering, and a credential-free executable example.
- Added the six-phase resumable modernization product with human approval gates.
- Added the Promise/exception JavaScript facade and reproducible npm package
  metadata.
- Added source-compatible API configuration enrichment at runner resolution,
  including default endpoints, redacted environment credentials, and target
  repository rooting for CLI agents.
- Added opt-in real examples for HTTP providers, edit-capable coding CLIs, a
  fully local LM Studio-to-pi handoff, and repeated LLM-as-a-Judge evaluation.
- Added atomic stateful chat, structured planning/readiness, file-scoped bounded
  review/fix loops, lint gates, and structured pull-request summaries.
- Added resumable implementation, GitHub issue-to-PR, and executable
  specification-driven development examples.
- Added disposable Rust, Scala, and Java starter repositories plus a seed/run
  script for complete implementation, local, issue-to-PR, and SDD workflows.
