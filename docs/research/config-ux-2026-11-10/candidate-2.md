# Candidate 2: one settings table, the environment stays the wire

## Problem

llm4ts has 96 `LLM4TS_*` names read in 88 files in three styles, 43 of them
undocumented, 8 with a flag, none storable. The user repeats the same
prefixes on every command (`LLM4TS_PACK`, `LLM4TS_CODER` seven times each in
the docs), a typo is silently ignored, and a flow that lacks
`LLM4TS_LEGACY_REPO` finds out after it has started.

Constraints that shape the answer:

- Flow scripts are child processes that read `process.env` directly (58
  sites). The first release may not touch them, so whatever the shell
  resolves has to reach the child **as environment variables**.
- `packages/flow` itself reads about 15 of the names (`Workspace.ts`,
  `Context.ts`, `Stall.ts`, …). The owner of the names therefore cannot sit
  above flow; "`RunConfig` in runner" from the architecture review has to
  move one package down for its table, while its file I/O stays in runner.
- Kits and project flows are discovered at run time from directories
  (ADR 0014) and read their own names (`LLM4TS_SOAP_SERVICE`,
  `LLM4TS_ADO_*`). The shell must know those names without importing kit code.
- Four places start a flow child: `run`, `refine`, the menu, and the MCP
  `RunSupervisor`. A file layer added in one of them is a bug in the other
  three.
- Today's boolean readers do not agree on spelling (`LLM4TS_TIMESTAMPS`
  accepts only `1|true`; `LLM4TS_NODE_CHECK` wants `off`;
  `LLM4TS_ESTIMATE_USAGE` wants `0`). A file value `true` must be written to
  the child in the spelling that setting's current reader accepts.
- Defaults differ per flow (`LLM4TS_CODER` is `claude` everywhere and `pi` in
  epic-stories; `LLM4TS_TRANSCRIPT` is off everywhere and on in epic-stories).
  Exporting a registry default into the child would change behaviour.

This is the user-facing side of the review's `RunConfig`, not a second
mechanism: `RunConfig` **is** the resolved table, and `envFlag` / `envInt`
are the table's one grammar.

## Usage (caller's view)

### Fresh machine (once)

```console
$ llm4ts config init
llm4ts config: machine settings → ~/.config/llm4ts/config.json
? Coding agent  › claude (found)  codex (found)  gemini  pi (found)  …
? Reasoning agent (splits, reviews, judges)  › claude
wrote ~/.config/llm4ts/config.json
  coder     codex
  reasoner  claude
credentials stay in your environment: ANTHROPIC_API_KEY unset, OPENAI_API_KEY set
next: in a repository, `llm4ts config init` again sets its pack and paths
```

A user who already exports variables adopts them instead of retyping:

```console
$ llm4ts config init --from-env
adopted from the environment:
  coder        codex                 → ~/.config/llm4ts/config.json
  pack         j2ee-nextjs-spa       → .llm4ts/config.json
  legacy-repo  /work/legacy-estate   → .llm4ts/config.json
left in the environment:
  LLM4TS_WAVE=wave-1            a run setting: pass --set wave=wave-1
  LLM4TS_GEMINI_BRIDGE_TOKEN    a secret: never written to a file
you can now remove from your shell profile: LLM4TS_CODER LLM4TS_PACK LLM4TS_LEGACY_REPO
```

### Fresh repository (once)

```console
$ cd /work/nextjs
$ llm4ts config set pack j2ee-nextjs-spa
pack = j2ee-nextjs-spa   → .llm4ts/config.json (repo)
$ llm4ts config set legacy-repo ../legacy-estate
legacy-repo = /work/legacy-estate   → .llm4ts/config.json (repo, stored as ../legacy-estate)
```

`.llm4ts/config.json` after that, the whole format:

```json
{
  "legacy-repo": "../legacy-estate",
  "pack": "j2ee-nextjs-spa"
}
```

### The bank runbook, before and after

| Before                                                                                                                            | After (inside the repo, after the setup above)                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `LLM4TS_LEGACY_REPO=/path/to/legacy-estate llm4ts run convert-page --pack j2ee-nextjs-spa --repo /path/to/nextjs accountOverview` | `llm4ts run convert-page accountOverview`                                                                                 |
| `LLM4TS_LEGACY_REPO=~/estates/legacy llm4ts run modernize-seed --pack j2ee-nextjs-spa --repo ~/estates/nextjs`                    | `llm4ts run modernize-seed`                                                                                               |
| `LLM4TS_TARGET_REPO=~/estates/nextjs llm4ts run modernize-refine --pack j2ee-nextjs-spa --repo ~/estates/legacy`                  | `llm4ts run modernize-refine` (legacy repo holds `target-repo`)                                                           |
| `LLM4TS_CODER=codex llm4ts run implement "Add a multiply function…"`                                                              | `llm4ts run implement "Add a multiply function…"`                                                                         |
| `LLM4TS_WAVE=wave-1 llm4ts run modernize-extract`                                                                                 | `llm4ts run modernize-extract --set wave=wave-1`                                                                          |
| `LLM4TS_MARK_DEEPEN=1 llm4ts run modernize-pack-upgrade --pack j2ee-nextjs-spa --repo ~/estates/legacy`                           | `llm4ts run modernize-pack-upgrade --set mark-deepen=on`                                                                  |
| `LLM4TS_ROSTER=examples/epic-light.roster.json llm4ts run epic-stories --repo <path> -- --epic epic-light`                        | `llm4ts run epic-stories --roster examples/epic-light.roster.json --repo <path> -- --epic epic-light` (flag exists today) |
| `LLM4TS_GEMINI_BRIDGE=1 llm4ts doctor`                                                                                            | `llm4ts config set gemini-bridge on` once, then `llm4ts doctor`                                                           |

From outside the repo, `--repo /path/to/nextjs` still works and is where the
repo file is looked for. Every old line keeps working unchanged.

### Seeing what is in force

```console
$ llm4ts config show
llm4ts 3.3.0 · repo /work/nextjs
files  ~/.config/llm4ts/config.json        (user)
       /work/nextjs/.llm4ts/config.json    (repo)

Machine
  coder          codex                  user file
  reasoner       claude                 default
  roster         (user + repo files)    default
  transcript     off                    default
Project
  pack           j2ee-nextjs-spa        repo file
  legacy-repo    /work/legacy-estate    repo file
  gates          (the pack's gates)     default
  judge-rounds   3                      environment LLM4TS_JUDGE_ROUNDS   (overrides repo file: 2)
Secrets (environment only)
  ANTHROPIC_API_KEY            unset
  OPENAI_API_KEY               set      environment
  LLM4TS_GEMINI_BRIDGE_TOKEN   unset
warning: LLM4TS_JUDGE_ROUND is not an llm4ts setting; did you mean LLM4TS_JUDGE_ROUNDS?
61 more settings are at their defaults: `llm4ts config show --all`
```

Rules of that output: one line per setting that is set anywhere, plus the
handful marked `common`; three columns (name, effective value, source); a
shadowed layer is shown in parentheses; a secret prints `set`/`unset`, never a
value. `--all` adds the tuning tier, `--json` emits
`{name, env, value, source, kind, shadowed[]}` rows, `--flow convert-page`
narrows to what that flow reads, marks `required`, and applies that flow's
defaults.

```console
$ llm4ts config show legacy-repo
legacy-repo   path · project · LLM4TS_LEGACY_REPO · --set legacy-repo=<path>
  The legacy repository holding the approved spec pack.
  required by: convert-page, convert-feature, convert-all, modernize-seed
  value   /work/legacy-estate
    flag          —
    environment   —
    repo file     ../legacy-estate   (/work/nextjs/.llm4ts/config.json)
    user file     —
    default       —
```

### Failing before a token is spent

```console
$ llm4ts run convert-page accountOverview
convert-page cannot start: legacy-repo is not set.
  legacy-repo   The legacy repository holding the approved spec pack.
  set it for this repository:   llm4ts config set legacy-repo <path>
  or for this run only:         llm4ts run convert-page --set legacy-repo=<path>
  (LLM4TS_LEGACY_REPO in the environment also works)
looked in: flags, environment, /work/nextjs/.llm4ts/config.json (absent), ~/.config/llm4ts/config.json
$ echo $?
2
```

### Call sites in code

The shell, at all four launch sites, through `launchFlow`:

```ts
const settings =
  yield *
  settingsFor({
    flow: "convert-page", // undefined for `config show`
    workDir, // --repo, else cwd
    flags: { pack: "j2ee-nextjs-spa" }, // --pack, --verbose, --set k=v …
    environment: process.env,
    files: nodePlainFileStore,
    tiers: shellTierPaths()
  })
for (const line of settings.warnings) yield * Console.error(line)
yield * nodeFlowProcess.start({ flowPath, args, environment: settings.environment })
```

A reader, after it migrates (unit 7; nothing forces it earlier):

```ts
import { read } from "@llm4ts/flow/Settings"
import { S } from "@llm4ts/flow/SettingsRegistry"

const rounds = read(S.judgeRounds, environment) // number, default applied, one grammar
const deferTests = flag || read(S.deferTests, environment) // boolean
const legacy = read(S.legacyRepo, environment) // string | undefined
```

Adding a setting is one row:

```ts
// packages/flow/src/SettingsRegistry.ts
reviewVotes: int({
  kind: "project",
  tier: "tuning",
  section: "Review",
  default: 1,
  min: 1,
  doc: "Independent votes of the adversarial lens per review round.",
  flows: ["epic-stories", "port-files", "port-tests", "port-compile"]
}),
```

The name `review-votes`, the variable `LLM4TS_REVIEW_VOTES`, the file key, the
`--set` key, the docs row and the unknown-name dictionary all derive from the
key `reviewVotes`.

## Shape

### Five decisions that carry the design

1. **One name, three spellings, all derived.** A setting has one identity,
   its kebab name (`legacy-repo`). The variable is `LLM4TS_` + upper snake,
   the file key and the `--set` key are the name itself. No row may spell a
   second name, so there is no table mapping keys to variables to keep in
   sync (per single source of truth). All 96 existing names fit the rule by
   construction.
2. **The environment stays the only wire to the flow.** Resolution happens
   once, in the parent, and its result is projected into the child's
   environment. Flow scripts, kit flows and user flows need no change, ever;
   migrating a reader to `read(S.x, environment)` is an internal clean-up, not
   a protocol change. `runNode` gets no new input.
3. **Only values the user wrote are projected.** The child's environment is
   `base` plus settings whose source is a flag or a file. Defaults are shown
   by `config show` and printed in the docs but never exported, so a
   flow-specific default in today's code keeps winning until that reader
   migrates.
4. **`kind` says where a value may live.** `machine` and `project` values may
   be stored in either file (`config set` picks the user file for machine,
   the repo file for project); `run` values (wave, executors, fork-as, …)
   are refused by both files and by `config set`, so a stale `wave` cannot
   hide in a file; `internal` values (`flow`, `run-id`, `trace-path`) are set
   by the shell and refused everywhere; `secret` is a separate axis, refused
   by files, `config set` and `--set`. "Tuning" in the working classification
   is not a kind: it is a display tier (`common` | `tuning`) orthogonal to
   where the value lives.
5. **Requirements are data in the table, checked by the parent.** A flow's
   required settings are the rows whose `requiredBy` names it. The shell reads
   them without executing or importing the flow.

### Data structures

```ts
// packages/flow/src/Settings.ts — pure, imports only `effect`
import * as Schema from "effect/Schema"

export type Environment = Readonly<Record<string, string | undefined>>

/** Where a value may be stored. See decision 4. */
export type SettingKind = "machine" | "project" | "run" | "internal"

/** The closed set of value shapes. `wire` is the spelling written to the child. */
export type SettingType<A> =
  | { readonly _tag: "Flag"; readonly wire: { readonly on: string; readonly off: string } }
  | { readonly _tag: "Int"; readonly min?: number; readonly max?: number }
  | { readonly _tag: "Number"; readonly min?: number }
  | { readonly _tag: "Text" }
  /** In a file: relative to the directory that holds `.llm4ts/` (or `~`); projected absolute. */
  | { readonly _tag: "Path" }
  | { readonly _tag: "Choice"; readonly values: ReadonlyArray<string> }
  | { readonly _tag: "List"; readonly separator: ";" | "," }
// `A` is carried by the constructor that built the type (flag → boolean, list → ReadonlyArray<string>, …)

export interface Setting<A> {
  /** `legacy-repo`. Derived from the registry key by `defineRegistry`; never written by hand. */
  readonly name: string
  /** `LLM4TS_LEGACY_REPO`. Derived from `name`. */
  readonly env: string
  readonly kind: SettingKind
  readonly tier: "common" | "tuning"
  readonly type: SettingType<A>
  readonly secret: boolean
  /** Documented default; `undefined` = unset. Applied by `read`, never projected. */
  readonly default: A | undefined
  /** Defaults that differ in one flow (`coder`: `{ "epic-stories": "pi" }`). */
  readonly defaultIn: Readonly<Record<string, A>>
  /** The flows that read it; `"all"` for run-wide settings. Drives docs and `--flow`. */
  readonly flows: "all" | ReadonlyArray<string>
  /** Subset of `flows` that cannot start without it. */
  readonly requiredBy: ReadonlyArray<string>
  /** One sentence for `config show`, the docs row and the preflight message. */
  readonly doc: string
  /** Heading it is listed under in docs/configuration.md. */
  readonly section: string
}

type Row<A> = Omit<
  Setting<A>,
  "name" | "env" | "type" | "secret" | "defaultIn" | "requiredBy" | "default"
> &
  Partial<Pick<Setting<A>, "secret" | "defaultIn" | "requiredBy" | "default">>

export const flag: (
  row: Row<boolean> & { readonly wire?: { on: string; off: string } }
) => Setting<boolean>
export const int: (
  row: Row<number> & { readonly min?: number; readonly max?: number }
) => Setting<number>
export const number: (row: Row<number>) => Setting<number>
export const text: (row: Row<string>) => Setting<string>
export const path: (row: Row<string>) => Setting<string>
export const choice: <const V extends string>(
  row: Row<V> & { readonly values: ReadonlyArray<V> }
) => Setting<V>
export const list: (
  row: Row<ReadonlyArray<string>> & { readonly separator: ";" | "," }
) => Setting<ReadonlyArray<string>>

/** Fills `name` and `env` from each key (`legacyRepo` → `legacy-repo`, `LLM4TS_LEGACY_REPO`). */
export const defineRegistry: <const R extends Record<string, Setting<never>>>(rows: R) => R

/** A credential llm4ts reads but does not name (`ANTHROPIC_API_KEY`): shown, never stored. */
export interface ForeignSecret {
  readonly env: string
  readonly doc: string
  readonly section: string
}

/** The whole vocabulary in force: built-in rows plus what kits and flow tiers declare. */
export interface Registry {
  readonly settings: ReadonlyArray<Setting<unknown>>
  readonly foreign: ReadonlyArray<ForeignSecret>
}

/**
 * A setting declared as data, beside a `flows/` directory (`kits/soap-ace/settings.json`,
 * `.llm4ts/flows/settings.json`). Decodes to the same `Setting`; a name the
 * built-in table already has is a load error.
 */
export const SettingDeclaration = Schema.Struct({
  name: Schema.String, // kebab, checked
  type: Schema.Literals(["flag", "int", "number", "text", "path", "choice", "list"]),
  kind: Schema.Literals(["machine", "project", "run"]),
  doc: Schema.String,
  secret: Schema.optional(Schema.Boolean),
  values: Schema.optional(Schema.Array(Schema.String)),
  separator: Schema.optional(Schema.Literals([";", ","])),
  default: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  flows: Schema.optional(Schema.Array(Schema.String)),
  requiredBy: Schema.optional(Schema.Array(Schema.String))
})
export const SettingsDeclarations = Schema.Struct({ settings: Schema.Array(SettingDeclaration) })
```

Resolution is one pure function over layers that are already in memory:

```ts
// packages/flow/src/Settings.ts (continued)

export type Source =
  | { readonly _tag: "Flag"; readonly flag: string } // "--pack", "--set"
  | { readonly _tag: "Environment" }
  | { readonly _tag: "RepoFile"; readonly path: string }
  | { readonly _tag: "UserFile"; readonly path: string }
  | { readonly _tag: "FlowDefault"; readonly flow: string }
  | { readonly _tag: "Default" }
  | { readonly _tag: "Unset" }

/** A config file already parsed to JSON; `values` are still untyped. */
export interface FileLayer {
  readonly path: string
  /** Directory relative paths resolve against. */
  readonly base: string
  readonly values: Readonly<Record<string, unknown>>
}

export interface Layers {
  /** Setting name → raw text, from first-class flags and `--set name=value`. */
  readonly flags: Readonly<Record<string, { readonly value: string; readonly flag: string }>>
  readonly environment: Environment
  readonly repo: FileLayer | undefined
  readonly user: FileLayer | undefined
}

export interface Resolved {
  readonly setting: Setting<unknown>
  /** Wire text of the winning layer; `undefined` when unset. Never printed when `setting.secret`. */
  readonly value: string | undefined
  readonly source: Source
  /** Lower layers that also carry a value, highest first. */
  readonly shadowed: ReadonlyArray<{ readonly source: Source; readonly value: string }>
}

export type Problem =
  /** `LLM4TS_JUDGE_ROUND`, or a file key no setting has. */
  | {
      readonly _tag: "UnknownName"
      readonly written: string
      readonly where: Source
      readonly closest: string | undefined
    }
  /** A value its type rejects. */
  | {
      readonly _tag: "BadValue"
      readonly setting: string
      readonly where: Source
      readonly reason: string
    }
  /** A secret, run or internal setting found in a file or behind `--set`. */
  | {
      readonly _tag: "Misplaced"
      readonly setting: string
      readonly where: Source
      readonly reason: string
    }

export interface Resolution {
  readonly entries: ReadonlyArray<Resolved> // one per registry setting, registry order
  readonly foreign: ReadonlyArray<{ readonly env: string; readonly set: boolean }>
  readonly problems: ReadonlyArray<Problem>
}

/**
 * Precedence, highest first: flag, environment, repo file, user file,
 * the flow's default, the default. Total: every problem is data, nothing throws.
 */
export const resolve = (registry: Registry, layers: Layers, flow?: string): Resolution => {
  throw new Error("not implemented")
  // for each setting: collect candidates in precedence order; first one wins
  // file values: typed JSON (boolean for Flag, number for Int, array for List) → wire text;
  //   Path: expand `~`, resolve against layer.base
  // unknown names: every `LLM4TS_*` key of the environment not in registry (env → UnknownName),
  //   every file key not in registry; closest = closestName(…) within distance 3
}

/** `base` plus every entry whose source is a flag or a file. Defaults are never exported. */
export const childEnvironment = (
  resolution: Resolution,
  base: Environment
): Record<string, string | undefined> => {
  throw new Error("not implemented")
}

/** The flow's required settings that resolved to `Unset`. */
export const missingFor = (
  resolution: Resolution,
  flow: string
): ReadonlyArray<Setting<unknown>> => {
  throw new Error("not implemented")
}

/**
 * The typed value a reader uses: parses the variable with the setting's
 * grammar, falls back to `defaultIn[environment.LLM4TS_FLOW]`, then `default`.
 * Total in 3.x (a malformed value falls back, as today; the parent already
 * warned). The one grammar replaces every private boolean and int parser.
 */
export const read: {
  <A>(setting: Setting<A> & { readonly default: A }, environment: Environment): A
  <A>(setting: Setting<A>, environment: Environment): A | undefined
} = () => {
  throw new Error("not implemented")
}

/** Damerau-Levenshtein over the registry's names; `undefined` beyond distance 3. */
export const closestName = (written: string, registry: Registry): string | undefined => {
  throw new Error("not implemented")
}
```

The table itself, one module, nothing but rows:

```ts
// packages/flow/src/SettingsRegistry.ts
import {
  choice,
  defineRegistry,
  flag,
  int,
  list,
  path,
  text,
  type ForeignSecret
} from "./Settings.ts"

export const S = defineRegistry({
  coder: choice({
    kind: "machine",
    tier: "common",
    section: "CLI connectors",
    values: [
      "claude",
      "codex",
      "gemini",
      "pi",
      "agy",
      "antigravity",
      "grok",
      "cursor",
      "opencode" /* + connector ids */
    ],
    default: "claude",
    defaultIn: { "epic-stories": "pi" },
    doc: "The coding agent that implements.",
    flows: "all"
  }),
  pack: text({
    kind: "project",
    tier: "common",
    section: "Kits and packs",
    doc: "Pack for the modernization flows: a kit pack name, kit/pack, or a directory holding pack.md.",
    flows: ["modernize-survey", "modernize-extract", "convert-page", "epic-stories" /* … */]
  }),
  legacyRepo: path({
    kind: "project",
    tier: "common",
    section: "Modernization",
    doc: "The legacy repository holding the approved spec pack.",
    flows: ["modernize-seed", "epic-design", "convert-page", "convert-feature", "convert-all"],
    requiredBy: ["modernize-seed", "convert-page", "convert-feature", "convert-all"]
  }),
  wave: text({
    kind: "run",
    tier: "common",
    section: "Modernization",
    doc: "Scope the run to one wave of the approved plan.",
    flows: ["modernize-extract", "modernize-survey"]
  }),
  timestamps: flag({
    kind: "machine",
    tier: "tuning",
    section: "Terminal",
    wire: { on: "1", off: "0" },
    default: false,
    doc: "Prefix terminal lines with a timestamp.",
    flows: "all"
  }),
  geminiBridgeToken: text({
    kind: "machine",
    tier: "tuning",
    section: "Gemini bridge",
    secret: true,
    doc: "Token every bridge request must carry.",
    flows: "all"
  }),
  flow: text({
    kind: "internal",
    tier: "tuning",
    section: "Set by llm4ts",
    doc: "The running flow's name, for its spans.",
    flows: "all"
  })
  // … 96 rows in all; kit names (soap-*, ado-*, ace-api, fail-fast) live in their kit's settings.json
})

export const foreignSecrets: ReadonlyArray<ForeignSecret> = [
  {
    env: "ANTHROPIC_API_KEY",
    section: "API connectors",
    doc: "Credential for the anthropic provider."
  }
  // OPENAI_API_KEY, GEMINI_API_KEY, TYPESAFE_API_KEY, OTEL_EXPORTER_OTLP_* …
]
```

Classification of the 96 (the working hypothesis, corrected): 34 machine, 43
project (30 of them tuning tier), 12 run, 4 internal, 2 secret plus the
foreign credentials; 12 of the project/run names belong to the two kits.
`legacy-repo` and `target-repo` are project-kind with machine-specific
values, which is why file paths are relative to the repository.

### The files (the one-way door)

- **Format**: JSON, one flat object, setting name → typed value (`true`,
  `3`, `"text"`, `["a", "b"]`). Same format, extension and loader pattern as
  `roster.json` and `mcp.json`; no parser dependency. An unknown key, a
  wrong type, a secret, a run or an internal setting is a load **error** that
  names the file, the key and the closest name: a new surface is strict from
  its first day. `flows` and `version` are reserved keys (no setting may take
  those names), which leaves room for per-flow sections later.
- **Locations**: `${XDG_CONFIG_HOME:-~/.config}/llm4ts/config.json` (user) and
  `<workDir>/.llm4ts/config.json` (repo), where `workDir` is `--repo`, else
  the current directory, exactly as `repoRosterPath(workDir)` does it. No
  upward search: the roster does none, and two rules for "which repo" would
  be worse than one. `config show` prints both paths and `(absent)`.
- **Precedence**: flag > environment > repo file > user file > the flow's
  default > default. Environment above files keeps every existing prefix
  meaning what it meant and lets CI override a checked-in file.
- **What the tool writes**: only `config set`, `config unset` and
  `config init` write, only these two files, only machine and project kinds,
  whole-file atomic replace (temp file + rename), keys sorted. `run` never
  writes a config file. The repo file is meant to be committed.

### Resolution, and where it is called

```ts
// packages/runner/src/RunSettings.ts — the one entry the shell and the runner call
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import type { Environment, Registry, Resolution } from "@llm4ts/flow/Settings"
import type { KitTierPaths } from "./Kits.ts"

export class SettingsInvalid extends Schema.TaggedError<SettingsInvalid>()("SettingsInvalid", {
  path: Schema.String,
  violations: Schema.Array(Schema.String)
}) {}

export class SettingsMissing extends Schema.TaggedError<SettingsMissing>()("SettingsMissing", {
  flow: Schema.String,
  missing: Schema.Array(Schema.String),
  /** The rendered message of the usage section; carries no values. */
  message: Schema.String
}) {}

export interface SettingsRequest {
  /** Flow name (script basename); `undefined` when no flow is starting (`config show`). */
  readonly flow: string | undefined
  readonly workDir: string
  readonly flags: Readonly<Record<string, { readonly value: string; readonly flag: string }>>
  readonly environment: Environment
  readonly files: PlainFileStoreShape
  /** Where `settings.json` declarations are discovered: kit tiers and flow tiers. */
  readonly tiers: { readonly kits?: KitTierPaths; readonly flowDirs: ReadonlyArray<string> }
}

export interface RunSettings {
  readonly registry: Registry
  readonly resolution: Resolution
  /** What the flow child receives: `childEnvironment(resolution, environment)`. */
  readonly environment: Record<string, string | undefined>
  /** Rendered, ready for stderr: unknown names, bad environment values. */
  readonly warnings: ReadonlyArray<string>
}

/**
 * Discovers declarations, loads both files, resolves, and when `flow` is
 * given checks its required settings. Fails with `SettingsInvalid` on a bad
 * file or a bad flag value, `SettingsMissing` on a missing required setting;
 * environment problems are warnings in 3.x.
 */
export const settingsFor = Effect.fn("@llm4ts/runner/RunSettings.settingsFor")(function* (
  request: SettingsRequest
): Effect.fn.Return<RunSettings, SettingsInvalid | SettingsMissing> {
  return yield* Effect.die("not implemented")
})

export type WriteTarget = "user" | "repo"

/**
 * Sets or removes one value in one file. `target` omitted: user for machine
 * kind, repo for project kind. Refuses run, internal and secret settings and
 * a value the type rejects. Idempotent; atomic replace.
 */
export const writeSetting = Effect.fn("@llm4ts/runner/RunSettings.writeSetting")(function* (
  request: Pick<SettingsRequest, "workDir" | "environment" | "files" | "tiers">,
  name: string,
  value: string | undefined, // undefined = unset
  target?: WriteTarget
): Effect.fn.Return<
  { readonly path: string; readonly stored: unknown; readonly shadowedBy: string | undefined },
  SettingsInvalid
> {
  return yield* Effect.die("not implemented")
})

export const userConfigPath: (environment: Environment) => string
export const repoConfigPath: (workDir: string) => string
```

Call sites:

- `launchFlow` in `packages/shell/src/FlowLaunch.ts` calls `settingsFor`
  before `nodeFlowProcess.start`. `run`, `refine` and the menu already go
  through it; `runEnvironmentFrom` shrinks to "flags → the `flags` layer"
  (`--pack` → `{ pack }`, `--verbose` → `{ verbosity: "verbose" }`, each
  `--set k=v`) plus the three internal values.
- `RunSupervisor.start` calls the same `settingsFor` in place of its
  hand-built object, with its knobs as the `flags` layer.
- `config show` and `doctor` call it with `flow: undefined`.
- From unit 7, `runFlowMain` calls it when `LLM4TS_FLOW` is absent (a flow
  started as `node flows/x.ts`, without the shell), so both ways of starting a
  flow see the files. `LLM4TS_FLOW` is already the mark that a parent
  resolved; no new marker.

### The verb

```
llm4ts config show [name] [--all] [--flow <flow>] [--json] [--repo <path>]
llm4ts config set <name> <value> [--user | --repo-file] [--repo <path>]
llm4ts config unset <name> [--user | --repo-file] [--repo <path>]
llm4ts config init [--from-env] [--repo <path>]
```

- `show`: output as in the usage section. Exit 0 with warnings, 2 on a
  `SettingsInvalid` file.
- `set`: prints `name = value   → path (user|repo)`. When the environment
  carries the same setting it adds
  `note: LLM4TS_PACK=cobol-springboot in your environment overrides this`.
  Refusals are one line each: `wave is a run setting; pass --set wave=<value>
to llm4ts run`, `gemini-bridge-token is a secret; export
LLM4TS_GEMINI_BRIDGE_TOKEN instead`, `unknown setting 'legasy-repo'; did you
mean legacy-repo?`.
- `unset`: prints `legacy-repo removed from path`, or `legacy-repo is not in
path`.
- `init`: on a terminal, asks the `common` machine settings (coder with the
  PATH probe from `CoderChoice`, reasoner) and, inside a repository, pack
  (from `llm4ts kits`) and each setting some flow of that pack's kit requires.
  Existing values are the prompts' defaults, so a second run changes nothing
  unless answered differently. Without a terminal and without `--from-env` it
  writes nothing and lists what it would ask. `--from-env` never prompts.

`llm4ts run` gains one flag: `--set name=value`, repeatable. The eight
existing flags stay as they are and feed the same layer. No per-setting flags
are generated: 96 flags would bury `run --help`, and `--set` is checked
against the registry with the same closest-name hint.

### Unknown names, bad values, preflight

All three come out of the same `Resolution.problems`, rendered by the parent
before the child starts, on stderr:

```
warning: LLM4TS_JUDGE_ROUND is not an llm4ts setting; did you mean LLM4TS_JUDGE_ROUNDS?
warning: LLM4TS_CODER='codx' is not one of claude|codex|gemini|pi|agy|grok|cursor|opencode; this flow falls back to its default
error: /work/nextjs/.llm4ts/config.json: unknown key 'legasy-repo'; did you mean legacy-repo?
```

| Where the problem is | 3.x                  | 4.0   |
| -------------------- | -------------------- | ----- |
| environment          | warning, run goes on | error |
| config file, flag    | error, exit 2        | error |
| required and unset   | error, exit 2        | error |

A project's own flows silence the warning for their names by declaring them
in `.llm4ts/flows/settings.json`, the same file kits ship.

Conditional requirements (`model` when `provider` is not `mock`) stay in the
reader that already checks them before any call; the table only encodes
"flow X cannot start without Y".

### Generated docs and the drift check

`scripts/settings-check.mjs` imports `SettingsRegistry.ts` (type stripping;
the two modules import only `effect`) and the kits' `settings.json`, and is
added to the verification chain as `pnpm settings` (`--write` regenerates).
It fails when:

1. A region of `docs/configuration.md` between
   `<!-- settings:<section> -->` and `<!-- /settings -->` differs from what
   the table renders for that section (name, variable, type, default, flows,
   doc). The prose around the regions stays hand-written; every hand-kept
   variable table is replaced by a region. `kits/*/README.md` get the same
   regions from their `settings.json`.
2. A `LLM4TS_[A-Z0-9_]+` token in `packages/*/src`, `flows/`, `kits/*/flows`
   or `kits/*/tools` is not in the registry (built-in, or that kit's
   declarations). The message names file and line.
3. A registry row's variable appears nowhere in those trees (a dead row).
4. A flow named in `flows` / `requiredBy` / `defaultIn` has no script, or a
   name read inside `flows/` or `kits/*/flows` (following relative imports
   from each flow script) is missing from that row's `flows`.
5. A `LLM4TS_*` token in non-frozen docs is not in the registry.
6. The number of doc command lines prefixed with `LLM4TS_…=` exceeds the
   ratchet constant in the script (28 at unit 1, 0 at unit 6).
7. From unit 7: the number of raw reads (`environment.LLM4TS_`,
   `process.env.LLM4TS_`, `["LLM4TS_`) outside `Settings.ts` exceeds its
   ratchet (184 → 0).

### Interface depth

Callers see `settingsFor` (one call that hides discovery, two files, six
layers of precedence, per-type grammar, path resolution, wire spelling,
requirement checks and message rendering), `writeSetting`, and `read`. The
shell never touches a layer; a reader never touches a parser; the docs and
the dictionary are derived. What stays exposed on purpose: `Resolution` as
plain data, because `config show`, `--json`, doctor and tests all render it
differently.

### What it deliberately does not do

No secrets storage, no `.local` third file, no per-flow sections in the file,
no upward search for the repository, no generated per-setting flags, no
`Settings` service (the environment record every reader already takes is the
replaceable dependency), no change to roster files or SOAP auth files.

## Module map

| Module                                                                | Owns                                                                                                 | Imports                 |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------- |
| `packages/flow/src/Settings.ts` (new)                                 | `Setting`, constructors, grammar, `resolve`, `childEnvironment`, `missingFor`, `read`, `closestName` | `effect` only           |
| `packages/flow/src/SettingsRegistry.ts` (new)                         | The table `S` and `foreignSecrets`; nothing else                                                     | `./Settings.ts`         |
| `packages/runner/src/RunSettings.ts` (new)                            | File paths, loading, declaration discovery, `settingsFor`, `writeSetting`, the two errors            | flow, `./Kits.ts`       |
| `packages/shell/src/ConfigCommand.ts` (new)                           | `config show/set/unset/init`, the renderers                                                          | runner                  |
| `packages/shell/src/FlowLaunch.ts`                                    | `launchFlow` calls `settingsFor`, prints warnings                                                    | runner                  |
| `packages/shell/src/Cli.ts`                                           | `--set`; `runEnvironmentFrom` becomes flags → layer                                                  |                         |
| `packages/shell/src/RunSupervisor.ts`                                 | Calls `settingsFor`                                                                                  |                         |
| `packages/runner/src/Doctor.ts`                                       | One "settings" block: files found, problems                                                          |                         |
| `kits/soap-ace/settings.json`, `kits/j2ee-nextjs/settings.json` (new) | The kits' own names                                                                                  |                         |
| `scripts/settings-check.mjs` (new)                                    | Docs regions and the seven checks                                                                    | registry, type-stripped |
| `docs/adr/00NN-settings.md` (new)                                     | File format, locations, precedence, kinds                                                            |                         |

## Synthesis decision

_Filled in by arena._

## Tradeoffs accepted

- We accept that the registry table sits in `flow`, one package below where
  the review put `RunConfig`, in exchange for flow's own 15 readers using it
  without an upward import.
- We accept a table that names flows and shell-only settings (`mcp-token`)
  from inside `flow`, in exchange for one file to open to add, find or
  document any setting.
- We accept that registry defaults are documentation until each reader
  migrates (code keeps its own default meanwhile), in exchange for a first
  release that changes no flow behaviour. Check 7's ratchet is what ends the
  duplication.
- We accept `--set wave=wave-1` being longer than a `--wave` flag, in
  exchange for one mechanism over 96 names and a readable `run --help`.
- We accept JSON without comments, in exchange for the roster's format, no
  dependency, and `config show <name>` as the place explanations live.
- We accept that `flows` / `requiredBy` are lists a human keeps, in exchange
  for the shell knowing requirements without running a script; check 4 fails
  the build when they drift for code under `flows/` and `kits/`.
- We accept that a run started outside the repository without `--repo` does
  not find the repo file, in exchange for the same rule the roster has.
- We accept `read` consulting `LLM4TS_FLOW` for a per-flow default, in
  exchange for a default that is written once instead of in each flow.

## Alternatives considered

- **A `Settings` Effect service with a layer, flows read `yield* Settings`.**
  It hides the environment entirely, but needs every one of 88 files changed
  before the file layer reaches a single flow, and a second wire (encoded
  config passed to the child) beside the environment. Lost on migration cost
  and on being two ways to carry a value.
- **A schema-per-package `RunConfig` struct, decoded once in the runner and
  passed down as an object.** A deep typed object, but flows and kits add
  names the struct cannot know, so kit names would remain raw env reads: two
  mechanisms. It also exposes nothing the user can list.
- **Flows declare their settings in their own script (header comment or an
  exported constant).** Requirements travel with the flow, but the first
  release would have to edit every flow script, the shell would parse
  comments or import scripts that run on import, and "which flows read X"
  becomes a scan instead of a field.
- **TOML with sections per kind or per flow.** Comments are attractive, but
  it adds a parser dependency or a hand-written parser, a second format
  beside `roster.json`, and nested keys that no longer equal the setting
  name.
- **An env file (`.llm4ts/env`) sourced into the child.** The cheapest file
  layer, but untyped, tempting for secrets, and unable to resolve relative
  paths or reject run settings.
- **Generate a flag per setting.** Uniform, but 96 flags, and kit names would
  need dynamic flags the CLI library does not declare.

## Open questions and risks

- Is `.llm4ts/config.json` meant to be committed in the bank repos? If
  `.llm4ts/` is ignored wholesale there, relative paths buy nothing and the
  per-machine case wants the user file to carry per-repo values, which this
  design does not offer.
- Should the repo file be allowed to set machine-kind values (`coder`)? The
  sketch says yes (a project may standardise its coder); the stricter rule is
  one line in `resolve`.
- Is failing on an unknown key in a config file too strict for a file shared
  across llm4ts versions (an older CLI reading a newer file)? The alternative
  is a warning, at the cost of silent typos in the one place this design
  could prevent them.
- `epic-stories` turns transcripts on by default; `config show --flow
epic-stories` shows that through `defaultIn`, but plain `config show` says
  `off`. Acceptable, or should `show` inside a repo with a single obvious flow
  guess?
- The seven flows that parse their own `--` arguments keep doing so; should
  run-kind settings such as `wave` become those flows' arguments instead of
  `--set` keys in 4.0?
- Risk: check 4 follows only relative imports. A name read in `packages/*`
  on behalf of one flow must be marked `flows: "all"` or listed by hand.
- Risk: `RunSupervisor.childEnvironment` filters the base environment today;
  the projection must be applied after that filter, never before, so a
  filtered secret cannot come back through a file (files cannot hold secrets,
  but the order should still be fixed by a test).

## Ordered units

Each lands alone and runs the full verification chain. Units 1 to 6 are the
first release (3.3.0, ADR with unit 4) and change no flow script.

| #   | Unit                                                                                                                                                                                                                                                                            | Check                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `Settings.ts` (types, constructors, `read`, `closestName`), `SettingsRegistry.ts` with all built-in rows, both kits' `settings.json`, `scripts/settings-check.mjs` checks 2, 3, 5; `pnpm settings` in the chain                                                                 | Script green on the tree; deleting any row fails it with file:line; adding `LLM4TS_NOPE` to a source file fails it; unit tests for each type's grammar including the per-flag wire spelling                                                                                 |
| 2   | Docs regions in `docs/configuration.md` and the kit READMEs generated from the table (check 1); the 43 undocumented names appear                                                                                                                                                | Editing a generated row by hand fails `pnpm settings`; `--write` restores it                                                                                                                                                                                                |
| 3   | `resolve` with flag, environment and default layers; `config show` (`--all`, `--flow`, `--json`, `<name>`); unknown-name and bad-value warnings on every launch through `launchFlow` and `RunSupervisor`; doctor block                                                          | `@effect/vitest` table tests of `resolve`; `verify-llm4ts`: `LLM4TS_CODR=x llm4ts run hello` prints the closest-name warning and still runs; `config show` shows `environment` as the source                                                                                |
| 4   | Config files: `RunSettings.ts` (`settingsFor`, `writeSetting`), file layers in `resolve`, `childEnvironment` projection, `config set/unset`, `run --set`; ADR                                                                                                                   | Tests with `makeMemoryPlainFileStore`: precedence matrix, relative path, secret/run/unknown key rejected, defaults not projected, set is idempotent; sandbox run: `config set coder codex` then a stub-coder run with no prefix uses codex; the environment still overrides |
| 5   | `requiredBy` enforced in `settingsFor`; `config init` and `--from-env`                                                                                                                                                                                                          | Sandbox: `llm4ts run convert-page x` without `legacy-repo` exits 2 with the message and the stub coder was never spawned; `init --from-env` writes the two files and skips run and secret names                                                                             |
| 6   | Runbooks and guides rewritten to prefix-free commands; check 6 ratchet 28 → 0; check 4 on                                                                                                                                                                                       | `pnpm settings` green with the ratchet at 0                                                                                                                                                                                                                                 |
| 7   | Readers migrate to `read(S.x, environment)`, package by package (flow, runner, shell, then `flows/`, then kits); private parsers deleted; `seatsFromEnvironment` built on `read`; `runFlowMain` calls `settingsFor` when no parent resolved; check 7 ratchet lowered in each PR | Existing reader tests unchanged and green; ratchet reaches 0; `node flows/hello.ts` in a repo with a config file sees it                                                                                                                                                    |
| 8   | 4.0.0: environment problems become errors; `coderFromEnv` removed; in-code defaults gone (the table's default is the only one)                                                                                                                                                  | Flow smokes; a malformed `LLM4TS_JUDGE_ROUNDS` exits 2 before a token                                                                                                                                                                                                       |

## Next implementation step

Write `packages/flow/src/Settings.ts` and the first twenty rows of
`SettingsRegistry.ts` with the grammar tests, then run check 2 against the
tree to let the 76 failures dictate the remaining rows.
