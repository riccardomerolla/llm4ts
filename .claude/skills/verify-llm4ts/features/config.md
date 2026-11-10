# Config files

A user writes `LLM4TS_*` settings once, in a global file under `HOME` or a project file in the repository, and every later `llm4ts` command reads them. The environment still wins over a file, a `run` flag or `--set` wins over both, and a flow that lacks a setting it requires stops before the coding agent is called.

## Sub-features

- `config-set` writes a setting to the file it belongs in and reports `new`, `changed` or `unchanged`.
- `config-show` prints each set setting with its value and its `global:LINE`, `project:LINE` or `environment` source.
- `config-file-run` runs a flow with a file value and no environment prefix.
- `config-env-wins` lets an exported value win over a file and prints a one-line note.
- `config-set-typo` refuses an unknown `--set` name with the closest setting, exit 2, agent never called.
- `config-env-typo` warns about a misspelled export and still runs.
- `config-preflight` refuses a flow that lacks a required setting, exit 2, agent never called.
- `config-trust-write` trusts what `config set` writes: no trust step for a user who only uses the verbs.
- `config-trust-changed` reads none of a project file edited by hand, and refuses a launch, exit 2, agent never called.
- `config-trust-accept` lists the file with `config trust --yes`, tags what runs as a command, and records.
- `config-trust-arrived` treats a project file that came with a repository, plain or behind a committed link, as not trusted.
- `config-trust-refuse-write` writes nothing into an untrusted project file.
- `config-untrust` forgets the record.
- `config-trust-terminal` asks once on a terminal: `n` records nothing, `y` records.
- `config-init` imports the environment's settings and changes nothing on a second run.
- `config-edit` is the guided editor on a terminal: filter the list, open a setting, change or remove it, leave with a summary.
- `config-edit-refusals` exits 2 off a terminal and for a name no file may hold.

## How to get to it (user POV)

- Run `llm4ts config set NAME=value`, `llm4ts config unset NAME`, `llm4ts config show` or `llm4ts config init`.
- After editing `<repo>/.llm4ts/config.env` by hand, or receiving one with a repository, run `llm4ts config trust`. `llm4ts config untrust` forgets it.
- On a terminal run `llm4ts config edit`, `llm4ts config edit NAME`, bare `llm4ts config`, or bare `llm4ts` and choose "Configure settings".
- Add `--repo <dir>` to any of them from outside the repository.
- Run `llm4ts run <flow> --set NAME=value` or `llm4ts run <flow> --coder <name>`.
- Run `llm4ts doctor` and read its `config:` section.

## Driving it with verify.sh

Preconditions:

- The baseline in [README.md](./README.md) holds.
- A counting responder is installed with `$V stub $R <file.cjs>`. It appends a line to `../stub-calls.log` and then calls `stubs/implement.cjs`. The file `$($V path $R sandbox)/stub-calls.log` is absent until the agent is called.
- Use a new sandbox for each flow run that must complete.

- **Set.** Run `$V cli $R config-set-global -- config set LLM4TS_VERBOSITY=verbose`. Exit code `0`. Stdout names the global file under the sandbox `home` and the row `LLM4TS_VERBOSITY=verbose   new`.
- **File value reaches the flow.** Run `$V cli $R config-file-run -- run --roster none implement "Add a multiply function"`. Exit code `0`. Stdout has ten `· tokens:` lines, the same count `run --verbose` gives.
- **Show.** Run `$V cli $R config-show -- config show`. Stdout has the row `LLM4TS_VERBOSITY   verbose   global:1` and `LLM4TS_CODER   claude   environment`, a `credentials` block of five keys marked `unset`, and a last line that counts the settings at their defaults.
- **Environment wins.** In a new sandbox repeat **Set**, then run `$V cli $R config-env-wins LLM4TS_VERBOSITY=quiet -- run --roster none implement "Add a multiply function"`. Exit code `0`. Stdout has no `· tokens:` line. Stderr starts with `note: LLM4TS_VERBOSITY from the environment overrides` and the global file's path with `:1`.
- **Typo in --set.** Run `$V cli $R config-set-typo -- run --roster none --set LLM4TS_VERBOSTY=verbose implement "Add a multiply function"`. Exit code `2`. Stderr is `llm4ts: --set: unknown setting LLM4TS_VERBOSTY; did you mean LLM4TS_VERBOSITY?`. `stub-calls.log` is absent.
- **Preflight.** Run `$V cli $R config-preflight -- run --roster none pack-fork`. Exit code `2`. Stderr has `pack-fork needs LLM4TS_TARGET_KIND:` and `pack-fork needs LLM4TS_FORK_AS:`, each followed by a `llm4ts config set --repo` line and a `llm4ts run pack-fork --set` line. `stub-calls.log` is absent.
- **Typo in the environment.** Run `$V cli $R config-env-typo LLM4TS_VERBOSTY=verbose -- run --roster none implement "Add a multiply function"`. Exit code `0`. Stderr starts with `warning: the environment: unknown setting LLM4TS_VERBOSTY; did you mean LLM4TS_VERBOSITY?`. Stdout ends with `✔ flow completed`.
- **Init.** Run `$V cli $R config-init LLM4TS_JUDGE_ROUNDS=2 LLM4TS_WAVE=w1 -- config init`. Stdout has a `wrote` block for the project file with `LLM4TS_JUDGE_ROUNDS=2`, one for the global file with `LLM4TS_CODER=claude`, and `skipped LLM4TS_WAVE is set per run`. The same command under a new label prints `nothing to do:` and no `wrote` line.

The trust proofs run in order in a new sandbox with the counting responder installed. `P="$($V path $R repo)/.llm4ts/config.env"` is the project file and `S="$($V path $R sandbox)/home/.local/state/llm4ts/config-trust.json"` is the trust list.

- **Trust: writing is trusting.** Run `$V cli $R trust-a-set -- config set LLM4TS_JUDGE_ROUNDS=1`, then `$V cli $R trust-a-show -- config show`. The `project` row ends with `1 setting`, the row `LLM4TS_JUDGE_ROUNDS   1   project:1` is listed, and `$S` holds one record.
- **Trust: an edit by hand.** Run `printf 'LLM4TS_GATES=echo pwned\n' >> "$P"`, then `$V cli $R trust-b-show -- config show`. The `project` row ends with `changed since trusted`, the `warnings` block has `has changed since it was trusted, so llm4ts did not read it. Review and accept it: llm4ts config trust --repo`, and neither `LLM4TS_JUDGE_ROUNDS` nor `LLM4TS_GATES` is listed. Run `$V cli $R trust-b-run -- run --roster none implement "Add a multiply function"`. Exit code `2`. Stderr has the same sentence and `Nothing was started.` `stub-calls.log` is absent.
- **Trust: refused write.** Run `$V cli $R trust-e-set -- config set LLM4TS_PACK=x`. Exit code `2`. Stderr has `so llm4ts writes nothing to it. Review and accept it first: llm4ts config trust --repo`. `$P` is unchanged.
- **Trust: off a terminal.** Run `$V cli $R trust-c-plain -- config trust`. Exit code `2`. Stdout is the listing, stderr starts with `llm4ts: not recorded:`, and `$S` still holds the old hash.
- **Trust: accept.** Run `$V cli $R trust-c-yes -- config trust --yes`. Exit code `0`. Stdout has `project file` with the path, `LLM4TS_JUDGE_ROUNDS   1`, `LLM4TS_GATES   echo pwned   [runs as a command]`, `2 settings; llm4ts runs 1 value as a command` and a last line that starts with `trusted:`. `config show` then lists both settings from `project:1` and `project:2`. The same command again prints `is already trusted`.
- **Trust: untrust.** Run `$V cli $R trust-f-untrust -- config untrust`. Stdout starts with `no longer trusted:`. `config show` then has the `project` row end with `not trusted`.
- **Trust: a file that arrived with the repository.** In a new sandbox write `.llm4ts/config.env` with `LLM4TS_GATES=echo pwned`, `git add -f` it and commit. `config show` has the `project` row end with `not trusted` and no `LLM4TS_GATES` row. `run --roster none implement "…"` exits `2` and `stub-calls.log` is absent. In another new sandbox put the file in a tracked folder `shared/`, commit `.llm4ts` as a symbolic link to `shared`, and repeat: same result. Git is not asked in either case.

`config trust` asks on a terminal, so these two are driven through `term.sh` like the editor below, in a new sandbox whose project file was written by hand.

- **Trust: no, then yes.** Run `$T start $R`, `$T keys "llm4ts config trust" Enter`, `$T shot $R trust-g-ask`. The screen has the listing and the question `Trust this file? llm4ts will read it, and run what it says to run`. Run `$T keys n Enter` and `$T shot $R trust-g-no`. The screen ends with `not trusted: nothing was recorded`, and `$S` is absent. Run the command again, `$T keys y Enter`, `$T shot $R trust-g-yes`. The screen ends with a line that starts with `trusted:`, and `$S` holds one record.
- **Trust: the editor's save is trusted.** Run `$T keys "llm4ts config edit LLM4TS_JUDGE_ROUNDS" Enter`, `$T keys Enter`, `$T keys 2 Enter`, `$T shot $R trust-g-edit`. The screen has `LLM4TS_JUDGE_ROUNDS=2` with `new` or `changed`. `$V cli $R trust-g-show -- config show` lists `LLM4TS_JUDGE_ROUNDS   2` from the project file with no trust warning. With an untrusted project file, `llm4ts config edit` prints the listing and asks the same question before the list opens.

The guided editor needs a terminal, so it is driven through tmux with `T=.claude/skills/verify-llm4ts/term.sh`. `$T start $R` opens a detached session in the sandbox repository with a clean environment, the sandbox `HOME`, and `llm4ts` on `PATH` as the built CLI. `$T keys …` sends tmux keys, and `$T shot $R <label>` saves and prints the screen as `<label>.screen.txt` in the evidence directory. Use a new sandbox with no config file, and run the steps in order.

- **Edit: filter and open.** Run `$T start $R`, `$T keys "llm4ts config edit" Enter`, `$T keys JUDGE`, `$T shot $R edit-a-filter`. The only row is `LLM4TS_JUDGE_ROUNDS   (default: 3 story-review roun…   default - Review, judging and stalls`. Run `$T keys Enter` and `$T shot $R edit-a-open`. The screen has `LLM4TS_JUDGE_ROUNDS is at its default`, the five layer rows, `value: a positive integer`, and the choices `change the value` and `back`.
- **Edit: a refused value.** Run `$T keys Enter`, `$T keys one Enter`, `$T shot $R edit-b-refused`. The prompt is still open and the line under it is `LLM4TS_JUDGE_ROUNDS must be a positive integer`.
- **Edit: save.** Run `$T keys C-u`, `$T keys 2 Enter`, `$T shot $R edit-cd-saved`. The screen has `project` with the project file's path, `LLM4TS_JUDGE_ROUNDS=2   new`, and the list again with `LLM4TS_JUDGE_ROUNDS   2   project` as the first setting. `cat "$($V path $R repo)/.llm4ts/config.env"` prints `LLM4TS_JUDGE_ROUNDS=2`, and `.gitignore` is beside it.
- **Edit: a toggle.** Run `$T keys GEMINI_BRIDGE`, `$T keys Enter`, `$T keys Enter`, `$T shot $R edit-e-toggle`. The choices are `on`, `off` and `back`. Run `$T keys Enter` and `$T shot $R edit-e-target`. The question is `Save it for` with `every repository (global)` first. Run `$T keys Enter`. `cat "$($V path $R sandbox)/home/.config/llm4ts/config.env"` prints `LLM4TS_GEMINI_BRIDGE=on`.
- **Edit: remove.** Run `$T keys JUDGE_ROUNDS`, `$T keys Enter`, `$T shot $R edit-f-actions`. The choices now include `remove it from the project file`. Run `$T keys Down`, `$T keys Enter`, `$T shot $R edit-f-removed`. The screen has `LLM4TS_JUDGE_ROUNDS   removed (was 2)`, and the project file is empty.
- **Edit: done.** Run `$T keys Enter`, `$T keys 'echo EXIT=$?' Enter`, `$T shot $R edit-g-done`. The screen ends with `changed: removed LLM4TS_JUDGE_ROUNDS (project), set LLM4TS_GEMINI_BRIDGE (global)` and `EXIT=0`.
- **Edit: bare config and Ctrl-C.** Run `$T keys clear Enter`, `$T keys "llm4ts config" Enter`, `$T shot $R edit-h-bare`. The same list opens, with `LLM4TS_GEMINI_BRIDGE   on   global` first. Run `$T keys C-c`, `$T keys 'echo EXIT=$?' Enter`, `$T shot $R edit-h-ctrl-c`. The screen ends with `nothing changed` and `EXIT=0`.
- **Edit: an exported setting.** Run `$T keys "LLM4TS_VERBOSITY=quiet llm4ts config edit LLM4TS_VERBOSITY" Enter` and `$T shot $R edit-name-env`. No list is shown. The screen has `LLM4TS_VERBOSITY = quiet    from the environment` and the line `LLM4TS_VERBOSITY is exported in this shell: the export keeps winning over whatever is saved here.` Run `$T keys Down` and `$T keys Enter` to go back. The command ends with `nothing changed`.
- **Edit: from the menu.** Run `$T keys llm4ts Enter`, `$T keys Down`, `$T keys Down`, `$T keys Enter`, `$T shot $R menu-configure`. The third menu entry, `Configure settings`, opened the list. Run `$T keys Enter` and `$T shot $R menu-after-done`. The menu is back under `nothing changed`. Run `$T keys C-c` and `$T stop`.
- **Edit refusals.** Run `$V cli $R config-edit-notty -- config edit`. Exit code `2`. Stderr is `llm4ts: config edit asks its questions on a terminal; here use llm4ts config set NAME=value`. `config edit LLM4TS_VERBOSTY` exits `2` with `did you mean LLM4TS_VERBOSITY?`, `config edit LLM4TS_WAVE` exits `2` with `is set per run`, and `config edit LLM4TS_MCP_TOKEN` exits `2` with `is a secret`. Bare `config` exits `2` and lists the sub-commands.

## Gotchas

- `$V cli` always exports `LLM4TS_CODER=claude`, so `config show` lists it from `environment` and `config init` imports it.
- The sandbox `HOME` is under `/var/…` and the repository resolves to `/private/var/…` on macOS. Assert on the file name and the state, not on the full path.
- A second `run implement` in one sandbox starts from the branch the first left. The typo and preflight checks spawn nothing, so they can share a sandbox with one completing run that comes last.
- `stub-calls.log` lives in the sandbox, not in the evidence directory. Record its line count beside the label's evidence before `$V cleanup`.
- `config init` asks questions only on a terminal. `$V cli` has none, so the coder and reasoner prompts are not driven here. Report them as unverified.
- `$T keys` waits 0.8 seconds after sending. Take a shot before the next key when a step saves a file, and repeat the shot when the screen is not yet redrawn.
- Typing in the list filters on the row text, so `project` also filters to the rows whose source is the project file. Type a part of the name.
- The row under the cursor carries its group after `-`. The other rows do not.
- `$T start` kills any earlier session of this helper. Run `$T stop` before `$V cleanup $R`.
- The trust list is keyed by the repository path the command was given. `$V cli` runs in the sandbox repository, whose path resolves to `/private/var/…` on macOS; `--repo` with the `/var/…` spelling is another key and is asked about again.
- `doctor`'s connector probes depend on the machine. Only its `config:` section is stable.
