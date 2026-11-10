---
name: verify-llm4ts
description: Drive the locally built llm4ts CLI the way a user does and capture proof. Use after changing packages/*/src, flows/ or kits/ when tests are not enough and you need to show the real `llm4ts` command behaving correctly (flow runs with a stubbed coding agent, `llm4ts tool`, list/view/kits, costs/profile).
---

# Verify llm4ts

The user-facing surface of this repo is the `llm4ts` CLI (`packages/shell/dist/cli-main.js`). This skill runs that built CLI in a throwaway sandbox and records each command with its stdout, stderr and exit code. It needs no network, credentials or installed provider CLI.

Everything goes through one helper. Run it from the repo root.

```bash
V=.claude/skills/verify-llm4ts/verify.sh
```

`$V help` lists the commands. Read [features/README.md](features/README.md) before driving, then use the matching feature file as the recipe.

## Launch

There is no server. Launch means build once, then create a sandbox per run.

```bash
$V build          # pnpm build: transpiles flows/ into packages/shell/flows, then tsc -b
R=$($V new)       # prints a run id
```

`$V new` creates a temp directory holding an empty `HOME`, a `bin/` for the stub agent, and a git repository `repo/` with one commit on `main`. It is ready when it prints the run id. `$V path $R repo` prints the sandbox repository path.

Built-in flows run from `packages/shell/flows/*.js`, not from `flows/*.ts`. An edit to a flow is invisible to the CLI until `$V build` runs.

## Doctor

```bash
$V doctor
```

Read-only. It exits 0 only when Node is 22 or newer, the built CLI exists, its `--version` matches `packages/shell/package.json`, no `packages/*/src` file is newer than its build, and no `flows/*.ts` is newer than its bundled `.js`. Run it first, and again whenever output does not match the source you are reading. On `FAIL`, run `$V build`.

## Drive

```bash
$V cli $R <label> [KEY=VALUE ...] -- <llm4ts args>
```

This runs `llm4ts <args>` with the sandbox repository as the working directory. The environment is wiped (`env -i`), so no provider credentials, global roster, global flows or global kits leak in. `LLM4TS_CODER=claude` is set. Extra variables go before `--`. The command returns the CLI's exit code. Each label can be used once per run.

Flows that call a model need a stub agent first.

```bash
$V stub $R implement        # a name under stubs/, or a path to your own .cjs
$V cli $R implement -- run --roster none implement "Add a multiply function"
```

The stub is a fake `claude` on the sandbox `PATH`. It speaks the CLI's stream-json protocol and answers from a responder, a CommonJS file exporting `(prompt, { fs, path }) => string`. The responder runs in the sandbox repository, so it can write files to stand in for a coding agent's edits. Branch on stable phrases in the prompt, as `stubs/implement.cjs` does. `flows/test/*.smoke.test.ts` holds responders for the other flows. Copy the function body into a `.cjs` file.

Record repository state after a mutation.

```bash
$V snapshot $R <label>      # git log, git status, file list
```

## Evidence

Evidence lives in `.llm4ts/verify/<run-id>/` at the repo root, which git ignores.

- `run.txt` holds the repo commit, dirty file count, CLI version and Node version.
- `<label>.cmd`, `<label>.stdout`, `<label>.stderr` and `<label>.exit` hold one driven command each.
- `<label>.repo.txt` holds a snapshot.
- `stub-<name>.cjs` is the responder that was installed.

Proof standards:

- Drive `llm4ts` through `$V cli`. Do not call a flow script, a package function or a test helper and call it CLI proof.
- Capture the action and the result. A flow run is proven by its exit code, its output, and a snapshot showing the commits and files it left.
- Check side effects where they land: the sandbox repository's branches and files, and `.llm4ts/` inside it (trace, `costs.jsonl`, plan file).
- The stub replaces the model only. Runner, workspace, gates and git are real. A claim about model behavior or a real provider CLI is not proven by this harness. Say so.
- Quote the evidence path with every claim.

## Cleanup

```bash
$V cleanup $R
```

This removes the sandbox directory that `$V new` created and nothing else. The evidence directory stays. Run it after a failed attempt too. A `cli` command is synchronous, so there is no process to kill.

## Isolation

Each run has its own sandbox, so runs can go side by side. Never point `$V cli` at this repository or at a user's repository. The helper has no flag for it on purpose.

## Not covered

`verify.sh` has no PTY. `term.sh` drives the CLI on a real terminal through tmux, and [features/config.md](features/config.md) uses it for `config edit` and the menu's "Configure settings". The menu's flow runs, `llm4ts refine`, `llm4ts watch` as a live TUI, and `run --ui tree` have no recipe yet and are not driven here. `llm4ts mcp`, `gemini-bridge`, `ask` and `doctor`'s connector probes depend on the machine's real CLIs and credentials. Report these as unverified when a change touches them.

## Helpers

- `verify.sh` is the harness. Commands: `build`, `doctor`, `new`, `path`, `stub`, `cli`, `snapshot`, `cleanup`, `help`.
- `term.sh` is the terminal driver for interactive commands. Commands: `start`, `keys`, `shot`, `stop`. It needs tmux.
- `stubs/implement.cjs` is the responder for the `implement` flow.
