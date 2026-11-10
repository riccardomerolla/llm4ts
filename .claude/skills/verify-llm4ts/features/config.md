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
- `config-tracked` ignores a project file that git tracks.
- `config-init` imports the environment's settings and changes nothing on a second run.

## How to get to it (user POV)

- Run `llm4ts config set NAME=value`, `llm4ts config unset NAME`, `llm4ts config show` or `llm4ts config init`.
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
- **Tracked project file.** In a new sandbox write `.llm4ts/config.env` in the repository, `git add -f` it and commit. Run `$V cli $R config-tracked-show -- config show`. The `project` row ends with `ignored (tracked by git)`, the `warnings` block names `git rm --cached .llm4ts/config.env`, and no setting from the file is listed. `config set LLM4TS_JUDGE_ROUNDS=1` then exits `2`.
- **Init.** Run `$V cli $R config-init LLM4TS_JUDGE_ROUNDS=2 LLM4TS_WAVE=w1 -- config init`. Stdout has a `wrote` block for the project file with `LLM4TS_JUDGE_ROUNDS=2`, one for the global file with `LLM4TS_CODER=claude`, and `skipped LLM4TS_WAVE is set per run`. The same command under a new label prints `nothing to do:` and no `wrote` line.

## Gotchas

- `$V cli` always exports `LLM4TS_CODER=claude`, so `config show` lists it from `environment` and `config init` imports it.
- The sandbox `HOME` is under `/var/…` and the repository resolves to `/private/var/…` on macOS. Assert on the file name and the state, not on the full path.
- A second `run implement` in one sandbox starts from the branch the first left. The typo and preflight checks spawn nothing, so they can share a sandbox with one completing run that comes last.
- `stub-calls.log` lives in the sandbox, not in the evidence directory. Record its line count beside the label's evidence before `$V cleanup`.
- `config init` asks questions only on a terminal. The harness has none, so the coder and reasoner prompts are not driven here. Report them as unverified.
- `doctor`'s connector probes depend on the machine. Only its `config:` section is stable.
