# Candidate 2: redraw the boundaries

Commit 894506cd, packages at 3.2.5. Numbers are measured with `wc -l` and
import scans unless marked "estimate". The scan script is
`candidate-2/split.py` beside this file.

## 1. Rationale

### Problem

The package graph `core → flow → runner → js/shell` has no violations, but it
no longer describes where the code is.

- **The flow package is two things.** A scan of `packages/flow/src` splits
  its 107 modules (37,315 lines) into a kernel of 59 modules / 17,951 lines
  (plan and story spine, events, review, roster, costs) and product code:
  modernization 26 / 10,994, taskforce and roundtable 3 / 2,570, tool catalog
  and endpoints 10 / 2,493, forge adapters 5 / 2,734, operator 2 / 389, dead
  2 / 184. The kernel imports product code in exactly three places, all
  type-only: `ProgramJudge → Pack`, `Stories → BoardSync`,
  `FlowContext → GitHubTool`. The split already exists; nothing enforces it.
- **A flow's knowledge is cut in three.** `Taskforce.nextAction` is in
  `packages/flow/src/Taskforce.ts:887`; the loop that calls it,
  `runTaskforce`, is in `flows/lib/taskforce.ts:871`; the wiring is in
  `flows/taskforce.ts`. Same for `runRoundtable`
  (`flows/lib/roundtable.ts:454`) and `runEpicStories`
  (`flows/lib/epic-stories.ts:2343`). `flows/lib` is 14 files / 9,185 lines
  and belongs to no published package: `grep` finds no reference to those
  three loops under `packages/*/src`.
- **The author contract points at code nobody can import.**
  `skills/authoring-llm4ts-flows/SKILL.md:20-21` tells authors to build an
  epic variant on `runEpicStories` with an `EpicStoriesOptions` policy, "not
  a copy of it". A script in `.llm4ts/flows/` cannot import
  `./lib/epic-stories.ts`.
- **Every module is public because the callers live outside.** flow exports
  106 of 107 modules. `flows/` alone imports 65 distinct flow subpaths, 30 of
  them product modules. The surface is wide because the orchestration code
  that needs the internals sits outside the package.
- **Runner holds offline readers only the shell uses.** Profile (1,213),
  Watch (446), RunReaders (419), StoryReaders (157), Costs (148), RunSummary
  (62) and Cli (49) have no importer in runner except each other, and no
  importer in flows or kits. That is 2,494 lines.
- **In-repo imports bypass the exports maps anyway.**
  `packages/runner/tsconfig.src.json` maps `@llm4ts/flow/*` to
  `../flow/src/*`, so any file is importable in the workspace whatever the
  package exports.

Constraints honoured: ADR 0006 (runner knows nothing of shell; flows run as
child processes; project pin wins), ADR 0014 (kits stay directories shipped
by the shell), CLAUDE.md rules (explicit subpath exports, `.ts` relative
imports, typed errors, deterministic tests). History to respect:
`@llm4ts/modernize` was retired on 2026-09-14 (commit 748f396e) because it
held two small modules and a state machine nothing called. That reason no
longer holds; the modernization code in flow is now 26 modules.

### Usage (caller's view)

**Flow author, new script** (`.llm4ts/flows/implement-house.ts`):

```ts
// Persistent plan with our house rules.
import { flowMain } from "@llm4ts/runner"
import { implementPlanFlow, planFrom, planStoreAt } from "@llm4ts/flow/Plan"

flowMain({
  defaultPrompt: "Add a multiply function to the calculator.",
  run: ({ input, context, files }) =>
    implementPlanFlow(context, {
      ...planStoreAt(files, input),
      plan: planFrom(context.reasoning, input.prompt),
      system: "Implement one task at a time."
    })
})
```

Today the same script repeats `resolveFlowInput` → `runNode({workDir,
workspace, userPrompt, coder: coderFromEnv(process.env), environment})` →
`runFlowMain` (`flows/implement.ts:17-42`), a preamble the runtime grounding
found in 18 files.

**Flow author, variant of a built-in** (works from npm, which it does not today):

```ts
// Epic stories judged by our release checklist.
import { flowMain } from "@llm4ts/runner"
import { epicStories } from "@llm4ts/engine/Epic"

flowMain(epicStories({ storyJudge: releaseChecklistJudge }))
```

**The shipped built-in** (`packages/engine/src/bin/taskforce.ts`, replacing
the 215-line `flows/taskforce.ts`):

```ts
// Run a taskforce on a goal: a Chief of Staff plans the briefs, ...
import { flowMain } from "@llm4ts/runner"
import { taskforce } from "@llm4ts/engine/Crew"

flowMain(taskforce)
```

**Maintainer adding a connector**: one row in `connectors` in
`packages/core/src/Models.ts`, plus the provider module built with
`makeCliConnector`/`makeApiConnector`. `tsc` fails until the row is
complete. Today the same fact is written in about seven places
(`Models.ts:5,22,90,110`, `ConnectorFactories.ts:83-129`,
`runner/Connectors.ts`, `shell/CoderChoice.ts:15`, `js/Client.ts:17`).

**Maintainer adding a flow event**: one `Schema.TaggedClass`, one entry in
the `FlowEvent` union, one row in `eventTraits`. `tsc` fails on a missing
row. Renderers add a case only if the event needs its own text. Today lane,
verbosity and "meaningful" are decided separately at `Terminal.ts:569`,
`RunReaders.ts:149`, `Retro.ts:189`, `Profile.ts:238,351`, `AgentTree.ts:425`.

**npm consumer**:

```ts
import { makeGitHubTool } from "@llm4ts/flow/Forge" // was /GitHubTool
import { implementPlanFlow } from "@llm4ts/flow/Plan" // was /Flow
import { loadPack } from "@llm4ts/engine/Modernize" // was @llm4ts/flow/Pack
import "@llm4ts/flow/plan/Persistence" // fails: not exported
```

### Shape

```text
core → flow → runner → engine → shell
                 └───→ js
```

| Package                | Owns                                                                                                                         | Public entry points                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `@llm4ts/core`         | contracts, providers, judgment, blackboard, eval                                                                             | about 12 (was 58)                                                                                       |
| `@llm4ts/flow`         | the kernel: context, events, plan, stories, review, roster, workspace, costs, forge adapters                                 | `Context Events Plan Stories Review Judgment Roster Workspace Forge Costs Errors testing` (12, was 107) |
| `@llm4ts/runner`       | the Node edge: live implementations, `flowMain`, seats from the environment, live terminal and tree rendering, kit discovery | `.` `Connectors` `Node` `RunView` `Doctor` `Kits` (6, was 39)                                           |
| `@llm4ts/engine` (new) | every shipped flow as a module: schema, state machine, loop, prompts, flags, and its `bin/` script                           | `Epic Modernize Port Crew Tools` (5)                                                                    |
| `@llm4ts/shell`        | CLI, menu, operator MCP server, offline readers (profile, watch, costs, run readers)                                         | the bin; subpaths as today                                                                              |
| `@llm4ts/js`           | Promise facade                                                                                                               | unchanged                                                                                               |

Load-bearing decisions:

1. **A flow is a module of `@llm4ts/engine`; the script is a thin entry.**
   One directory per product (`src/epic/`, `src/modernize/`, `src/port/`,
   `src/crew/`, `src/tools/`) holds what today is split across
   `packages/flow/src`, `flows/lib` and `flows/*.ts`. Simple flows whose
   script is the whole flow (`hello`, `implement`, `sdd`, `local`,
   `issue-pr`) stay full scripts in `src/bin/` using only public entries, so
   `llm4ts view implement > my.ts` keeps working as the fork path. Grouping
   is by knowledge owned, not by purity or execution order.
2. **Engine sits above runner.** `flows/lib` already imports runner
   (`ScriptUsage`, `terminalSafe`, `nodeProcessExecutor`, `Transcripts`,
   `Tools`, `Connectors`; `flows/lib/epic-stories.ts:68,104,962-963`), so
   this states the existing dependency instead of inventing one. Runner loses
   its four product modules (Packs, Tools, ToolMain, Graph) to engine.
3. **Built-ins ship as engine's compiled `dist/bin/*.js`.** The shell's
   built-in tier becomes that directory, found through
   `@llm4ts/engine/package.json`. The flow half of
   `scripts/sync-shell-flows.mjs` (lines 28-84, a second transpiler with a
   regex import rewriter) is deleted; the kit half stays (ADR 0014).
4. **Entry points are the top-level files of `src/`; everything else is in a
   subdirectory and is not exported.** `src/Plan.ts` re-exports named symbols
   from `src/plan/*.ts`. The exports map is then derivable, so
   `scripts/check-exports.mjs` fails when it differs from the top-level file
   list, and an ESLint rule rejects any `@llm4ts/<pkg>/<dir>/<file>` import,
   which closes the tsconfig `paths` wildcard hole. Node enforces the same
   for npm consumers.
5. **Reachability replaces the allowlist.** With real entry points,
   `pnpm unused` becomes "every module is reachable from an entry point or a
   bin". `ALLOWED` (`scripts/unused-modules.mjs:16-24`) disappears: a kept
   module is exported from an entry or deleted. Transitively dead modules
   (AgentSession behind ClaudeAgentSession) become visible.
6. **Offline presentation lives in the shell; live presentation stays in
   runner.** The child process renders Terminal and AgentTreeSurface, and it
   must not import the shell (ADR 0006). The shell reads traces after the
   fact. Both use the pure fold and view through `@llm4ts/runner/RunView`.
7. **One import path per symbol.** The runner root exports runtime only. The
   22 flow re-exports at `packages/runner/src/index.ts:30-47` stay for one
   major, marked deprecated and forbidden in-repo by lint, because field
   scripts use them.

Interface depth: `flowMain` hides argv parsing, a single typed decode of the
`LLM4TS_*` run variables, checked seat selection, signal handling, context
construction and consumer draining behind one call. It also fixes
`--verbose`, which `llm4ts run` sets (`shell/src/Cli.ts:208`) and
`runWithBundle` never reads (`FlowRunner.ts:1010`). Each engine entry hides
1.6k to 12k lines behind a flow definition plus the vocabulary kits need.
Total exported subpaths go from 224 to about 40 (estimate; the exact list is
fixed in the ADR).

Deliberately not done: no plugin registry for events (the union stays closed
in the kernel, including product events, because an open union would cost
exhaustiveness); no per-product npm packages; no change to kits or to the
env-var contract between shell and child.

### Synthesis decision

### Tradeoffs accepted

- We accept a 4.0.0 a short time after 3.0.0 in exchange for one break that
  moves every subpath once, with a codemod, instead of several.
- We accept a 34k-line engine package (estimate: 16,331 from flow + 714 from
  runner + 9,185 from `flows/lib` + 7,764 from `flows/*.ts`) in exchange for
  a kernel of about 20k lines that a reader can hold. The total does not
  shrink in this proposal; it is relocated so later deletion is local.
- We accept a sixth published package (one more `package.json`, tsconfig
  trio, README) in exchange for a boundary the package graph enforces. The
  two hand-written package lists (`set-version.mjs:17`, `pack-smoke.mjs:14`)
  are derived from `packages/*` first so the sixth costs nothing there.
- We accept that forge adapters (GitHub, Azure DevOps, Basecamp, BoardSync)
  stay in the kernel behind `Forge`, because `FlowContext` and `Stories`
  type against them.
- We accept that entry files are hand-written export lists. They are the
  definition of the API, and there is exactly one per entry.
- We accept that `llm4ts view taskforce` shows a three-line script; the
  source to read is the engine module, and the skill must say so.

### Alternatives considered

- **Layers inside `@llm4ts/flow`** (`flow/kernel`, `flow/modernize`, lint
  between them). Same surface reduction, no new package. Lost because the
  loops in `flows/lib` import runner, so they still could not move in, and
  the fork gap stays open.
- **One package per product** (`@llm4ts/modernize`, `@llm4ts/crew`, ...).
  Deepest isolation; lost on cost for one maintainer and because the epic
  flows share one engine (`EpicStoriesOptions`, `flows/lib/epic-stories.ts:2261`).
- **Engine below runner, scripts above** (pure loops with every Node effect
  injected). Cleaner layering on paper; lost because it splits each flow
  across two packages again, the fault this proposal removes.
- **Keep scripts as the unit, publish `flows/lib` as-is.** Smallest move;
  lost because the 107-module surface stays and state machines stay apart
  from their loops.

### Open questions and risks

- Is `@llm4ts/engine` the right name? ADR 0014 says "engine flows";
  `@llm4ts/flows` is one letter from `@llm4ts/flow`.
- Unpinned field scripts resolve `@llm4ts/*` from the shell's install (ADR
  0006), so a shell upgrade to 4.0.0 breaks them without a pin change. Is
  the deprecated barrel plus a resolve-time redirect (sketch 7) enough, or
  should 4.0.0 wait for a customer window?
- Do Nightcall and Dunder Mifflin import more than `GitHubTool` and
  `BasecampTool`? (`scripts/unused-modules.mjs:20` says "consumed by sibling
  projects"; not checkable from this repo.)
- `Mermaid` and `McpStdio` are "kept by decision (3.0.0 cleanup)". Under
  reachability they must be exported from an entry or go. Which?
- `flowMain` must cover commands that run without seats (`--list`,
  `--eject-personas` in `flows/taskforce.ts`). The sketch uses `prepare`; is
  that the right cut, or should those become shell verbs?
- Should `@llm4ts/js` (207 lines, one in-repo consumer, a declared but
  unused dependency on flow) fold into runner as `@llm4ts/runner/Promise`?
- Docs with verbatim excerpts (`examples/test/guide-sync`, `docs-sync`) will
  fail on every moved import until regenerated.

### Next implementation step

Create `packages/engine` holding today's `flows/` unchanged (`lib/` under
`src/`, scripts under `src/bin/`), point the shell's built-in tier at its
`dist/bin`, and delete the flow half of `sync-shell-flows.mjs`.

## 2. Type and signature sketches

```ts
// ── 1. packages/runner/src/index.ts ── the author runtime ───────────────
/** Run variables decoded once from the environment. Single reader of LLM4TS_* run knobs. */
export class RunConfig extends Schema.Class<RunConfig>("RunConfig")({
  verbosity: Schema.Literals(["Quiet", "Normal", "Verbose"]),
  ui: Schema.Literals(["plain", "tree"]),
  roster: Schema.optional(Schema.String),
  transcript: Schema.Boolean,
  otel: Schema.optional(Schema.String)
  // TODO: the remaining run-level names from docs/configuration.md; flow-level
  // names stay with the flow's own Flags schema.
}) {
  static readonly fromEnvironment: (
    environment: Readonly<Record<string, string | undefined>>
  ) => Effect.Effect<RunConfig, ScriptUsage> = () => Effect.die("not implemented")
}

export interface FlowRun<Flags> {
  readonly input: FlowInput
  readonly flags: Flags
  readonly config: RunConfig
  readonly context: FlowContextShape
  readonly files: PlainFileStore
  readonly processes: ProcessExecutor
}

/** What exists before seats are resolved; enough for --list style commands. */
export type FlowPrelude<Flags> = Omit<FlowRun<Flags>, "context">

export interface FlowDefinition<Flags = {}, A = void, E = never> {
  readonly defaultPrompt?: string
  /** Flow-specific argv and env. Fails with ScriptUsage; never reads process.env itself. */
  readonly flags?: (
    argv: ReadonlyArray<string>,
    environment: Readonly<Record<string, string | undefined>>
  ) => Effect.Effect<{ readonly flags: Flags; readonly rest: ReadonlyArray<string> }, ScriptUsage>
  /** Runs without seats. `Done` ends the process with exit 0. */
  readonly prepare?: (
    prelude: FlowPrelude<Flags>
  ) => Effect.Effect<"Continue" | "Done", ScriptUsage | FlowError>
  /** Adjust the seats read from the environment (defaults, read-only, turn limits). */
  readonly seats?: (fromEnvironment: Seats, flags: Flags) => Seats
  readonly run: (run: FlowRun<Flags>) => Effect.Effect<A, E | FlowError>
}

/** Parse, decode, resolve seats, build the context, run, drain consumers, exit. */
export const flowMain = <Flags, A, E>(definition: FlowDefinition<Flags, A, E>): void => {
  throw new Error("not implemented")
}
/** The same without process exit, for embedding and tests. Replaces runNode + runEmbedded. */
export const runFlow: <Flags, A, E>(
  definition: FlowDefinition<Flags, A, E>,
  process: {
    readonly argv: ReadonlyArray<string>
    readonly environment: Readonly<Record<string, string | undefined>>
  }
) => Effect.Effect<A, E | FlowError | ScriptUsage, Scope.Scope> = () =>
  Effect.die("not implemented")

// ── 2. packages/engine/src/Crew.ts, Epic.ts ── one definition per flow ──
export const taskforce: FlowDefinition<TaskforceFlags, TaskforceOutcome> = undefined! // not implemented
export const roundtable: FlowDefinition<RoundtableFlags, RoundtableOutcome> = undefined! // not implemented
/** The epic engine with a policy; epic-mvp, epic-draft and the board variant are policies. */
export const epicStories: (
  policy?: Partial<EpicStoriesPolicy>
) => FlowDefinition<EpicFlags, EpicOutcome> = () => {
  throw new Error("not implemented")
}
export const epicMvp: FlowDefinition<EpicFlags, EpicOutcome> = undefined! // = epicStories(mvpPolicy)

// ── 3. packages/flow/src/Events.ts ── one classification, one consumer loop
export interface EventTraits {
  readonly lane: "carried" | "none" // does the event carry a lane field
  readonly minVerbosity: "Quiet" | "Normal" | "Verbose"
  readonly meaningful: boolean // shows in run digests (RunReaders.meaningfulKinds today)
  readonly stage: "opens" | "closes" | "none"
}
/** Exhaustive by construction: adding a FlowEvent without a row fails typecheck. */
export const eventTraits: { readonly [Tag in FlowEvent["_tag"]]: EventTraits } = undefined! // not implemented
export const laneOf: (
  event: FlowEvent
) => { readonly lane: string; readonly executor?: string } | undefined = () => {
  throw new Error("not implemented")
}

export interface Consumer {
  readonly name: string
  readonly drained: Effect.Effect<void>
}
/** subscribe → stream → handle → count, forked in scope. Replaces five hand copies. */
export const consume: (
  hub: FlowEventHub,
  name: string,
  handle: (event: FlowEvent) => Effect.Effect<void>
) => Effect.Effect<Consumer, never, Scope.Scope> = () => Effect.die("not implemented")

// ── 4. packages/core/src/Models.ts ── connector identity, one table ─────
export interface ConnectorSpec {
  readonly id: string // "claude-cli"
  readonly kind: "api" | "cli"
  readonly provider?: LlmProvider // api connectors and provider-backed CLIs
  readonly defaultBaseUrl?: string
  readonly apiKeyVariable?: string // "ANTHROPIC_API_KEY"
  readonly aliases: ReadonlyArray<string> // ["claude"]
  readonly executable?: string // cli only
}
export const connectors = [
  /* 16 rows */
] as const satisfies ReadonlyArray<ConnectorSpec>
export type ConnectorName = (typeof connectors)[number]["id"]
export const connectorSpec: (idOrAlias: string) => ConnectorSpec | undefined = () => undefined // not implemented
// Derived, not written: ConnectorIds, connectorProvider, providerConnectorId,
// runner coder aliases and environmentApiKey, shell coderChoices, js JsProvider.

// ── 5. packages/flow/src/Context.ts ── seat policy leaves the runner ────
export interface SeatPolicy {
  readonly retry: TransientRetryPolicy
  readonly meter: boolean
  readonly transcript: TranscriptSink | undefined
  readonly deniedPaths: ReadonlyArray<string>
}
/** capability notices → retry → estimated usage → timing → transcript, in one place. */
export const decorateSeat: (
  seat: LlmServiceShape,
  role: SeatRole,
  policy: SeatPolicy,
  events: FlowEventsShape
) => LlmServiceShape = () => {
  throw new Error("not implemented")
}
// FlowRunner keeps one context builder: a plain run is a roster of one executor per seat.

// ── 6. scripts/check-exports.mjs ── the layout is the contract ──────────
// for each packages/*: expected = top-level src/*.ts (minus index.ts → ".")
// fail when package.json exports ≠ expected, or when any exported file re-exports with `export *`.

// ── 7. packages/shell/src/legacy-subpaths.ts ── one migration table ─────
/** "@llm4ts/flow/GitHubTool" → "@llm4ts/flow/Forge". Read by the codemod and by ResolveFallback. */
export const legacySubpaths: Readonly<Record<string, string>> = {} // not implemented
// ResolveFallback: on ERR_PACKAGE_PATH_NOT_EXPORTED for a listed specifier, resolve the
// replacement and warn once on stderr. Only active for flows the shell already assists.
```

## 3. Module map

| Before                                                                                                                                                                 | After                                                                                                  | Modules / lines                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `packages/flow/src` kernel (spine, events, review, roster, costs)                                                                                                      | `flow/src/{context,events,plan,stories,review,judgment,roster,workspace,costs}/` behind 12 entry files | 58 / 17,677 (kernel 59 minus ProgramJudge) |
| flow `GitHubTool AzureDevOpsTool BasecampTool BoardSync PrSummary`                                                                                                     | `flow/src/forge/`, entry `Forge`                                                                       | 5 / 2,734                                  |
| flow modernization (`Survey Graph* Pack Decisions Domains PageSpec Equiv* Bench* Patterns Provenance Wall Artifacts Approval SpecChecks Diagnostics`) + `ProgramJudge` | `engine/src/modernize/`                                                                                | 22 / about 7.9k (estimate)                 |
| flow `EpicBrief Retro CoverageLedger`                                                                                                                                  | `engine/src/epic/`                                                                                     | 3 / 2,902                                  |
| flow `Port WorkQueue`                                                                                                                                                  | `engine/src/port/`                                                                                     | 2                                          |
| flow `Taskforce Roundtable Memory`                                                                                                                                     | `engine/src/crew/`                                                                                     | 3 / 2,570                                  |
| flow `tools/*`, `endpoint/*`                                                                                                                                           | `engine/src/tools/` (Node transport and secret source are legal here)                                  | 10 / 2,493                                 |
| flow `OperatorSchemas`                                                                                                                                                 | `shell/src/` (consumers: RunReaders, StoryReaders, shell Operator\*)                                   | 1                                          |
| flow `McpServer`                                                                                                                                                       | `runner/src/bridge/` (consumers: `NodeGeminiAcpBridge.ts:31`, `McpStdio.ts:6`)                         | 1                                          |
| flow `Classified` + `Declassified` event (`FlowEvents.ts:205`, `Terminal.ts:316`)                                                                                      | deleted; no importer of the module                                                                     | 1 / about 70                               |
| `flows/lib/*.ts`                                                                                                                                                       | `engine/src/<product>/` beside their state machines                                                    | 14 / 9,185                                 |
| `flows/*.ts`                                                                                                                                                           | `engine/src/bin/*.ts`; about 12 collapse to `flowMain(definition)`                                     | 30 / 7,764 → estimate 3.5k                 |
| `flows/test`, product tests in `packages/flow/test`                                                                                                                    | `engine/test/`                                                                                         | 10,123 + product share                     |
| runner `Packs Tools ToolMain Graph`                                                                                                                                    | `engine/src/{modernize,tools}/`                                                                        | 4 / 714                                    |
| runner `Profile Watch RunReaders StoryReaders Costs RunSummary Cli`                                                                                                    | `shell/src/`                                                                                           | 7 / 2,494                                  |
| runner `ReviewFingerprint` (13) vs flow `ReviewCache.fingerprintOf`                                                                                                    | one function in flow `Review`; cached keys change once                                                 | 1                                          |
| three `Package.ts` (11 lines each, differ only in the name)                                                                                                            | one generated `version.ts` per package, or read from `package.json`                                    | 3                                          |
| runner after                                                                                                                                                           | Node edge only                                                                                         | 38 → about 26 modules, 12,409 → about 9.3k |
| flow after                                                                                                                                                             | kernel + forge                                                                                         | 107 → 63 modules, 37,315 → 20,411          |
| exported subpaths                                                                                                                                                      | entry points                                                                                           | 224 → about 40 (estimate)                  |

Cross-product imports inside engine today: crew → modernize 2, modernize →
forge 1 (`Retro → BoardSync`). Both go through the public entry.

## 4. Work plan

Subtract first. Each unit is green on `pnpm typecheck && pnpm lint && pnpm
format:check && pnpm unused && pnpm test` on its own. Releases: units 1-2
are a patch, 3-6 are additive minors, 7-10 land on main unreleased and ship
together as **4.0.0, the only release that carries breaks**.

| #   | Unit                                                                                                                                                                                                                                                                                                  | Proof beyond the standard chain                                                                                                                                 | Semver                                                                                              | ADR                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | Internal subtraction: finish the ReviewModel split (`GateTriage.ts:10`, `OracleGuard.ts:6`, `Evidence.ts:4`, `SpecChecks.ts:4` import from `ReviewModel`), break `Survey ↔ GraphRules`; `unused-modules.mjs` skips `packages/shell/{flows,kits}`                                                      | a cycle scan added to `pnpm unused` reports 0                                                                                                                   | patch                                                                                               | no                        |
| 2   | Derive package lists in `set-version.mjs` and `pack-smoke.mjs` from `packages/*/package.json`                                                                                                                                                                                                         | `pnpm build && node scripts/pack-smoke.mjs`                                                                                                                     | patch                                                                                               | no                        |
| 3   | `packages/engine` created from `flows/` as-is; shell built-in tier reads `@llm4ts/engine/dist/bin`; delete `sync-shell-flows.mjs:28-84`; entries export `runEpicStories`, `runTaskforce`, `runRoundtable`                                                                                             | pack smoke installs six packages and runs `llm4ts list`, `llm4ts view implement`, `llm4ts run hello` with the mock coder; `flows/test` passes from its new home | minor (new package; `node_modules/@llm4ts/shell/flows` disappears, noted like 0.17.0 did for packs) | **ADR 0049**, amends 0006 |
| 4   | `eventTraits` + `consume`; Terminal, RunReaders, Retro, Profile, AgentTree and the five consumer loops read them                                                                                                                                                                                      | existing Terminal, AgentTree, Profile golden tests unchanged; one new test: every tag has a row                                                                 | minor, no surface removed                                                                           | no (no behaviour change)  |
| 5   | `connectors` table in core; derive runner, shell, js lists                                                                                                                                                                                                                                            | a test that `llm4ts doctor` lists exactly `connectors`; existing connector tests                                                                                | minor                                                                                               | no                        |
| 6   | `flowMain`, `RunConfig`, checked seats; move `reasonerFromEnvironment`/`storyCoderFromEnvironment` (`flows/lib/epic-stories.ts:824-853`) to runner; convert the `bin/` scripts                                                                                                                        | smoke tests assert `--verbose` changes output; a docs test checks `docs/configuration.md` against `RunConfig` plus the flow `Flags` schemas                     | minor; `--verbose` starts working (changelog)                                                       | ADR 0049 section          |
| 7   | Move product modules flow → engine (40 modules / 16,331 lines) with `git mv` and an import rewrite                                                                                                                                                                                                    | `git diff -M` shows renames only; no `packages/flow/src` file imports engine                                                                                    | major                                                                                               | ADR 0049                  |
| 8   | Move runner offline readers → shell, product modules → engine, `OperatorSchemas` → shell, `McpServer` → runner; delete `Classified`/`Declassified`                                                                                                                                                    | lint rule: runner imports nothing from engine or shell                                                                                                          | major                                                                                               | ADR 0049                  |
| 9   | Entry-point layout: top-level entry files, subdirectories internal, `check-exports.mjs`, lint rule against deep package imports, reachability-based `pnpm unused` without `ALLOWED`, pass-through re-exports removed (`Flow.ts:58`, `Gates.ts:15`, `Pack.ts:13`, `Judgment.ts:33`, `Taskforce.ts:15`) | pack smoke imports every entry and asserts one former deep subpath fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`                                                   | major                                                                                               | ADR 0049                  |
| 10  | Migration: `legacySubpaths` table, `scripts/codemod-imports.mjs`, ResolveFallback redirect, `docs/migration-4.md`, skills and guides regenerated                                                                                                                                                      | run the codemod on a 3.2.5 copy of `kits/` and `examples/`; typecheck passes                                                                                    | major                                                                                               | no                        |
| 11  | After 4.0.0: `decorateSeat` in flow, single context builder in `FlowRunner.ts` (fixes the `deniedPaths` drift at `:886` vs `:645`)                                                                                                                                                                    | a test that roster and plain runs pass identical denied paths                                                                                                   | patch                                                                                               | no                        |

Cost estimate for one maintainer: units 1-6 are about a week of agent-driven
work; 7-10 are mechanical but touch roughly 400 files and every doc excerpt,
about another week including the codemod.

## 5. Repo cleanup (separate from the code plan)

Verified in this run unless marked G (taken from the hygiene grounding).

| Item                                                                               | Action                                                 | Evidence                                                                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `docs/superpowers/plans/*.md` (14 files, about 900 KB G)                           | delete                                                 | `git grep -l -F <basename>` returns nothing outside the file itself for all 14                        |
| `tools/prototype/watch-tui.ts`                                                     | delete                                                 | only reference is one superpowers plan                                                                |
| `tools/loop/` (8 files)                                                            | delete                                                 | referenced only from `specs/completed/*`; pinned to 0.1.4 G; ralph is the documented loop (CLAUDE.md) |
| `plan.md`, `docs/csp/`, `docs/CSP_STATUS.md`, `docs/parity.md`                     | move to `docs/history/`; fix `README.md:254-255`       | CLAUDE.md calls them frozen                                                                           |
| `docs/migration-from-llm4zio.md`                                                   | move to `docs/history/`; fix `README.md:249`           | parity is no longer a goal (CLAUDE.md)                                                                |
| `specs/architecture/overview.md`                                                   | delete                                                 | lines 9 and 11 send agents to `docs/csp/` and `docs/parity.md`, against CLAUDE.md                     |
| `docs/research/oh-my-claudecode-improvements-2026-10-22.md`                        | delete or keep with a "not adopted" header             | 0 references G                                                                                        |
| `docs/presentation/marvin-gen.py`                                                  | delete                                                 | 0 references, hardcoded home path G                                                                   |
| `.env.example:7,34`                                                                | fix path to `examples/api-provider.ts`                 | `packages/examples` does not exist                                                                    |
| `package.json:30` `@effect/language-service: "latest"`                             | pin                                                    | every other effect dependency is exact                                                                |
| `tsx` used by `judgment:*` scripts                                                 | declare, or run with `node --experimental-strip-types` | undeclared G                                                                                          |
| `flows/package.json` scripts                                                       | disappears with unit 3                                 | already missing epic-retro, pack-fork, roundtable, taskforce                                          |
| `flows/dist/`                                                                      | local delete only                                      | gitignored (`.gitignore:2`); holds stale `convert-all`, `convert-page` output                         |
| `packages/*/test/support/RecordingTracer.ts` (flow, runner)                        | one copy exported from `@llm4ts/flow/testing`          | identical md5                                                                                         |
| `packages/shell`                                                                   | add LICENSE and README                                 | the other four have both G                                                                            |
| `tools/ralph` verification chain                                                   | add `pnpm unused`                                      | CLAUDE.md lists it; the script does not G                                                             |
| `examples/test/skills-sync.test.ts:48`                                             | check all five skills                                  | checks three G                                                                                        |
| `specs/pending` rehearsal specs (6-7)                                              | move to `specs/rehearsals/`                            | their own text says they are not loop work G; moving specs is the owner's call (CLAUDE.md)            |
| `packages/js/package.json`                                                         | drop the `@llm4ts/flow` dependency                     | `Client.ts` imports only core and runner G                                                            |
| local only: merged `.claude/worktrees/*`, `repos/` (84 MB), July `.llm4ts/` traces | remove                                                 | untracked; unreferenced G                                                                             |

Correction to the grounding: the three `Package.ts` files are not
byte-identical (md5 differs; the package name line differs). `Classified` has
no importer; `flows/port-ledger.ts` defines its own unrelated class of that
name.
