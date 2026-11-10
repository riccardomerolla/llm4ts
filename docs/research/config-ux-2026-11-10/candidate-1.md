# Candidate 1: the environment, written down

One registry declares every `LLM4TS_*` name. Two dotenv-style files hold the
values a person would otherwise export: one per machine, one per repository.
The shell resolves flags, environment, files and defaults once per command,
and hands each flow child a complete environment, so no flow script changes
for the first release. A setting has exactly one name, the environment
variable's, in every place it appears: file, flag, output, docs, code.

## Problem

Real usage needs 5 to 10 settings per repository and per machine, and
today the only way to give them is the environment: 96 names, 8 of them with
a `run` flag, 43 undocumented, read in 88 files under three styles with five
boolean grammars. A typo is silently ignored, a malformed value silently
becomes the default, and an unknown `LLM4TS_CODER` silently runs claude. The
runbooks carry 28 prefixed command lines and `export` blocks that a
presenter must retype in every new terminal (forgetting `LLM4TS_PACK` makes
the survey reason in COBOL terms without a word).

Constraints that shape the answer:

- **Additive in 3.x.** Every variable and flag keeps its meaning. In
  particular an exported variable must keep winning over anything new,
  which fixes the precedence order before any taste enters.
- **Flows are child processes that read `process.env`.** 88 reading files,
  seven of them parsing their own `--` arguments. The shell already builds
  the child's environment (`runEnvironmentFrom`), and so do three other
  launchers: `refine`, the menu, and the MCP `RunSupervisor`. A layer that
  slots in there needs no flow change.
- **`.llm4ts/` is machine-local and coder-denied.** `RunState.ts` puts a
  `.gitignore` (`*`) in every `.llm4ts/` and denies every CLI seat
  `.llm4ts/**` by default. A config file there is not committed by accident
  and cannot be rewritten by a coder (a coder that could edit
  `LLM4TS_GATES` could switch its own gates off).
- **One owner for run configuration already decided.** The architecture
  review's `RunConfig` (shell encodes, runner decodes with the same schema;
  `envFlag`/`envInt` give knobs one grammar). This design is that owner: the
  registry is the schema, and `RunConfig` is derived from it, not written
  beside it.
- **Requirements are conditional.** `epic-design -- --list` needs no legacy
  repository; `LLM4TS_SOAP_SERVICE` is needed only when a repository holds
  several services; `epic-mvp` needs one of `LLM4TS_TEST_REPORT` and
  `LLM4TS_TEST_ONE`. Whoever checks a requirement must know the flow's mode.
- **Flow defaults differ per flow.** `LLM4TS_CODER` defaults to claude, but
  to pi in the epic flows; `LLM4TS_REVIEW_VOTES` is 1, but 2 in the port
  flows. A registry cannot hold one default for those.

## Usage (caller's view)

### Fresh machine

```console
$ npm i -g @llm4ts/shell
$ llm4ts config init
? Which coding agent edits files? › pi ✓ found
? Which agent plans, reviews and judges? › claude ✓ found
wrote ~/.config/llm4ts/config.env (global)
  LLM4TS_CODER=pi
  LLM4TS_REASONER=claude
no project settings asked: run `llm4ts config init` inside a repository for those
check: llm4ts config show
$ llm4ts doctor
...
config:
  ✔ global   ~/.config/llm4ts/config.env       2 settings
  · project  ./.llm4ts/config.env              none
```

A machine that already exports variables imports them instead of answering:
`init` writes every `LLM4TS_*` the environment sets, each to the file its
setting belongs in, never overwriting a line that exists, and then says which
exports can go. Off a terminal it only imports and asks nothing:

```console
$ llm4ts config init --repo ~/demo/nextjs      # in the shell that ran the runbook's export block
wrote ~/demo/nextjs/.llm4ts/config.env (project)
  LLM4TS_PACK=j2ee-nextjs-spa                      from the environment
  LLM4TS_LEGACY_REPO=/Users/me/demo/legacy-j2ee    from the environment
  LLM4TS_JUDGE_ROUNDS=1                            from the environment
  LLM4TS_MAX_CLOSURE_FILES=8                       from the environment
  LLM4TS_EXTRACT_CONCURRENCY=3                     from the environment
skipped LLM4TS_WAVE: chosen per run (--set LLM4TS_WAVE=…)
skipped LLM4TS_EXTRACT_CONCURENCY: not a setting; did you mean LLM4TS_EXTRACT_CONCURRENCY?
these exports can now go from your shell profile: LLM4TS_PACK LLM4TS_LEGACY_REPO LLM4TS_JUDGE_ROUNDS
  LLM4TS_MAX_CLOSURE_FILES LLM4TS_EXTRACT_CONCURRENCY
$ llm4ts config init --repo ~/demo/nextjs
nothing to do: both files exist and hold every setting the environment sets
```

Import writes into the repository you name; knobs that belong to the other
repository of a pair are moved with `config unset` and `config set`.

### Fresh repository

```console
$ cd ~/work/portal
$ llm4ts config init
? Which pack does this repository use? › j2ee-nextjs-spa (kit j2ee-nextjs)
? The legacy repository this one replaces (empty: none) › ~/legacy/ib-core
wrote ~/work/portal/.llm4ts/config.env (project)
  LLM4TS_PACK=j2ee-nextjs-spa
  LLM4TS_LEGACY_REPO=/Users/me/legacy/ib-core
check: llm4ts config show
$ llm4ts run epic-design "Current account: balance, movements, statements"
```

The global file exists, so only project questions are asked. A repository
holding `docs/modernization/README.md` is an extracted legacy, so `init` asks
for `LLM4TS_TARGET_REPO` there instead of a legacy repository.

### Setting, checking, overriding

```console
$ llm4ts config set --repo ~/demo/nextjs LLM4TS_PACK=j2ee-nextjs-spa LLM4TS_LEGACY_REPO=~/demo/legacy-j2ee LLM4TS_CODER=pi
project  ~/demo/nextjs/.llm4ts/config.env
  LLM4TS_PACK=j2ee-nextjs-spa                     new
  LLM4TS_LEGACY_REPO=/Users/me/demo/legacy-j2ee   new
global   ~/.config/llm4ts/config.env
  LLM4TS_CODER=pi                                 unchanged
note: LLM4TS_PACK is also exported in this shell (cobol-springboot), which wins over the file

$ llm4ts config set LLM4TS_JUDGE_ROUND=1
unknown setting LLM4TS_JUDGE_ROUND; did you mean LLM4TS_JUDGE_ROUNDS?        (exit 2, nothing written)
$ llm4ts config set LLM4TS_JUDGE_ROUNDS=one
LLM4TS_JUDGE_ROUNDS needs a positive integer, got 'one'                      (exit 2, nothing written)
$ llm4ts config set LLM4TS_WAVE=wave-1
LLM4TS_WAVE is chosen per run: llm4ts run <flow> --set LLM4TS_WAVE=wave-1   (exit 2)
$ llm4ts config set LLM4TS_MCP_TOKEN=abc
LLM4TS_MCP_TOKEN is a secret and stays out of config files: export it, or use --token-file   (exit 2)

$ llm4ts config unset --repo ~/demo/nextjs LLM4TS_JUDGE_ROUNDS
project  ~/demo/nextjs/.llm4ts/config.env
  LLM4TS_JUDGE_ROUNDS  removed (was 2)
```

`config set` takes `NAME=value` pairs, the same form as a file line and as
`run --set`. Each name goes to the file its setting belongs in (see
[scopes](#scope-decides-where-a-value-may-come-from)); `--global` or
`--project` forces one. `--repo <dir>` keeps the meaning it has on every
other verb: which repository (default: the working directory). Every pair is
validated before anything is written. Setting a value a file already holds
writes nothing.

```console
$ llm4ts config show --repo ~/demo/nextjs
files
  global   ~/.config/llm4ts/config.env        2 settings
  project  ~/demo/nextjs/.llm4ts/config.env   4 settings

setting                      value                         from
LLM4TS_CODER                 pi                            global:1
LLM4TS_REASONER              claude                        global:2
LLM4TS_PACK                  cobol-springboot              environment   (project:1 has j2ee-nextjs-spa)
LLM4TS_LEGACY_REPO           /Users/me/demo/legacy-j2ee    project:2
LLM4TS_JUDGE_ROUNDS          1                             project:3
LLM4TS_ADO_ORG_URL           https://dev.azure.com/acme    project:4
LLM4TS_GEMINI_BRIDGE_TOKEN   (secret, set)                 environment

warnings
  LLM4TS_EXTRACT_CONCURENCY (environment) is not a setting; did you mean LLM4TS_EXTRACT_CONCURRENCY?
  LLM4TS_STALL_MINUTES=soon (environment) is not a number of minutes; flows treat it as unset

92 settings at their defaults: llm4ts config show --all · one in full: llm4ts config show <NAME>
```

`--all` adds every setting at its default, grouped as in the docs, with
`default` in the `from` column and the default's text as the value
(`1200`, `per flow: claude; pi in the epic flows`, `off`). `--json` always
carries every setting. One setting in full:

```console
$ llm4ts config show LLM4TS_JUDGE_ROUNDS --repo ~/demo/nextjs
LLM4TS_JUDGE_ROUNDS = 1    from project ~/demo/nextjs/.llm4ts/config.env:3
  flag         —
  environment  —
  project      1
  global       —
  default      per flow: 3 per story in the epic flows, 2 in task mode
Judge attempts per story before it fails; --review-rounds and --judge-rounds set it too.
value: a positive integer · belongs in: the project file · group: review
```

### Per run

```console
$ llm4ts run modernize-extract --repo ~/demo/legacy-j2ee --set LLM4TS_WAVE=wave-1
$ llm4ts run implement --coder codex "Add a multiply function next to add, with tests"
$ LLM4TS_JUDGE_ROUND=1 llm4ts run convert-all --repo ~/demo/nextjs
warning: LLM4TS_JUDGE_ROUND (environment) is not a setting; did you mean LLM4TS_JUDGE_ROUNDS?
...the run starts...
$ llm4ts run convert-all --repo ~/demo/nextjs --set LLM4TS_JUDGE_ROUND=1
unknown setting LLM4TS_JUDGE_ROUND in --set; did you mean LLM4TS_JUDGE_ROUNDS?   (exit 2, nothing runs)
```

`--set NAME=value` (repeatable) sets any non-secret setting for one run and
is validated like `config set`: a typo or a bad value stops the launch. An
exported variable still works, with its old meaning, and is only warned
about. `--coder <name>` joins the eight existing `run` flags as sugar for
`--set LLM4TS_CODER=<name>`, because coder choice is the most common
per-run prefix in the docs (`LLM4TS_CODER=` appears 7 times).

### A flow that lacks a required setting (unit 6)

```console
$ llm4ts run epic-design --repo ~/work/portal "Current account"
epic-design needs LLM4TS_LEGACY_REPO: the legacy repository holding docs/modernization/.
  for this repository:  llm4ts config set --repo /Users/me/work/portal LLM4TS_LEGACY_REPO=<path>
  for this run only:    llm4ts run epic-design --set LLM4TS_LEGACY_REPO=<path> …
(exit 1, no model called)
```

### Runbook commands, before and after

The one-time setup of the DemoBank workshop
(`kits/j2ee-nextjs/fixtures/demo-bank/RUNBOOK.md`, Act 0), before:

```bash
export LLM4TS_PACK=j2ee-nextjs-spa
export LLM4TS_LEGACY_REPO=~/demo/legacy-j2ee
export LLM4TS_JUDGE_ROUNDS=1        # bound judge feedback to one round on stage
export LLM4TS_MAX_CLOSURE_FILES=8   # bound legacy evidence per page
export LLM4TS_EXTRACT_CONCURRENCY=3 # pages extracted and judged at once
```

After (each repository names its counterpart; `reset-demo.mjs` can write
both files itself, leaving `llm4ts config show` as the stage beat):

```bash
llm4ts config set --repo ~/demo/legacy-j2ee LLM4TS_PACK=j2ee-nextjs-spa \
  LLM4TS_TARGET_REPO=~/demo/nextjs LLM4TS_MAX_CLOSURE_FILES=8 \
  LLM4TS_EXTRACT_CONCURRENCY=3 LLM4TS_JUDGE_ROUNDS=1
llm4ts config set --repo ~/demo/nextjs LLM4TS_PACK=j2ee-nextjs-spa \
  LLM4TS_LEGACY_REPO=~/demo/legacy-j2ee LLM4TS_JUDGE_ROUNDS=1
```

| Where                                   | Before                                                                                                                            | After                                                                                                                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kits/j2ee-nextjs/README.md:26`         | `LLM4TS_LEGACY_REPO=/path/to/legacy-estate llm4ts run convert-page --pack j2ee-nextjs-spa --repo /path/to/nextjs accountOverview` | once: `llm4ts config set --repo /path/to/nextjs LLM4TS_PACK=j2ee-nextjs-spa LLM4TS_LEGACY_REPO=/path/to/legacy-estate`; then `llm4ts run convert-page --repo /path/to/nextjs accountOverview` |
| demo-bank Act 1                         | `LLM4TS_WAVE=wave-1 llm4ts run modernize-extract --repo ~/demo/legacy-j2ee`                                                       | `llm4ts run modernize-extract --repo ~/demo/legacy-j2ee --set LLM4TS_WAVE=wave-1`                                                                                                             |
| demo-bank refine, off stage             | `LLM4TS_TARGET_REPO=~/demo/nextjs llm4ts run modernize-refine --repo ~/demo/legacy-j2ee`                                          | `llm4ts run modernize-refine --repo ~/demo/legacy-j2ee` (the legacy's file names its target; `llm4ts refine` needs no `--target` either)                                                      |
| demo-bank Act 2                         | `llm4ts run convert-all --repo ~/demo/nextjs` after the exports                                                                   | the same command, in any terminal                                                                                                                                                             |
| demo-bank ADO mirror                    | `export LLM4TS_ADO_ORG_URL=…` / `export LLM4TS_ADO_PROJECT=…`                                                                     | `llm4ts config set --repo ~/demo/nextjs LLM4TS_ADO_ORG_URL=https://dev.azure.com/<org> LLM4TS_ADO_PROJECT=<project>`                                                                          |
| demo-bank recovery drills               | `LLM4TS_FAIL_FAST=1`, `LLM4TS_EXCLUDE_DIRS=…`, `LLM4TS_MAX_DISCOVER_RESULTS=…`                                                    | `--set LLM4TS_FAIL_FAST=on`; `llm4ts config set --repo <legacy> LLM4TS_EXCLUDE_DIRS=… LLM4TS_MAX_DISCOVER_RESULTS=50000`                                                                      |
| `flows/README.md:256`, `epic-design.ts` | `LLM4TS_LEGACY_REPO=~/legacy/ib-core llm4ts run epic-design --repo ~/work/portal "…"`                                             | once: `llm4ts config set --repo ~/work/portal LLM4TS_LEGACY_REPO=~/legacy/ib-core`; then `llm4ts run epic-design --repo ~/work/portal "…"`                                                    |
| internet-banking Act 0                  | `export LLM4TS_CONTEXT_BUDGET=120000` / `export LLM4TS_CODER_MODEL=openai-codex/gpt-5.5`                                          | `llm4ts config set --repo ~/demo/portal LLM4TS_CONTEXT_BUDGET=120000` / `llm4ts config set LLM4TS_CODER_MODEL=openai-codex/gpt-5.5`                                                           |
| soap-ace rehearsal                      | `LLM4TS_SOAP_STUB=<kit>/fixtures/demo-bank-soap/responses`, `LLM4TS_SOAP_ENV=uat`                                                 | `llm4ts config set LLM4TS_SOAP_STUB=…` (project); `--set LLM4TS_SOAP_ENV=uat` or the existing `-- --env uat`                                                                                  |
| `README.md:43`                          | `LLM4TS_CODER=codex llm4ts run implement "…"`                                                                                     | `llm4ts run implement --coder codex "…"`, or once `llm4ts config set LLM4TS_CODER=codex`                                                                                                      |
| `docs/configuration.md:133,180`         | `LLM4TS_GEMINI_BRIDGE=1 LLM4TS_GEMINI_BRIDGE_MODE=model llm4ts doctor`                                                            | `llm4ts config set LLM4TS_GEMINI_BRIDGE=on LLM4TS_GEMINI_BRIDGE_MODE=model`; `llm4ts doctor`                                                                                                  |
| `flows/README.md`, `flow-authoring.md`  | `LLM4TS_CODER=codex pnpm --filter @llm4ts/flows implement -- --repo … "…"`                                                        | `llm4ts run implement --coder codex --repo … "…"` (from a checkout: `pnpm llm4ts run …`); one way to start a flow                                                                             |
| `flows/README.md:666` (local models)    | `ANTHROPIC_BASE_URL=… ANTHROPIC_AUTH_TOKEN=lmstudio LLM4TS_CODER=claude LLM4TS_CODER_MODEL=…`                                     | a roster executor whose `env` carries the two `ANTHROPIC_*` names (ADR 0019 already supports it), plus `config set` for the coder model                                                       |

The last row shows a limit kept on purpose: a config file takes only
registry names, never a foreign variable. Variables that configure a CLI
belong to a roster executor's `env`, which exists for exactly that.

### Call sites in code

The shell, for every flow it launches (run, refine, menu, MCP):

```ts
const settings = yield * loadConfig({ repo, flags: runFlagAssignments(config) })
yield * printProblems(settings)
const exitCode =
  yield *
  launchFlow({
    flowPath,
    taskArgs,
    environment: flowEnvironment(settings, { flow: flowName })
  })
```

An in-process verb (doctor, graph, watch, roster, gemini-bridge):

```ts
const settings = yield * loadConfig({ repo })
const report = yield * makeDoctorProgram(settings.environment)
```

A reader in the runner, flow package, flows or kits (units 5 to 7):

```ts
const timeout = settingValue("LLM4TS_GATE_TIMEOUT", environment) // Duration, its default when unset
const votes = settingValue("LLM4TS_REVIEW_VOTES", environment) ?? 2 // per-flow default: number | undefined
const legacy =
  yield *
  requireSetting("LLM4TS_LEGACY_REPO", environment, {
    purpose: "the legacy repository holding docs/modernization/",
    repo: given.workDir
  })
```

A misspelled name is a type error in all three: `SettingName` is the
registry's key union.

## Shape

### Data first: a setting

```text
name (the key)  LLM4TS_JUDGE_ROUNDS            the one spelling, everywhere
group           review                         docs sections, config show --all
scope           project                        which sources may supply it, which file config set writes
value           positive                       one shared grammar: schema, phrase, empty rule, path?, runs a command?
fallback        PerFlow "3 per story …"        Default(value) | PerFlow(text) | Off(text)
doc             one or two sentences           rendered into docs and config show NAME
flag            — (LLM4TS_PACK has --pack)     the run flag that also sets it
requiredBy      []                             flows that stop before their first model call without it (proved by a test)
shellOnly       —                              read by the shell, never handed to a flow (LLM4TS_MCP_TOKEN)
```

Which flows _read_ a setting is not declared: no check could keep such a
list honest. `requiredBy` is declared, because a contract test proves every
entry; `config show --flow` (unit 8) derives the rest from the flow's own
source tree.

### Scope decides where a value may come from

The grounding's classification (machine, project, run, tuning) mixes two
questions: how often a value changes, and where it may be written down. Only
the second shapes the design. `--verbose` changes every run yet is a
preference; a gate timeout almost never changes yet is about one
repository's test suite; API keys are "machine" yet must never be written.
So a setting carries one of five scopes:

| scope      | examples                                                    | flag / `--set` | environment   | project file    | global file     | `config set` writes    |
| ---------- | ----------------------------------------------------------- | -------------- | ------------- | --------------- | --------------- | ---------------------- |
| `global`   | coder, reasoner, models, UI, verbosity, OTEL, bridge        | yes            | yes           | yes             | yes             | global file            |
| `project`  | pack, legacy/target repo, gates, app dir, bounds, kit knobs | yes            | yes           | yes             | yes             | project file           |
| `run`      | wave, bench mode, fork-as, pilot, executors                 | yes            | yes           | ignored, warned | ignored, warned | refused, names `--set` |
| `secret`   | MCP token, bridge token                                     | refused        | yes           | ignored, warned | ignored, warned | refused                |
| `internal` | flow name, run id, trace path                               | refused        | set by llm4ts | ignored, warned | ignored, warned | refused                |

"Tuning" is not a scope: the forty knobs are `project` settings that `config
show` hides until `--all`.

### Precedence, files, format

Highest first: **flag (`--set` and named flags) > environment > project
file > global file > default.** Environment above files is forced by
additivity (an existing export must keep its meaning) and is the dotenv and
direnv convention. Project above global is the roster's rule
(`mergeRosterDocuments`). A flag and `--set` naming the same setting is a
usage error, not a precedence question.

- **Global file:** `${XDG_CONFIG_HOME:-~/.config}/llm4ts/config.env`, beside
  `roster.json`, `mcp.json`, `kits/` and `flows/`.
- **Project file:** `<repo>/.llm4ts/config.env`, where `<repo>` is the
  command's `--repo`, else the working directory: the same rule as
  `.llm4ts/roster.json`. No walk-up to parent directories. Under `.llm4ts/`
  it is git-ignored by the existing `.gitignore` and denied to every coder.
- **Format:** the environment written down. Each line is blank, a comment
  (`#` first), or `[export ]NAME=value[ # comment]`, where value is
  unquoted (ends at whitespace followed by `#`, trimmed) or wholly `"…"` or
  `'…'` quoted. No escapes, no interpolation, no multi-line values. Anything
  else is a malformed line, an error naming `path:line`. An `export` block
  copied from a runbook is a valid file.
- **Paths in files:** a `path` setting's value has a leading `~/` expanded
  and a relative path resolved against the repository (project file) or the
  home directory (global file), so the child always receives an absolute
  path. Paths from the environment pass through untouched, as today.
  `config set` stores absolute paths resolved against the working directory.
- **Empty values:** an empty value counts as unset, unless the setting's
  grammar gives empty a meaning (`LLM4TS_WORKTREE_SETUP=` skips setup,
  `LLM4TS_GATES=` runs none). So an empty export does not shadow a file.

**What the tool writes:** only `config set`, `config unset` and `config
init`; only the two files; only `global` and `project` settings; never a
secret. It edits by name inside the text it read just before an atomic
replace (`writeAtomic`), keeping comments, order and any line it does not
understand. It writes through `ignoringRunState(nodePlainFileStore)`, so
creating the project file also leaves `.llm4ts/.gitignore` (`*`) when the
directory had none, exactly as a run's first write does. New names are appended. Values are written unquoted, or
double-quoted when they hold whitespace or `#`, or single-quoted when they
hold `"`; a value holding both quotes or a newline is refused. Setting the
current value writes nothing. Flows and the MCP operator only read.

### Strict where new, lenient where old

| Problem                                          | in `--set`, a named flag, `config set` | in a file               | in the environment (3.x)                   | in the environment (4.0.0) |
| ------------------------------------------------ | -------------------------------------- | ----------------------- | ------------------------------------------ | -------------------------- |
| unknown `LLM4TS_*` name                          | error, closest name                    | warning, closest name   | warning, closest name                      | warning                    |
| value the grammar does not read                  | error                                  | error, `path:line`      | warning; flows treat it as unset, as today | error                      |
| `run`/`secret`/`internal` setting                | per the scope table                    | warning, ignored        | accepted                                   | accepted                   |
| environment value shadows a different file value | —                                      | —                       | note at run start, shown by `config show`  | same                       |
| same name twice in one file                      | —                                      | warning, last line wins | —                                          | —                          |

Files and `--set` are new surface, so they are strict from their first
release and never need a breaking change. Unknown names stay warnings
forever: a file may outlive a version that knew the name. The closest name
is the registry name at the smallest Damerau-Levenshtein distance over the
part after `LLM4TS_` (at most 2, or a quarter of the length), or one with the
same `_`-separated words in another order (`LLM4TS_REPO_LEGACY`). Secret
values never appear in any message.

### Where resolution runs

Once per command, in the shell, by one pure function. The four launchers
hand the child `flowEnvironment(resolution, …)`: the process environment,
plus each file value the environment lacks, plus the flags, minus
`shellOnly` secrets, plus `LLM4TS_FLOW` (and, for the operator,
`LLM4TS_RUN_ID` and `LLM4TS_TRACE_PATH`). `launchFlow` and
`FlowProcess.start` accept only a `FlowEnvironment`, whose brand only
`flowEnvironment` can produce, so a fifth launcher cannot forget the files.
This also fixes a quiet gap: the menu launches today without `LLM4TS_FLOW`.

The flow child does not read files. A script started with plain `node`
sees only its environment; the docs move their `pnpm --filter @llm4ts/flows
<flow>` commands to `llm4ts run <flow>`, which the architecture review
already wants as the one way to start a flow.

### Where requirements are checked

By the reader, never by the launcher. `requireSetting(name, env, {purpose,
repo})` fails with `SettingMissing`, whose message names the setting, the
flow (from `LLM4TS_FLOW`) and the two ways to set it. Called at the top of a
flow's program, before `runNode`, it fails before any token. Conditional
requirements (several SOAP services, `epic-design --list`) stay where the
mode is known, with the same error. The registry's `requiredBy` lists the
unconditional pairs, and a contract test runs each flow without its
setting, with a stub coder on `PATH` that records calls: exit 1, the name on
stderr, zero calls. Adding a `requiredBy` entry adds a test case.

### Registry placement and the derived `RunConfig`

The registry lives in `@llm4ts/flow/Settings`: flow is the lowest package
that reads settings (15 names in 12 modules), so every reader above it, and
the shell, can use the typed names. Core stays free of CLI configuration.
The runner's settings are read through the same `settingValue`, which is
the `RunConfig` of the architecture review with no second schema: the shell
writes strings named by `SettingName`, the runner reads them with the codec
that validated them.

Built-in kits' settings (`LLM4TS_SOAP_*`, `LLM4TS_ADO_*`,
`LLM4TS_FAIL_FAST`) are in the same table under their kit's group: the
registry holds names and grammars, not behaviour, and one table is what the
docs, warnings and checks need. The `LLM4TS_` namespace belongs to the
registry: a user's own flow or kit uses its own prefix.

### Docs and drift

`docs/configuration.md` keeps its hand-written prose. Between
`<!-- settings:begin -->` and `<!-- settings:end -->` it carries the
reference, rendered from the registry: one table per group (setting, value,
default, belongs in, meaning, required by). `examples/test/settings-sync.test.ts`
fails when:

1. the region differs from `settingsReference()` (fix: `pnpm build && node scripts/settings-docs.mjs`);
2. a `LLM4TS_[A-Z0-9_]+` token in `packages/*/src`, `flows`, `kits`,
   `examples` or `tools/judgment` (tests and build copies excluded) is not a
   registry name: code reads a name the registry lacks;
3. a registry name appears nowhere in that code: a dead entry;
4. a `LLM4TS_` token in the live docs (`docs/*.md` except the frozen ones,
   `README.md`, `flows/README.md`, `kits/**/README.md`, the RUNBOOKs) is not
   a registry name;
5. a shell code fence in those docs assigns an `LLM4TS_*` variable, as a
   prefix or an `export` (predicate 1 as a test; baseline 28);
6. a `requiredBy` flow or a `flag` does not exist.

### Interface depth

The public surface is small for what it hides. Readers get two functions
and a type (`settingValue`, `requireSetting`, `SettingName`). The shell gets
`loadConfig`, `flowEnvironment` and `printProblems`. Users get four
subcommands, `--set` and `--coder`. Behind them: the line grammar, layering,
path normalization, empty-value rules, the strict and lenient policy,
secret handling, closest-name search, shadow detection and comment-keeping
edits. A caller never chooses a layer, a parser or a source.

## Type sketch

```ts
// ---- packages/flow/src/settings/Value.ts  (@internal: one grammar per kind) ----
import * as Duration from "effect/Duration"
import * as Schema from "effect/Schema"

/**
 * How a setting's raw string reads. One instance per grammar, shared by every
 * setting of that grammar, so `on` means the same for all toggles. The same
 * decoding applies whatever the source: flag, environment or file.
 */
export interface SettingValue<A> {
  /** Docs, `config show` and errors print this: "on or off", "a positive integer". */
  readonly grammar: string
  readonly schema: Schema.Codec<A, string>
  /** "unset": an empty string reads as unset. "value": empty means something. */
  readonly empty: "unset" | "value"
  /** A filesystem path: `~` expanded and made absolute when it comes from a file or `config set`. */
  readonly path: boolean
  /** llm4ts runs it as a command (gates, setup, test-one); docs and `config show` say so. */
  readonly runs: boolean
}

/** 1|true|on|yes and 0|false|off|no, any case: the one boolean grammar. */
export declare const toggle: SettingValue<boolean>
/** An integer of at least 1. */
export declare const positive: SettingValue<number>
/** An integer of at least 0; 0 turns the feature off. */
export declare const count: SettingValue<number>
/** Whole seconds, minutes or a span such as `90s`, `5m`, `1h`. */
export declare const seconds: SettingValue<Duration.Duration>
export declare const minutes: SettingValue<Duration.Duration>
export declare const span: SettingValue<Duration.Duration>
/** Non-empty text, trimmed. */
export declare const text: SettingValue<string>
export declare const path: SettingValue<string>
export declare const url: SettingValue<string>
/** One command line (`runs: true`). */
export declare const command: SettingValue<string>
/** `cmd; cmd`; empty means none (`empty: "value"`, `runs: true`). */
export declare const commands: SettingValue<ReadonlyArray<string>>
/** Comma-separated names. */
export declare const names: SettingValue<ReadonlyArray<string>>
/** `key=value;key=value`, extra CLI flags for a seat. */
export declare const cliFlags: SettingValue<Readonly<Record<string, string>>>
export declare const oneOf: <const L extends ReadonlyArray<string>>(
  choices: L
) => SettingValue<L[number]>

// ---- packages/flow/src/settings/Registry.ts  (@internal: the one table) ----------
import { apiProviderNames, coderNames } from "@llm4ts/core/Models" // from connectorTable (architecture review unit 6)
import * as Value from "./Value.ts"

export type SettingScope = "global" | "project" | "run" | "secret" | "internal"

/** Docs sections and `config show --all` groups, in this order. */
export const settingGroups = [
  ["seats", "Seats and models"],
  ["repositories", "Repositories, packs and worktrees"],
  ["gates", "Gates"],
  ["review", "Review, judging and stalls"],
  ["context", "Context and estate bounds"],
  ["modernization", "Modernization flows"],
  ["ports", "Port flows"],
  ["soap-ace", "Kit: soap-ace"],
  ["j2ee-nextjs", "Kit: j2ee-nextjs"],
  ["terminal", "Terminal, transcripts and the agent tree"],
  ["telemetry", "OpenTelemetry and usage estimates"],
  ["gemini-bridge", "Gemini bridge"],
  ["operator", "MCP operator"],
  ["launch", "Set by llm4ts"]
] as const
export type SettingGroup = (typeof settingGroups)[number][0]

export type Fallback<A> =
  /** One default for every reader; `settingValue` returns it when unset. */
  | { readonly _tag: "Default"; readonly value: A; readonly text: string }
  /** Each flow decides; the text says how ("claude; pi in the epic flows"). */
  | { readonly _tag: "PerFlow"; readonly text: string }
  /** Unset means the feature is off or absent. */
  | { readonly _tag: "Off"; readonly text: string }

export interface Setting<A, F extends Fallback<A>> {
  readonly group: SettingGroup
  readonly scope: SettingScope
  readonly value: Value.SettingValue<A>
  readonly fallback: F
  /** One or two sentences: what it changes. Rendered into the docs and `config show NAME`. */
  readonly doc: string
  /** The `llm4ts run` flag that also sets it. */
  readonly flag?: `--${string}`
  /** Flows that stop before their first model call when it is unset; the contract test proves each. */
  readonly requiredBy?: ReadonlyArray<string>
  /** Read by the shell only; `flowEnvironment` never hands it to a flow. */
  readonly shellOnly?: true
}

/** Identity at runtime; infers `A` and `F` for each entry. */
export const setting = <A, F extends Fallback<A>>(spec: Setting<A, F>): Setting<A, F> => spec

export const fallback = {
  value: <A>(value: A, text: string): Fallback<A> & { readonly _tag: "Default" } => ({
    _tag: "Default",
    value,
    text
  }),
  perFlow: (text: string) => ({ _tag: "PerFlow", text }) as const,
  off: (text: string) => ({ _tag: "Off", text }) as const
}

/** Every `LLM4TS_*` name llm4ts reads. Unit 1 fills all of inventory.md (96) plus tools/judgment. */
export const settings = {
  LLM4TS_CODER: setting({
    group: "seats",
    scope: "global",
    value: Value.oneOf(coderNames),
    fallback: fallback.perFlow("claude; pi in the epic flows"),
    flag: "--coder",
    doc: "The coding agent that edits files."
  }),
  LLM4TS_REASONER: setting({
    group: "seats",
    scope: "global",
    value: Value.oneOf(coderNames),
    fallback: fallback.perFlow("claude"),
    doc: "The agent that plans, reviews and judges in the epic, soap and design flows."
  }),
  LLM4TS_PROVIDER: setting({
    group: "seats",
    scope: "global",
    value: Value.oneOf(apiProviderNames),
    fallback: fallback.value("mock", "mock"),
    doc: "The API provider of provider-driven flows such as hello; LLM4TS_MODEL is then required."
  }),
  LLM4TS_PACK: setting({
    group: "repositories",
    scope: "project",
    value: Value.text,
    fallback: fallback.perFlow(
      "cobol-springboot in the modernization flows; j2ee-nextjs-spa in the convert flows"
    ),
    flag: "--pack",
    doc: "The pack: a kit pack name, kit/pack, or a directory holding pack.md."
  }),
  LLM4TS_LEGACY_REPO: setting({
    group: "repositories",
    scope: "project",
    value: Value.path,
    fallback: fallback.off("none"),
    requiredBy: ["epic-design", "modernize-seed", "convert-page", "convert-all", "convert-feature"],
    doc: "The legacy repository holding docs/modernization/, for flows rooted at the target."
  }),
  LLM4TS_GATES: setting({
    group: "gates",
    scope: "project",
    value: Value.commands,
    fallback: fallback.perFlow(
      "the pack's ## Gates, else pnpm typecheck, lint, test and build when defined"
    ),
    doc: "The gate commands run after every task and merge, overriding the pack's."
  }),
  LLM4TS_GATE_TIMEOUT: setting({
    group: "gates",
    scope: "project",
    value: Value.seconds,
    fallback: fallback.value(Duration.seconds(1200), "1200 seconds"),
    doc: "How long a gate may run before it is killed and reported as a hang."
  }),
  LLM4TS_WORKTREE_SETUP: setting({
    group: "repositories",
    scope: "project",
    value: Value.command, // empty: "value" (an empty setting skips setup)
    fallback: fallback.perFlow("the pack's setup:, else pnpm install --offline"),
    doc: "Prepares each story worktree before its coder starts; empty skips setup."
  }),
  LLM4TS_JUDGE_ROUNDS: setting({
    group: "review",
    scope: "project",
    value: Value.positive,
    fallback: fallback.perFlow("3 per story in the epic flows, 2 in task mode"),
    doc: "Judge attempts per story before it fails; --review-rounds and --judge-rounds set it too."
  }),
  LLM4TS_WAVE: setting({
    group: "modernization",
    scope: "run",
    value: Value.text,
    fallback: fallback.off("every wave, with estate-wide coverage"),
    doc: "Scopes modernize-extract to one wave of the approved plan."
  }),
  LLM4TS_VERBOSITY: setting({
    group: "terminal",
    scope: "global",
    value: Value.oneOf(["quiet", "normal", "verbose", "debug"]),
    fallback: fallback.value("normal" as const, "normal"),
    flag: "--verbose",
    doc: "How much the terminal shows."
  }),
  LLM4TS_GEMINI_BRIDGE: setting({
    group: "gemini-bridge",
    scope: "global",
    value: Value.toggle,
    fallback: fallback.value(false, "off"),
    doc: "Starts the local Gemini bridge for pi seats during a run."
  }),
  LLM4TS_GEMINI_BRIDGE_TOKEN: setting({
    group: "gemini-bridge",
    scope: "secret",
    value: Value.text,
    fallback: fallback.off("no token required"),
    doc: "The bearer every bridge request must carry; also pi's apiKey."
  }),
  LLM4TS_MCP_TOKEN: setting({
    group: "operator",
    scope: "secret",
    shellOnly: true,
    value: Value.text,
    fallback: fallback.off("no HTTP transport without --token-file"),
    doc: "The bearer token of `llm4ts mcp --http`; never reaches a flow."
  }),
  LLM4TS_FLOW: setting({
    group: "launch",
    scope: "internal",
    value: Value.text,
    fallback: fallback.off("set by every launcher"),
    doc: "The running flow's name, for its spans and for SettingMissing messages."
  })
  // … every other name of inventory.md
} as const

// ---- packages/flow/src/Settings.ts  (public: @llm4ts/flow/Settings) -----------
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { settings, type SettingGroup, type SettingScope } from "./settings/Registry.ts"
import type * as Value from "./settings/Value.ts"

export type { SettingGroup, SettingScope }
export type Environment = Readonly<Record<string, string | undefined>>

/** The registry's keys: a misspelled name does not compile. */
export type SettingName = keyof typeof settings

type Entry<N extends SettingName> = (typeof settings)[N]
export type ValueOf<N extends SettingName> =
  Entry<N>["value"] extends Value.SettingValue<infer A> ? A : never
/** What `settingValue` returns: the value, or `undefined` when unset with no single default. */
export type Reading<N extends SettingName> = Entry<N>["fallback"] extends {
  readonly _tag: "Default"
}
  ? ValueOf<N>
  : ValueOf<N> | undefined

/** What the shell, the docs and `config show` read about a setting; never its schema. */
export interface SettingFacts {
  readonly name: SettingName
  readonly group: SettingGroup
  readonly scope: SettingScope
  readonly grammar: string
  readonly path: boolean
  readonly runs: boolean
  readonly emptyIsValue: boolean
  readonly fallback: { readonly kind: "default" | "per-flow" | "off"; readonly text: string }
  readonly doc: string
  readonly flag?: string
  readonly requiredBy: ReadonlyArray<string>
  readonly shellOnly: boolean
}

export const settingNames: ReadonlyArray<SettingName> = notImplemented("settingNames")
export const isSettingName = (name: string): name is SettingName => notImplemented("isSettingName")
export const settingFacts = (name: SettingName): SettingFacts => notImplemented("settingFacts")

/**
 * One raw string read by the setting's grammar: what `config set`, `--set`
 * and the file loader validate with. The error is the grammar phrase; it
 * never carries the raw value, so a secret cannot leak through it.
 */
export const readSetting = <N extends SettingName>(
  name: N,
  raw: string
): Result.Result<ValueOf<N> | undefined, string> => notImplemented("readSetting")

/**
 * The setting's value in `environment` (which the shell has already layered).
 * Unset: the `Default` fallback's value, else `undefined`. 3.x: a value the
 * grammar does not read reads as unset, as every private parser did; 4.0.0
 * makes the shell refuse it at launch instead, so this stays total.
 */
export const settingValue = <N extends SettingName>(
  name: N,
  environment: Environment
): Reading<N> => notImplemented("settingValue")

export class SettingMissing extends Schema.TaggedError<SettingMissing>()("SettingMissing", {
  name: Schema.String,
  flow: Schema.optional(Schema.String),
  message: Schema.String
}) {}

export class SettingUnreadable extends Schema.TaggedError<SettingUnreadable>()(
  "SettingUnreadable",
  {
    name: Schema.String,
    grammar: Schema.String,
    message: Schema.String
  }
) {}

/**
 * For a flow that cannot run without the setting. Call it at the top of the
 * program, before `runNode`, so it fails before any token. The message names
 * the setting, the flow (`LLM4TS_FLOW`), the purpose and both ways to set it:
 *   epic-design needs LLM4TS_LEGACY_REPO: <purpose>.
 *     for this repository:  llm4ts config set --repo <repo> LLM4TS_LEGACY_REPO=<path>
 *     for this run only:    llm4ts run epic-design --set LLM4TS_LEGACY_REPO=<path> …
 */
export const requireSetting = Effect.fn("@llm4ts/flow/Settings.requireSetting")(function* <
  N extends SettingName
>(
  name: N,
  environment: Environment,
  options: { readonly purpose: string; readonly repo?: string }
): Effect.fn.Return<ValueOf<N>, SettingMissing | SettingUnreadable> {
  return yield* notImplementedEffect("requireSetting")
})

/** The Markdown between the settings markers of docs/configuration.md: one table per group. */
export const settingsReference = (): string => notImplemented("settingsReference")

// ---- packages/shell/src/Config.ts  (files, layering, the child's environment) --
import * as Effect from "effect/Effect"
import { FileSystem } from "effect/FileSystem"
import * as Schema from "effect/Schema"
import type { Environment, SettingName } from "@llm4ts/flow/Settings"

export type Layer = "flag" | "environment" | "project" | "global"
export type FileLayer = "project" | "global"

/** One `NAME=value` from one source, before it is judged. `name` may not be a setting. */
export interface Assignment {
  readonly name: string
  readonly raw: string
  readonly layer: Layer
  /** Files: where the line is. Flags: which flag (`--set`, `--pack`). */
  readonly at?: { readonly path: string; readonly line: number } | { readonly flag: string }
}

/** A parsed config file: every line kept, so an edit can write back what it did not touch. */
export interface ConfigFile {
  readonly layer: FileLayer
  readonly path: string
  readonly exists: boolean
  readonly lines: ReadonlyArray<ConfigLine>
}
export type ConfigLine =
  | {
      readonly _tag: "Entry"
      readonly line: number
      readonly name: string
      readonly raw: string
      readonly text: string
    }
  | { readonly _tag: "Other"; readonly line: number; readonly text: string }
  | { readonly _tag: "Malformed"; readonly line: number; readonly text: string }

export type SettingProblem =
  | {
      readonly _tag: "UnknownName"
      readonly assignment: Assignment
      readonly closest?: SettingName
    }
  | {
      readonly _tag: "Unreadable"
      readonly assignment: Assignment
      readonly name: SettingName
      readonly grammar: string
    }
  | {
      readonly _tag: "Misplaced"
      readonly assignment: Assignment
      readonly name: SettingName
      readonly scope: "run" | "secret" | "internal"
    }
  | { readonly _tag: "Shadowed"; readonly winner: Assignment; readonly loser: Assignment }
  | { readonly _tag: "Duplicate"; readonly first: Assignment; readonly second: Assignment }
  | { readonly _tag: "Malformed"; readonly path: string; readonly line: number }
  | { readonly _tag: "Conflict"; readonly name: SettingName; readonly flags: ReadonlyArray<string> }

/**
 * Blocking: anything from a flag (unknown, unreadable, misplaced, conflict),
 * an unreadable file value, a malformed line. Everything from the
 * environment, unknown and misplaced file names, duplicates and shadows only
 * warn (4.0.0: an unreadable environment value blocks too).
 */
export const isBlocking = (problem: SettingProblem): boolean => notImplemented("isBlocking")

export interface Resolved {
  readonly winner: Assignment
  /** Lower layers that also set it, highest first. */
  readonly shadowed: ReadonlyArray<Assignment>
}

export interface Resolution {
  readonly repo: string
  readonly files: ReadonlyArray<ConfigFile>
  /** Settings with any assignment; the rest are at their fallback. */
  readonly settings: ReadonlyMap<SettingName, Resolved>
  readonly problems: ReadonlyArray<SettingProblem>
  /**
   * The process environment, plus each file value it lacks (paths made
   * absolute), plus the flags. What in-process verbs read in place of
   * `process.env`; `flowEnvironment` derives the child's from it.
   */
  readonly environment: Environment
}

export class ConfigInvalid extends Schema.TaggedError<ConfigInvalid>()("ConfigInvalid", {
  message: Schema.String // every blocking problem, one per line; never a secret's value
}) {}

/** `${XDG_CONFIG_HOME:-~/.config}/llm4ts/config.env` and `<repo>/.llm4ts/config.env`. */
export const configPaths = (
  repo: string,
  environment: Environment
): { readonly global: string; readonly project: string } => notImplemented("configPaths")

/** Pure: the line grammar. A missing file is `exists: false` with no lines. */
export const parseConfigFile = (
  layer: FileLayer,
  path: string,
  text: string | undefined
): ConfigFile => notImplemented("parseConfigFile")

/**
 * Pure: flag > environment > project > global > default. Judges each
 * assignment against the registry (unknown, unreadable, misplaced), keeps
 * what each winner shadows, normalizes file paths against the repository or
 * home, treats an empty value as unset unless its grammar says otherwise.
 */
export const resolveConfig = (input: {
  readonly repo: string
  readonly environment: Environment
  readonly files: ReadonlyArray<ConfigFile>
  readonly flags: ReadonlyArray<Assignment>
}): Resolution => notImplemented("resolveConfig")

/** Reads both files for `repo` (default: the working directory), resolves, fails on blocking problems. */
export const loadConfig = Effect.fn("@llm4ts/shell/Config.loadConfig")(function* (options: {
  readonly repo?: string
  readonly flags?: ReadonlyArray<Assignment>
  readonly environment?: Environment
}): Effect.fn.Return<Resolution, ConfigInvalid, FileSystem> {
  // TODO: read global then project with fs.readFileString (missing → undefined),
  // parseConfigFile each, resolveConfig, then fail with every blocking problem at once.
  return yield* notImplementedEffect("loadConfig")
})

/** `--set NAME=value` arguments as flag assignments; a missing `=` is a usage error. */
export const setAssignments = (
  values: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<Assignment>, ShellUsageError> => notImplemented("setAssignments")

/** Warnings and notes to stderr, once per command, in a fixed order. */
export const printProblems = (resolution: Resolution): Effect.Effect<void> =>
  notImplemented("printProblems")

declare const FlowEnvironmentId: unique symbol
/** The only environment a flow child may get; only `flowEnvironment` makes one. */
export interface FlowEnvironment {
  readonly [FlowEnvironmentId]: true
  readonly variables: Environment
}

/**
 * The child's environment: `resolution.environment` minus `shellOnly`
 * settings, plus `LLM4TS_FLOW` and the operator's run identity.
 */
export const flowEnvironment = (
  resolution: Resolution,
  launch: { readonly flow: string; readonly runId?: string; readonly tracePath?: string }
): FlowEnvironment => notImplemented("flowEnvironment")

/**
 * Pure: the file's new text after setting or removing names. Edits the last
 * line of a name in place and drops earlier duplicates, appends new names,
 * keeps every other line byte for byte. Returns `undefined` when nothing
 * changes, so an unchanged `config set` writes nothing.
 */
export const editConfigText = (
  file: ConfigFile,
  changes: ReadonlyArray<{ readonly name: SettingName; readonly value: string | undefined }>
): string | undefined => notImplemented("editConfigText")

/** Damerau-Levenshtein ≤ 2 (or a quarter of the length) after the prefix, or the same words reordered. */
export const closestSettingName = (name: string): SettingName | undefined =>
  notImplemented("closestSettingName")

// ---- packages/shell/src/ConfigCommand.ts  (`llm4ts config`) --------------------
import * as Result from "effect/Result"
import { Argument, Command, Flag } from "effect/cli"

export class ConfigReport extends Schema.Class<ConfigReport>("ConfigReport")({
  repo: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      layer: Schema.Literals(["global", "project"]),
      path: Schema.String,
      exists: Schema.Boolean,
      settings: Schema.Number
    })
  ),
  settings: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      from: Schema.Literals(["flag", "environment", "project", "global", "default"]),
      value: Schema.optional(Schema.String), // absent for a secret
      secret: Schema.Boolean,
      at: Schema.optional(Schema.Struct({ path: Schema.String, line: Schema.Number })),
      shadows: Schema.Array(
        Schema.Struct({ from: Schema.String, value: Schema.optional(Schema.String) })
      )
    })
  ),
  problems: Schema.Array(Schema.Struct({ kind: Schema.String, message: Schema.String }))
}) {}

export const configReport = (
  resolution: Resolution,
  options: { readonly all: boolean }
): ConfigReport => notImplemented("configReport")
export const renderConfigShow = (
  report: ConfigReport,
  options: { readonly all: boolean }
): string => notImplemented("renderConfigShow")
export const renderSettingDetail = (resolution: Resolution, name: SettingName): string =>
  notImplemented("renderSettingDetail")

/** What `config set` will do, decided before anything is written: per file, per name, new/changed/unchanged. */
export interface SetPlan {
  readonly writes: ReadonlyArray<{
    readonly file: ConfigFile
    readonly changes: ReadonlyArray<{
      readonly name: SettingName
      readonly value: string
      readonly was?: string
    }>
  }>
  readonly notes: ReadonlyArray<string> // "also exported in this shell (…), which wins over the file"
}
/** Pure: validates every pair (unknown, unreadable, scope), normalizes paths against `cwd`, picks each file. */
export const planSet = (input: {
  readonly assignments: ReadonlyArray<{ readonly name: string; readonly raw: string }>
  readonly target: "by-scope" | FileLayer
  readonly resolution: Resolution
  readonly cwd: string
}): Result.Result<SetPlan, ReadonlyArray<string>> => notImplemented("planSet")

export const configCommand: Command.Command<"config", unknown, unknown, unknown> =
  notImplemented("configCommand") // subcommands: show [NAME] [--all] [--json], set NAME=value…, unset NAME…, init

// ---- changed signatures -----------------------------------------------------------
// packages/shell/src/FlowLaunch.ts
export interface LaunchFlowOptions {
  readonly flowPath: string
  readonly taskArgs: ReadonlyArray<string>
  readonly environment: FlowEnvironment // was optional Record; `coder` override goes (a flag assignment now)
  readonly cwd?: string
  readonly stdio?: "inherit" | "ignore"
}
// packages/shell/src/Cli.ts: runEnvironmentFrom is replaced by
export const runFlagAssignments = (flags: RunFlags): ReadonlyArray<Assignment> =>
  notImplemented("runFlagAssignments")
// packages/shell/src/RunSupervisor.ts: knobsToEnvironment is replaced by
export const knobAssignments = (knobs: OperatorKnobs): ReadonlyArray<Assignment> =>
  notImplemented("knobAssignments")
// packages/runner/src/Doctor.ts: collectDoctorReport already takes an environment; it gains
//   a `config` section fed by the shell (files, counts, blocking problems).

// sketch helpers
declare const notImplemented: (what: string) => never
declare const notImplementedEffect: (what: string) => Effect.Effect<never>
declare class ShellUsageError {}
declare interface OperatorKnobs {}
declare interface RunFlags {}
```

## Module map

```text
packages/core/src/Models.ts                 coderNames, apiProviderNames: derived from connectorTable
                                            (architecture review unit 6; until then two checked tuples)
packages/flow/src/Settings.ts               PUBLIC. SettingName, settingValue, requireSetting, readSetting,
                                            settingFacts, SettingMissing, SettingUnreadable, settingsReference
packages/flow/src/settings/Value.ts         @internal. The grammars (toggle, positive, seconds, commands, …)
packages/flow/src/settings/Registry.ts      @internal. The one table, groups, scopes, fallbacks
packages/shell/src/Config.ts                Config files, line grammar, resolveConfig, loadConfig,
                                            flowEnvironment, editConfigText, closestSettingName, printProblems
packages/shell/src/ConfigCommand.ts         `llm4ts config show|set|unset|init`, ConfigReport, renderers, planSet
packages/shell/src/Cli.ts                   run: --set, --coder, runFlagAssignments; every verb loads the config
                                            for its --repo and passes resolution.environment; doctor --repo
packages/shell/src/FlowLaunch.ts            launchFlow takes a FlowEnvironment
packages/shell/src/FlowProcess.ts           start takes a FlowEnvironment
packages/shell/src/RunSupervisor.ts         knobAssignments; loadConfig per repo; flowEnvironment with run id
packages/shell/src/Menu.ts, CoderChoice.ts  read the resolution; coder choice becomes a flag assignment
packages/runner/src/*                       (unit 5) runner settings through settingValue: the derived RunConfig
flows/, kits/*/flows                        (units 6–7) requireSetting at the top; settingValue for knobs
scripts/settings-docs.mjs                   splices settingsReference() into docs/configuration.md (--check mode)
examples/test/settings-sync.test.ts         the six drift checks
examples/test/required-settings.test.ts     (unit 6) the requiredBy contract, stub coder on PATH
docs/adr/0049-settings-and-config-files.md  the one-way doors: format, places, precedence, scopes
```

Trace of `llm4ts run convert-page --repo X accountOverview`: `Cli.ts` run
handler → `Config.loadConfig` (reads two files, `resolveConfig` against
`Settings` facts) → `launchFlow(flowEnvironment(…))`. Three files from flag
to child.

## Synthesis decision

To be filled in by arena.

## Tradeoffs accepted

- We accept `--set LLM4TS_WAVE=wave-1` being barely shorter than the old
  prefix, in exchange for one spelling and a launch that stops on a typo or
  a bad value instead of ignoring it.
- We accept that an exported variable shadows a file value, in exchange for
  additivity; the run-start note and `config show` make the shadow visible.
- We accept a central registry in the flow package that names built-in kit
  settings, in exchange for one list that docs, warnings, `config` and the
  checks all derive from.
- We accept that a flow script started with plain `node` sees no config
  files, in exchange for one resolver and one way to start a flow.
- We accept lenient environment values until 4.0.0, in exchange for no
  behaviour change in 3.x; files and `--set` are strict from birth.
- We accept a hand-written parser for a dotenv subset (about 60 lines) in
  exchange for no dependency and a file that is the environment's own
  syntax.
- We accept one project file per repository (the bank demo writes two), in
  exchange for no walk-up surprises and the roster's rule.
- We accept that `config show` lists only non-default settings unless
  `--all`, in exchange for a screen a person reads; `--json` is complete.
  Predicate 2 is met by `config show --all`.
- We accept `requiredBy` as a declared list, in exchange for a contract
  test it generates; requirements that depend on a flow's mode are checked
  in the flow with the same error and are not listed.

## Alternatives considered

- **Structured file with its own keys** (`config.toml`, `[seats] coder =
"pi"`, or `config.json`). A second vocabulary beside the 96 names users
  already see in docs, errors and flow comments, a second decoder (TOML's
  `1` is a number, the environment's `"1"` a string), and either a parser
  dependency (TOML) or no comments (JSON). It exposes a mapping to callers
  and hides nothing the dotenv subset does not.
- **Walk-up project discovery** (nearest `.llm4ts/config.env` above the
  working directory, like `.npmrc` or `.editorconfig`). A parent directory
  silently changes a run, `roster.json` does not walk, and a flow's
  repository is `--repo` or the working directory anyway.
- **Files beat the environment.** Breaks additivity: every existing export
  would lose to a file the user may not know exists.
- **Named profiles** (`llm4ts config use demo-bank`, kubectl-style). A
  second axis of hidden state ("which profile is current?") that `show`
  must explain; per-repository files give the same result with no pointer.
- **A generated flag per setting** (`llm4ts run modernize-extract --wave
wave-1`). Ninety flags in `--help` and a third spelling per setting. One
  generic, validated `--set` covers them; `--coder` is the one sugar that
  earns its place.
- **The runner resolves files in each child** (`runFlowMain` reads the
  files). In-process verbs (doctor, graph, watch) need resolution in the
  shell anyway, so there would be two resolvers and every warning printed
  twice.
- **Effect `Config`/`ConfigProvider` layered with `orElse`.** No
  provenance, so `config show` cannot say where a value came from, and
  flows are child processes that read a flat environment regardless.
- **The launcher enforces required settings** (shell preflight from a
  static per-flow list). Requirements depend on a flow's mode, so a static
  check would block `epic-design -- --list` and one-service SOAP runs, and
  the requirement would live in two places that drift.
- **Settings declared next to their owner** (runner, flows/lib and each
  kit declare their own, the shell unions them). Ownership-correct, but the
  union is a hand-kept list of modules, kit settings would need the shell
  to import kit code, and an agent adding a knob sees no single example to
  copy.

## Open questions and risks

1. Should a team be able to commit `.llm4ts/config.env`? Today
   `.llm4ts/.gitignore` (`*`) keeps it local. If yes, should settings whose
   grammar `runs` a command (`LLM4TS_GATES`, `LLM4TS_WORKTREE_SETUP`,
   `LLM4TS_TEST_ONE`) from a project file need a one-time `llm4ts config
trust`, as direnv's `allow` does? (A cloned repository can already ship
   `.llm4ts/flows/*.ts`, which is worse, so this may be moot.)
2. Should `config show` with no flag print every setting, to meet
   predicate 2 literally, or only those not at their default, as `git
config --list` does?
3. Is `LLM4TS_CONFIG=none` (ignore both files) wanted for CI and
   reproducible rehearsals, or is `XDG_CONFIG_HOME` plus a clean
   repository enough?
4. Should a few foreign, non-secret names (`OTEL_EXPORTER_OTLP_ENDPOINT`)
   be allowed in the global file, or does everything foreign stay in the
   environment or a roster executor's `env`?
5. Should the run record which settings came from which layer (names and
   layers, no values) in its trace, so `llm4ts profile --against` can say
   "this run had `LLM4TS_JUDGE_ROUNDS` from the project file"?
6. Which scope for the forty tuning knobs that are about the model rather
   than the repository (`LLM4TS_CONTEXT_BUDGET`): project, as proposed, or
   global?
7. Should a removed name (`LLM4ZIO_CODER`) get a "no longer read; use
   `LLM4TS_CODER`" warning through a `formerly` field?
8. Risk: `coderNames` depends on the architecture review's `connectorTable`.
   If unit 6 there has not landed, unit 1 here adds two checked tuples to
   `core/Models.ts`, a short-lived second list guarded by a runner test.

## Independently landable units

Every unit runs `pnpm typecheck`, `lint`, `format:check`, `unused` and
`test`. Units that change CLI behaviour are also driven through the
`verify-llm4ts` skill. Units 1 to 4 change no flow script and together make
release 3.3.0.

| #   | Unit                                                                                                                                                                                                                                                                                                                    | Check                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Registry and a read-only `config show`.** `@llm4ts/flow/Settings` with every name of inventory.md plus `tools/judgment` (scopes, groups, grammars, fallbacks, docs). `config show [NAME] [--all] [--json]` over the environment alone, with unknown-name warnings. `coderNames`/`apiProviderNames` in core if needed. | `settings-sync` checks 2, 3 and 6 pass; golden tests of `config show` for a fake environment; a typo in the environment prints the closest name (predicate 3, environment half). `pnpm unused` sees `ConfigCommand` import `Settings`.                                                                                                                                                                                                                                       |
| 2   | **Config files and one resolution.** `Config.ts`; `config set`, `unset`, `init`; `run --set` and `--coder`; `run`, `refine`, menu and MCP launch through `flowEnvironment`; in-process verbs read `resolution.environment`; warnings and shadow notes at launch; doctor's config section. ADR 0049.                     | Table-driven tests of `parseConfigFile`, `resolveConfig` (the four layers set and unset, empty values, paths, quotes, inline comments, duplicates, misplaced scopes, conflicts) and `editConfigText` (comments kept, idempotent). `verify-llm4ts` in a sandbox `HOME`: `config set`, then `run` a stub flow that prints its environment; an export overrides the file; `--set` overrides the export; a typo in `--set` stops the launch. Predicates 1 (capability), 2 and 3. |
| 3   | **Generated reference.** `settingsReference()`, markers in `docs/configuration.md`, `scripts/settings-docs.mjs` (`--check`), the 43 undocumented names documented by construction.                                                                                                                                      | `settings-sync` check 1 fails on a deliberately edited registry doc and passes after the script. Predicate 5.                                                                                                                                                                                                                                                                                                                                                                |
| 4   | **Runbooks without prefixes.** The 28 lines and the RUNBOOK `export` blocks become `config set`, `--set` or `--coder`; `pnpm --filter @llm4ts/flows <flow>` commands become `llm4ts run <flow>`; the local-model recipe becomes a roster entry; `reset-demo.mjs` may write both demo files.                             | `settings-sync` checks 4 and 5: prefixed assignments in shell fences go from 28 to 0 and stay there. Predicate 1, measured.                                                                                                                                                                                                                                                                                                                                                  |
| 5   | **Runner reads through the registry (the derived RunConfig).** FlowRunner, Connectors, Otel, ExecutorRoster, Doctor, AgentTree, Tools, PiModels, GeminiBridgeServe use `settingValue`; `truthy`, `switchedOn`, `switchedOff` and the runner's integer parses go.                                                        | Existing runner tests unchanged; one grammar test per toggle (`on`, `1`, `yes`, `true` all read true), which closes the `LLM4TS_GEMINI_BRIDGE=on` defect class.                                                                                                                                                                                                                                                                                                              |
| 6   | **Required settings fail typed and early.** `requireSetting` in epic-design, modernize-seed, the convert lib, the provider model check, the SOAP service pick and epic-mvp's evidence choice; flow header comments show `config set`.                                                                                   | `required-settings.test.ts` runs each `requiredBy` pair without its setting, a stub coder on `PATH` recording calls: exit 1, the name on stderr, zero calls. Predicate 4.                                                                                                                                                                                                                                                                                                    |
| 7   | **Flow, flows/lib and kit readers migrate**, one area per PR (flow kernel; epic-stories; modernize and ports; kits). `coderFromEnv` callers move to `settingValue` through `seatsFromEnvironment` (architecture review unit 7).                                                                                         | A ratchet in `settings-sync`: raw `LLM4TS_` environment reads outside `Settings.ts` may only fall; the private boolean and integer parsers are deleted.                                                                                                                                                                                                                                                                                                                      |
| 8   | **`config show --flow <name>`** (optional): the settings a flow's own source tree mentions, plus the run-wide ones, found by the catalog that already reads flow sources.                                                                                                                                               | Golden output for `convert-page` and a project-tier flow.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 9   | **4.0.0:** an environment value its grammar does not read refuses the launch; `coderFromEnv` is removed.                                                                                                                                                                                                                | Flow smokes; the `config show` warning row becomes an error row.                                                                                                                                                                                                                                                                                                                                                                                                             |

## Next implementation step

Write `packages/flow/src/settings/Registry.ts` from inventory.md, entry by
entry, with the `settings-sync` test that fails until every name the code
reads is in it, then `config show` over the environment on top.
