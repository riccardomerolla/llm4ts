# Run reports

After a run, a user reads what it cost and where its time went from the state the run left in the repository's `.llm4ts/`.

## Sub-features

- `reports-costs` totals tokens across past runs, bucketed per day, hour and model.
- `reports-profile` breaks the newest run's time down by category and label.

## How to get to it (user POV)

- Run `llm4ts costs` in the repository.
- Run `llm4ts profile` in the repository.

## Driving it with verify.sh

Preconditions:

- The baseline in [README.md](./README.md) holds.
- One `run-implement` from [run-flow.md](./run-flow.md) finished with exit code `0` in this sandbox.

- **Costs.** Run `$V cli $R reports-costs -- costs`. Exit code `0`. Stdout shows `runs: 1 · requests: 10` and `measured: 1,000 in, 400 out, 1,400 total`.
- **Costs match the run.** Compare with the `run-implement` stdout. Its `By model:` line reads `1000 in, 400 out`, the same totals.
- **Profile.** Run `$V cli $R reports-profile -- profile`. Exit code `0`. Stdout starts with `llm4ts profile` and its last table counts `reasoning 9`, `coder 2` and `git commitAll 2`.

## Gotchas

- Both commands read the sandbox repository's `.llm4ts/`. In a sandbox with no finished run they have nothing to report.
- A second run in the same sandbox changes every total. Assert the single-run figures only after exactly one run.
- `implement` has no stories, so `profile` shows `0 stories` and an empty story table. The story columns need an epic flow, which is not mapped yet.
- Stub turns take milliseconds, so every duration rounds to `0s`. This harness cannot prove a timing figure.
- `llm4ts watch` reads the same trace but draws a full-screen view. It is not driven here.
