# Changelog

## Unreleased

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
