# API Guide

The packages expose explicit subpaths. The package manifests are the canonical
export list; the following modules are the main entry points.

## Core

- `@llm4ts/core/Models`: messages, chunks, responses, usage, configuration,
  connector identifiers, health.
- `@llm4ts/core/LlmService`: backend-neutral LLM service.
- `@llm4ts/core/ConnectorConfig` and `ConnectorRegistry`: connector selection.
- `@llm4ts/core/providers/*`: API and CLI connector implementations.
- `@llm4ts/core/Streaming`: collection, progress, timeout, buffering, fallback,
  and SSE helpers.
- `@llm4ts/core/tools/*`: tool declarations, registry, and bounded tool loop.
- `@llm4ts/core/eval/*`: checks, judges, evaluators, and suites.
  `judgeWithJudgment(judgment, dimensions)` is the rubric judge over the
  Judgment service: one Score question per dimension.
- `@llm4ts/core/judgment/*` (ADR 0017): typed judgments. `Schemas` holds
  `State`, the `choice` / `score` / `truth` question constructors, the
  answers (probabilities, `confidence`, `support`, `origin`), `JudgmentRequest` and
  `JudgmentResult`; `Judgment` the service, its errors, and the typed
  accessors `choiceOf` / `scoreOf` / `truthOf`; `LlmJudgment` the layer over
  any `LlmServiceShape` (per-question label scoring, `concurrency`,
  `permutations`, `batching` (`independent` or `shared-prefix`: the state
  once with every question, each position read as its own label, a
  position the batch could not read falling back to its own call),
  verbalized fallback, usage and fallback hooks);
  `TypeSafeJudgment` the hosted Jev layer (`TYPESAFE_API_KEY`, native
  batching, `truth` ↔ `noul`, calibration `claimed`); `FakeJudgment` the
  deterministic test double.
- `@llm4ts/core/LabelScoring`: `scoreLabels`, the classification primitive
  every connector offers (a probability per offered label), with the
  verbalized default derivation, `normalizeLabelProbabilities`, and
  `unsupportedScoreLabels` for fakes. The optional `scoreLabelSequence`
  primitive answers several label questions in one call over a shared
  prompt prefix; `verbalizedScoreLabelSequence` derives it from structured
  output when a backend has no native read. `mlx-lm` answers it from token
  log-probabilities in one forward pass.
- `@llm4ts/core/observability/*`: metrics, tracing, recording, logging,
  redaction.

## Flow

- `@llm4ts/flow/Flow`: the flow spine — `implementPlanFlow` recovers or creates
  a plan, checks out the epic branch, and runs the per-task coder + review +
  commit loop; `completeAndPublish` streams one prompt and publishes the
  response as an assistant message. See the
  [flow authoring guide](flow-authoring.md) for the rung-by-rung walkthrough.
  `ImplementPlanOptions.chatPerTask` opts into per-task chat isolation:
  - What it does: when `true`, each task gets a fresh `Chat` seeded with the
    system prompt plus the plan's current render (showing prior tasks'
    completion status), instead of one `Chat` shared across the whole plan.
  - Review-fix rounds: a task's review-fix rounds always share that task's
    `Chat` — isolation is between tasks, not within a task's fix loop.
  - Default: `false`/omitted, which preserves the original single-shared-
    `Chat` behavior.
  - When to use: long-running, dogfood-style plans where an ever-growing
    shared transcript would otherwise degrade context quality across many
    tasks.
- `@llm4ts/flow/FlowContext` and `FlowEvents`: workflow dependencies and event
  protocol.
- `@llm4ts/flow/Chat`: atomic, serialized conversation history for coding
  agents.
- `@llm4ts/flow/Plan`, `Planner`, `PlanExecution`, and `Persistence`: structured
  planning and resumable work.
- `@llm4ts/flow/Workspace*`: contained filesystem access and workspace tools.
- `@llm4ts/flow/GitTool`, `GitHubTool`, and `AzureDevOpsTool`: audited repository
  and forge boundaries. `GitTool.diffVsBaseScoped(base, paths)` is the
  path-scoped diff primitive: empty paths yield `""` (never the whole diff),
  and the capability guard runs either way. `GitHubTool` drives `gh` and
  `AzureDevOpsTool` drives `az` (ADR 0011); each CLI owns its own
  credential, so neither tool accepts or stores a token.
- `@llm4ts/flow/Context`: context budgeting for LLM prompts, in characters
  (deterministic, no tokenizer). `cap(text, limit)` never returns more than
  `limit` chars (marker included; head ¾, tail ¼); `capped(label, text, limit)`
  additionally publishes a `FlowEvent` and records the truncation;
  `withShrink(label, f)` runs `f` at the budget and retries prompt-too-large
  failures at ½ then ¼ before failing with a message naming
  `LLM4TS_CONTEXT_BUDGET` (default 400_000). `truncations` reads back what this run shortened —
  flows append it to `provenance.json` — and `isolateTruncations` scopes a
  private log.
- `@llm4ts/flow/ProgramJudge`: per-program spec-compliance judging.
  `groupFiles` partitions changed files by the pack's per-program regex;
  `judgeAllPrograms` judges each program against only its slice of the diff
  (cached per program, resumable), judges the unassigned remainder once, and
  reports every spec'd program with no matching changed file as a Critical
  finding. `judgment: { judgment, mode? }` compares typed Score answers with
  the generative scores in observe mode by default. `withJudgment` exposes
  the same wrapper for an `Evaluator<Sample>`; act returns judgment scores.
  Verdict caches include mode and checkpoint identity when configured;
  cache hits emit no new observations.
- `@llm4ts/flow/Reviewer`, `Pack`, `Review`, `SpecChecks`, and `Survey`:
  file-scoped review lenses, bounded review/fix loops, and discovery.
  `ReviewPrescreen.mode` defaults to observe: `prescreenReviewers` returns
  selected reviewers plus answers/decisions, and `reviewAndFixLoop` publishes
  their outcomes after the lenses run. Only act skips confident negative lenses.
  `Pack.programFiles`/`filesFor(program)` locate a program's implementation
  files; `Survey.closureFor(graph, program, maxFiles)` resolves the bounded
  breadth-first include closure extract hands its analysts.
- `@llm4ts/flow/StoryPlan`, `Perimeter`, and `Stories`: the parallel story
  executor (ADR 0013). `StoryPlan` is the epic-level plan — stories with
  `dependsOn`, `owned`, `sharedReadOnly`, and `provides` — embedded as a
  ` ```json storyplan ` block in the markdown the operator edits;
  `validateStoryPlan` reports every violation (cycles, unknown targets,
  overlapping ownership) at once, and `topologicalWaves`/`readyStories` are
  the pure scheduling helpers. `Perimeter.enforcePerimeter` fails a story
  whose branch changed paths outside its `owned` set. `implementStoriesFlow`
  runs stories in per-story worktrees under a concurrency cap, each through
  the unchanged `implementPlanFlow`, judges and perimeter-checks the branch,
  merges it into the epic branch one at a time, re-gates the epic head, and
  writes the board and the `EpicReport` (usage figures estimated). Seats come
  from the `contextFor` option; the `BLOCKED_ON:` sentinel ends a story as a
  typed `MissingDependency`.
- `@llm4ts/flow/PrSummary`: structured pull-request titles and bodies.
- `@llm4ts/flow/Judgment` (ADR 0017): what a flow does with a judgment.
  `JudgmentMode` is `observe | advise | act`, defaulting to observe whenever
  a consumer enables a judgment. Observe preserves the full path's result;
  advise also renders its decision and outcome through an `Info` event.
  `JudgmentPolicy` (bands keyed by calibration evidence, then by extraction
  method, verbalized held highest, plus `minSupport`), `decide` (act /
  caution / hold), `judgeOrEscalate` (held or failed answers re-asked of the
  reasoning seat, origin `reasoning` with `escalated`), `cachedJudgment`
  (fingerprinted on state, questions and the judgment identity), and
  `judgmentOf(context)`.
  `Review.prescreenReviewers` and the `prescreen` option of
  `reviewAndFixLoop` ask one Truth question per selected lens over the diff;
  the pre-screen is disabled unless configured. In `Flow`,
  `ImplementPlanOptions.satisfiedProbe: { mode?: JudgmentMode }` enables a
  judgment alongside the literal empty-diff confirmation. Omitted or
  `"literal"` makes no judgment call. `"judgment"` remains a legacy alias
  for `{ mode: "act" }`, with literal fallback on doubt or failure.
  `FlowEvents.JudgmentObserved` carries consumer, question key, policy
  decision, certainty, support, origin, mode, state, question, answer,
  judgment identity, and a `JudgmentOutcome` tagged
  union: `ReviewPrescreen { lens, issues: { Critical, Warning, Info } }`,
  `SatisfiedProbe { literalMatch }`, or `ProgramJudge { score }`. Events
  are published in observe/advise for answered questions with a full-path
  outcome; failed questions/backend calls never fabricate an answer or
  change that outcome. Act retains the existing automated behavior.

  `@llm4ts/flow/JudgmentLog` exports `JudgmentObservation`, `judgmentLogPath`,
  and `makeJudgmentLog({ files, root, runId })`: a scoped hub subscriber
  (`consume`, `awaitDrained`) that validates and appends one JSON line per
  observation through `PlainFileStoreShape`. Enable it with
  `FlowRunnerOptions.judgmentLog: true` (off by default, no environment
  variable); files accumulate across runs at
  `<workDir>/.llm4ts/judgments/<consumer>.jsonl`, with `at` in epoch
  milliseconds as in `FlowRecorder`. State is preserved verbatim except
  sealed `Classified` values: text and JSON conversion use `Classified(…)`,
  without declassification. Explicitly declassified strings have no remaining
  classification metadata. Writes degrade permanently on a persistence or
  encoding failure, as with the recorder, without changing the flow result.
  The engine never stages or commits these observations; this repository
  already ignores `.llm4ts/`.

- `@llm4ts/flow/Replay`, `Equiv`, and `EquivReport`: offline replay and
  behavioral proof.
- `@llm4ts/flow/CostReport`: the cross-run budgeting view. `usageSamplesFromTrace`
  lifts a trace's `TokensUsed` lines into timestamped samples,
  `buildCostReport` buckets them per day and hour in a chosen zone with
  measured and `estimated:<model>` usage kept apart, averages per active
  day, calendar day, active hour, and run, and an optional projection for an
  assumed run rate; `renderCostReport` prints it. `CostLedger` is the
  run-level companion: the runner appends one `CostRecord` per run to
  `.llm4ts/costs.jsonl`.
- `@llm4ts/flow/Artifacts`: resumable per-program extraction and vector
  generation; `@llm4ts/flow/Approval`: the draft marker and human gate the
  modernization phases pause on (both moved here from the retired
  `@llm4ts/modernize` package in 0.18.0).

## Runner

- `@llm4ts/runner` (root): the flow author's barrel — `runNode`,
  `runFlowMain`, `resolveFlowInput`, `coderFromEnv`,
  `apiConnectorFromEnvironment`, `openPack`, and the flow verbs a script
  calls (`completeAndPublish`, `implementPlanFlow`, `stage`,
  `implementTaskLoop`, `reviewAndFixLoop`, `lintCommand`, `makePlanStore`,
  `planFrom`, `defaultPlanPath`, events, errors). Re-exports only; the
  subpaths below remain the contract.
- `@llm4ts/runner/FlowRunner`: `runEmbedded`, `runNode`, and Node dependency
  presets. The flow context carries `contextFor(workDir)`: the same seats
  rebound to another directory (a story worktree), sharing the run's events
  and cost tracker — what `implementStoriesFlow` needs and the runner's only
  part in parallel story execution.
- `@llm4ts/runner/Connectors`: API presets (including `mlxLm`),
  source-compatible environment enrichment, immutable configuration
  transforms, edit-capable CLI presets, and `judgmentConnectorFromEnvironment`
  (`LLM4TS_JUDGMENT_PROVIDER` / `LLM4TS_JUDGMENT_MODEL`).
- The flow context carries `judgment`: `FlowRunnerOptions.judgment` names
  the seat (default: the reasoning seat), `judgmentBackend` or
  `LLM4TS_JUDGMENT_BACKEND=typesafe` selects the hosted model. Its usage is
  metered as agent `judgment`.
- `@llm4ts/runner/Kits` and `Packs`: kit discovery across the project,
  global, and built-in tiers, pack name resolution, `openPack`, and the
  kit's pattern deck (ADR 0014).
- `@llm4ts/runner/Cli`: command-line composition.
- Every run through `runNode` writes `.llm4ts/trace-<timestamp>.jsonl` and
  appends to `.llm4ts/costs.jsonl` under `workDir` unless
  `FlowRunnerOptions.tracePath` / `costLedgerPath` name other files or
  `persistRun: false` turns both off.
- `@llm4ts/runner/Costs`: `makeCostsProgram` reads the traces of one or more
  repositories into a `CostReport`, skipping and naming unreadable traces;
  `llm4ts costs` is its command.
- `@llm4ts/runner/McpStdio`: JSON-RPC MCP stdio transport.

## JavaScript

`@llm4ts/js` and `@llm4ts/js/Client` export:

- `createClient(config)` and `mockClient()`;
- `LlmClient.complete(prompt, { signal? })`;
- `LlmClient.health({ signal? })`;
- stable completion, usage, health, and error values;
- `Llm4tsError.category` for exception-based branching.

The Effect packages preserve typed error channels. The JavaScript facade rejects
Promises with `Llm4tsError` because exceptions are its explicit compatibility
contract.
