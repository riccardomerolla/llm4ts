# MCP Operator Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `llm4ts mcp` serves a typed MCP tool set over stdio and HTTP that starts, supervises, observes and diagnoses llm4ts runs, so a chat agent (Grok Bot, Claude Code, Cursor) operates llm4ts without a shell; plus the docs and the Grok Bot template that use it.

**Architecture:** Pure folds and schemas live in `flow` and `runner` (status from the watch reducer, retro digest per story, doctor as a report). The server, the run supervisor and the spawn service live in `shell`, on Effect's `effect/unstable/ai/McpServer` with `@effect/platform-node` for stdio and HTTP. Runs are child processes in the server's scope, registered under the XDG state directory, identified by a run id the server allocates and the flow runner reads from its environment. Act tools are registered only when the server is started with the matching allow flag.

**Tech Stack:** TypeScript on Effect `4.0.0` (`effect/unstable/ai/{McpServer,Tool,Toolkit,McpProtocol}`, `effect/unstable/http/HttpRouter`, `effect/cli`), `@effect/platform-node` `4.0.0` (`NodeStdio`, `NodeHttpServer`, `NodeFileSystem`), `@effect/vitest`, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-10-22-mcp-operator-server-design.md`

## Global Constraints

- Effect and `@effect/*` pinned exactly at `4.0.0`; no new runtime dependency in any package. `runner` must not import `shell` or `@effect/platform-node`.
- Package graph `core → flow → runner → js | shell`. Every new module gets an explicit `"./X": "./dist/X.js"` entry in its package's `exports`; relative imports use `.ts` extensions; tests import through `@llm4ts/<pkg>/<Module>`.
- No `any`, no unchecked type assertions, no namespaces, no unmanaged promises; expected failures are `Schema.TaggedError`; schemas at every tool boundary.
- Secrets never in process arguments, logs, traces, the registry, tool outputs or error messages. The bearer token comes from `LLM4TS_MCP_TOKEN` or `--token-file`, is compared in constant time, and a miss is a bare `401`.
- HTTP binds `127.0.0.1` unless `--host` is given; HTTP without a token refuses to start.
- Registry and logs live under `${XDG_STATE_HOME:-~/.local/state}/llm4ts/mcp/<repoId>/`, never under `<repo>/.llm4ts/`.
- Tests are deterministic (`@effect/vitest`, memory file stores, fakes, `TestClock`); CI needs no network, credentials or provider CLI. Run one file with `pnpm vitest run <path>`.
- Commit after each task. Before the final task: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`, then `pnpm build && node scripts/pack-smoke.mjs`.
- Behaviour divergences from llm4zio are additive and go in `docs/parity.md`; the decisions become ADR 0041.

## Review Focus

1. A trace written by a newer llm4ts (`schemaVersion` ≠ 1): `run_status` must answer with a typed error naming the trace, not an internal error. Pinned in Task 8.
2. A story id carrying a path (`../x`, `a/b`): story tools must refuse it, never read outside `stories/`. Pinned in Task 9.
3. A run killed without a `RunEnded` line: `run_wait` must return `exited: true` from the supervisor, not poll forever. Pinned in Task 14.
4. A torn last line in `runs.jsonl` (the server died mid-append): `latestRuns` skips it and the rest still loads. Pinned in Task 3.
5. A token file ending in a newline, and a presented token of a different length: the first must authenticate, the second must get `401` without throwing. Pinned in Tasks 12 and 15.

---

## File structure

| Package | File | Responsibility |
| --- | --- | --- |
| flow | `src/OperatorSchemas.ts` (new) | Tool input/output schemas, `OperatorRun` registry record, `OperatorKnobs`, `latestRuns` |
| flow | `src/Retro.ts` | Export `renderStoryDigest` over the existing private `storySection` |
| flow | `src/Approval.ts` | Gains `approveMarkdown` (moved from shell `Refine.ts`) |
| runner | `src/FlowRunner.ts` | Reads `LLM4TS_RUN_ID` / `LLM4TS_TRACE_PATH`; `runFlowMain` interrupts on SIGINT |
| runner | `src/RunSummary.ts` (new) | `summarizeTree(state): string` |
| runner | `src/RunReaders.ts` (new) | Run-level folds: status, meaningful events, run diagnosis, costs for one run |
| runner | `src/StoryReaders.ts` (new) | Story detail and story diagnosis over `stories/<id>.*` |
| runner | `src/Doctor.ts` | Split into `collectDoctorReport` + `renderDoctorReport`; `makeDoctorProgram` composes them |
| shell | `src/FlowProcess.ts` (new) | Spawn service: start / signal / exit handle, Node impl and fake |
| shell | `src/FlowLaunch.ts` | Terminal wrapper over `FlowProcess` |
| shell | `src/RunSupervisor.ts` (new) | Registry, start with run id and knobs, stop with grace, lost detection, idempotency, concurrency rule |
| shell | `src/OperatorConfig.ts` (new) | `mcpOptionsFrom` flags+env → `OperatorConfig`; `mcp.json`; token loading |
| shell | `src/OperatorTools.ts` (new) | `readToolkit`, `actToolkit`, their handlers over `OperatorDeps` |
| shell | `src/OperatorServer.ts` (new) | Server layer: stdio or HTTP, bearer middleware, tool registration by allow flags |
| shell | `src/Cli.ts` | `mcp` command |
| docs | `docs/adr/0041-mcp-operator-server.md`, `docs/grok-bot/operator.md`, `docs/parity.md`, `CHANGELOG.md`, `skills/using-llm4ts/SKILL.md` | Decisions, template, notes |

---

### Task 1: The flow runner takes its run id and trace path from the environment

**Files:**
- Modify: `packages/runner/src/FlowRunner.ts:332-337` (`makeFlowRunnerContext`), `:923-932` (trace path)
- Test: `packages/runner/test/FlowRunner.test.ts`

**Interfaces:**
- Produces: `export const runIdentityFromEnvironment = (options: Pick<FlowRunnerOptions, "runId" | "tracePath">, environment: Readonly<Record<string, string | undefined>>): { readonly runId?: string; readonly tracePath?: string }` in `FlowRunner.ts`. Explicit options win over the environment; empty strings count as unset. Variables: `LLM4TS_RUN_ID`, `LLM4TS_TRACE_PATH`.

- [ ] **Step 1: Write the failing tests** in `FlowRunner.test.ts`, a new `describe("runIdentityFromEnvironment")`:
  - `"takes LLM4TS_RUN_ID and LLM4TS_TRACE_PATH when the options give none"`: `runIdentityFromEnvironment({}, { LLM4TS_RUN_ID: "op-1", LLM4TS_TRACE_PATH: "/t/op-1.jsonl" })` deep-equals `{ runId: "op-1", tracePath: "/t/op-1.jsonl" }`.
  - `"explicit options win and blank variables are ignored"`: `runIdentityFromEnvironment({ runId: "given" }, { LLM4TS_RUN_ID: "op-1", LLM4TS_TRACE_PATH: "  " })` deep-equals `{ runId: "given" }`.
  - `"the context's runId comes from the environment"`: `makeFlowRunnerContext({ ...minimal options used by the existing "embedded runner" tests, environment: { LLM4TS_RUN_ID: "op-2" } }, dependencies)` yields a bundle with `runId === "op-2"`.
- [ ] **Step 2: Run** `pnpm vitest run packages/runner/test/FlowRunner.test.ts` → FAIL (`runIdentityFromEnvironment` is not exported).
- [ ] **Step 3: Implement** `runIdentityFromEnvironment`; in `makeFlowRunnerContext` use `runIdentityFromEnvironment(options, options.environment ?? process.env).runId ?? \`run-${ms}\``; in the trace-path selection use the same helper's `tracePath` before the default.
- [ ] **Step 4: Run** the file → PASS.
- [ ] **Step 5: Commit** `feat(runner): run id and trace path from LLM4TS_RUN_ID / LLM4TS_TRACE_PATH`.

### Task 2: Graceful SIGINT for every flow

**Files:**
- Modify: `packages/runner/src/FlowRunner.ts:1192-1206` (`runFlowMain`)
- Test: `packages/runner/test/FlowRunner.test.ts`

**Interfaces:**
- Produces: `export interface SignalSource { readonly once: (signal: "SIGINT", handler: () => void) => void; readonly off: (signal: "SIGINT", handler: () => void) => void; readonly exit: (code: number) => void }` and `export const interruptOnSignal = <A, E>(fiber: Fiber.Fiber<A, E>, signals: SignalSource): void` in `FlowRunner.ts`. First SIGINT interrupts the fiber (`Effect.runFork(Fiber.interrupt(fiber))`) and re-arms; the second calls `signals.exit(130)`. `runFlowMain` calls it with `process` and sets `process.exitCode = 130` when the program's exit is an interruption (`Cause.hasInterruptsOnly`).

- [ ] **Step 1: Write the failing tests**, `describe("interruptOnSignal")`:
  - `"the first SIGINT interrupts the fiber and the trace ends interrupted"`: build a bundle with `makeFlowRunnerContext` and the test file's `files(state)` store; fork `runWithBundle(bundle, options, () => Effect.never, dependencies)` with `Effect.scoped`; a fake `SignalSource` records handlers in a `Map`; call `interruptOnSignal(fiber, fake)`; invoke the recorded SIGINT handler once; `yield* Fiber.await(fiber)` is an interrupt exit; the trace file's last line decodes to `kind: "RunEnded"` with `fields.outcome === "interrupted"`; `exit` was not called.
  - `"the second SIGINT exits 130"`: same fake, invoke the handler twice (the handler re-arms itself through `once`) → `exitCalls` deep-equals `[130]`.
- [ ] **Step 2: Run** the file → FAIL.
- [ ] **Step 3: Implement** `interruptOnSignal` and wire `runFlowMain`: fork the program as a fiber, call `interruptOnSignal(fiber, process)`, remove the handler in `Effect.ensuring`, map an interrupted exit to `process.exitCode = 130` with no stderr message.
- [ ] **Step 4: Run** the file → PASS. Also run `pnpm vitest run packages/shell/test/FlowLaunch.test.ts` → PASS (unchanged).
- [ ] **Step 5: Commit** `feat(runner): first SIGINT interrupts the flow and ends the trace; second kills`.

### Task 3: Operator schemas in flow

**Files:**
- Create: `packages/flow/src/OperatorSchemas.ts`
- Modify: `packages/flow/package.json` (`exports`: `"./OperatorSchemas": "./dist/OperatorSchemas.js"`)
- Test: `packages/flow/test/OperatorSchemas.test.ts`

**Interfaces (all exported, `Schema.Class` unless noted):**
- `OperatorRunState = Schema.Literals(["starting", "running", "exited", "interrupted", "lost"])`
- `OperatorKnobs` (`Schema.Struct`, every field `Schema.optionalKey`): `task: String`, `epic: String`, `pack: String`, `executors: Array(String)`, `coder: String`, `judgeRounds: Int`, `mergeRevisions: Int`, `land: String` (the branch), `flags: Array(String)`, `requestId: String`.
- `OperatorRun`: `runId: String, repo: String, flow: String, args: Array(String), knobs: OperatorKnobs, startedAt: Number, pid: optionalKey(Int), tracePath: optionalKey(String), logDir: String, state: OperatorRunState, exitCode: optionalKey(Int), signal: optionalKey(String), endedAt: optionalKey(Number), requestId: optionalKey(String)`.
- `decodeOperatorRunLine = Schema.decodeUnknownOption(Schema.fromJsonString(OperatorRun))`, `encodeOperatorRunLine = Schema.encodeSync(Schema.fromJsonString(OperatorRun))`.
- `latestRuns = (lines: ReadonlyArray<string>): ReadonlyArray<OperatorRun>`: decodes each line, skips undecodable ones, keeps the last record per `runId`, returns newest `startedAt` first.
- `LaneStatusOut` (`Struct`): `id, status: Literals(["running","done","failed"]), stage: optionalKey(String), executor: optionalKey(String), activity: optionalKey(String), lastEventAgeMs: Int, costUsd: Number`.
- `RunStatus`: `runId, state: OperatorRunState, ended: optionalKey(Literals(["completed","failed","interrupted"])), elapsedMs: Int, lanes: Array(LaneStatusOut), stories: Array(Struct({ id, status: BoardStatus from BoardSync })), tokens: Int, costUsd: Number, warnings: Array(String), seq: Int, summary: String`.
- `MeaningfulEvent` (`Struct`): `seq: Int, at: Number, kind: String, lane: optionalKey(String), text: String`.
- `RunWaitResult`: `events: Array(MeaningfulEvent), seq: Int, ended: optionalKey(RunOutcome from FlowRecorder), exited: Boolean, summary: String`.
- `ConnectorHealthOut` (`Struct`): `id, availability: Availability, authStatus: AuthStatus, probe: Literals(["version", "unknown"]), latencyMs: optionalKey(Int)`.
- `ExecutorHealthOut` (`Struct`): `id, harness, roles: Array(String), disabled: Boolean, healthy: optionalKey(Boolean)`.
- `PreflightResult`: `llm4ts: String, node: String, connectors: Array(ConnectorHealthOut), executors: Array(ExecutorHealthOut), notes: Array(String)`.
- `StoryDetail`: `id, title, state: optionalKey(Struct({ status: StoryStatus, branch, worktree, executor: optionalKey(String) })), board: optionalKey(Struct({ status: BoardStatus, detail: optionalKey(String) })), tasks: Array(Struct({ title, completed: Boolean })), findings: optionalKey(String), verdict: optionalKey(Schema.Json), gateLogs: Array(String)`.
- `Diagnosis`: `runId, story: optionalKey(String), digest: String, failure: optionalKey(Struct({ stage: optionalKey(String), message, lane: optionalKey(String) })), gateLogTails: Array(Struct({ path, tail })), transcriptTail: Array(String)`.
- `CostsOut`: `report: CostReport` (from `./CostReport.ts`), `total: Number`, `ledger: optionalKey(Number)`, `differs: Boolean`.
- `UnknownRepo`, `UnknownRun`, `UnknownStory`, `UnknownFlow`, `NotAllowed`, `RunInProgress` (`{ runId }`): `Schema.TaggedError`s with a `message`.

- [ ] **Step 1: Write the failing tests**: `"latestRuns keeps the last record per run, newest first, and skips a torn line"` (three good lines for `run-1` starting/running/exited, one for `run-2` running with a later `startedAt`, then `'{"runId":"torn"'`; expect `[run-2 running, run-1 exited]`), `"OperatorKnobs round-trips with every field optional"` (`decode({})` succeeds; encode/decode of a full knobs object is identity).
- [ ] **Step 2: Run** `pnpm vitest run packages/flow/test/OperatorSchemas.test.ts` → FAIL.
- [ ] **Step 3: Implement** the module and the `exports` entry.
- [ ] **Step 4: Run** → PASS; `pnpm typecheck` → clean.
- [ ] **Step 5: Commit** `feat(flow): operator schemas and run registry record`.

### Task 4: A per-story retro digest

**Files:**
- Modify: `packages/flow/src/Retro.ts` (after `renderRetroDigest`, `:435`)
- Test: `packages/flow/test/Retro.test.ts`

**Interfaces:**
- Produces: `export const renderStoryDigest = (inputs: RetroInputs, storyId: string, share: number = perStoryShare): string | undefined`: `traceView(inputs.trace)` then `storySection(inputs, view, entry, share)` for the `StoryFiles` whose `story.id === storyId`; `undefined` when the plan has no such story. No candidate filter: a merged story still gets a digest.

- [ ] **Step 1: Write the failing tests** using the file's `seeded` and `loadInputs`: `"renderStoryDigest renders one story's section"` (`renderStoryDigest(inputs, "a")` starts with `"## Story a — "`, contains `"- [x] add the route"` and `"Revision 1"`), `"renderStoryDigest is undefined for an unknown story"` (`renderStoryDigest(inputs, "zz") === undefined`).
- [ ] **Step 2: Run** `pnpm vitest run packages/flow/test/Retro.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(flow): renderStoryDigest for one story`.

### Task 5: `approveMarkdown` moves to flow

**Files:**
- Modify: `packages/flow/src/Approval.ts`, `packages/shell/src/Refine.ts:84-88,399`, `packages/shell/test/Refine.test.ts:8,74-76`
- Test: `packages/flow/test/Approval.test.ts` (create if absent)

**Interfaces:**
- Produces: `export const approveMarkdown = (markdown: string): string` in `Approval.ts`, the body of today's `Refine.ts:85-88`. `Refine.ts` imports it from `@llm4ts/flow/Approval` and stops exporting its own.

- [ ] **Step 1: Write the failing test** in flow: the three assertions from `Refine.test.ts:74-76`, under `describe("approveMarkdown")`.
- [ ] **Step 2: Run** → FAIL. Move the function; update `Refine.ts` and move the three assertions out of `Refine.test.ts` (or re-import from flow).
- [ ] **Step 3: Run** `pnpm vitest run packages/flow/test/Approval.test.ts packages/shell/test/Refine.test.ts` → PASS.
- [ ] **Step 4: Commit** `refactor: approveMarkdown lives beside the marker it ticks`.

### Task 6: The doctor as a report

**Files:**
- Modify: `packages/runner/src/Doctor.ts:259-347`
- Test: `packages/runner/test/Doctor.test.ts`

**Interfaces:**
- Produces: `export interface DoctorReport { readonly connectors: ReadonlyArray<{ readonly id: string; readonly status: HealthStatus; readonly probe: "version" | "unknown" }>; readonly node: NodePreflightReport; readonly lines: ReadonlyArray<string> }` where `lines` is every line today's program renders after the connectors block (coder, credentials, pi, gemini, otel). `export const collectDoctorReport = (registry?, environment?, readPiModelsJson?, nodeCheck?, probeOtel?, systemPolicies?): Effect.Effect<DoctorReport>` with the same parameters and defaults as `makeDoctorProgram` today. `export const renderDoctorReport = (report: DoctorReport): string` produces exactly today's text. `makeDoctorProgram` becomes `Effect.map(collectDoctorReport(...), renderDoctorReport)`.
- `probe` is `"version"` for a `Cli` connector (its health is `cliVersionProbeHealthCheck`, `Connector.ts:147`) and `"unknown"` for an `Api` one. The kind comes from the registry's registered entries (`kind: "Api" | "Cli"` as `makeConnectorRegistry` receives them); if `ConnectorRegistryShape` does not expose it, add a `kindOf(id): "Api" | "Cli" | undefined` to the registry shape in core and its fake.

- [ ] **Step 1: Write the failing tests**: `"collectDoctorReport labels a CLI connector's auth as a version probe"` (with the file's `fakeRegistry`, the CLI connector entry has `probe === "version"`, an API one `"unknown"`), and `"renderDoctorReport renders what makeDoctorProgram rendered"` (`renderDoctorReport(yield* collectDoctorReport(fakeRegistry, env, ...)) === yield* makeDoctorProgram(fakeRegistry, env, ...)` for the arguments of the first existing test).
- [ ] **Step 2: Run** `pnpm vitest run packages/runner/test/Doctor.test.ts` → FAIL.
- [ ] **Step 3: Implement** the split; the four existing tests must stay green unchanged.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `refactor(runner): doctor collects a report, then renders it`.

### Task 7: The status sentence

**Files:**
- Create: `packages/runner/src/RunSummary.ts`
- Modify: `packages/runner/package.json` (`exports`)
- Test: `packages/runner/test/RunSummary.test.ts`

**Interfaces:**
- Produces: `export const summarizeTree = (state: TreeState, flow: string | undefined): string`. Format, exactly: `"<flow or title>, <elapsed>: <n> stories done, <n> active (<lane id>, <executor or ?>, <innermost stage or activity>), <n> failed (<lane id>: <last log text for that lane or 'failed'>), $<costUsd to 2 decimals>"`, where elapsed is `<m> min` under an hour, `<h> h <m> min` after; story counts come from `state.stories` (board) when present, otherwise from lanes; the active and failed parentheticals list at most three lanes each, more become `+<n>`; the `ended` run prefixes `"<outcome>, "`. A state with no lanes and no stories renders `"<flow>, 0 min: no stories yet, $0.00"`.

- [ ] **Step 1: Write the failing tests** by folding events with `reduceTree(emptyTree({ stories: [...] }), { _tag: "Event", at, event })` built from `StoryStatusChanged`, `StageStarted`, `ExecutorLeased` and `TokensUsed` instances (construct with `new StoryStatusChanged({...})` etc. from `@llm4ts/flow/FlowEvents`):
  - `"renders done, active and failed stories with executor, stage and cost"` → the exact string for 3 done, 1 active on `codex` in stage `review`, 1 failed, cost `12.4` → `"epic-stories, 42 min: 3 stories done, 1 active (payments, codex, review), 1 failed (notifications: failed), $12.40"`.
  - `"renders an ended run and an empty one"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(runner): summarizeTree, one sentence per run`.

### Task 8: Run readers

**Files:**
- Create: `packages/runner/src/RunReaders.ts`
- Modify: `packages/runner/package.json` (`exports`)
- Test: `packages/runner/test/RunReaders.test.ts`

**Interfaces:**
- Consumes: `readTrace` (`@llm4ts/flow/Replay`), `treeInputsOfTrace`, `reduceTree`, `emptyTree` (`./AgentTree.ts`), `summarizeTree` (Task 7), `loadVersioned`/`Board` (board seeding as `Watch.ts:167-190`), `profileOf`, `usageSamplesFromTrace`/`buildCostReport` (`@llm4ts/flow/CostReport`), `CostRecord` (`@llm4ts/flow/CostLedger`), `RunStatus`, `MeaningfulEvent`, `Diagnosis`, `CostsOut` (Task 3).
- Produces:
  - `export class TraceUnreadable extends Schema.TaggedError<TraceUnreadable>()("TraceUnreadable", { path: Schema.String, message: Schema.String }) {}`
  - `export interface RunSources { readonly files: PlainFileStoreShape; readonly listFiles: (directory: string) => ReadonlyArray<string> }`
  - `export interface TraceFold { readonly lines: ReadonlyArray<TraceLine>; readonly state: TreeState; readonly seq: number }`
  - `export const foldTrace = (files: PlainFileStoreShape, tracePath: string, boardDir?: string): Effect.Effect<TraceFold, TraceUnreadable>`: wraps `readTrace` failures (`PlanParseError`, `UnsupportedSchemaVersion`) into `TraceUnreadable`; seeds the tree from `<boardDir>/board.json` when `boardDir` is given, as `Watch.ts:167-190` does.
  - `export const runStatusOf = (fold: TraceFold, run: { readonly runId: string; readonly flow: string; readonly state: OperatorRunState }, now: number): RunStatus` (pure): lanes mapped from `TreeLane` (`stage` = `stages.at(-1)`, `activity` = `activity?.text`, `lastEventAgeMs = now - lastEventAt`), `warnings` = `CapabilityUnenforceable` details and exclusions, `seq` = last line's `seq`, `summary = summarizeTree(state, flow)`.
  - `export const meaningfulKinds: ReadonlySet<string>` = `StoryStatusChanged, StageFailed, Aborted, CapabilityUnenforceable, ExecutorExcluded, ExecutorHandedOver, StoryJudged, Began, RunEnded`.
  - `export const meaningfulEventsAfter = (lines: ReadonlyArray<TraceLine>, sinceSeq: number): ReadonlyArray<MeaningfulEvent>`: `text` is a one-line rendering per kind (e.g. `StoryStatusChanged` → `"story <id> <status>"`, `StageFailed` → `"<stage> failed: <message>"`, `RunEnded` → `"run <outcome>"`).
  - `export const eventsAfter = (lines, sinceSeq, kinds: ReadonlyArray<string> | undefined, limit: number): ReadonlyArray<TraceLine>`.
  - `export const runDiagnosisOf = (sources: RunSources, args: { runId: string; tracePath: string; planPath: string | undefined; transcriptsDir: string | undefined; gateLogDir: string | undefined; budget: number }): Effect.Effect<Diagnosis, TraceUnreadable>`: `failure` = the last `StageFailed`/`Aborted` (a `Stalled` message is kept verbatim); `digest` = the plan's tasks as `- [x]`/`- [ ]` lines (via `parsePlan`) plus the last 40 `Info`/`StageFailed` texts; `gateLogTails` = last 30 lines of each file under `gateLogDir`; `transcriptTail` = last 30 lines of the `run` lane transcript rendered with `tailLinesOf` (`./Transcripts.ts`); total capped at `budget` characters.
  - `export const costsOfRun = (files, tracePath: string, ledgerPath: string, runId: string): Effect.Effect<CostsOut, TraceUnreadable>`: `report` from the trace's usage samples; `ledger` = `totalCostUsd` of the `CostRecord` line with that `runId`, when present; `differs` = both present and `|total − ledger| > 0.005`.

- [ ] **Step 1: Write the failing tests** on a memory store seeded with a hand-built trace (the `event(seq, value)` helper idiom from `packages/flow/test/Retro.test.ts:69-77`): `"foldTrace seeds stories from the board and folds the trace"`, `"foldTrace reports a trace of a newer schema as TraceUnreadable"` (a line with `schemaVersion: 2` → failure `_tag === "TraceUnreadable"` with `path` set), `"meaningfulEventsAfter returns only meaningful kinds after the sequence"`, `"runDiagnosisOf names the failing stage and the open tasks"`, `"costsOfRun flags a ledger that disagrees"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(runner): run readers: status, meaningful events, diagnosis, costs`.

### Task 9: Story readers

**Files:**
- Create: `packages/runner/src/StoryReaders.ts`
- Modify: `packages/runner/package.json` (`exports`)
- Test: `packages/runner/test/StoryReaders.test.ts`

**Interfaces:**
- Consumes: `loadStoryFiles`, `loadEpicFiles`, `renderStoryDigest` (Task 4), `RetroInputs` (`@llm4ts/flow/Retro`); `makeStoryPlanStore` (`@llm4ts/flow/StoryPlan`); `readTrace`; `loadTranscript`, `tailLinesOf` (`./Transcripts.ts`); `RunSources` (Task 8); `StoryDetail`, `Diagnosis`, `UnknownStory` (Task 3).
- Produces:
  - `export const isSafeStoryId = (id: string): boolean` — `/^[A-Za-z0-9][A-Za-z0-9._-]*$/u`.
  - `export const storyDetailOf = (sources: RunSources, stateDir: string, storyId: string): Effect.Effect<StoryDetail, FlowError | UnknownStory>`: loads `plan.md` with the story plan store, fails `UnknownStory` for an unsafe or absent id, otherwise maps `loadStoryFiles` + the board item; `gateLogs` lists `<stateDir>/stories/<id>/gates/**` through `sources.listFiles`.
  - `export const storyDiagnosisOf = (sources: RunSources, args: { stateDir: string; storyId: string; runId: string; tracePath: string; transcriptsDir: string | undefined; budget: number }): Effect.Effect<Diagnosis, FlowError | UnknownStory | TraceUnreadable>`: builds `RetroInputs` for the one story (`transcripts` = a map with that lane when the transcript exists), `digest = renderStoryDigest(inputs, storyId, budget)`, `gateLogTails` and `transcriptTail` as in Task 8, `failure` from the board item's `detail`.

- [ ] **Step 1: Write the failing tests** on the retro fixture (copy `seeded` from `packages/flow/test/Retro.test.ts` into `packages/runner/test/support/retroFixture.ts` and import it): `"storyDetailOf reads state, board, tasks and findings for a story"` (story `a`: `state.status === "failed"`, `board.status === "failed"`, two tasks with `completed` `[true, false]`, `findings` contains `"judge round 1"`), `"storyDetailOf refuses a story id with a path"` (`"../a"` and `"a/b"` → `UnknownStory`, and `sources.files.read` was never called with a path containing `".."`: record reads in the memory store wrapper), `"storyDiagnosisOf returns the story's digest and the board reason"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(runner): story readers: detail and diagnosis`.

### Task 10: The spawn service

**Files:**
- Create: `packages/shell/src/FlowProcess.ts`
- Modify: `packages/shell/src/FlowLaunch.ts`, `packages/shell/package.json` (`exports`: `./FlowProcess`)
- Test: `packages/shell/test/FlowProcess.test.ts`; `packages/shell/test/FlowLaunch.test.ts` unchanged and green

**Interfaces:**
- Produces, in `FlowProcess.ts`:
  - `export interface FlowProcessStart { readonly flowPath: string; readonly args: ReadonlyArray<string>; readonly environment: Readonly<Record<string, string | undefined>>; readonly cwd?: string; readonly stdio: "inherit" | { readonly stdout: string; readonly stderr: string } }` (file paths are opened append by the Node implementation).
  - `export interface FlowProcessExit { readonly code: number | undefined; readonly signal: string | undefined }`
  - `export interface FlowProcessHandle { readonly pid: number; readonly exited: Effect.Effect<FlowProcessExit>; readonly signal: (signal: "SIGINT" | "SIGTERM") => Effect.Effect<void> }`
  - `export interface FlowProcessShape { readonly start: (options: FlowProcessStart) => Effect.Effect<FlowProcessHandle, FlowLaunchError>; readonly isAlive: (pid: number) => boolean }`
  - `export const flowNodeArgs = (flowPath: string): ReadonlyArray<string>` — `["--experimental-strip-types", ...(needsResolveFallback(flowPath) ? ["--import", resolveFallbackUrl] : [])]`, moved from `FlowLaunch.ts`.
  - `export const nodeFlowProcess: FlowProcessShape` — `spawn(process.execPath, [...flowNodeArgs(p), p, ...args])`; `isAlive` = `process.kill(pid, 0)` in a try.
  - `export interface FakeFlowProcess { readonly process: FlowProcessShape; readonly started: Effect.Effect<ReadonlyArray<FlowProcessStart>>; readonly exit: (pid: number, exit: FlowProcessExit) => Effect.Effect<void>; readonly signals: Effect.Effect<ReadonlyArray<{ pid: number; signal: string }>>; readonly setAlive: (pid: number, alive: boolean) => Effect.Effect<void> }` and `export const makeFakeFlowProcess = (): Effect.Effect<FakeFlowProcess>` — pids from 1000 upward; `exited` is a `Deferred` resolved by `exit`.
- `FlowLaunch.launchFlow` keeps its signature and tests; it builds a `FlowProcessStart` with `stdio: "inherit"`, keeps the SIGINT relay and `restoreTerminal`, and returns `exit.code ?? 128 + signal number`.

- [ ] **Step 1: Write the failing tests** (`describe("nodeFlowProcess")`, temp dir idiom from `FlowLaunch.test.ts:8-11`): `"reports the exit code and writes stdout to the file"` (script `console.log("hi"); process.exit(3)` with file stdio → `code === 3`, stdout file contains `hi`), `"a SIGTERM ends the child with the signal"` (script `setTimeout(() => {}, 60_000)`; `yield* handle.signal("SIGTERM")`; `exited` → `signal === "SIGTERM"`), `"isAlive is false after exit"`. `describe("makeFakeFlowProcess")`: `"records starts, resolves exits and signals"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** and refactor `FlowLaunch.ts` onto it. **Step 4: Run** `pnpm vitest run packages/shell/test` → PASS.
- [ ] **Step 5: Commit** `feat(shell): FlowProcess spawn service with a fake; FlowLaunch wraps it`.

### Task 11: The run supervisor

**Files:**
- Create: `packages/shell/src/RunSupervisor.ts`
- Modify: `packages/shell/package.json` (`exports`)
- Test: `packages/shell/test/RunSupervisor.test.ts`

**Interfaces:**
- Consumes: `FlowProcessShape`, `FlowProcessStart` (Task 10); `OperatorRun`, `OperatorKnobs`, `latestRuns`, `encodeOperatorRunLine`, `RunInProgress`, `UnknownRun` (Task 3); `PlainFileStoreShape`.
- Produces:
  - `export const operatorStateDir = (environment: Readonly<Record<string, string | undefined>>, repoId: string): string` — `${XDG_STATE_HOME or ~/.local/state}/llm4ts/mcp/<repoId>` (empty `XDG_STATE_HOME` counts as unset, like `FlowCatalog.ts:57-60`).
  - `export interface SupervisorRepo { readonly id: string; readonly path: string }`
  - `export interface StartRun { readonly repo: SupervisorRepo; readonly flow: { readonly name: string; readonly path: string }; readonly knobs: OperatorKnobs; readonly baseEnvironment: Readonly<Record<string, string | undefined>> }`
  - `export interface RunSupervisorShape { readonly start: (request: StartRun) => Effect.Effect<OperatorRun, FlowLaunchError | RunInProgress | PersistenceError>; readonly stop: (runId: string) => Effect.Effect<OperatorRun, UnknownRun>; readonly get: (runId: string) => Effect.Effect<OperatorRun | undefined>; readonly list: (repoId?: string) => Effect.Effect<ReadonlyArray<OperatorRun>> }`
  - `export interface SupervisorOptions { readonly repos: ReadonlyArray<SupervisorRepo>; readonly environment: Readonly<Record<string, string | undefined>>; readonly files: PlainFileStoreShape; readonly process: FlowProcessShape; readonly parallelRuns: number; readonly graceMs: number; readonly readOnlyFlows: ReadonlySet<string> }` with `graceMs` default `30_000` and `readOnlyFlows` default `new Set(["epic-retro"])`.
  - `export const makeRunSupervisor = (options: SupervisorOptions): Effect.Effect<RunSupervisorShape, PersistenceError, Scope.Scope>`.
  - `export const knobsToArgs = (flow: string, knobs: OperatorKnobs): ReadonlyArray<string>` and `export const knobsToEnvironment = (knobs: OperatorKnobs): Record<string, string>`: `task` → first argv; `epic` → `--epic <id>`; `land` → `--land=<branch>`; `judgeRounds` → `--judge-rounds <n>`; `mergeRevisions` → `--merge-revisions <n>`; `flags` appended last; `executors` → `LLM4TS_EXECUTORS=a,b`; `pack` → `LLM4TS_PACK`; `coder` → `LLM4TS_CODER`. Nothing else from the knobs reaches the environment.
- Behaviour:
  - Construction reads every repo's `runs.jsonl` and appends a `lost` record for each latest `starting`/`running` run whose pid is not alive.
  - `start`: a repeated `knobs.requestId` for the same repo returns the existing run without spawning; a repo with a latest `running` run of a flow not in `readOnlyFlows` and count ≥ `parallelRuns` fails `RunInProgress`; otherwise `runId = op-<startedAt ms>-<4 hex>`, environment = base + `knobsToEnvironment` + `LLM4TS_RUN_ID` + `LLM4TS_TRACE_PATH = <repo>/.llm4ts/trace-<startedAt>.jsonl` + `LLM4TS_FLOW=<flow name>`; stdio files under `<stateDir>/runs/<runId>/`; appends `starting`, then `running` with `pid`; a forked fiber awaits `exited` and appends `exited` (`exitCode`, `signal`, `endedAt`), or `interrupted` when `stop` was called.
  - `stop`: `signal("SIGINT")`, then after `graceMs` (via `Effect.sleep`) `signal("SIGTERM")` unless exited; returns the final record.
  - The scope's finalizer calls `stop` on every running run.

- [ ] **Step 1: Write the failing tests** with `makeFakeFlowProcess`, `makeMemoryPlainFileStore`, `TestClock` (`import { TestClock } from "effect/testing"`): `"start spawns the flow with the run id, trace path and knob variables and records running"` (started env has `LLM4TS_RUN_ID === run.runId`, `LLM4TS_TRACE_PATH` ends with `/.llm4ts/trace-<startedAt>.jsonl`, `LLM4TS_EXECUTORS === "claude,codex"`; args deep-equal `["bump deps", "--judge-rounds", "1"]`; registry latest is `running` with `pid`), `"a repeated requestId returns the same run"`, `"a second run on a busy repo is refused unless the flow is read-only"` (second `implement` → `RunInProgress`; `epic-retro` → starts), `"stop sends SIGINT, then SIGTERM after the grace period"` (`TestClock.adjust("30 seconds")`; signals deep-equal `[SIGINT, SIGTERM]`; after `fake.exit(pid, { code: undefined, signal: "SIGTERM" })` the record is `interrupted`), `"a running record whose pid is dead is marked lost on construction"`, `"an exit is recorded with its code"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(shell): run supervisor with a registry under the state dir`.

### Task 12: Operator configuration

**Files:**
- Create: `packages/shell/src/OperatorConfig.ts`
- Modify: `packages/shell/package.json` (`exports`)
- Test: `packages/shell/test/OperatorConfig.test.ts`

**Interfaces:**
- Produces:
  - `export interface McpFlags { readonly stdio: boolean; readonly http: boolean; readonly host: Option.Option<string>; readonly port: Option.Option<number>; readonly tokenFile: Option.Option<string>; readonly repo: ReadonlyArray<string>; readonly allowRun: boolean; readonly allowApprove: boolean; readonly parallelRuns: Option.Option<number> }`
  - `export interface OperatorConfig { readonly transport: { readonly _tag: "stdio" } | { readonly _tag: "http"; readonly host: string; readonly port: number; readonly token: string }; readonly repos: ReadonlyArray<{ readonly id: string; readonly path: string }>; readonly allowRun: boolean; readonly allowApprove: boolean; readonly parallelRuns: number }`
  - `export const McpConfigFile = Schema.Struct({ repos: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String })) })` read from `${XDG_CONFIG_HOME:-~/.config}/llm4ts/mcp.json`.
  - `export const mcpOptionsFrom = (flags: McpFlags, environment: Readonly<Record<string, string | undefined>>, cwd: string, readFile: (path: string) => Effect.Effect<string | undefined>): Effect.Effect<OperatorConfig, ShellUsageError>`: `--stdio` and `--http` together → usage error; neither → stdio; HTTP token = `environment.LLM4TS_MCP_TOKEN` else the trimmed contents of `--token-file`, missing or empty → usage error `"--http needs a token: LLM4TS_MCP_TOKEN or --token-file"`; default host `127.0.0.1`, default port `4321`; repos = `--repo` paths resolved against `cwd` with `id = basename`, else the config file, else usage error `"mcp needs --repo <path> or ~/.config/llm4ts/mcp.json"`; duplicate ids → usage error; `parallelRuns` default `1`.

- [ ] **Step 1: Write the failing tests**: `"stdio is the default and needs no token"`, `"http without a token is refused"`, `"http reads the token from the file and trims the newline"` (`readFile` returns `"s3cret\n"` → `token === "s3cret"`), `"repos come from --repo flags with basename ids, else from mcp.json"`, `"both transports is a usage error"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(shell): operator config from flags, environment and mcp.json`.

### Task 13: Read tools

**Files:**
- Create: `packages/shell/src/OperatorTools.ts`
- Modify: `packages/shell/package.json` (`exports`)
- Test: `packages/shell/test/OperatorTools.test.ts`

**Interfaces:**
- Consumes: `Tool.make`, `Toolkit.make` (`effect/unstable/ai/Tool`, `Toolkit`); Tasks 3, 6, 7, 8, 9, 11, 12; `discoverFlows`, `defaultTierPaths` (`./FlowCatalog.ts`); `rosterReport`, `httpProbe` (`@llm4ts/runner/ExecutorRoster`); `listEpics` is the runner's `nodeListEpics` shape `(directory) => ReadonlyArray<string>`; `readEpicRuns` (`@llm4ts/flow/EpicRuns`); `loadTranscript`, `tailLinesOf`, `TranscriptFiles` (`@llm4ts/runner/Transcripts`); `makeProfileProgram`/`profileOf` (`@llm4ts/runner/Profile`); `readRetroIndex`, `retroPaths`, `retroApprovalOf` (`@llm4ts/flow/Retro`); `packageVersion` (`./Package.ts`).
- Produces:
  - `export interface OperatorDeps { readonly config: OperatorConfig; readonly files: PlainFileStoreShape; readonly listFiles: (directory: string) => ReadonlyArray<string>; readonly listTraces: (directory: string) => ReadonlyArray<string>; readonly listEpics: (directory: string) => ReadonlyArray<string>; readonly transcripts: TranscriptFiles; readonly supervisor: RunSupervisorShape; readonly doctor: Effect.Effect<DoctorReport>; readonly roster: (repoPath: string) => Effect.Effect<RosterReport, FlowError>; readonly probe: (url: string) => Effect.Effect<boolean>; readonly flows: (repoPath: string) => Effect.Effect<ReadonlyArray<DiscoveredFlow>, unknown>; readonly now: Effect.Effect<number>; readonly environment: Readonly<Record<string, string | undefined>> }`
  - `export const resolveRepo = (config: OperatorConfig, id: string | undefined): Effect.Effect<{ id: string; path: string }, UnknownRepo>` (one repo → optional id).
  - `export const readToolkit = Toolkit.make(preflight, list_flows, list_epics, list_runs, run_status, run_events, run_log, story_detail, diagnose, transcript_tail, costs, profile, retro_list)` where each is `Tool.make("<name>", { description, parameters: Schema.Struct({...}), success: <Task 3 schema or Schema.Struct>, failure: Schema.Union([...typed errors]) })`, annotated `Tool.Readonly` true. Parameters, with `repo: Schema.optional(Schema.String)` on every repo-scoped tool:
    - `preflight {}` → `PreflightResult`
    - `list_flows {}` → `Schema.Array(Struct({ name, tier, description: optional(String), kit: optional(String) }))`
    - `list_epics {}` → `Array(Struct({ id, title, stories: Int, board: Array(Struct({ id, status })), lastRun: optional(Struct({ runId, startedAt, action })) }))`
    - `list_runs { epic?: String, limit?: Int }` → `Array(OperatorRun)` merged with runs found in traces (state `exited`/`running` inferred from `RunEnded` presence, `flow` from `LLM4TS_FLOW` unknown → `"?"`), newest first, `limit` default 20
    - `run_status { runId }` → `RunStatus`
    - `run_events { runId, sinceSeq?: Int, kinds?: Array(String), limit?: Int }` → `Array(TraceLine)`; `limit` default 200, max 1000
    - `run_log { runId, lines?: Int }` → `Struct({ stdout: Array(String), stderr: Array(String) })`; default 100
    - `story_detail { epic, story }` → `StoryDetail`
    - `diagnose { runId, story?: String, chars?: Int }` → `Diagnosis`; `chars` default 12 000; a story needs the run to belong to an epic (`run_status`'s trace lives in `runs.jsonl` of that epic) else `UnknownStory`
    - `transcript_tail { runId, lane, entries?: Int, role?: String }` → `Array(String)`; default 40
    - `costs { runId?: String }` → `CostsOut` for one run, or `CostsResult` (`@llm4ts/runner/Costs`) for the repo
    - `profile { runId }` → `ProfileReport`
    - `retro_list { epic }` → `Array(Struct({ runId, at, approved: Boolean, applied: Boolean }))`
  - `export const readHandlers = (deps: OperatorDeps): Toolkit.HandlersFrom<Toolkit.Tools<typeof readToolkit>>` built with `readToolkit.of({...})`.
  - `preflight`: `llm4ts = packageVersion`, `node = process.version`, connectors from `deps.doctor` mapped to `ConnectorHealthOut` with `probe`, executors from `deps.roster(repo.path)` with `healthy = yield* deps.probe(url)` when `health` is set else `undefined`, `notes = report.lines`.
  - Run lookup: a `runId` resolves through `deps.supervisor.get` first; when unknown there, through the repos' `.llm4ts/epics/*/runs.jsonl` and trace file names; else `UnknownRun`.

- [ ] **Step 1: Write the failing tests** calling handlers directly (`readHandlers(deps).run_status({ runId })` style, with a deps object over a memory store seeded as in Tasks 8–9, a fake supervisor holding one `running` run, a fake doctor report with one CLI connector, a roster with one executor whose `health` URL the fake `probe` answers `true`): `"preflight never reports a bare Valid: a CLI connector carries probe version"`, `"preflight probes executor health"`, `"run_status folds the supervised run's trace"` (`summary` is a non-empty string, `state === "running"`), `"diagnose with a story returns the retro digest"`, `"diagnose without a story returns the run-level digest"`, `"resolveRepo accepts no id with one repo and refuses an unknown one"`, `"run_events bounds limit at 1000"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(shell): operator read tools`.

### Task 14: Act tools and `run_wait`

**Files:**
- Modify: `packages/shell/src/OperatorTools.ts`
- Test: `packages/shell/test/OperatorTools.test.ts`

**Interfaces:**
- Produces:
  - `run_wait { runId, sinceSeq?: Int, timeoutSeconds?: Int }` added to `readToolkit` → `RunWaitResult`: polls every `500 ms` (`Effect.sleep`), returns as soon as `meaningfulEventsAfter(lines, sinceSeq)` is non-empty or the supervisor says the run is no longer `running` (`exited: true`), else after `min(timeoutSeconds, 300)` seconds (default `120`) with empty `events`; `seq` is the last seen line's `seq`, `ended` from the trace, `summary` from `runStatusOf`.
  - `export const actToolkit = Toolkit.make(start_run, stop_run, retro_start, approve)`, annotated `Tool.Destructive` true for `stop_run`, `Tool.Idempotent` true for `start_run`:
    - `start_run { repo?, flow: String, task?, epic?, pack?, executors?, coder?, judgeRounds?, mergeRevisions?, land?, flags?, requestId? }` → `Struct({ runId, tracePath: optional(String), pid: Int })`; resolves the flow with `deps.flows(repo.path)` by name (`UnknownFlow` from Task 3), then `deps.supervisor.start`.
    - `stop_run { runId }` → `OperatorRun`.
    - `retro_start { repo?, epic, run?: String }` → same as `start_run` with `flow: "epic-retro"`, `flags: ["--epic", epic, ...(run ? ["--run", run] : [])]`.
    - `approve { repo?, kind: Literals(["retro"]), epic, id }` → `Struct({ path, approved: Boolean })`: path = `retroPaths(<repo>/.llm4ts/epics/<epic>, id).report`, must exist (`UnknownRun` otherwise), rewritten with `approveMarkdown`.
  - `export const actHandlers = (deps: OperatorDeps): Toolkit.HandlersFrom<Toolkit.Tools<typeof actToolkit>>`.

- [ ] **Step 1: Write the failing tests** (`TestClock`): `"run_wait returns on the first meaningful event"` (fork `run_wait({ runId, sinceSeq: 0 })`, append a `StoryStatusChanged` line to the memory trace, `TestClock.adjust("500 millis")` → events length 1, `exited === false`), `"run_wait returns exited when the supervisor's run is no longer running"` (fake supervisor flips to `exited`, no new lines → `exited === true`, `events` empty), `"run_wait times out empty"` (`timeoutSeconds: 5`, adjust 5 s → empty events, `seq` unchanged), `"start_run resolves the flow and passes typed knobs to the supervisor"`, `"approve ticks the retro report's marker and refuses an unknown retro"`, `"retro_start starts epic-retro with --epic and --run"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(shell): act tools and run_wait`.

### Task 15: The server layer

**Files:**
- Create: `packages/shell/src/OperatorServer.ts`
- Modify: `packages/shell/package.json` (`exports`)
- Test: `packages/shell/test/OperatorServer.test.ts`

**Interfaces:**
- Consumes: `McpServer.layerStdio`, `McpServer.layerHttp`, `McpServer.toolkit`, `McpProtocol.v2025_06_18` (`effect/unstable/ai/McpServer`, `McpProtocol`); `HttpRouter.middleware`, `HttpRouter.toWebHandler` (`effect/unstable/http/HttpRouter`); `HttpServerRequest`, `HttpServerResponse` (`effect/unstable/http/*`); `NodeStdio.layer`, `NodeHttpServer.layer` (`@effect/platform-node/*`); Tasks 12–14.
- Produces:
  - `export const serverName = "llm4ts"`; version = `packageVersion`.
  - `export const bearerMiddleware = (token: string): Layer.Layer<never, never, HttpRouter.HttpRouter>` via `HttpRouter.middleware(...)`.layer: reads `authorization`; accepts only `Bearer <token>` compared with `timingSafeEqual` on equal-length buffers (different length → false without throwing); otherwise responds `HttpServerResponse.empty({ status: 401 })`.
  - `export const toolLayer = (config: OperatorConfig, deps: OperatorDeps): Layer.Layer<never, never, McpServer>`: `McpServer.toolkit(readToolkit)` provided `readToolkit.toLayer(readHandlers(deps))`, merged with the act toolkit only when `config.allowRun || config.allowApprove` (when only one is allowed, the other's tools are still unregistered: build `actToolkit` from the allowed subset, e.g. `Toolkit.make(start_run, stop_run, retro_start)` vs `Toolkit.make(approve)`; expose `export const actToolkitFor = (config) => Toolkit`).
  - `export const httpAppLayer = (config: OperatorConfig & { transport: { _tag: "http" } }, deps): Layer.Layer<never, never, HttpRouter.HttpRouter>`: `toolLayer` over `McpServer.layerHttp({ name, version, path: "/mcp", protocols: [McpProtocol.v2025_06_18] })` with `bearerMiddleware(token)`.
  - `export const runOperatorServer = (config: OperatorConfig, deps: OperatorDeps): Effect.Effect<never, ServeError | IllegalArgumentError>`: stdio → `Layer.launch(toolLayer over McpServer.layerStdio(...) provided NodeStdio.layer, logger to stderr)`; http → `HttpRouter.serve(httpAppLayer, { disableLogger: true })` provided `NodeHttpServer.layer(createServer, { host, port })`, logging one line per request (`method`, tool name when it is `tools/call`, duration, outcome) and never arguments.

- [ ] **Step 1: Write the failing tests** with an in-process handler (`HttpRouter.toWebHandler(httpAppLayer(config, deps), { disableLogger: true })`, the raw POST helper idiom of Effect's own `McpServer/utils.ts`; deps = a memory-backed `OperatorDeps` as in Task 13): `"no token is 401"`, `"a token of another length is 401, not an error"`, `"the right token initializes and lists only read tools"` (initialize, then `tools/list` names contain `preflight`, `run_wait`; not `start_run`), `"--allow-run lists start_run and stop_run but not approve"`, `"--allow-approve lists approve"`, `"tools/call run_status answers structured content"` (`structuredContent.summary` is a string).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(shell): operator MCP server over stdio and HTTP with a bearer token`.

### Task 16: The `mcp` command

**Files:**
- Modify: `packages/shell/src/Cli.ts` (new command before `doctorCommand`, added to `withSubcommands`)
- Test: `packages/shell/test/Cli.test.ts`

**Interfaces:**
- Produces: `mcpCommand = Command.make("mcp", { stdio: Flag.Boolean("stdio"), http: Flag.Boolean("http"), host: Flag.String("host").pipe(Flag.optional), port: Flag.Int("port").pipe(Flag.optional), tokenFile: Flag.String("token-file").pipe(Flag.optional), repo: Flag.String("repo").pipe(Flag.atLeast(0)), allowRun: Flag.Boolean("allow-run"), allowApprove: Flag.Boolean("allow-approve"), parallelRuns: Flag.Int("parallel-runs").pipe(Flag.optional) }, ...)` with descriptions; the handler calls `mcpOptionsFrom(config, process.env, process.cwd(), nodeRead)`, builds `OperatorDeps` with `nodeFlowProcess`, `nodePlainFileStore`, `nodeListTraces`, `nodeListEpics`, `nodeTranscriptFiles`, `collectDoctorReport()`, `rosterReport`, `httpProbe`, `discoverFlows(defaultTierPaths(...))` (provided `NodeFileSystem.layer`), `makeRunSupervisor` in a scope, then `runOperatorServer`. Description: `"Serve llm4ts to an MCP client (Grok Bot, Claude Code, Cursor): status, diagnosis and, when allowed, runs (ADR 0041)"`.
- `export const nodeListEpics` must be exported from `@llm4ts/runner/Watch` if it is not already (it is module-private today at `Watch.ts`; export it).

- [ ] **Step 1: Write the failing test** in `Cli.test.ts`: `"mcp --http without a token is a usage error"` through `mcpOptionsFrom` with the flags object the command builds (the pure-validator idiom at `Cli.test.ts:232-289`), and `"the mcp command is registered"` (`runShellCommand(["mcp", "--help"])` succeeds or fails with `ShowHelp`, as the existing help tests do).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm vitest run packages/shell/test` → PASS.
- [ ] **Step 5: Manual check** (not CI): `pnpm build`, then in a scratch repo: `node packages/shell/dist/cli-main.js mcp --stdio --repo .` and send `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}` on stdin → a result with `serverInfo.name === "llm4ts"`; `LLM4TS_MCP_TOKEN=t node … mcp --http --repo . --allow-run` and `curl -s -o /dev/null -w '%{http_code}' -X POST localhost:4321/mcp` → `401`.
- [ ] **Step 6: Commit** `feat(shell): llm4ts mcp`.

### Task 17: Docs, ADR, template, release notes, verification

**Files:**
- Create: `docs/adr/0041-mcp-operator-server.md`, `docs/grok-bot/operator.md`
- Modify: `docs/parity.md`, `CHANGELOG.md`, `skills/using-llm4ts/SKILL.md`, `README.md` (one paragraph under the CLI verbs, if the README lists them)

- [ ] **Step 1: ADR 0041** in the house format (Status, Date, Context, Decision numbered, Considered options, Consequences): decisions D1–D9 of the spec, including graceful SIGINT and the two coexisting MCP servers; `docs/parity.md` gains a bullet: `MCP operator server (ADR 0041, 2026-10-22): llm4ts mcp over stdio and HTTP, a run supervisor, first SIGINT interrupts a flow; llm4zio has no server and no signal handling. Additive.`
- [ ] **Step 2: `docs/grok-bot/operator.md`** with the five parts of spec D8: template contents (name, title, description, instructions verbatim as the bot's rules), routines, install steps (install, token file, `llm4ts mcp --http --repo … --allow-run` under a supervisor, `ssh -N -L 4321:127.0.0.1:4321 <server>` from the bot's computer, add `http://127.0.0.1:4321/mcp` with header `Authorization: Bearer <token>` in Grok Bot's MCP settings, verify with `preflight`), a "publish as template" section, and the local stdio variant (`command: llm4ts`, `args: ["mcp", "--stdio", "--repo", "<path>"]`).
- [ ] **Step 3: `skills/using-llm4ts/SKILL.md`**: a section "With the MCP server" saying to prefer `preflight`, `start_run`, `run_wait`, `diagnose`, `costs` over `npx -y @llm4ts/shell run …` when an llm4ts MCP server is configured.
- [ ] **Step 4: CHANGELOG** under a new `## 2.46.0` heading, in the house style: the server, the supervisor, SIGINT, the doctor's `probe`, the Grok Bot template; and the out-of-scope list from spec section 9 as "Known, not fixed here".
- [ ] **Step 5: Verify**: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` → all green; `pnpm build && node scripts/pack-smoke.mjs` → passes (the new `exports` resolve).
- [ ] **Step 6: Commit** `docs: ADR 0041, Grok Bot operator template, release notes`.

---

## Self-review notes

- Spec coverage: D1 → Tasks 12, 15, 16; D2 → 12, 13; D3 → 1, 2, 10, 11; D4 → 13, 14; D5 → 7; D6 → 11 (registry holds argv and knobs only), 15 (401, per-request log without arguments); D7 → 17 (ADR records coexistence); D8 → 17; D9 → file structure; section 5 done criteria → 15/16 tests and the manual check; section 9 → CHANGELOG "known, not fixed".
- Names used across tasks: `OperatorRun`, `OperatorKnobs`, `latestRuns`, `RunStatus`, `RunWaitResult`, `Diagnosis`, `StoryDetail`, `PreflightResult`, `CostsOut` (3); `renderStoryDigest` (4); `approveMarkdown` (5); `DoctorReport`, `collectDoctorReport` (6); `summarizeTree` (7); `foldTrace`, `runStatusOf`, `meaningfulEventsAfter`, `eventsAfter`, `runDiagnosisOf`, `costsOfRun`, `TraceUnreadable`, `RunSources` (8); `storyDetailOf`, `storyDiagnosisOf`, `isSafeStoryId` (9); `FlowProcessShape`, `FlowProcessHandle`, `makeFakeFlowProcess`, `flowNodeArgs` (10); `RunSupervisorShape`, `makeRunSupervisor`, `operatorStateDir`, `knobsToArgs`, `knobsToEnvironment` (11); `McpFlags`, `OperatorConfig`, `mcpOptionsFrom` (12); `OperatorDeps`, `readToolkit`, `readHandlers`, `resolveRepo` (13); `actToolkit`, `actHandlers` (14); `bearerMiddleware`, `toolLayer`, `actToolkitFor`, `httpAppLayer`, `runOperatorServer` (15).
