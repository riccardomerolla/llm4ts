# Configuration

## Settings files

Every setting is an `LLM4TS_*` name. llm4ts takes a setting from the first
of these places that has it (ADR 0049):

1. A `run` flag, or `--set NAME=value` on `llm4ts run`.
2. The environment.
3. The project file, `<repo>/.llm4ts/config.env`. `<repo>` is the command's
   `--repo`, else the working directory. Parent directories are not searched.
4. The global file, `~/.config/llm4ts/config.env`
   (`$XDG_CONFIG_HOME/llm4ts/config.env` when that variable is set).
5. The setting's default.

A file holds one `NAME=value` per line. An `export` in front of the name is
allowed, so an `export` block copied from a shell profile is a valid file.
Blank lines and `#` comments are skipped. A value is unquoted or wholly
quoted. There are no escapes, no interpolation and no multi-line values. A
path value has `~/` expanded and is made absolute against the repository in
the project file and against the home directory in the global file.

```dotenv
# ~/work/portal/.llm4ts/config.env
LLM4TS_PACK=j2ee-nextjs-spa
LLM4TS_LEGACY_REPO=~/legacy/ib-core
```

The `config` verb reads and edits both files:

```sh
llm4ts config init                        # write the LLM4TS_* exports of this shell into the files
llm4ts config set LLM4TS_CODER=pi         # each name goes to the file it belongs in
llm4ts config set --repo ~/work/portal LLM4TS_PACK=j2ee-nextjs-spa
llm4ts config show                        # effective values and where each one comes from
llm4ts config show LLM4TS_JUDGE_ROUNDS    # one setting in full: every layer, its grammar, its meaning
llm4ts config unset LLM4TS_PACK
llm4ts config edit                        # guided: pick a setting, see it, change or remove it
llm4ts run convert-all --set LLM4TS_JUDGE_ROUNDS=1   # this run only
```

`config set` writes each name to the file the reference below lists under
"Belongs in". `--global` and `--project` force one file. `config init` never
overwrites a line. `--set` is repeatable and takes any setting except a
secret. `llm4ts run --coder <name>` is short for `--set LLM4TS_CODER=<name>`.

`config edit` is the same editing as questions on a terminal. It lists every
setting a file may hold, the ones that are set first, each with its
effective value or default and its source (`global`, `project`,
`environment`, `default`). Typing filters the list by name. Opening a
setting prints what `config show NAME` prints, and says so when an export
will keep winning over the saved value. From there you change the value or
remove it from a file that holds it. An on/off setting and a setting with a
fixed list of values are chosen from a list, `LLM4TS_CODER` and
`LLM4TS_REASONER` from the coding agents with the ones found on `PATH`
marked, and anything else is typed. A value the grammar does not read is
refused in place and asked again, and an empty answer leaves the setting as
it was. To store an empty value, use `config set NAME=`. A value goes to the
file the setting belongs in. For a global setting edited inside a
repository, the editor asks whether to save it for every repository or for
this one only. The editor then returns to the list, and "done" or Ctrl-C
ends it with one line naming what changed. `config edit NAME` opens one
setting and ends after it. Bare `llm4ts config` on a terminal opens the
editor, and so does "Configure settings" in the `llm4ts` menu. Per-run
settings and secrets are not listed. Off a terminal `config edit` exits
with code 2 and points at `config set`.

`config set` and `--set` refuse an unknown name and a value the setting's
grammar does not read. A malformed line in a file stops the launch and names
`path:line`. The environment only warns: an unknown `LLM4TS_*` export that is
close to a real name prints the name it probably meant. A flow that lacks a
setting it requires exits with code 2 before it starts, and names the
setting.

Three kinds of setting never come from a file. A file line that names one is
ignored with a warning.

- A secret (`LLM4TS_GEMINI_BRIDGE_TOKEN`, `LLM4TS_MCP_TOKEN`) is read from
  the environment only. `config set` and `--set` refuse it, and
  `config show` prints `(secret, set)` in place of its value.
- A per-run setting, such as `LLM4TS_WAVE`, goes on the command with `--set`.
- `LLM4TS_FLOW`, `LLM4TS_RUN_ID` and `LLM4TS_TRACE_PATH` are set by llm4ts.

### Trusting the project file

The project file can set commands llm4ts runs (`LLM4TS_GATES`,
`LLM4TS_WORKTREE_SETUP`, `LLM4TS_TEST_ONE`) and the flags a coding agent is
started with. A repository you cloned or unpacked could arrive with one. So
llm4ts uses a project file only when you have trusted exactly that content
for exactly that repository.

- `config set`, `config unset`, `config init` and `config edit` trust what
  they write. If you only ever change the file with these commands, there
  is no trust step.
- If you edit the file by hand, run `llm4ts config trust` once after each
  edit.
- If the file arrived with the repository, run `llm4ts config trust` and
  read the listing before you accept it.

```bash
llm4ts config trust            # list the file, ask once, record
llm4ts config trust --yes      # list the file and record without asking
llm4ts config untrust          # forget this repository's record
```

`config trust` prints the file's path and every setting in it with its
value. A value llm4ts runs as a command is tagged `[runs as a command]`, and
agent flags are tagged `[flags for a coding agent]`. A line the parser
rejects is printed with its line number. Off a terminal without `--yes` it
prints the listing, records nothing and exits with code 2.

While a project file is new or has changed since you trusted it, llm4ts
reads none of it:

- `llm4ts run`, `llm4ts refine`, a flow started from the menu and the MCP
  operator's `start` refuse with exit code 2 before anything is started. The
  message names the file and the command that reviews it.
- `config show`, `doctor` and the other verbs that start no flow go on
  without the file. `config show` lists it as `not trusted` or
  `changed since trusted`.
- `config set`, `config unset --project` and `config init` write nothing to
  it. `config edit` shows the listing and asks the same question first.

The records are in `${XDG_STATE_HOME:-~/.local/state}/llm4ts/config-trust.json`,
one per repository path. A repository you move is asked about again at its
new path. llm4ts git-ignores `.llm4ts/`, so the file stays local to a clone
unless someone commits it on purpose.

Only the `llm4ts` command reads the files. A flow script started with `node`
or `pnpm --filter @llm4ts/flows <flow>` reads only the environment.

## Settings reference

`scripts/settings-docs.mjs` writes this section from the registry in
`@llm4ts/flow/Settings`. Do not edit it by hand: `pnpm test` fails when it
differs from the registry. "Belongs in" is where `config set` writes the
setting. A value marked "run as a command" is a command line that llm4ts
executes.

<!-- settings:begin -->

### Seats and models

| Setting                    | Value                                                                                                          | Default                                                      | Belongs in   | Meaning                                                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LLM4TS_CODER`             | claude, claude-cli, gemini, gemini-cli, opencode, codex, pi, agy, antigravity, antigravity-cli, grok or cursor | claude; pi in the epic flows                                 | global file  | The coding agent that edits files: claude, codex, gemini, pi, agy, grok, cursor or opencode.                                                                       |
| `LLM4TS_REASONER`          | claude, claude-cli, gemini, gemini-cli, opencode, codex, pi, agy, antigravity, antigravity-cli, grok or cursor | claude                                                       | global file  | The agent that plans, reviews and judges in the epic, soap, roundtable and taskforce flows; any coder name.                                                        |
| `LLM4TS_CODER_MODEL`       | text                                                                                                           | the agent's own default; the local and sdd flows name theirs | global file  | The coder seat's model. pi takes provider/model, such as openai-codex/gpt-5.5.                                                                                     |
| `LLM4TS_REASONING_MODEL`   | text                                                                                                           | the agent's own default; the local and sdd flows name theirs | global file  | The reasoning seat's model.                                                                                                                                        |
| `LLM4TS_CODER_FLAGS`       | key=value pairs separated by ;                                                                                 | none                                                         | global file  | Extra CLI flags for the coder seat in the epic flows, on top of its preset's own.                                                                                  |
| `LLM4TS_REASONING_FLAGS`   | key=value pairs separated by ;                                                                                 | none                                                         | global file  | Extra CLI flags for the reasoning seat in the epic flows.                                                                                                          |
| `LLM4TS_CODER_HEALTH_URL`  | an http or https URL                                                                                           | the local server's model list at its default address         | global file  | The URL polled until a local serving engine answers again after it went down.                                                                                      |
| `LLM4TS_PROVIDER`          | openai, anthropic, gemini, gemini-api, lm-studio, lmstudio, ollama, mlx-lm, mlxlm, mlx or mock                 | mock                                                         | global file  | The API provider of provider-driven flows such as hello: mock, openai, anthropic, gemini, lm-studio, ollama or mlx-lm. Any provider but mock needs `LLM4TS_MODEL`. |
| `LLM4TS_MODEL`             | text                                                                                                           | none; required unless the provider is mock                   | global file  | The model `LLM4TS_PROVIDER` serves.                                                                                                                                |
| `LLM4TS_JUDGMENT_PROVIDER` | openai, anthropic, gemini, gemini-api, lm-studio, lmstudio, ollama, mlx-lm, mlxlm, mlx or mock                 | the reasoning seat answers typed judgments                   | global file  | The API provider of the judgment seat, named the way `LLM4TS_PROVIDER` is.                                                                                         |
| `LLM4TS_JUDGMENT_MODEL`    | text                                                                                                           | none; required with a judgment provider other than mock      | global file  | The model `LLM4TS_JUDGMENT_PROVIDER` serves.                                                                                                                       |
| `LLM4TS_JUDGMENT_BACKEND`  | llm or typesafe                                                                                                | llm                                                          | global file  | What answers typed judgments: an LLM seat, or the TypeSafe API (needs `TYPESAFE_API_KEY`).                                                                         |
| `LLM4TS_JUDGMENT_BATCHING` | independent or shared-prefix                                                                                   | independent                                                  | global file  | shared-prefix sends the questions of one judgment request behind one shared prompt prefix, for a local model that caches it.                                       |
| `LLM4TS_ISOLATED`          | on or off                                                                                                      | off                                                          | project file | Asks every CLI seat to leave the repository's own hooks, MCP servers, settings and instruction files unloaded.                                                     |
| `LLM4TS_ROSTER`            | text                                                                                                           | the user's and the repository's roster.json, merged          | project file | The executor roster in place of the roster.json files: a roster file, or none for one executor per seat. Flag: `--roster`.                                         |
| `LLM4TS_EXECUTORS`         | names separated by commas                                                                                      | every executor of the roster                                 | per run      | Narrows the roster to these executor ids. Flag: `--executors`.                                                                                                     |

### Repositories, packs and worktrees

| Setting                 | Value                                              | Default                                                                                                   | Belongs in   | Required by                                                        | Meaning                                                                                                                          |
| ----------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `LLM4TS_PACK`           | text                                               | cobol-springboot in the modernization flows; j2ee-nextjs-spa in the convert flows; none in the epic flows | project file |                                                                    | The pack: a kit pack name, kit/pack, or a directory holding pack.md. Flag: `--pack`.                                             |
| `LLM4TS_LEGACY_REPO`    | a path                                             | none                                                                                                      | project file | `modernize-seed`, `convert-page`, `convert-all`, `convert-feature` | The legacy repository holding docs/modernization/, for flows rooted at the target. epic-design needs it too, except with --list. |
| `LLM4TS_TARGET_REPO`    | a path                                             | none: a refine proposal claims nothing as provided by the target                                          | project file |                                                                    | The target repository, mounted read-only by modernize-refine; `llm4ts refine --target` sets it.                                  |
| `LLM4TS_WORKTREE_ROOT`  | a path                                             | `<repo>.worktrees` beside the repository                                                                  | project file |                                                                    | Where the epic flows and taskforce keep their worktrees, one folder per epic.                                                    |
| `LLM4TS_WORKTREE_SETUP` | a command line; empty runs none (run as a command) | the pack's setup:, else pnpm install --offline                                                            | project file |                                                                    | Prepares each story worktree before its coder starts; empty skips setup.                                                         |
| `LLM4TS_SETUP_AGENT`    | on or off                                          | off                                                                                                       | project file |                                                                    | Gives the coder one turn to repair a failed worktree setup, then runs the setup again.                                           |
| `LLM4TS_APP_DIR`        | text                                               | the repository root, or its one first-level folder with a package.json                                    | project file |                                                                    | The folder inside the repository where setup and gates run, relative to it (frontend).                                           |
| `LLM4TS_NODE_CHECK`     | on or off                                          | on                                                                                                        | project file |                                                                    | Checks the node on PATH against the repository's pin before gates run; off runs anyway.                                          |

### Gates

| Setting                  | Value                                           | Default                                                                                   | Belongs in   | Meaning                                                                                                   |
| ------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| `LLM4TS_GATES`           | command lines separated by ; (run as a command) | the pack's ## Gates, else pnpm typecheck, lint, test and build where the app defines them | project file | The gate commands of the epic flows, overriding the pack's.                                               |
| `LLM4TS_GATE_TIMEOUT`    | a positive number of seconds                    | 1200 seconds                                                                              | project file | How long a gate may run before it is killed and reported as a hang.                                       |
| `LLM4TS_GATE_TAIL_CHARS` | a positive integer                              | 4000                                                                                      | project file | How many characters of a red gate's output the fix prompt carries.                                        |
| `LLM4TS_TEST_REPORT`     | text                                            | none; epic-mvp needs this or `LLM4TS_TEST_ONE`                                            | project file | The JUnit XML report the test gate writes, relative to the app folder; epic-mvp reads its evidence there. |
| `LLM4TS_TEST_ONE`        | a command line (run as a command)               | none; epic-mvp needs this or `LLM4TS_TEST_REPORT`                                         | project file | A test command run once per outcome in epic-mvp, with {tag} or {tagRegex} replaced by the outcome's tag.  |

### Review, judging and stalls

| Setting                   | Value                        | Default                                                             | Belongs in   | Meaning                                                                                                                                  |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM4TS_JUDGE_ROUNDS`     | a positive integer           | 3 story-review rounds in the epic flows; 2 judge attempts elsewhere | project file | Judge attempts before a story, page or program fails; in the epic flows --review-rounds and --judge-rounds set it too.                   |
| `LLM4TS_REVIEW_VOTES`     | a positive integer           | 1; 2 in the port flows                                              | project file | Independent votes of the adversarial review lens per round.                                                                              |
| `LLM4TS_REVIEW_FIXER`     | separate                     | the implementer's own chat fixes review findings                    | project file | separate sends review findings to a fresh fixer chat.                                                                                    |
| `LLM4TS_MERGE_REVISIONS`  | a whole number, 0 or more    | 1                                                                   | project file | Times a story whose merge turns the epic gates red goes back to be fixed; 0 fails at once. --merge-revisions sets it too.                |
| `LLM4TS_TASK_CONCURRENCY` | a positive integer           | 1                                                                   | project file | Coders working on one story at once; --task-concurrency sets it too.                                                                     |
| `LLM4TS_DEFER_FINDINGS`   | on or off                    | off                                                                 | project file | Fixes only Critical review findings in place and defers the rest to one refine round after the last merge; --defer-findings sets it too. |
| `LLM4TS_DEFER_TESTS`      | on or off                    | off                                                                 | project file | Records the judge's tests score as debt instead of failing the story; --defer-tests sets it too.                                         |
| `LLM4TS_STALL_REPEATS`    | a positive integer           | 5                                                                   | project file | Ends a coder turn that repeats one tool call this many times in a row; at least 2.                                                       |
| `LLM4TS_STALL_MINUTES`    | a positive number of minutes | no silence limit                                                    | project file | Ends a coder turn that prints nothing for this long.                                                                                     |

### Context and estate bounds

| Setting                       | Value                     | Default                                          | Belongs in   | Meaning                                                                             |
| ----------------------------- | ------------------------- | ------------------------------------------------ | ------------ | ----------------------------------------------------------------------------------- |
| `LLM4TS_CONTEXT_BUDGET`       | a positive integer        | 400000                                           | project file | The character budget of the evidence one prompt may carry.                          |
| `LLM4TS_ORIENTATION_CHARS`    | a whole number, 0 or more | 8000                                             | project file | How much of the repository digest the planner and every coder see; 0 leaves it out. |
| `LLM4TS_STORY_CONTEXT_CHARS`  | a whole number, 0 or more | 40000                                            | project file | How much of the code a story starts from its coder sees up front; 0 leaves it out.  |
| `LLM4TS_RETRO_CHARS`          | a positive integer        | 60000                                            | project file | The character budget of the digest epic-retro reads.                                |
| `LLM4TS_MAX_READ_BYTES`       | a positive integer        | the workspace's cap; 8388608 for a legacy estate | project file | The per-file read cap, for estates whose sources exceed it.                         |
| `LLM4TS_MAX_DISCOVER_RESULTS` | a positive integer        | the workspace's cap; 20000 for a legacy estate   | project file | How many files a discovery may return before it fails.                              |
| `LLM4TS_EXCLUDE_DIRS`         | names separated by commas | the built-in pruned list (.git, node_modules, …) | project file | Directory names discovery prunes, replacing the built-in list.                      |

### Modernization flows

| Setting                      | Value               | Default                                                | Belongs in   | Required by | Meaning                                                                                                                           |
| ---------------------------- | ------------------- | ------------------------------------------------------ | ------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `LLM4TS_WAVE`                | text                | every wave, with estate-wide coverage                  | per run      |             | Scopes modernize-extract to one wave of the approved plan.                                                                        |
| `LLM4TS_EXTRACT_CONCURRENCY` | a positive integer  | 1                                                      | project file |             | Programs modernize-extract extracts and judges at once.                                                                           |
| `LLM4TS_ANALYST_TURNS`       | a positive integer  | 48                                                     | project file |             | The turn budget of one program's analyst in modernize-extract and modernize-refine.                                               |
| `LLM4TS_MAX_CLOSURE_FILES`   | a positive integer  | 40 in the modernization flows; 12 in the convert flows | project file |             | How many files of a program's include closure are named as evidence.                                                              |
| `LLM4TS_GRAPH_REFINE`        | on or off           | on                                                     | project file |             | The LLM pass that refines modernize-survey's code graph; off ships the regex graph.                                               |
| `LLM4TS_REGROUP`             | on or off           | off                                                    | per run      |             | Makes modernize-refine consolidate domains again even when domains.md is current; `llm4ts refine` sets it for its regroup action. |
| `LLM4TS_MARK_DEEPEN`         | on or off           | off                                                    | per run      |             | Makes modernize-pack-upgrade add a ## Deepen request to every incompatible program.                                               |
| `LLM4TS_APPROVER`            | text                | the OS user                                            | global file  |             | The name that signs refine decisions and the seed's provenance.                                                                   |
| `LLM4TS_BENCH_MODE`          | measure or report   | measure; report when the task is `report`              | per run      |             | Whether modernize-bench measures a run or prints the comparison report.                                                           |
| `LLM4TS_BENCH_PROJECT`       | a positive integer  | no projection                                          | per run      |             | A program count the bench report projects its measured cost onto.                                                                 |
| `LLM4TS_TARGET_KIND`         | frontend or backend | none                                                   | per run      | `pack-fork` | Which side of the target repository pack-fork reads conventions from.                                                             |
| `LLM4TS_FORK_AS`             | text                | none                                                   | per run      | `pack-fork` | The forked pack's name, lowercase kebab-case.                                                                                     |
| `LLM4TS_FEEDBACK`            | text                | none: a fresh fork                                     | per run      |             | What to fix in the fork `LLM4TS_FORK_AS` names, revising it instead of starting over.                                             |

### Port flows

| Setting                      | Value                     | Default         | Belongs in   | Meaning                                                                      |
| ---------------------------- | ------------------------- | --------------- | ------------ | ---------------------------------------------------------------------------- |
| `LLM4TS_PORT_PILOT`          | a whole number, 0 or more | 0: no pilot     | per run      | Ports this many files first, then stops for an approval of the pilot report. |
| `LLM4TS_PORT_CONCURRENCY`    | a positive integer        | 4               | project file | Files the port flows work on at once.                                        |
| `LLM4TS_PORT_BATCH`          | a positive integer        | 100             | project file | Files port-files takes from the queue per run.                               |
| `LLM4TS_PORT_SOURCE_CHARS`   | a positive integer        | 120000          | project file | How many characters of one source file a port prompt carries; at least 1000. |
| `LLM4TS_PORT_SHARDS`         | a whole number, 0 or more | 0: one checkout | project file | Worktrees port-files spreads its work over, under .llm4ts/port/shards.       |
| `LLM4TS_PORT_TEST_ROUNDS`    | a positive integer        | 4               | project file | Fix rounds port-tests gives a red test gate.                                 |
| `LLM4TS_PORT_COMPILE_ROUNDS` | a positive integer        | 6               | project file | Fix rounds port-compile gives a red build.                                   |
| `LLM4TS_PORT_GUIDE_SAMPLE`   | a positive integer        | 3               | project file | Files port-guide samples to draft the porting guide.                         |
| `LLM4TS_PORT_GUIDE_TRIAL`    | on or off                 | on              | project file | The trial port that proves port-guide's draft; off skips it.                 |

### Kit: soap-ace

| Setting               | Value  | Default                                                     | Belongs in   | Meaning                                                                                          |
| --------------------- | ------ | ----------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| `LLM4TS_SOAP_SERVICE` | text   | the only service discovered; several need the name          | project file | The SOAP service the soap flows work on, and the folder of its auth.json.                        |
| `LLM4TS_SOAP_ENV`     | text   | the default profile, auth.json                              | per run      | The environment whose `auth.<env>.json` the soap flows use; `-- --env` sets it too.              |
| `LLM4TS_SOAP_STUB`    | a path | calls go to the network                                     | project file | A folder of recorded `<operation>.xml` responses that answers SOAP calls instead of the network. |
| `LLM4TS_ACE_API`      | text   | derived from the service: DemoBankService gives DemoBankApi | project file | The name of the ACE API project soap-epic builds.                                                |

### Kit: j2ee-nextjs

| Setting              | Value                | Default                | Belongs in   | Meaning                                                                                     |
| -------------------- | -------------------- | ---------------------- | ------------ | ------------------------------------------------------------------------------------------- |
| `LLM4TS_ADO_ORG_URL` | an http or https URL | no Azure DevOps mirror | project file | The Azure DevOps organization convert-all mirrors its board to; needs `LLM4TS_ADO_PROJECT`. |
| `LLM4TS_ADO_PROJECT` | text                 | no Azure DevOps mirror | project file | The Azure DevOps project of the work-item mirror.                                           |
| `LLM4TS_ADO_REPO`    | text                 | the project's name     | project file | The Azure DevOps repository the mirrored work items link to.                                |
| `LLM4TS_FAIL_FAST`   | on or off            | off                    | per run      | Stops convert-all at the first page that fails instead of marking it and going on.          |

### Terminal, transcripts and the agent tree

| Setting             | Value                           | Default                   | Belongs in   | Meaning                                                                                                                 |
| ------------------- | ------------------------------- | ------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `LLM4TS_VERBOSITY`  | quiet, normal, verbose or debug | normal                    | global file  | How much the terminal shows. Flag: `--verbose`.                                                                         |
| `LLM4TS_UI`         | classic or tree                 | classic                   | global file  | tree draws the agent tree full-screen on a terminal; q returns to the classic view. Flag: `--ui`.                       |
| `LLM4TS_TIMESTAMPS` | on or off                       | off                       | global file  | Prefixes every terminal line with the time.                                                                             |
| `LLM4TS_TRANSCRIPT` | on or off                       | off; on in the epic flows | global file  | Records what each seat is told and answers under .llm4ts/transcripts/, for `llm4ts watch --tail`. Flag: `--transcript`. |
| `LLM4TS_IDLE_AFTER` | a span such as 90s, 5m or 1h    | 2m                        | global file  | How long a lane of the agent tree may be silent before it is marked idle.                                               |
| `LLM4TS_TOOL_BRIEF` | on or off                       | on                        | project file | The paragraph of a coder's brief that lists the pack's tool presets; off drops it.                                      |

### OpenTelemetry and usage estimates

| Setting                           | Value              | Default                                          | Belongs in  | Meaning                                                                                                                                                 |
| --------------------------------- | ------------------ | ------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM4TS_OTEL`                     | on or off          | off, unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set | global file | Exports spans over OTLP, to a local Phoenix unless the `OTEL_*` variables say otherwise; off silences export even with an endpoint set. Flag: `--otel`. |
| `LLM4TS_OTEL_CONTENT`             | off, on or full    | off                                              | global file | What exported spans carry besides usage: on adds prompts, replies and tool I/O; full the system prompt too. Flag: `--otel-content`.                     |
| `LLM4TS_ESTIMATE_USAGE`           | on or off          | on                                               | global file | Estimates token usage from character counts for seats whose backend reports none.                                                                       |
| `LLM4TS_ESTIMATE_MODEL`           | text               | claude-sonnet-4                                  | global file | The price-list model usage estimates are priced as.                                                                                                     |
| `LLM4TS_ESTIMATE_CHARS_PER_TOKEN` | a positive integer | 4                                                | global file | Characters per token in usage estimates.                                                                                                                |

### Gemini bridge

| Setting                      | Value              | Default                                      | Belongs in       | Meaning                                                                                                    |
| ---------------------------- | ------------------ | -------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `LLM4TS_GEMINI_BRIDGE`       | on or off          | off                                          | global file      | Starts the local Gemini bridge for pi seats during a run.                                                  |
| `LLM4TS_GEMINI_BRIDGE_MODE`  | acp or model       | acp                                          | global file      | The route the bridge serves: acp, a Gemini ACP session, or model, one locked-down gemini call per request. |
| `LLM4TS_GEMINI_BRIDGE_MODEL` | text               | the one bridge model pi's models.json offers | global file      | The provider/model pi is started with when its models.json offers several bridge models.                   |
| `LLM4TS_GEMINI_BRIDGE_PORT`  | a positive integer | 8731                                         | global file      | The port on 127.0.0.1 the bridge listens on.                                                               |
| `LLM4TS_GEMINI_BRIDGE_TOKEN` | text               | no token required                            | environment only | The bearer every bridge request must carry in model mode; also pi's apiKey.                                |
| `LLM4TS_GEMINI_MODEL`        | text               | the model pi's request names                 | global file      | The Gemini model the bridge reasons with.                                                                  |

### MCP operator

| Setting            | Value | Default                                | Belongs in       | Meaning                                                        |
| ------------------ | ----- | -------------------------------------- | ---------------- | -------------------------------------------------------------- |
| `LLM4TS_MCP_TOKEN` | text  | no HTTP transport without --token-file | environment only | The bearer token of `llm4ts mcp --http`; never reaches a flow. |

### Set by llm4ts

| Setting             | Value  | Default                                         | Belongs in    | Meaning                                                                  |
| ------------------- | ------ | ----------------------------------------------- | ------------- | ------------------------------------------------------------------------ |
| `LLM4TS_FLOW`       | text   | set by the launcher                             | set by llm4ts | The running flow's name, for its spans.                                  |
| `LLM4TS_RUN_ID`     | text   | the runner makes one                            | set by llm4ts | The run's id, set by the MCP operator so it can find the run it started. |
| `LLM4TS_TRACE_PATH` | a path | `.llm4ts/trace-<start>.jsonl` in the repository | set by llm4ts | Where the run writes its trace, set by the MCP operator.                 |

<!-- settings:end -->

## JavaScript facade

`createClient` validates a plain object:

| Field            | Meaning                                                                     |
| ---------------- | --------------------------------------------------------------------------- |
| `provider`       | `mock`, `openai`, `anthropic`, `gemini`, `lm-studio`, `ollama`, or `mlx-lm` |
| `model`          | Provider model identifier                                                   |
| `baseUrl`        | Optional endpoint override                                                  |
| `apiKey`         | Optional secret; converted immediately to `Redacted`                        |
| `timeoutSeconds` | Optional request timeout                                                    |
| `temperature`    | Optional sampling temperature                                               |
| `maxTokens`      | Optional completion limit                                                   |

API keys are sent in provider headers and are not placed in URLs, process
arguments, events, or persisted flow artifacts.

## Judgment seat

Typed judgments (ADR 0017) run on their own seat, which defaults to the
reasoning seat. `LLM4TS_JUDGMENT_PROVIDER` and `LLM4TS_JUDGMENT_MODEL` name
another seat, the way `LLM4TS_PROVIDER` and `LLM4TS_MODEL` do.
`LLM4TS_JUDGMENT_BACKEND=typesafe` selects the hosted Jev model. It requires
`TYPESAFE_API_KEY`, which is sent as a header only and never logged.
`LLM4TS_JUDGMENT_BATCHING=shared-prefix` makes one call per request, with
the state sent once and each answer read as its own label. The default,
`independent`, makes one call per question.

A small non-thinking model served by `mlx-lm` is the intended judgment seat:
one forward pass and one output token per question.

## CLI connectors

The Node runner exports presets for Claude, Codex, Gemini, Pi, Antigravity, Grok,
Cursor, and OpenCode. Their native CLIs own authentication. `LLM4TS_CODER`
selects `claude`, `codex`, `gemini`, `pi`, `agy`, `grok`, `cursor`, or
`opencode`. The llm4zio-era `LLM4ZIO_CODER` name is no longer read (2.0).

`LLM4TS_VERBOSITY` accepts `quiet`, `normal`, `verbose`, or `debug`.
`LLM4TS_UI=tree` (what `llm4ts run --ui tree` sets) draws the full-screen
agent tree instead of the classic view (ADR 0022). `LLM4TS_IDLE_AFTER`
(`90s`, `5m`, `1h`; default `2m`) is how long a story may go without an
event before the tree marks it: **quiet** while a model call is open,
**idle** when nothing is under way. A gate, setup command, git step, merge
or wait the story said it began shows as running however long it takes.
`LLM4TS_STORY_CONTEXT_CHARS` (default `40000`, `0` to turn it off) is how much
of the code a story starts from goes into its coder's system prompt in
`epic-stories`. `LLM4TS_ORIENTATION_CHARS` (default `8000`, `0` to turn it
off) is how much of the repository orientation digest (folders with counts,
scripts, where tests live) the planner and every coder see (ADR 0025).
`LLM4TS_TRANSCRIPT=on` (what `llm4ts run --transcript` sets) records each
seat's input and output under `.llm4ts/transcripts/`, for `llm4ts watch
--tail`; `epic-stories` records them by default (`off` to stop) — a `--plan-only` or
refine-planning run therefore leaves a small transcript of the planner's call
too — and `--land` compacts them to their shape (calls, tools, timings; no
content).

With a Google Cloud project and a **Vertex AI service-account key** as the
only model access, see `vertex-service-account.md`: which harnesses accept
the key (Claude Code, Gemini CLI, opencode, pi; not Codex), the variables
each reads, and a roster that combines them.

### Gemini ACP bridge (for `pi` without a model credential)

When `pi` is the coder and the only paid model access available is a
`gemini-cli` OAuth subscription (no `GEMINI_API_KEY`, no Vertex key), a
`pi`-coding flow run can start a local bridge that lets `pi` draw its
inference from that subscription instead. Set `LLM4TS_GEMINI_BRIDGE` (any
truthy value) to start it, scoped to that flow run; `LLM4TS_GEMINI_BRIDGE_PORT`
overrides the fixed port (default `8731`) the bridge binds. Concurrent flow
runs sharing one bridge are unsupported — a run that finds the port already
bound fails fast rather than sharing an unowned server.

The run starts the bridge only when a seat actually uses `pi` (the reasoning
seat defaults to the coder, so a `pi` coder is enough), and points every such
seat at the resolved bridge model. A seat that already names a model keeps it
— an explicit choice outranks the default. If the bridge is requested but no
model can be resolved, the run fails there with the reason rather than
letting pi fail later with `No API key found for selected model`.

The bridge does not configure `pi` for you: add a custom provider to
`~/.pi/agent/models.json` with `baseUrl` set to `http://127.0.0.1:<port>`
(`api: "anthropic-messages"`) once, outside any flow run — `llm4ts doctor`
reports whether that file already points at the configured port but never
writes it (that file belongs to `pi`, not llm4ts).

```json
{
  "providers": {
    "gemini-bridge": {
      "baseUrl": "http://127.0.0.1:8731",
      "api": "anthropic-messages",
      "apiKey": "bridge-unused",
      "models": [{ "id": "gemini-2.5-pro" }]
    }
  }
}
```

Two details pi enforces and llm4ts cannot relax:

- Each `models` entry is an **object** carrying a string `id`, never a bare
  `"gemini-2.5-pro"` string. A wrong entry fails validation with
  `providers.<name>.models.0: must be object`, and pi then loads _nothing_
  from the file — including providers that were fine.
- `apiKey` must be present, though its value is never used. pi keeps a
  provider's models out of `--model` and `--list-models` until auth is
  configured, so a keyless bridge entry loads and stays invisible. Any
  placeholder works; the real credential is gemini's own OAuth session,
  which the bridge holds and pi never sees. (`pi /login` for that provider
  does the same job.)

`pi --list-models` is the final word on what pi accepts — check there when a
`--model` value is rejected.

Pointing that file at the bridge is necessary but not sufficient: `pi`
selects a provider per invocation, so the run must also be told to use this
one with `--model <provider>/<model>` (`gemini-bridge/gemini-2.5-pro` for
the entry above). The two ways to get that wrong fail differently — no
`--model` at all uses pi's own default and fails with `No API key found for
selected model`, while a name absent from the provider's `models` list
fails with `Model not found`. Both mean the bridge is up and nothing is
routed to it.

`llm4ts doctor` resolves the file and prints every pair pi will accept,
marking the bridged ones:

```sh
llm4ts config set LLM4TS_GEMINI_BRIDGE=on   # once per machine
llm4ts doctor
```

From a source checkout, `pnpm build && pnpm llm4ts doctor` runs the working
tree's CLI instead of the installed release.

```text
prerequisites:
  ✔ pi-gemini-bridge: a provider in ~/.pi/agent/models.json points at 127.0.0.1:8731
      bridge models — pass one as LLM4TS_GEMINI_BRIDGE_MODEL (pi's --model):
        gemini-bridge/gemini-2.5-pro
```

#### Model mode: Gemini CLI as a plain model for `pi` (ADR 0037)

In the mode above Gemini CLI stays an agent: its own system prompt (about
16,600 tokens on every call, measured with `gemini-2.5-pro`) and its own
tools ride along with pi's. `LLM4TS_GEMINI_BRIDGE_MODE=model` serves pi an
OpenAI-shaped `/v1/chat/completions` route instead. Each request is one
`gemini` call, run in an empty scratch directory, with:

- pi's system prompt, a text tool-call protocol and pi's tool schemas in
  place of Gemini's prompt (`GEMINI_SYSTEM_MD`);
- an admin policy denying every tool (`--admin-policy`), so Gemini sees
  none of its own;
- sub-agents switched off in Gemini CLI's system settings.

pi runs its own tools, Gemini only answers. A reply whose tool call cannot
be used gets one retry with the reason; a second bad reply reaches pi as
text. Usage reports cached prompt tokens apart, as OpenAI's shape does.

pi's provider for this mode uses the OpenAI completions API:

```json
{
  "providers": {
    "gemini-bridge": {
      "baseUrl": "http://127.0.0.1:8731/v1",
      "api": "openai-completions",
      "apiKey": "bridge-unused",
      "models": [{ "id": "gemini-3.8-flash" }]
    }
  }
}
```

```sh
llm4ts config set LLM4TS_GEMINI_BRIDGE=on LLM4TS_GEMINI_BRIDGE_MODE=model
llm4ts doctor
```

#### Running the bridge on its own

The bridge also runs outside any flow run, as an OpenAI-compatible server
for `pi` itself (or any OpenAI chat-completions client), the way LM Studio
serves a local model:

```sh
llm4ts gemini-bridge
```

It listens on `127.0.0.1` (`--port`, else `LLM4TS_GEMINI_BRIDGE_PORT`, else
`8731`) until Ctrl-C, and prints the `models.json` entry pi needs and the
`pi --model` to use. `--mode model` (the default) is this section's route;
`--mode acp` serves ADR 0016's Anthropic Messages route instead.
`--model <id>` runs every request on that Gemini model, whatever the client
names. A flow run with `LLM4TS_GEMINI_BRIDGE` set starts its own bridge on
the same port, so stop this one first.

Both routes answer local tools only: a request with a browser `Origin`, a
content type other than JSON, or a Host other than `127.0.0.1`, `localhost`
or `[::1]` is refused. For model mode, `--token <value>` (or
`LLM4TS_GEMINI_BRIDGE_TOKEN`, which flow runs read too) makes every request
carry that token as a bearer; put the same value in pi's `apiKey`. It keeps
other programs on the machine from using the subscription through the
bridge.

Limits, from `examples/gemini-model-probe.mjs` on a real subscription:

- **Models.** `gemini-3.8-flash` kept to the tool-call protocol in 10 of 10
  calls; `gemini-2.5-pro` in 1 of 10. Use flash, and run the probe on a
  new model before switching to it.
- **System admin policies.** When Gemini CLI's system policy directory
  (`/etc/gemini-cli/policies` on Linux) holds a `.toml` file, Gemini CLI
  ignores `--admin-policy`; the bridge then refuses to start in this mode,
  since Gemini's tools would stay in view.
- **One process per turn.** Each pi turn starts Gemini CLI, about a second
  or two, and resends the whole conversation.
- **Terms.** Only Gemini CLI talks to Google, under its own login; llm4ts
  never reads or forwards its credentials. Gemini CLI's terms forbid
  directly accessing its services from third-party software, and using it
  as a model for another agent stays close to that clause. `llm4ts doctor`
  prints the clause in this mode; confirm with Google before relying on it.

The ADR 0016 smoke test (`examples/gemini-acp-bridge-smoke.ts`) reads the
same list rather than assuming a name: with exactly one bridged pair it uses
it, and otherwise asks for `LLM4TS_GEMINI_BRIDGE_MODEL`. That value only
routes pi — the bridge echoes it back and never forwards it, so gemini
reasons with `LLM4TS_GEMINI_MODEL` instead.

See ADR 0016 for the full design.

## API connectors

The runner exports `openAI`, `anthropic`, `geminiApi`, `lmStudio`, `ollama`, `mlxLm`, and
`mock` presets. Before registry resolution it fills a missing provider base URL
and reads a missing cloud credential from:

| Connector  | Environment credential                             |
| ---------- | -------------------------------------------------- |
| OpenAI     | `OPENAI_API_KEY`                                   |
| Anthropic  | `ANTHROPIC_API_KEY`                                |
| Gemini API | `GEMINI_API_KEY`, falling back to `GOOGLE_API_KEY` |

Explicit `baseUrl` and redacted `apiKey` values always win. LM Studio and Ollama
use their local default endpoints and require no credential. See the
[real examples](../examples/README.md) for runnable commands.

The Anthropic connector marks the system prompt and the last message as
prompt-cache breakpoints (`cache_control: ephemeral`, ADR 0029), so a chat
whose history only grows at the end reads every earlier turn from the
cache; it reports usage (input, output, cache reads as `cached`, cache
writes counted as input), so the seat is measured rather than estimated.
`promptCache: false` on the connector config turns the markers off. An
`effort` on an API connector config becomes `output_config.effort`
(Anthropic) or `reasoning_effort` (OpenAI); the other API providers ignore
it and say so on the run's events.

## Kits and packs

The modernization and conversion flows read a pack selected by `LLM4TS_PACK`
(or `llm4ts run --pack`; default `cobol-springboot`): a bare pack name
resolved across the kits discovered in the project (`./.llm4ts/kits/`),
global (`~/.config/llm4ts/kits/`, honouring `XDG_CONFIG_HOME`), and built-in
tiers; `kit/pack` to name one kit; or a directory holding `pack.md`, relative
to the launch directory or absolute, for a pack not yet in a kit. Two kits of
one tier shipping the same pack name is an error naming both. `llm4ts kits`
lists the kits with their packs and flows (ADR 0014).

Estate reading is bounded by `LLM4TS_MAX_READ_BYTES` (per file, 8 MiB in the
estate-reading phases), `LLM4TS_MAX_DISCOVER_RESULTS` (20 000 there, 1 000
elsewhere), and `LLM4TS_EXCLUDE_DIRS` (replaces the pruned directory list).

## Usage estimates

Every seat the runner resolves is metered, so a run always accounts for its
tokens even when the backend reports none (Antigravity, Copilot, and Cursor on
the [capability matrix](provider-capabilities.md)). The estimate counts
characters on both sides of a request and is published under the model label
`estimated:<model>`, which keeps it in its own column of `llm4ts costs` and out
of any measured total. Measured usage always wins: the estimate only fills a
gap the backend left.

`LLM4TS_ESTIMATE_MODEL` is the price-list model the estimate is priced as,
and `LLM4TS_ESTIMATE_CHARS_PER_TOKEN` is the characters counted per token.
`LLM4TS_ESTIMATE_USAGE=off` leaves the seats raw, so nothing accrues.

`FlowRunnerOptions.estimateUsage: false` does the same for one run in code and
takes precedence over the environment.

## OpenTelemetry

A run can export what its agents do, their tokens and reported costs as
OpenTelemetry spans and metrics over OTLP (ADR 0026,
[observability.md](observability.md)). The standard `OTEL_*` variables are
the source of truth: `OTEL_EXPORTER_OTLP_ENDPOINT` (or the per-signal
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) sends traces and metrics to any
collector, and llm4ts defaults `OTEL_TRACES_EXPORTER` and
`OTEL_METRICS_EXPORTER` to `otlp` when an endpoint is set. `LLM4TS_OTEL=on`
(what `llm4ts run --otel` sets) with no endpoint exports traces only to a
local Arize Phoenix at `http://localhost:6006`; `LLM4TS_OTEL=off` or
`OTEL_SDK_DISABLED=true` turns everything off. `LLM4TS_OTEL_CONTENT` (what
`llm4ts run --otel-content` sets) is `off` by default; `on` adds prompts, replies and tool I/O to the spans (redacted,
capped), `full` adds the system prompt. `LLM4TS_FLOW` is set by the shell to
the flow's name for the run span. Nothing is exported while the test suite
runs.

## Gates

The target's gate commands run after every task and after every merge
(ADR 0013). `epic-stories` (and `epic-stories-board`) takes them from the
pack selected with `llm4ts run --pack` or `LLM4TS_PACK`: every `## Gates`
line, in the order written, and an empty section runs none. `LLM4TS_GATES`
overrides that list. With neither set, the commands are `pnpm typecheck`,
`pnpm lint`, `pnpm test`, and `pnpm build`, each only when the application's
`package.json` defines that script. Each story worktree is prepared first by
the pack's `setup:` command (none when the pack declares none), or by
`pnpm install --offline` with no pack; `LLM4TS_WORKTREE_SETUP` overrides
both, and an empty value skips setup. Since ADR 0027 a gate
has a timeout, a class and a memory: the gates' result on the code a change
started from is recorded as a baseline under the run's state folder
(`gates/baselines.json`, keyed by commit, app dir and commands), and a change
is charged only with the failing lines it added. Lines already red on the
base are listed once as inherited; a test-gate line red once and green on one
rerun is flaky; neither blocks. Gate output is written to
`stories/<id>/gates/<n>-<command>.log` in the state folder, and the fix
prompt carries its tail and, for CLI coders, its path. Without gate commands
(a flow that passes `lint` but no `baseline`) every red line blocks, as
before.

`LLM4TS_GATE_TIMEOUT` is the number of seconds before a gate is killed and
reported as a hang. `LLM4TS_GATE_TAIL_CHARS` is how many characters of gate
output the fix prompt carries.

`--land` deletes the baselines and compacts the gate logs to their failing
lines.

The **oracle guard** runs beside the gates (ADR 0027 decision 4): a change
that deletes a test file, adds a skip or focus marker (`.skip(`, `.only(`,
`xit(`, `test.todo(`, `@Ignore`, `@Disabled`, `@pytest.mark.skip`,
`#[ignore]`) or lowers the passed-test count against the baseline fails its
gate round, with the file and line, and the fix round undoes it. A story whose
job includes changing tests says so with `testsChange: true` in its plan
entry; `sdd` and `modernize-implement` declare it for the task that writes
the red tests. A pack extends what counts as a test file or a marker in a
`## Oracle` section. The count check runs only when both sides report a
summary line the guard reads (Vitest, Jest, pytest, cargo, mocha, JUnit) and
says once when they do not.

## Review

Every lens (the built-in ones, a pack's `reviewers/*.md`, the repository's
own rules) is asked with the shared review-rules preamble first (ADR 0027
decision 9): no stubbed bodies, no skipped, deleted or weakened tests, no
layering workaround, and "a paragraph-long justification means the code is
wrong". The adversarial lens, whose only job is to find why the diff does not
work, is in the minimal set. A pack extends the rules in a `## Review rules`
section (`- preamble: off` leaves the shared preamble out of that pack's
lenses); a repository without a pack puts its rules in
`.llm4ts/review-rules.md` (a reviewer file: optional `files:` frontmatter,
then the rules), which every review round loads as one extra lens. A finding
a reviewer cannot place is moved down, never dropped: a Critical with no file
becomes a Warning, a finding naming a file the diff does not touch becomes an
Info, each as a `ReviewFindingDemoted` event.

`LLM4TS_REVIEW_VOTES` is the number of independent votes of the adversarial
lens per round, and any Critical blocks. `LLM4TS_REVIEW_FIXER=separate` sends
the findings to a fresh fixer chat that is briefed to apply them and nothing
else. By default the implementer's chat fixes them.

`epic-mvp` (ADR 0042) needs per-test evidence for each MVP outcome, from one
of two settings. `LLM4TS_TEST_REPORT` is the JUnit XML report the test gate
writes, relative to the app directory. An outcome is green when every test
tagged `[story#n]` passed. `LLM4TS_TEST_ONE` is a command run once per
outcome, with `{tag}` or `{tagRegex}` replaced by its tag
(`pnpm vitest run -t {tagRegex}`). An outcome is green when the command
exits 0.

`epic-draft` (ADR 0043) takes two flags of its own: `--with-tests` keeps the
test gate while drafting (it is off by default; typecheck, lint and build
always run), and `--harden` plans the epic's open `debt.md` lists as a refine
round under epic-stories' full bar.

The epic flows review each story once, not each task (ADR 0044): every lens
and the judge read the story's diff side by side, one fix turn takes their
findings, and later rounds re-check only what had findings. `--review-at
task` reviews every task instead. `--review-rounds <n>` (default 3; also
`--judge-rounds` or `LLM4TS_JUDGE_ROUNDS`) bounds the story review; in task
mode it counts judge attempts (default 2). `llm4ts profile` shows the
largest review diff per story.

`epic-stories --defer-findings` (or `LLM4TS_DEFER_FINDINGS=1`) makes review
lighter (ADR 0031). A task's review settles once only non-Critical findings
are left (a red gate still loops). The judge clears a story whose findings
are all Warnings: a partial `scope`, `house-style` or `tests`, while
`provides` short of full or any 0 stays Critical. What is left is written to
`stories/<id>.deferred.md`. Once every story of the epic is merged, those
lists are planned and run as one refine round.

`epic-stories --defer-tests` (or `LLM4TS_DEFER_TESTS=1`, ADR 0045) excuses
the judge's `tests` score at any value, 0 included: it is kept in the
verdict, never a finding. Nothing else changes: the coder is still asked
for tests, the `test` lens still reviews, and a red test gate still fails.
Each merged story whose tests were excused is written to `debt.md` with its
acceptance outcomes as tests owed; `epic-stories --harden` plans the open
debt as a refine round under the full bar and marks it paid once that round
settles. The judge's bar is part of its cached verdict's key, so a story
that failed on `tests 0` is judged afresh when rerun with `--defer-tests`.

Votes multiply only the adversarial lens; the concern lenses run once. With a
roster, consecutive votes take turns across executors (ADR 0019), so two
votes usually come from two models.

A loop that stops making progress ends typed, as `Stalled`, instead of
spending its rounds (ADR 0027 decision 11): a fix round that leaves the diff
byte-identical, a coder turn that repeats the same tool call with the same
arguments too many times in a row, or, when asked, a turn with no output
for too long. The story fails with the signal in its reason, dependents
hold, and the retro digest shows it.

`LLM4TS_STALL_REPEATS` is the number of identical tool calls in a row that
ends the turn. `LLM4TS_STALL_MINUTES` is the number of minutes without
output that ends the turn. It is off unless set, because a slow seat looks
like silence.

The retro can edit the loop, not only the stories (ADR 0027 decision 12).
Its digest ends with a Signatures section when a pattern repeats across
stories (gaming the oracle guard caught, the same reviewer finding in two
stories, fabricated status in two stories), and the seat may answer with
`rules`: an `append-rule` line or a `replace-section` for
`.llm4ts/review-rules.md`, a pack's `reviewers/<name>.md`, `pack.md`,
`lessons.md` or a `patterns/pitfalls-*.md` card. The report renders each as
a diff; the next `epic-stories` run applies approved ones from the JSON and
marks the report, like tasks and story edits.

## Autonomy contract and evidence

Every coder's system prompt opens with one paragraph from
`@llm4ts/flow/AutonomyContract` (ADR 0027 decision 5): nobody is watching;
act, do not announce; the task is the whole scope; the working directory is
the coder's whole world (it does not go looking for the tool running it —
its installation, source, processes or environment — and reads llm4ts's
files only where its instructions name them); make the smallest change;
pre-existing bugs and wrong tests are findings, not fixes; never edit, skip
or delete a test to pass; end with the commands run, not a claim. The
built-in flows use it through `withContract(...)`; a roster entry picks a
profile per executor with `"contract": "full" | "minimal" | "off"` (`minimal`
keeps the scope, workspace and no-gaming rules for a model that over-verifies under the
full text; `off` is for a flow that writes its own rules).

A task's `## Findings` section ends with one `verified: <command>` line per
command the coder ran to check its work and a `confidence: high|medium|low`
line. With transcripts on (the default for epic-stories), each `verified:`
claim is checked against the tool calls the transcript shows for that task
(ADR 0027 decision 6): a command that never ran is a `fabricated status`
Warning in the story's findings, travels to the judge as an evidence note,
is counted in `llm4ts profile`, and is a signature the retro reads. An API
coder keeps no tool transcript, so its claims are reported as unchecked.

## Roster: effort per role and isolation

A roster entry (ADR 0019) can shape what its seats spend and what they load
(ADR 0029):

```json
{
  "id": "claude",
  "harness": "claude",
  "roles": ["coder", "reviewer", "judge"],
  "effort": { "coder": "low", "default": "high" },
  "isolated": true
}
```

`effort` is `low`, `medium`, `high` or `max`, one for every role or per
role with a `default`; the runner configures each seat with the effort of
the role it serves, so one executor drafts at `low` and judges at `high`.
Each harness maps it to its own flag or ignores it with a
`CapabilityUnenforceable` event (`docs/provider-capabilities.md`); unset, the
harness keeps its default. The Bun port's shape is mechanical drafting on
the cheapest setting and the rulebook audit on the strongest. `isolated`
asks the harness to leave the repository's own hooks, MCP servers,
settings and instruction files unloaded; `LLM4TS_ISOLATED=1` asks it of
every CLI seat in a run. `llm4ts costs` ends with a by-role table (the
seat's label: coder, planner, reviewer, judge, judgment, chat) so a run
shows what the strongest model was spent on.

## Harness evals

`llm4ts profile --against <trace|report.json>` compares the profiled run
with an earlier one in the order `docs/harness-evals/README.md` asks for:
stories done and failed, explore calls before the first edit, coder turns,
reviewer and judge calls, gate runs and failures, fabricated verification
claims, low-confidence tasks, then wall, model, tool, gate and waiting
time, each with its change and whether that is better. `--json` with
`--against` emits the delta rows. A report saved with `llm4ts profile
--json > before.json` is the natural "before".

## Ports

The port flows (ADR 0028) port a code base file by file with a porting pack
(`LLM4TS_PACK`, e.g. the built-in `zig-rust`, `scala-ts` or
`cobol-springboot-port`): `target:` (the
target path template), `comment:` (the `PORT STATUS` trailer's comment
marker), `prompts/porting.md` (the rulebook), pitfall cards, `## Diagnostics`
(`json`, `cargo`, `tsc` or `javac`, the last reading javac's and Maven's
error lines with the Maven module as the unit), `## Ledger` (what
`port-ledger` classifies),
`## Differential` (the two test commands `port-tests` compares) and
`## Audit` (the dimensions `port-guide` audits). In order: `port-guide`
(`.llm4ts/port/guide-audit.md`, approved → appended to the rulebook on the
next run), `port-ledger` (`<specs-dir>/ledger.tsv`, committed), `port-files`
(`.llm4ts/port/ledger.jsonl`, `report.md`, `pilot.md`), `port-compile`
(`diagnostics-<round>.md`), `port-tests` (`.llm4ts/port/tests/`: a
`.baseline.json` and a `.diag.md` per test file, `report-<round>.md`).

The [port settings](#port-flows) bound each step. Three of them do more
than their one-line meaning says:

- `LLM4TS_PORT_PILOT` ports that many files, writes the pilot report and
  stops behind `- [ ] Approved`. Unset, the flow ports every file.
- `LLM4TS_PORT_BATCH` is the files per batch. A batch whose first file is
  over 2200 lines takes 6.
- `LLM4TS_PORT_SHARDS` spreads the implementers of `port-files` over that
  many worktrees (`.llm4ts/port/shards/<n>`, one branch each). The flow
  merges them into the checkout after every round and removes them at the
  end.

`LLM4TS_REVIEW_VOTES` defaults to `2` in the port flows.

## Capabilities

Filesystem, process, network, Git, and forge operations require explicit
capability grants at the flow boundary. Connector capabilities describe what a
backend supports; grants describe what a particular run may do. They are
separate checks.

## Modernization

The phases persist their own artifacts under `docs/modernization/` of the
repository they run in. The source-compatible approval marker is
`- [x] Approved`:

- approve `docs/modernization/wave-plan.md` before extraction;
- approve `docs/modernization/README.md` before seeding.

Phase bodies receive their LLM, repository, workspace, and forge dependencies
through `runNode`; no provider is selected inside the flow package.

`epic-design` reads an extract pack from a second repository:
`LLM4TS_LEGACY_REPO=<path>` is the legacy repository holding
`docs/modernization/` (required). The flow itself runs rooted at the target
repository (`--repo <target>`), writes `.llm4ts/epics/<epic-id>/brief.md`
there, and takes `LLM4TS_PACK` only to describe a target that is still empty.

### mlx-lm

`mlx-lm` serves MLX models on Apple Silicon over the OpenAI wire format and
returns token log-probabilities, which the `Judgment` service uses for
one-token label scoring. Start it against a text-only MLX model directory
(the ones LM Studio downloads work when they are text-only, for example
`Qwen3-4B-Instruct-2507-4bit`; Qwen 3.5+ community conversions are
multimodal and do not load):

```bash
python3 -m venv ~/.mlxenv && ~/.mlxenv/bin/pip install mlx-lm
```

```bash
~/.mlxenv/bin/python -m mlx_lm.server --model ~/.lmstudio/models/mlx-community/Qwen3-4B-Instruct-2507-4bit --port 8080
```

Then set `LLM4TS_PROVIDER` to `mlx-lm` and `LLM4TS_MODEL` to the same path.
The default base URL is `http://localhost:8080`. The model id must be the path the server
lists at `/v1/models`.
