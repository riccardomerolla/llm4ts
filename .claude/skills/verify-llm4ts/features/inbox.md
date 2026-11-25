# Control inbox

While an epic runs, a person steers it from a second process with `llm4ts inbox`: retry a story that failed in this run, or skip a story. The run answers each command within about two seconds and `llm4ts inbox` shows the outcome (ADR 0057). Here the epic is `epic-stories` over a stub agent with three stories: `add`, `slow`, and `mul`, which depends on `add`.

## Sub-features

- `inbox-retry` reruns a failed story; its dependents run after it and the epic ends green.
- `inbox-retry-refused` refuses to retry a story that is running.
- `inbox-skip` interrupts a running story, kills its coding agent and records the story as `skipped`.
- `inbox-skip-exit` ends a run that skipped a story with exit 1 and `1 skipped`.
- `inbox-list` lists pending commands and answered ones with their outcome.

## How to get to it (user POV)

- Run `llm4ts inbox retry <story>` or `llm4ts inbox skip <story> --reason "<why>"` in the repository of a running epic.
- Run `llm4ts inbox` there to list commands and outcomes.
- Add `--repo <path>` from elsewhere, and `--epic <id>` when the repository has more than one epic.

## Driving it with verify.sh

Preconditions:

- The baseline in [README.md](./README.md) holds. Use one fresh run per scenario (retry, skip).
- `$V stub $R epic` installed the stub agent.
- The stub's knobs live in `$S/epic/`, with `S=$($V path $R sandbox)`: `mkdir -p $S/epic; echo 30 >$S/epic/sleep` makes the coding turn of `slow` last 30 s, so the run is alive while you steer.
- `K=$PWD/.claude/skills/verify-llm4ts/stubs` and `E=$($V path $R evidence)`.
- The run goes to the background, since `$V cli` returns only when the CLI exits. Both scenarios start it the same way:

  ```bash
  $V cli $R inbox-run "LLM4TS_GATES=sh $K/epic-gate.sh $S/epic/fail" LLM4TS_WORKTREE_SETUP=true \
    -- run --roster none epic-stories -- --no-test-first "Add a calculator" >/dev/null 2>&1 & P=$!
  ```

- **Retry.** Before the start, `touch $S/epic/fail` so the gate is red for `add`. Wait until `$S/repo/.llm4ts/epics/*/board.md` lists `**add**` under `## Failed` (about 3 s), then `rm $S/epic/fail` and run `$V cli $R inbox-retry -- inbox retry add`. Exit `0`; stdout says `retry of story add written to epic add-a-calculator-…`.
- **Retry refused.** Right after, run `$V cli $R inbox-retry-refused -- inbox retry slow`. Exit `0` (the command was written). The refusal shows in the run's output and in the listing below.
- **Retry result.** `wait $P` returns `0`. `$E/inbox-run.stdout` has `· control: retry of story add by cli`, `✖ control: retry of story slow by cli refused: story slow is running`, `3 done, 0 failed, 0 waiting` and `✔ flow completed`. `$V snapshot $R inbox-retry-repo` shows `merge story add`, `merge story mul` and `merge story slow` on the epic branch.
- **Skip.** In a fresh run with no `fail` file, wait until `$S/epic/claude.log` has `code START in slow` and note the pid on that line. Run `$V cli $R inbox-skip -- inbox skip slow --reason "burning tokens"`. Exit `0`. Within 4 s `kill -0 <pid>` fails, and the log never gains `code DONE in slow`.
- **Skip result.** `wait $P` returns `1`. `$E/inbox-run.stdout` has `· control: skip of story slow by cli: burning tokens`; stderr has `is not finished: 2 done, 0 failed, 0 waiting, 1 skipped`. `$S/repo/.llm4ts/epics/*/report.md` has the rows `| add | done`, `| slow | skipped` with `burning tokens`, and `| mul | done`.
- **List.** After either run, `$V cli $R inbox-list -- inbox`. Stdout has `pending: none` and one `answered` line per command ending in `— applied` or `— refused: story slow is running`, each with its id and `by cli`.

## Gotchas

- Without `LLM4TS_GATES` the flow runs `pnpm typecheck` in a sandbox that has no `package.json`, and every story fails. Pass the stub gate in both scenarios; it is green unless `$S/epic/fail` exists.
- Without `LLM4TS_WORKTREE_SETUP=true` the story worktree setup fails before any coding turn.
- `--no-test-first` is required: the stub has no answer for the shared red phase.
- The two unrelated stories start together and `add` fails in about 3 s. A `sleep` below 10 lets the run end before the retry is written; the command then stays pending and the next run expires it.
- In zsh an unmatched `epics/*/board.md` glob is an error, not an empty result. Poll with `ls`, or run the recipe in bash.
- The pid on a `code START` line is the stub agent's own process. The flow's pid is `$P`'s child, not that one.
- The stub replaces the model only. That a real coding agent's child processes die with it is proven by the runner's process-group tests, not here.
- `story_retry`, `story_skip` and `control_list` over `llm4ts mcp`, and steering from `llm4ts chat`, are not driven by this recipe.
