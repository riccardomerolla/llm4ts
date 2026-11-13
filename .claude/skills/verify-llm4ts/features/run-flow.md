# Run a flow

A user hands a task to a flow. The `implement` flow plans the task, creates a branch, implements and reviews one task at a time, commits each, and ends with a cost summary.

## Sub-features

- `run-implement` plans, implements, reviews and commits every task, then exits 0.
- `run-cost-summary` prints token totals by agent and by model before the completion line.
- `run-state` leaves a trace, a cost ledger and a plan file under the repository's `.llm4ts/`.
- `run-failure` exits non-zero and names the cause when the coding agent fails.

## How to get to it (user POV)

- Run `llm4ts run implement "<task>"` in the repository.
- Run `llm4ts run --repo <path> implement "<task>"` from elsewhere.
- Choose the flow from the bare `llm4ts` menu.

## Driving it with verify.sh

Preconditions:

- The baseline in [README.md](./README.md) holds.
- `$V stub $R implement` installed the stub agent.

- **Run.** Run `$V cli $R run-implement -- run --roster none implement "Add a multiply function"`. Exit code `0`. Stdout shows `✔ branch`, `✔ Add multiply`, `✔ Test multiply` and ends with `✔ flow completed`.
- **Reviews.** Read the same stdout. Each task shows `review round 1` with four lenses and `review settled after round 1: clean`.
- **Cost summary.** Read the same stdout. `By model:` lists `stub-claude-1: 1000 in, 400 out`, followed by a `Total:` line.
- **Commits.** Run `$V snapshot $R run-implement`. The log shows branch `calculator` two commits ahead of `main`, named `calculator: Add multiply` and `calculator: Test multiply`. `git status` is empty.
- **Files.** Read the same snapshot. It lists `./calculator.txt`, `./.llm4ts/costs.jsonl`, one `./.llm4ts/plan-*.md` and one `./.llm4ts/trace-*.jsonl`.
- **Failure.** In a fresh run, install a responder that throws, then run the same command. The exit code is non-zero and stderr carries `claude failed:` with the responder's error.

## Gotchas

- Without `--roster none` the run reads a roster from `HOME`. The sandbox `HOME` is empty, but keep the flag so the command is the same one a user would need on a machine with a global roster.
- A healthy run prints three `✖ capability unenforceable: 'claude-cli' is asked to keep out of .llm4ts/**` lines at the start. They are warnings about the harness, not failures.
- `✖ some run events were still unconsumed: …` names each consumer that missed events and by how many. A healthy run does not print it. Treat it as a defect.
- The menu entry point needs a terminal and is not driven by this harness. Report it as unverified.
- The stub answers every reviewer with a clean report. A change to review handling needs a responder that returns issues.
- A second `run implement` in the same sandbox starts from the `calculator` branch the first run left. Use a new run for an independent proof.
