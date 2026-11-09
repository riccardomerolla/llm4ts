# llm4ts verification map

This directory is the maintained source for verifying the user-facing behavior of the `llm4ts` CLI. Read this index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- `V=.claude/skills/verify-llm4ts/verify.sh`, run from the repo root.
- `$V doctor` exits 0. If it does not, run `$V build` and check again.
- `R=$($V new)` created a fresh sandbox for this run.
- Never drive a sandbox another run created.

## Driving conventions

- Every command goes through `$V cli $R <label> -- <args>`. Treat the args as literal.
- Give each command a label that names the feature ID it proves.
- Flows that call a model need `$V stub $R <name>` first and `--roster none` on `run`.
- Assert on exit codes, JSON fields and fixed phrases. Durations, run ids and temp paths change on every run.
- Take `$V snapshot $R <label>` after any command that changes the sandbox repository.

## Proof and skip reporting

- CLI proof is the `.cmd`, `.stdout`, `.stderr` and `.exit` files of the label.
- Mutation proof adds a snapshot, or a second read-only command that shows the stored result.
- Record the feature ID with every artifact you cite.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify.sh` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands and observable proof.

## Features

- [Discover flows and kits](./discover.md) covers `list`, `view` and `kits`.
- [Run a flow](./run-flow.md) covers `run implement` end to end against a stubbed coding agent.
- [Tool catalog](./tool-catalog.md) covers `tool list`, `tool describe` and `tool run`, with passing and failing reports.
- [Run reports](./run-reports.md) covers `costs` and `profile` over a finished run.

Not mapped yet: the modernize, epic, port, soap, roundtable and taskforce flows, `graph`, `roster`, and the interactive surfaces named under "Not covered" in the skill.
