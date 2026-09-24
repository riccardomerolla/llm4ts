# Executor roster: runner, shell and `epic-stories`

Wires the roster library (`specs/pending/executor-roster.md`) into runs:
the runner loads a roster and serves every seat from it, the shell gains
`--roster`, `--executors` and `llm4ts roster`, and the story executor sizes
its launches by free coder slots and leases its judge and verifier per
story. Design record: ADR 0019.

## Decisions (agreed 2026-09-24)

| Decision   | Choice                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Files      | `${XDG_CONFIG_HOME:-~/.config}/llm4ts/roster.json`, overridden by id by `<repo>/.llm4ts/roster.json`. State in `${XDG_STATE_HOME:-~/.local/state}/llm4ts/roster-state.json`.   |
| Selection  | `LLM4TS_ROSTER=<path>` uses that file alone, `none` ignores rosters; `LLM4TS_EXECUTORS=a,b` narrows. The shell's `run --roster` / `--executors` set them.                      |
| Authority  | A roster in force replaces the flow's and the environment's seat choices (one warning line). No roster: today's behaviour, byte for byte.                                      |
| Secrets    | `env` values may only be `${VAR}` references (or literal non-secret values); a missing variable is a typed load error.                                                         |
| Stories    | Launches min(cap, free coder slots), at least one when nothing runs; the judge and the verifier lease per story; `RosterExhausted` stops launching like a dirty epic checkout. |
| Visibility | Board detail and `StoryOutcome.executor`; a per-executor section in `report.md`; roster `Info` events in the trace; `llm4ts roster` shows live state.                          |

## Changes

### Runner (`packages/runner`)

- `ExecutorRoster.ts`: `loadRosterDocument(source)` resolving the two
  files, `LLM4TS_ROSTER` and `LLM4TS_EXECUTORS`;
  `executorConfig(spec, readOnly, environment)` mapping a harness to a
  connector config (CLI presets via `coderFor`, API presets for `lm-studio`,
  `ollama`, `openai`, `anthropic`, `gemini-api`, `mlx-lm`), with `model`,
  `flags`, `baseUrl` and `env` (after `${VAR}` substitution) applied;
  `rosterLoadViolations` adding harness checks (unknown harness, an API
  harness with the coder role); `rosterStatePath(environment)`.
- `FlowRunnerOptions.roster?: RosterDocument | "none"`; the runner loads it
  when the caller passes none. With a roster, `makeFlowRunnerContext`:
  - builds the `Roster` (state store, `httpProbe` for health, run events);
  - caches seats per (executor, read-only, workDir) in the run scope;
  - root context: `coder` a lazy `heldCoder`, `reasoning` a `rosterSeat`
    for `planner`, `reviewers` one `rosterSeat` for `reviewer`, `roster`
    the view;
  - `contextFor(dir)`: an eager `heldCoder` in the caller's scope (a story
    waits here for capacity), reasoning and reviewers avoiding it, and a
    `roster` view whose `forRole` avoids it and borrows it when no one else
    can serve;
  - probes every executor's harness once at start (`isAvailable`); a failed
    probe excludes it for the run;
  - prints the executors instead of the coder/reasoning pair.
- `httpProbe` moves from the flow lib into the runner.

### Flow (`packages/flow`)

- `FlowContextShape.roster?: RosterView`.
- `Stories`:
  - the judge and `verifyBlocked` receive the story's `StorySeats`;
  - launch budget: min(`concurrency` - running, `roster.available("coder")`),
    and at least one when nothing is running (its lease waits);
  - `RosterExhausted` is a halt interruption;
  - `StoryOutcome.executor` (and the executor history on handover) from the
    story context's roster view; the board's detail names it; `report.md`
    gains a "By executor" section summing the story estimates.

### Shell (`packages/shell`)

- `llm4ts run … --roster <path|none> --executors a,b` (flags before `--`).
- `llm4ts roster`: the merged roster and each executor's state (free,
  excluded until …, waiting for health).
- `llm4ts roster pause <id> [--for 2h]` and `llm4ts roster resume <id>`,
  writing the state file.

### `epic-stories`

- The judge uses `seats.context.roster?.forRole("judge")`, the verifier
  `forRole("verifier")`, each falling back to the run's reasoning seat.
- Without `--concurrency`, the default is the roster's coder slots (3
  without a roster).
- The local-server concurrency warning applies only without a roster.

### Demo (`examples/internet-banking`)

- `roster.example.json`: pi on LM Studio, two opencode executors on the
  on-prem Lemonade server (Ornith-1.5-35B-A3B, DeepSeek-V4-Flash), codex,
  claude, with the agreed roles, slots and priorities.
- RUNBOOK: installing the roster, running with `--concurrency 3`,
  `llm4ts roster` during the run.

## Tasks

1. Runner roster loading, harness mapping, violations, tests.
2. Runner seats from the roster; root and `contextFor` contexts; start-up
   probes; run header; tests with fake connectors.
3. `FlowContextShape.roster`; Stories launch budget, per-story judge and
   verifier, `RosterExhausted` halt, executor reporting; tests.
4. Shell flags and `llm4ts roster` commands; tests.
5. `epic-stories` wiring; demo roster; RUNBOOK; README; CHANGELOG.
