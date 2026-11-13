# ADR 0049: Settings Registry and Config Files — The Environment, Written Down

Status: Accepted · Date: 2026-11-10 · Relates to ADR 0006, ADR 0019, ADR 0026, ADR 0041

## Context

Every knob of llm4ts is an environment variable. Measured on 2026-11-10,
before this change:

- 96 distinct `LLM4TS_*` names are read across `packages/*/src`, `flows/`
  and `kits/`; 43 of them appear in neither `docs/configuration.md` nor the
  README.
- 8 of the 96 have an `llm4ts run` flag.
- No settings file exists (the roster and the SOAP auth files aside), so a
  repository's settings are retyped, or exported, for every run.
- 28 documentation lines carry an `LLM4TS_…=` assignment a reader has to
  copy in front of a command.
- Nothing checks a name. `LLM4TS_JUDGE_ROUND=1` is accepted in silence and
  changes nothing.
- Readers disagree on spellings. One toggle accepts only `1`, another `1`
  or `true`, a third reacts only to `off`.

A flow that needs a setting finds out after it has started, sometimes after
it has spent tokens.

## Decision

### One registry, keyed by the name users already type

`@llm4ts/flow/Settings` holds every `LLM4TS_*` name in one table. An entry
carries its group, its scope, a value grammar, the fallback when unset, one
doc sentence, and optionally the `run` flag that sets it, the flows that
cannot start without it (`requiredBy`) and `shellOnly`. The literal
variable name is the only spelling. A test fails when code reads a name the
table lacks, or the table holds a name nothing reads.

### Two files in a strict dotenv subset

- Global: `${XDG_CONFIG_HOME:-~/.config}/llm4ts/config.env`, beside
  `roster.json`.
- Project: `<repo>/.llm4ts/config.env`, where `<repo>` is the command's
  `--repo`, else the working directory. No walk-up to parent directories.

Each line is blank, a `#` comment, or `[export ]NAME=value[ # comment]`,
with the value unquoted or wholly quoted. There are no escapes, no
interpolation and no multi-line values. An `export` block copied from a
runbook is a valid file. A path value has `~/` expanded and is made
absolute against the repository (project file) or the home directory
(global file).

The project file is local to a clone. `.llm4ts/` is git-ignored by the tool
itself, and a project file is read only when the user has trusted its
content for that repository (see Consequences).

### Precedence

Flag and `--set` > environment > project file > global file > default. The
environment stays above the files so that every export keeps the meaning it
has today. A named flag and `--set` for the same setting is a usage error.

### Scopes decide where a value may live

| Scope      | Files                 | `--set` and flags | Environment |
| ---------- | --------------------- | ----------------- | ----------- |
| `global`   | global (or project)   | yes               | yes         |
| `project`  | project (or global)   | yes               | yes         |
| `run`      | ignored, with warning | yes               | yes         |
| `secret`   | ignored, with warning | refused           | yes         |
| `internal` | ignored, with warning | refused           | set by us   |

`config set` routes a name to the file its scope names; `--global` and
`--project` force one. A secret is never written to a file and never
printed: `config show` says `(secret, set)`, and no message built by the
config code carries a value.

### Strict where new, lenient where old

Files, `--set` and `config set` are new surface, so they are strict from
their first release: an unknown name or a value the grammar does not read
in `--set` or `config set` is refused, and a malformed line or an
unreadable value in a file refuses the launch with `path:line`. The
environment only warns in 3.x. A launch warns about an unknown `LLM4TS_*`
export only when a known name is close, because a user's own flow may read
its own name. `config show` lists every unknown name.

### Toggles are projected as `1` and `off`

A toggle that comes from a file or a flag reaches the flow child as `1` for
on and `off` for off, whatever spelling the file used. Every current reader
reads that pair correctly, so no per-setting wire spelling is needed. A
value that comes from the environment is passed through untouched.

### The shell resolves; the child receives a branded environment

Resolution runs once per command, in the shell. The four launchers (`run`,
`refine`, the menu, the MCP operator's run supervisor) call one function,
`prepareLaunch`, which loads both files, layers them under the environment
and the flags, and returns a `FlowEnvironment`. `launchFlow` and
`FlowProcess.start` accept only that branded type, and only
`flowEnvironment` makes one, so a fifth launcher cannot skip the files. The
child gets the process environment, plus each value a file or a flag
supplies, minus `shellOnly` settings (the operator's bearer token), plus
`LLM4TS_FLOW`. No flow script reads a file, and none changed.

In-process verbs (`doctor`, `graph`, `watch`, `roster`, `gemini-bridge`)
read the same resolved environment.

### Preflight

Before spawning, the shell checks the registry's `requiredBy`. A flow that
lacks a required setting exits 2 with the setting's doc sentence and the
two ways to set it (`llm4ts config set --repo <repo> NAME=<value>` and
`llm4ts run <flow> --set NAME=<value>`). `requiredBy` lists only
unconditional pairs: no mode of the flow returns before the check, and no
flow argument satisfies it. `epic-design` is left out for
`LLM4TS_LEGACY_REPO` because `-- --list` returns first. Conditional
requirements stay in the flow.

### The verb

`llm4ts config show [NAME] [--all] [--json]`, `config set NAME=value…`,
`config unset NAME…`, `config init`, `config trust [--yes]` and
`config untrust`. `run` gains `--set NAME=value`
(repeatable) and `--coder <name>`. `init` imports the `LLM4TS_*` exports of
the current shell into the files, never overwriting a line, and on a
terminal with no global file asks for the coder and the reasoner first.

`config edit [NAME]` is a guided editor on a terminal, also opened by bare
`llm4ts config` and by the menu's "Configure settings". It lists the
settings a file may hold with their effective value and source, shows the
chosen one as `config show NAME` does, and asks for a new value or a
removal. It adds no second way to write: it checks an answer with the plan
`config set` uses and saves through `config set` and `config unset`, so the
refusals, the trust rule and the printed change are theirs. With a project
file that is not trusted it prints the listing `config trust` prints and
asks the same question before the list opens; after a no it saves to the
global file only. How a
value is asked comes from two registry facts, `toggle` and `choices`, not
from the grammar's wording. Per-run settings and secrets are not offered.
Off a terminal it exits with code 2.

## Consequences

- A runbook's `export` block becomes a one-time `config set` or
  `config init`; the commands after it need no prefix.
- An existing export behaves as before. The only new output on an unchanged
  setup is a warning for a misspelled name that is close to a real one.
- **A project file is used only when the user trusted it.** The file can
  set settings llm4ts runs as commands (`LLM4TS_GATES`,
  `LLM4TS_WORKTREE_SETUP`, `LLM4TS_TEST_ONE`) and seat flags
  (`LLM4TS_CODER_FLAGS`, `LLM4TS_REASONING_FLAGS`), and whoever hands over a
  directory, by clone or by archive, can put one in it. The rule: llm4ts
  uses a project file only when the user has trusted exactly that content
  for exactly that repository.
  - The trust list is one JSON file the tool owns,
    `${XDG_STATE_HOME:-~/.local/state}/llm4ts/config-trust.json`: a map from
    a repository's absolute path to the SHA-256 of its project file. It
    lives outside every repository, so nothing a repository holds can add
    to it. A list that cannot be read or decoded trusts nothing, and a
    warning says so.
  - `loadConfig` hashes the text it read and then parses that same text.
    A match with the record for the repository's path means the file is
    used. With no record (`not trusted`) or another hash
    (`changed since trusted`) none of the file reaches the resolution: not
    its settings, and not its warnings.
  - Writing is trusting. `config set`, `unset`, `init` and `edit` record
    the hash of what they wrote, so a user who only uses the verbs never
    meets a trust step. They write nothing into a file that is not
    trusted; a write to the global file in the same command still happens.
  - `llm4ts config trust [--repo <dir>] [--yes]` prints the file's path,
    every setting in it with its value, a tag on each value llm4ts runs as
    a command and on seat flags, and every line the parser rejects. Control
    and direction characters are printed escaped, so a file cannot hide a
    line of its own listing. It asks one confirmation on a terminal, and
    records the hash of the text it listed. Off a terminal without `--yes`
    it prints the listing and exits 2. `config untrust` removes the record.
  - A launch (`run`, `refine`, the menu, the MCP operator's `start`) with a
    project file that is not trusted is refused before anything is
    spawned: a run must not go on other settings than the user believes
    are in force. `config show`, `doctor` and the other in-process verbs
    go on without the file and say so with the command that accepts it.
  - A user who edits the file by hand runs `llm4ts config trust` once per
    edit. A repository that moves is not trusted at its new path.
  - The path is the one llm4ts was given, made absolute, not the real path
    behind symbolic links: the same repository reached through a link is
    asked about once more.
- The MCP operator's knobs are validated like flags. A knob value the
  grammar does not read, a malformed config line, or a missing required
  setting fails `start` before a run is recorded.
- A flow started with plain `node` sees only its environment. `llm4ts run`
  is the one way to start a flow with the files applied.
- The shell cannot see flow arguments after `--`. A `--repo` passed there
  does not select the project file; the shell's own `--repo` does.
- Every reader reads through the registry: `settingValue`, or `settingGiven`
  and `settingText` where a reader keeps its own default or refuses a value
  by name. That holds for `packages/*/src`, for `flows/` and for the flows
  and tools of `kits/`. A rule beyond the grammar (a minimum above 1, a
  per-flow default, a name pattern) stays in the reader, after the read.
  `examples/test/settings-sync.test.ts` fails on any raw `LLM4TS_*` read in
  those three areas, and on a call that hands a quoted setting name to
  anything but a registry reader, which is how a by-name helper such as
  `positiveEnvInt("LLM4TS_…", 48)` read the environment by hand.

## Alternatives rejected

- **JSON files with short names.** No comments, typed values that differ
  from what the environment carries, a second vocabulary beside the names
  every doc and error already uses, and no paste path from an `export`
  block.
- **A committed project file.** It needs a location outside `.llm4ts/`.
  The owner chose a file local to the clone. The trust list would cover a
  committed file too, at one `config trust` per change.
- **Asking git whether the file came with the clone.** The first build
  ignored a project file that git tracks. Three reviews each found a way
  past the check:
  1. `.llm4ts` committed as a symbolic link to a tracked folder. Git
     reports a path behind a tracked link as unknown, so the file passed.
  2. `.LLM4TS/config.env` committed under another letter case. On a
     case-insensitive filesystem it is the file llm4ts reads, and the
     plain pathspec listed nothing.
  3. The index path compared with the platform separator, which never
     matches git's forward slashes on Windows.

  A directory unpacked from an archive was not covered at all, and neither
  was a machine without git. Each fix kept the premise that git's answer
  tells where a file came from. The premise is what failed, so the check
  was removed and trust no longer depends on anything git reports.

- **Trusting a repository, not its content.** A record keyed by path alone
  would keep trusting a file after a `git pull` or an unpacked archive
  replaced it. The hash makes every change ask again.
- **Kit-local settings declarations.** The kits that exist ship in this
  repository, so one table covers them. Revisit when a kit lives elsewhere.
- **Walk-up discovery of the project file.** The roster already resolves
  against `--repo` or the working directory only. A file found in a parent
  directory would apply settings nobody at the prompt can see.
- **One flag per setting.** 96 flags, each a second spelling to document.
  `--set NAME=value` covers all of them; `--coder` is the one addition,
  because coder choice is the most common per-run prefix in the docs.

## Not decided here

The generated reference in `docs/configuration.md`, the runbooks without
prefixes, moving the readers behind the registry, and refusing an
unreadable environment value in 4.0.0 (decided in the 2026-11-13 amendment
below).

## Amendment, 2026-11-13: seat names are a fixed set

`LLM4TS_CODER` was left as free text because `coderFromEnv`, which most
built-in flows called, read an unknown name as claude. A registry stricter
than its readers would have refused at `config set` what a run accepted.

The readers now share one lookup in `packages/runner/src/Connectors.ts`,
through the connector table's names. `coderFromEnvironment` reads
`LLM4TS_CODER`, `reasonerFromEnvironment` reads `LLM4TS_REASONER`, and
`seatsFromEnvironment` reads both for a flow that runs both seats; each takes
the default its flow passes. Every built-in flow and the j2ee-nextjs kit
flows call one of them before `runNode`, so an unknown name for a seat the
flow runs is a `ScriptUsage` naming the accepted names, and no agent starts.
A flow answers only for the seats it runs: a bad name for a seat it never
uses is the shell's to warn about, as any other unreadable environment value
is in 3.x.

`coderFromEnv` is deprecated and keeps its fallback, so a user's flow script
that calls it runs as before. It is removed in 4.0.0.

`LLM4TS_CODER` is typed as one of the coder names, as `LLM4TS_REASONER` is.
`--coder`, `--set`, `config set` and the config files refuse another name.
This is a behaviour change inside a minor release: a misspelled name that
ran claude now stops the run. It is taken because the old behaviour ran an
agent the operator did not ask for.

The soap-ace flows still read `LLM4TS_REASONER` themselves, only when their
design step runs. They accept the same names. The model and flag settings
are read where they were: this unit does not widen where they apply.

## Amendment, 2026-11-13: 4.0.0 refuses an unreadable environment value

"The environment only warns in 3.x" ends in 4.0.0. An exported `LLM4TS_*`
value that its grammar does not read stops the launch on both paths, with
one message per value that names the setting and its grammar and never the
value:

```text
the environment: LLM4TS_JUDGE_ROUNDS must be a positive integer; fix or unset it
```

- **Shell.** `resolveConfig` marks the value an error, as it already did for
  a flag or a file, and keeps it in the resolution so `config show` prints
  where it comes from. `prepareLaunch` refuses on any error, so `run`,
  `refine`, the menu and the MCP operator's `start` exit before a child is
  spawned. `doctor` and the other in-process verbs print it and go on.
- **Without the shell.** `unreadableEnvironment` in `@llm4ts/flow/Settings`
  checks a whole environment against the registry. The runner calls it once
  at each entry: `runFlowMain` on `process.env` before the flow's program
  starts, and `runEmbedded` (so `runNode`) on the run's environment before
  the run context is built. A refusal is `ScriptUsage`, the runner's usage
  failure, not a defect.

One check of the whole environment at the start, rather than a strict flag
the readers consult, covers every setting a flow can read: each `LLM4TS_*`
reader goes through the registry, and the registry is the list checked. The
readers stay as they are. `settingValue` still counts an unreadable value as
unset, so a library caller outside the runner keeps the lenient reading;
inside a run that case no longer arises.

A flow now refuses a bad name for a seat it never runs, as the shell does:
the seat amendment's "the shell's to warn about" no longer holds.

## Amendment, 2026-11-13: model and flag settings apply in every flow

The seat amendment left `LLM4TS_CODER_MODEL`, `LLM4TS_REASONING_MODEL`,
`LLM4TS_CODER_FLAGS` and `LLM4TS_REASONING_FLAGS` where they were read: the
epic flows, `local` and `sdd`. A setting `config set` accepts for every flow
did nothing for most of them. From 4.1.0 `runEmbedded` (so `runNode`) puts
the four on the run's seats once, through `withSeatSettings` in
`@llm4ts/runner/Connectors`, before the context is built. The seat functions
were not the place: `implement` names no reasoning seat, the soap-ace flows
and user flow scripts build seats without them, and the run banner is
printed from the options `runEmbedded` holds.

- The coder seat takes the coder settings. The reasoning seat, and a
  reviewer or judge seat on the reasoning seat's agent, takes the reasoning
  settings. A non-coder seat on the coder's agent with no model yet takes
  `LLM4TS_CODER_MODEL`, because a model name is read only by its own agent.
  The coder's flags never reach another seat: a read-only seat does not
  inherit edit permissions.
- A model the flow sets in code wins. A flag key the flow set to a value
  other than its preset's keeps the flow's; a key at the preset's value takes
  the setting's, which is what the epic flows did.
- A roster in force ignores the flow's seats, and these settings with them.

The epic flows' own copies are removed. `local` and `sdd` keep their reads:
they name per-flow default models, which the rule above leaves to the flow.
