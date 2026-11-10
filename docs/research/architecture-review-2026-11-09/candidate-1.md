# Candidate 1: subtract and deepen in place

Thesis: the package graph `core → flow → runner → js/shell` is right and has
no violations. The cost is accretion inside the packages: dead modules kept by
an allowlist, the connector list hand-copied into about fourteen places,
eight event-tag switches each interpreting the run their own way, five copies
of the event-consumer loop, environment parsing spread over 88 files, and 219
public subpaths of which 40 serve no caller outside their package. Keep the
five packages and the layout. Delete first. Then give each repeated mechanism
one deep owner in the package that already owns it, and make the compiler or a
script fail when a list would drift again.

Measured at 894506cd unless marked _estimate_.

## Problem

Constraints the shape must honour:

- **Every module is public**: the exports maps mirror `src`, 219 subpaths
  (core 57, flow 106, runner 38, js 2, shell 16), so any removal is
  semver-major. 3.0.0, three days ago, was a removal release and kept `Mermaid`
  and `McpStdio` "by decision" (`scripts/unused-modules.mjs:22-23`).
- **In-repo builds ignore the exports map**: `tsconfig.json:5-12` and
  `vitest.config.ts:9-15` alias every `@llm4ts/x/*` to `src`. Only Node at
  runtime and `scripts/pack-smoke.mjs` see the map, so "internal" needs its own
  check.
- **The shell reaches the flow child only through env vars**
  (`shell/src/Cli.ts:202-218`); ADR 0006:86 names `coderFromEnv`.
- **Two fingerprint encodings key on-disk caches**: `runner/ReviewFingerprint.ts:3`
  (4-byte length prefix) and `flow/ReviewCache.ts:9` (`len:` prefix). Unifying
  them invalidates one family once.

User-visible symptoms of the drift:

- **`llm4ts run --verbose` does nothing**: the shell sets `LLM4TS_VERBOSITY`
  (`Cli.ts:208`), `runWithBundle` uses `options.verbosity ?? "Normal"`
  (`FlowRunner.ts:1010`), and no flow passes it.
- **The roster judgment seat drops `deniedPaths`** (`FlowRunner.ts:886`); the
  other five seat sites pass it (`:625, :628, :632, :645, :805`).
- **Seat variables mean different things per flow**: `LLM4TS_CODER_MODEL` is
  read only by the epic-stories engine, local and sdd; `LLM4TS_CODER_FLAGS`
  only by `lib/epic-stories.ts:863`; and 21 flow scripts (18 + 3 in kits) use
  the unchecked `coderFromEnv`, which silently runs claude on an unknown name
  (`runner/Connectors.ts:265`).
- **Booleans parse per variable**: `FlowRunner.ts:266` rejects `on`, so
  `LLM4TS_GEMINI_BRIDGE=on` is ignored; `Connectors.ts:166` and `Otel.ts:24`
  accept it.
- **`llm4ts profile` cannot see roundtable or taskforce lanes**: lanes open by
  stage-name strings (`Stories.ts:2503`, `lib/roundtable.ts:491`,
  `lib/taskforce.ts:937`); `AgentTree.ts:283` parses all three, `Profile.ts:207`
  only `story`.

## Usage (caller's view)

**A flow author writing `flows/*.ts`.** There are fewer names to learn, and the
same environment means the same thing in every flow:

```ts
// flows/modernize-review.ts, after
import * as Effect from "effect/Effect"
import {
  asReadOnly,
  envInt,
  resolveFlowInput,
  runFlowMain,
  runNode,
  seatsFromEnvironment
} from "@llm4ts/runner"

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("Review the modernized service against its spec pack.")
  // LLM4TS_CODER / _MODEL / _FLAGS and LLM4TS_REASONER / _REASONING_MODEL / _FLAGS,
  // checked: an unknown name is a ScriptUsage naming every coder llm4ts knows.
  const { coder, reasoner } = yield* seatsFromEnvironment({ coder: "claude" })
  const rounds = yield* envInt("LLM4TS_JUDGE_ROUNDS", { default: 2, min: 1 })
  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder,
      reasoning: asReadOnly(reasoner),
      reviewers: [asReadOnly(reasoner)]
      // `environment: process.env` is gone: it was always the default (FlowRunner.ts:521, :1009)
    },
    (context) => reviewProgram(context, rounds)
  )
})
runFlowMain(program)
```

The epic family writes `seatsFromEnvironment({ coder: "pi", reasoner: "claude" })`
and deletes its private copies (`lib/epic-stories.ts:824-878`). sdd writes
`seatsFromEnvironment({ coder: "gemini", coderModel: "gemini-2.5-flash", reasoner: "gemini", reasonerModel: "gemini-3-pro-preview" })`.

**A maintainer adding a connector.** There is one row, and the compiler demands
two more edits:

```ts
// packages/core/src/Models.ts: the identity row
Kimi: { id: "kimi", kind: "Cli", executable: "kimi", aliases: ["kimi"] },
// packages/core/src/providers/ConnectorFactories.ts: missing key is a type error
Kimi: cli((config, deps) => makeKimiConnector(config, deps.process)),
// packages/runner/src/Connectors.ts: missing preset is a type error
Kimi: CliConnectorConfig.make({ connectorId: ConnectorIds.Kimi }),
```

Everything else is derived from the row: `coderIds`, the shell's
`coderChoices`, the `FlowHelp` coder list, the error messages, doctor's
credential keys, `JsProvider` for API rows, the default base URLs, and the
binary that `versionProbe` spawns.

**A maintainer adding a flow event.** Add the class and its union member. The
build then fails in exactly two exhaustive tables until the event is classified:

```ts
// flow/src/FlowEvents.ts
GateRetried: unlaned,                                   // or stampLane(GateRetried) if it can carry a lane
// runner/src/EventPresentation.ts (internal)
GateRetried: { line: "Verbose", kind: "a gate retry" }  // + digest when `llm4ts watch` should show it
```

Terminal, AgentTree, Profile, RunReaders, Retro and `withLane` read these
tables. None of them keeps its own list.

**An npm consumer importing subpaths.** Nothing they read about in
`docs/api.md` moves:

```ts
import { implementPlanFlow } from "@llm4ts/flow/Flow" // unchanged
import { makeClaudeCliConnector } from "@llm4ts/core/providers/ClaudeCliConnector" // unchanged
import { runNode, fingerprintOf } from "@llm4ts/runner" // 4.0: fingerprintOf replaces reviewFingerprint
import { guarded } from "@llm4ts/flow/CapabilityGuard" // 4.0: ERR_PACKAGE_PATH_NOT_EXPORTED (internal)
createClient({ provider: "lmstudio", model: "qwen3" }) // 4.0: aliases accepted, as LLM4TS_PROVIDER does
```

## Shape

Five owners, each in the package that already holds the knowledge. Each turns
a hand-synced list into a derivation or a compile error (per
single-source-of-truth).

1. **Connector identity: `connectorTable` in `core/src/Models.ts`.** One row per
   connector, keyed by today's `ConnectorIds` names: id, kind, provider, default
   base URL, credential variables, aliases, executable.
   - Derived from it: `ConnectorIds`, the id arrays, `defaultBaseUrl`,
     `connectorProvider`, `providerConnectorId` (`Models.ts:22-129`), the
     credential keys (`Connectors.ts:133`, `Doctor.ts:18`, `FlowArgs.ts:39`),
     the aliases (`Connectors.ts:190, :226, :243`, `CoderChoice.ts:15`,
     `js/Client.ts:17, :88`, `FlowArgs.ts:33`) and the binaries
     (`cursor-agent` appears 4 times in `CursorConnector.ts:87-139`).
   - The factories (`ConnectorFactories.ts:83-129`) and runner presets become
     `{ [K in ConnectorName]: … }` records, so a missing entry is a type error.
   - Implementations stay out of the table: core's contract layer must not
     import providers.

2. **Seat construction: `seatsFromEnvironment` in `runner/src/Connectors.ts`.**
   It generalizes the checked `coderFromEnvironment` (`:278`) and replaces
   `coderFromEnv` (`:268`), `reasonerFromEnvironment`/`storyCoderFromEnvironment`
   (`lib/epic-stories.ts:824-853`), `flagsFromEnvironment` (`:863`) and the
   reasoner read in `kits/soap-ace/flows/soap-design.ts:74`. One rule, written
   once: the reasoner is `LLM4TS_REASONER`, else the flow's default, else the
   coder. Inside FlowRunner one local `seat(config, workDir)` serves all six
   resolutions, which makes the `:886` drift unrepresentable.

3. **Run configuration: `runner/src/RunConfig.ts` (new, public).**
   - `RunConfig` is a `Schema.Class` over the ~22 variables the shell writes
     and the runner reads; `runVariables` maps field to name exhaustively.
     The runner decodes it once; the shell encodes with the same codec
     (replacing `Cli.ts:202-218`), so `--verbose` cannot be lost again.
     Secrets such as `LLM4TS_GEMINI_BRIDGE_TOKEN` decode as `Redacted`.
   - `envFlag`/`envInt`/`envString` give flow-level knobs one grammar and a
     typed `ScriptUsage` naming the variable. They replace five boolean
     parsers (`FlowRunner.ts:266, :269`, `Otel.ts:24`, `Doctor.ts:59`,
     `Connectors.ts:166`, `NodePreflight.ts:229`) and ≥16
     `Number.parseInt(env…)` sites, including three different parses of
     `LLM4TS_JUDGE_ROUNDS` (`lib/epic-stories.ts:411`,
     `modernize-implement.ts:69`, `convert.ts:489`).
   - Flow scripts cannot be imported as data, so docs are checked rather than
     derived: a docs-sync test fails when a `LLM4TS_*` literal in production
     code is missing from `docs/configuration.md` (96 in code, 53 listed, 11
     in no living markdown).

4. **Events: `flow/src/FlowEvents.ts` plus one internal runner table.**
   - `hub.consume(name, handle)` is the one consumer loop (replacing
     `CostTracker.ts:169`, `FlowRecorder.ts:115`, `JudgmentLog.ts:75`,
     `Terminal.ts:750/803`, `AgentTreeSurface.ts:114`). It subscribes before
     seeding its counter; JudgmentLog does the reverse, a race.
     `hub.drained()` replaces the hand-listed drain (`FlowRunner.ts:1165-1179`)
     and names laggards for the warning at `:1188`.
   - `eventLanes`, exhaustive per tag, replaces the `stamped` switch
     (`FlowEvents.ts:577-688`) and three `laneOf` copies (`Terminal.ts:566`,
     `Profile.ts:233`, `Retro.ts:189`), which have drifted already: `Timed`
     and `Began` are stamped but missing from Terminal's list.
     `openLane`/`laneOpened` own the stage-name protocol both ways; the trace
     format is unchanged.
   - `eventPresentation`, exhaustive and runner-internal (screen policy is
     presentation), replaces `Terminal.rendersEvent` (`:34-72`),
     `RunReaders.meaningfulKinds`/`textOf` (`:149-202`) and `Profile.describe`
     (`:236-291`). Rendering a line's content stays in Terminal.

5. **Public surface: `scripts/unused-modules.mjs`, deepened.** A module whose
   first line is `// @internal: <reason>` is not exported; the script derives
   every `exports` map (`--write` regenerates, default checks). It also fails
   on an outside import of an internal module (closing the alias hole), on an
   intra-package cycle, and on transitively dead modules (`AgentSession` looks
   alive only because the dead `ClaudeAgentSession` imports it). It skips the
   gitignored `packages/shell/{flows,kits}` copies. This is also the
   prerequisite for `specs/pending/duplication-and-dead-export-gates.md`: once
   internals are not entry points, knip can see their unused exports.

**Depth.** New public names: `seatsFromEnvironment`, `envFlag`/`envInt`/
`envString`, `RunConfig` and its two codecs, `hub.consume`/`hub.drained`, and
`fingerprintOf` moving into the barrel. Behind them sit alias resolution, three
variable families, one grammar, typed failures, drain accounting and the lane
protocol. Public subpaths go from 219 to 180.

## Synthesis decision

## Tradeoffs accepted

- We accept **a 4.0.0 three days after 3.0.0** in exchange for carrying every
  break once; fixes ship first as 3.2.6, additive owners as 4.x minors.
- We accept **one cold review cache for the modernize and convert flows** in
  exchange for one fingerprint, the flow-internal `fingerprintOf`, which also
  keys the GateTriage baselines we must not invalidate.
- We accept **two event tables** (flow lanes, runner presentation) in exchange
  for keeping screen policy out of flow; both are exhaustive over
  `FlowEvent["_tag"]`, so the compiler keeps them in step.
- We accept **a marker comment rather than an `internal/` folder** in exchange
  for an unchanged layout; a failing check backs it.
- We accept that **`stampLane` rows keep their per-event logic**
  (TaskStarted's parallel executor, ToolUse's workDir stripping); the win is
  exhaustiveness, not lines.
- We accept **fail-fast on malformed values**; `judgeRoundsOption` falls back
  silently today (`lib/epic-stories.ts:401`).

## Alternatives considered

- **Redraw the boundaries** (Profile, Graph, StoryReaders into shell;
  Transport, Auth into runner). Cleaner per-package story, but it moves ~4k
  lines (_estimate_), breaks subpaths, and removes no duplicate: every
  hand-synced list survives the move.
- **Wildcard `"./*"` export with a `null` `internal/` folder.** Node enforces
  it, but it breaks CLAUDE.md's explicit-exports rule, moves files, and still
  needs the in-repo check because of the aliases.
- **One shared run-state fold for Terminal, AgentTree and Profile.** Deeper,
  400–700 lines saved (_estimate_), but Terminal's live in-flight tokens are
  not in `reduceTree` and nobody has diffed the semantics. Kept as optional
  unit 14 behind golden traces.
- **A `flowMain(spec, body)` entry** that also resolves input and seats.
  Shorter call sites, but a second way to start a flow beside
  `runNode`/`runFlowMain`, and the 41 `runNode` sites differ too much in their
  pre-run work (epic-design, roundtable, modernize-seed).

## Open questions and risks

1. Delete `Mermaid` and `McpStdio` in 4.0, reversing the 3.0.0 "kept by
   decision"? `flow/McpServer` stays either way: the Gemini bridge uses it.
2. Delete `ClaudeAgentSession` (230 + 69 lines, tests its only importers)
   while ADR 0035 is still Proposed? Git keeps it.
3. Does a sibling project import `@llm4ts/flow/BasecampTool`? If not, 581
   dead lines; this repo cannot tell.
4. Is one re-review of in-flight modernization estates acceptable (tradeoff
   2)? If not, keep the binary encoding as `fingerprintOf` and invalidate
   flow's own caches, triage baselines included, instead.
5. `copilot` is a connector (`Models.ts:33`, `ConnectorFactories.ts:120`) but
   not selectable as a coder (absent from `coderAliases`, `coderChoices`,
   `FlowHelp`). Intended? The table makes it explicit (`aliases: []`).
6. `pages.yml:44` publishes all of `docs/presentation/`, including
   `marvin-gen.py` and the internal pitch decks. Intended?
7. Risk: unit 7 rewrites the tests of the 18 internalized modules to
   `../src/X.ts` (flow tests use `@llm4ts/flow/` 270 times). Mechanical, wide.
8. Risk: after unit 1, `LLM4TS_VERBOSITY: "quiet"` in
   `flows/test/support/smoke.ts:237` takes effect; output assertions may move.

## Next implementation step

Fix `--verbose` in `runWithBundle` and route all six seat resolutions through
one local `seat(config, workDir)` in `makeFlowRunnerContext`, each with a
FlowRunner test, and ship that as 3.2.6.

---

## Type and signature sketches

```ts
// ---- core/src/Models.ts: connector identity --------------------------------
declare function notImplemented(): never

interface ApiRow {
  readonly id: string
  readonly kind: "Api"
  readonly provider: LlmProvider
  readonly baseUrl?: string
  /** Credential variables, first set wins. Read by enrichApiConnector and doctor; never printed. */
  readonly apiKeyEnv?: ReadonlyArray<string>
  /** Names LLM4TS_PROVIDER and the js facade accept besides `id`. */
  readonly aliases: ReadonlyArray<string>
}
interface CliRow {
  readonly id: string
  readonly kind: "Cli"
  /** What versionProbe and the interactive argv spawn, and what the shell looks for on PATH. */
  readonly executable: string
  /** Names LLM4TS_CODER / LLM4TS_REASONER accept; empty = not offered as a coder (copilot). */
  readonly aliases: ReadonlyArray<string>
  readonly provider?: LlmProvider // GeminiCli only
}
export type ConnectorRow = ApiRow | CliRow

export const connectorTable = {
  OpenAI: {
    id: "openai",
    kind: "Api",
    provider: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: ["OPENAI_API_KEY"],
    aliases: []
  },
  GeminiApi: {
    id: "gemini-api",
    kind: "Api",
    provider: "GeminiApi",
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKeyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    aliases: ["gemini"]
  },
  LmStudio: {
    id: "lm-studio",
    kind: "Api",
    provider: "LmStudio",
    baseUrl: "http://localhost:1234/v1",
    aliases: ["lmstudio"]
  },
  AntigravityCli: {
    id: "antigravity-cli",
    kind: "Cli",
    executable: "agy",
    aliases: ["agy", "antigravity"]
  },
  Cursor: { id: "cursor", kind: "Cli", executable: "cursor-agent", aliases: ["cursor"] },
  Copilot: { id: "copilot", kind: "Cli", executable: "copilot", aliases: [] }
  // … one row per connector; 16 today
} as const satisfies Record<string, ConnectorRow>

export type ConnectorName = keyof typeof connectorTable
type RowOf<K extends ConnectorName> = (typeof connectorTable)[K]
export type CliName = { [K in ConnectorName]: RowOf<K> extends CliRow ? K : never }[ConnectorName]
/** Every string LLM4TS_CODER accepts: CLI ids and aliases. */
export type CoderName = { [K in CliName]: RowOf<K>["id"] | RowOf<K>["aliases"][number] }[CliName]
export type ApiProviderName = {
  [K in ConnectorName]: RowOf<K> extends ApiRow
    ? RowOf<K>["id"] | RowOf<K>["aliases"][number]
    : never
}[ConnectorName]

/** Derived; same public value as today (Models.ts:22). */
export const ConnectorIds: { readonly [K in ConnectorName]: ConnectorId } = notImplemented()
export const connectorRow = (id: ConnectorId): ConnectorRow | undefined => notImplemented()
export const coderNamed = (name: string): CliName | undefined => notImplemented()
export const apiProviderNamed = (name: string): ConnectorName | undefined => notImplemented()
export const coderNames: ReadonlyArray<CoderName> = notImplemented()
export const apiProviderNames: ReadonlyArray<ApiProviderName> = notImplemented()
export const credentialVariables: ReadonlyArray<string> = notImplemented() // doctor + FlowHelp

// ---- core/src/providers/ConnectorFactories.ts ------------------------------
type FactoryFor<R extends ConnectorRow> = (
  deps: ConnectorFactoryDependencies
) => (config: R extends CliRow ? CliConnectorConfig : ApiConnectorConfig) => ConnectorShape
/** Exhaustive: a row without a factory is a type error. */
declare const factories: { readonly [K in ConnectorName]: FactoryFor<RowOf<K>> }

// ---- runner/src/Connectors.ts: seats ---------------------------------------
/** Exhaustive presets (edit-capable flags for claude/codex/antigravity live here). */
declare const presets: { readonly [K in ConnectorName]: ConnectorConfig }

export interface SeatDefaults {
  readonly coder: CoderName
  readonly coderModel?: string
  /** Default for LLM4TS_REASONER; omitted = the coder's choice. */
  readonly reasoner?: CoderName
  readonly reasonerModel?: string
}
export interface Seats {
  readonly coder: CliConnectorConfig
  readonly reasoner: CliConnectorConfig
}
/**
 * The one reading of seat variables: LLM4TS_CODER, _CODER_MODEL, _CODER_FLAGS,
 * LLM4TS_REASONER, _REASONING_MODEL, _REASONING_FLAGS. Unknown names fail typed,
 * listing `coderNames`. Flags parse `key=value;key` (first `=` splits).
 */
export const seatsFromEnvironment = Effect.fn("@llm4ts/runner/Connectors.seatsFromEnvironment")(
  function* (
    defaults: SeatDefaults,
    environment: Environment = process.env
  ): Effect.fn.Return<Seats, ScriptUsage> {
    return notImplemented()
  }
)
// coderFor / apiPresetFor / apiConnectorFromEnvironment / judgmentConnectorFromEnvironment
// keep their signatures; their bodies read connectorTable. coderFromEnv, coderFromEnvironment: removed in 4.0.

// ---- runner/src/RunConfig.ts (new, public) ---------------------------------
export type Environment = Readonly<Record<string, string | undefined>>
export type EnvName = `LLM4TS_${Uppercase<string>}`

export class RunConfig extends Schema.Class<RunConfig>("RunConfig")({
  verbosity: Verbosity, // LLM4TS_VERBOSITY, default Normal
  ui: Schema.Literals(["classic", "tree"]), // LLM4TS_UI
  transcript: Schema.Boolean, // LLM4TS_TRANSCRIPT
  otel: Schema.Boolean, // LLM4TS_OTEL
  otelContent: Schema.Literals(["off", "on", "full"]), // LLM4TS_OTEL_CONTENT
  timestamps: Schema.Boolean, // LLM4TS_TIMESTAMPS
  isolated: Schema.Boolean, // LLM4TS_ISOLATED
  estimateUsage: Schema.Boolean, // LLM4TS_ESTIMATE_USAGE
  judgmentBackend: Schema.Literals(["llm", "typesafe"]), // LLM4TS_JUDGMENT_BACKEND
  judgmentBatching: Schema.Literals(["independent", "shared-prefix"]),
  geminiBridge: Schema.Boolean,
  geminiBridgeToken: Schema.optionalKey(Schema.Redacted(Schema.String)), // never printed
  roster: Schema.optionalKey(Schema.String),
  executors: Schema.optionalKey(Schema.String),
  pack: Schema.optionalKey(Schema.String),
  flow: Schema.optionalKey(Schema.String),
  runId: Schema.optionalKey(Schema.String),
  tracePath: Schema.optionalKey(Schema.String)
  // … the rest of the ~22 shell↔runner variables
}) {}

/** Field ↔ variable, exhaustive: a field with no variable does not compile. */
export const runVariables: { readonly [K in keyof RunConfig]: EnvName } = notImplemented()
/** Decoded once per run in makeFlowRunnerContext; FlowRunnerOptions fields still win. */
export const runConfigFromEnvironment = (
  environment: Environment
): Effect.Effect<RunConfig, ScriptUsage> => notImplemented()
/** What the shell's `run` flags forward (replaces Cli.ts:202-218). */
export const runConfigToEnvironment = (
  config: Partial<RunConfig>
): Readonly<Record<string, string>> => notImplemented()

/** One grammar: on|1|true|yes / off|0|false|no; anything else is a ScriptUsage naming the variable. */
export const envFlag = (
  name: EnvName,
  options: { readonly default: boolean },
  environment?: Environment
): Effect.Effect<boolean, ScriptUsage> => notImplemented()
export const envInt = (
  name: EnvName,
  options: { readonly default: number; readonly min?: number; readonly max?: number },
  environment?: Environment
): Effect.Effect<number, ScriptUsage> => notImplemented()
export const envString = (name: EnvName, environment?: Environment): string | undefined =>
  notImplemented()

// ---- flow/src/FlowEvents.ts: consumption ------------------------------------
export interface HubConsumer {
  /** Bounded wait until this consumer handled everything published so far. */
  readonly drained: (timeout?: Duration.Input) => Effect.Effect<boolean>
}
export interface FlowEventHub extends FlowEventsShape {
  readonly subscribe: Effect.Effect<PubSub.Subscription<FlowEvent>, never, Scope.Scope>
  readonly stream: Stream.Stream<FlowEvent>
  readonly publishedCount: Effect.Effect<number>
  /**
   * The single consumer loop. Invariant: subscribes, then seeds `consumed` from
   * publishedCount, so a late consumer can still drain. Registered by name for `drained`.
   */
  readonly consume: (
    name: string,
    handle: (event: FlowEvent) => Effect.Effect<void>
  ) => Effect.Effect<HubConsumer, never, Scope.Scope>
  /** Every registered consumer caught up; returns the names that did not. */
  readonly drained: (timeout?: Duration.Input) => Effect.Effect<ReadonlyArray<string>>
}

// ---- flow/src/FlowEvents.ts: lanes ------------------------------------------
type Tag = FlowEvent["_tag"]
type EventOf<K extends Tag> = Extract<FlowEvent, { readonly _tag: K }>
export interface LaneTags {
  readonly lane: string
  readonly executor?: string
  readonly clone?: number
  readonly workDir?: string
}
export type LaneRule<E> = "unlaned" | ((event: E, tags: LaneTags) => E)
/** Exhaustive: a new event fails to compile until it says whether it carries a lane. */
export const eventLanes: { readonly [K in Tag]: LaneRule<EventOf<K>> } = notImplemented()
export const laneOf = (
  event: FlowEvent
): { readonly lane: string; readonly executor?: string } | undefined => notImplemented()

export type LaneKind = "story" | "attendee" | "specialist"
/** The StageStarted/StageCompleted pair that opens and closes a lane; trace format unchanged. */
export const openLane = (kind: LaneKind, id: string): StageStarted => notImplemented()
export const closeLane = (kind: LaneKind, id: string): StageCompleted => notImplemented()
export const laneOpened = (
  event: FlowEvent
): { readonly kind: LaneKind; readonly id: string } | undefined => notImplemented()

// ---- runner/src/EventPresentation.ts  (// @internal: screen policy) ---------
export interface Presentation<E> {
  /** Lowest verbosity that prints the event as its own line. */
  readonly line: "Never" | Verbosity | ((event: E, verbosity: Verbosity) => boolean)
  /** The event by kind, never content (profile gaps). */
  readonly kind: string
  /** Present = shown by `llm4ts watch` and the MCP run digests. */
  readonly digest?: (event: E) => { readonly text: string; readonly lane?: string }
}
export const eventPresentation: { readonly [K in Tag]: Presentation<EventOf<K>> } = notImplemented()
export const rendersEvent = (verbosity: Verbosity, event: FlowEvent): boolean => notImplemented()

// ---- flow/src/ReviewCache.ts: one fingerprint --------------------------------
/** The only fingerprint; re-exported by the runner barrel in place of reviewFingerprint. */
export const fingerprintOf = (parts: ReadonlyArray<string>): string => notImplemented()
```

```text
scripts/unused-modules.mjs  (`pnpm unused`, deepened; `--write` regenerates exports)
  derive exports(pkg) = { ".": index?, "./<Mod>": every src module without `// @internal` } + package.json
  fail if: manifest.exports ≠ derived
         | non-package file imports @llm4ts/<pkg>/<internal>
         | intra-package import cycle
         | module unreachable from a live entry (package root, bin, flows/kits/tools/examples), following
           imports transitively, unless ALLOWED names it (deliberate library API, e.g. eval/Checks)
  skip: packages/shell/{flows,kits} (gitignored build copies)
```

## Module map

| Area                                                                                                         | Before                                                                                    | After                                                                                         | Change (measured unless _estimate_)                                        |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| core `AgentSession`, `providers/ClaudeAgentSession`                                                          | 69 + 230 lines                                                                            | deleted                                                                                       | −299 src, −~51 test (`ClaudeCliConnector.test.ts:287-337`)                 |
| core `providers/{Anthropic,Gemini,LmStudio,Ollama,OpenAI}Models`                                             | exported wire types                                                                       | `@internal`                                                                                   | −5 subpaths                                                                |
| core `Models.ts` identity                                                                                    | 8 lists/switches (`:5-129`)                                                               | `connectorTable` + derivations; `"OpenCode"` provider residue (`:13, :85, :97, :126`) removed | _estimate_ −60 lines                                                       |
| core `ConnectorFactories.ts`                                                                                 | array of 16                                                                               | exhaustive record                                                                             | ~0 lines, now compile-checked                                              |
| flow `Classified` (+ `Declassified` event, `Terminal.ts:316`)                                                | 72 lines, second `guarded`                                                                | deleted                                                                                       | −72 src, −60 test, one event fewer                                         |
| flow `Mermaid`                                                                                               | 112 lines                                                                                 | deleted (Q1)                                                                                  | −112 src, −~50 test                                                        |
| flow `CapabilityGuard, CarriedNotes, Evidence, GraphRules, OracleGuard, Recheck, ReviewModel`                | exported                                                                                  | `@internal`                                                                                   | −7 subpaths                                                                |
| flow cycles Review↔GateTriage/OracleGuard, Survey↔GraphRules                                                 | 2 cycles                                                                                  | 0                                                                                             | `ReviewIssue`/`ReviewResult` from ReviewModel; `JoinMatch` into GraphRules |
| flow pass-through re-exports                                                                                 | `Flow.ts:58`, `Gates.ts:15` (`export *`), `Pack.ts:13`, `Taskforce.ts:15`                 | removed; `Judgment.ts:33` kept (JudgmentTypes is internal)                                    | one import path each                                                       |
| flow `FlowEvents.ts`                                                                                         | `stamped` switch (112 lines) + 5 consumer loops elsewhere                                 | `eventLanes`, `consume`, `drained`, lane protocol                                             | _estimate_ −80 lines across consumers                                      |
| runner `McpStdio`, `ReviewFingerprint`                                                                       | 41 + 13 lines                                                                             | deleted                                                                                       | −54 src, −28 test                                                          |
| runner `AgentTreeSurface, NodeGeminiCliExecutor, NodeGeminiModelBridge, RunSummary, WindowsCommand, Package` | exported                                                                                  | `@internal`                                                                                   | −6 subpaths                                                                |
| runner `RunConfig.ts`, `EventPresentation.ts`                                                                | none                                                                                      | new (public / internal)                                                                       | +1 subpath                                                                 |
| runner `FlowRunner.ts`                                                                                       | 1385 lines, 20 `LLM4TS_` reads, 6 seat sites                                              | reads `RunConfig`; one `seat()`                                                               | _estimate_ −60 lines                                                       |
| runner `Terminal/Profile/RunReaders`                                                                         | 3 switches + set (~190 lines)                                                             | read `eventPresentation`                                                                      | _estimate_ −80 lines                                                       |
| shell exports                                                                                                | 16 subpaths                                                                               | bin + `package.json` only                                                                     | −16 subpaths (`pack-smoke.mjs:80` updated)                                 |
| shell `CoderChoice.ts`                                                                                       | hand list (`:15`)                                                                         | derived from table                                                                            | −8 lines                                                                   |
| js `Client.ts`                                                                                               | `JsProvider` + switch (`:17, :88`), dependency on `@llm4ts/flow` unused                   | derived; dependency dropped                                                                   | −20 lines                                                                  |
| flows + kit flows                                                                                            | 21 `coderFromEnv`, 50 `environment: process.env`, 2 `positiveEnvInt`, ≥16 `parseInt(env)` | `seatsFromEnvironment`, `envInt`                                                              | _estimate_ −200 lines                                                      |
| Public subpaths                                                                                              | 219                                                                                       | 180                                                                                           | core 57→50, flow 106→97, runner 38→31, js 2, shell 16→0                    |

## Work plan

Fixes, then subtraction, then consolidation. Units 4–10 merge one at a time on
main and are tagged together as **4.0.0, the release that carries every
break**; 11+ are 4.x minors. Every unit runs `pnpm typecheck`, `lint`,
`format:check`, `unused`, `test`; units 4–10 also `pnpm build && node
scripts/pack-smoke.mjs`. Schedule the pending knip/jscpd spec after unit 7.

| #   | Unit                                        | Changes                                                                                                                                         | Proof                                                 | Semver                        | ADR                                            |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------- | ---------------------------------------------- |
| 1   | `--verbose` works                           | `FlowRunner.ts:1010` falls back to `LLM4TS_VERBOSITY`                                                                                           | new FlowRunner test; smoke output (risk 8)            | 3.2.6                         | no, restores `FlowArgs.ts:34`                  |
| 2   | One `seat()`                                | 6 seat sites; `:886` drift fixed                                                                                                                | roster test: judge config carries `deniedPaths`       | 3.2.6                         | no                                             |
| 3   | Repo cleanup                                | list below                                                                                                                                      | docs-sync, `unused`                                   | none                          | no                                             |
| 4   | Delete dead code                            | Classified + `Declassified`, Mermaid, McpStdio, ClaudeAgentSession + AgentSession, `LlmProvider "OpenCode"`; ALLOWED 7→3                        | `unused` fails on stale entries                       | major                         | amend 0035; CHANGELOG names the 3.0.0 reversal |
| 5   | Break cycles                                | 5 modules → ReviewModel; `JoinMatch` → GraphRules; eval type                                                                                    | cycle check in `unused`                               | none                          | no                                             |
| 6   | One fingerprint, no pass-throughs           | `ReviewFingerprint.ts` gone; barrel gains `fingerprintOf`, `structuredAndPublish`; 4 re-exports gone; local ESLint rule bans sibling re-exports | typecheck, lint, flows tests                          | major                         | no; CHANGELOG: one cold modernize cache        |
| 7   | Surface gate                                | `@internal` on 18 modules; shell bin-only; derived exports                                                                                      | `unused`, pack smoke                                  | major                         | **new: public surface = documented subpaths**  |
| 8   | Connector table                             | derivations; exhaustive factories and presets                                                                                                   | factory/preset/CoderChoice tests; type test per row   | major (`JsProvider` widens)   | no                                             |
| 9   | Seats                                       | `seatsFromEnvironment`; `coderFromEnv`, `coderFromEnvironment` and flow copies gone; 21 flows migrate                                           | Connectors tests (model, flags, unknown); flow smokes | major (unknown coder fails)   | **new: run configuration** (9–10); amend 0006  |
| 10  | Run config                                  | `RunConfig`, `env*`; shell encodes; parsers gone; `configuration.md` +43 rows                                                                   | docs-sync, FlowRunner, shell Cli tests                | major (malformed values fail) | same                                           |
| 11  | Event consumption                           | `hub.consume`/`drained`; 5 loops and manual drain gone                                                                                          | consumer tests; late-subscriber drain test            | 4.1                           | no                                             |
| 12  | Event tables, lane protocol                 | `eventLanes`, `eventPresentation`, `openLane`; 8 switches/sets gone                                                                             | renderer tests; Profile shows attendee lanes          | 4.1                           | no                                             |
| 13  | _optional_ one context builder              | plain path = roster of one (`FlowRunner.ts:650, :872`)                                                                                          | FlowRunner.test.ts green, unchanged                   | 4.x                           | no                                             |
| 14  | _optional_ Terminal lanes from `reduceTree` | `Terminal.ts:607-665`                                                                                                                           | golden-trace snapshots before/after                   | 4.x                           | no                                             |

## Repo cleanup (separate from the code plan)

| Item                                                                                             | Action                                                                                 | Evidence                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/superpowers/plans/` (14 files, ~0.9 MB)                                                    | delete                                                                                 | `git grep -F <basename>`: 0 inbound refs for each. Keep `specs/`: ADRs 0020, 0021, 0041, two pending specs and the marvin decks link them.                        |
| `tools/loop/` (8 files)                                                                          | delete                                                                                 | Outside `pnpm-workspace.yaml`; pins `@llm4ts/*` 0.1.x and `effect 4.0.0-beta.102`; refs only in `specs/completed/*`; its `CostLedger` import has other importers. |
| `tools/prototype/watch-tui.ts`                                                                   | delete                                                                                 | Only ref is a superpowers plan deleted above.                                                                                                                     |
| `specs/architecture/overview.md`                                                                 | delete; point `tools/ralph/RALPH_AUTO_PROMPT.md:21` at CLAUDE.md                       | Sends agents to `docs/csp/` and `docs/parity.md` (`:9-12`), which CLAUDE.md forbids; only ref is the Ralph prompt.                                                |
| `docs/presentation/marvin-gen.py`                                                                | move to `tools/presentation/`                                                          | 0 refs; hardcodes a local path (`:13, :15`); published by `pages.yml:44` (Q6).                                                                                    |
| `docs/migration-from-llm4zio.md`                                                                 | list as historical (`README.md:249`)                                                   | Parity retired in 3.0.0.                                                                                                                                          |
| `.env.example:7, :34`                                                                            | fix to `examples/api-provider.ts`                                                      | `packages/examples` is gone.                                                                                                                                      |
| `flows/package.json`                                                                             | add epic-retro, pack-fork, roundtable, taskforce; test every `flows/*.ts` has a script | 4 missing; `docs-sync.test.ts:213` reads this file.                                                                                                               |
| `scripts/set-version.mjs:17`, `pack-smoke.mjs:14`                                                | glob `packages/*` like `release.yml:55`                                                | Both hard-code five names.                                                                                                                                        |
| `package.json:30` language-service `"latest"`; undeclared `tsx` (`:22-27`)                       | pin; declare or use `node --experimental-strip-types`                                  | Every other Effect pin is exact; `tsx` is in no manifest.                                                                                                         |
| `packages/shell` README, LICENSE                                                                 | add                                                                                    | The other four ship both.                                                                                                                                         |
| `examples/test/skills-sync.test.ts:48`; Ralph chain                                              | cover 5 skills; add `pnpm unused`                                                      | Checks 3 of 5; 0 `unused` hits in ralph.                                                                                                                          |
| `RecordingTracer.ts` in flow and runner test support                                             | optional: keep one                                                                     | byte-identical.                                                                                                                                                   |
| Local, untracked: `repos/` (84 MB), 4 merged `.claude/worktrees/*`, stale `flows/dist/convert-*` | delete locally                                                                         | ignored; no refs; 0 commits ahead of main.                                                                                                                        |
