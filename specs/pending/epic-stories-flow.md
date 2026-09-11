# Flow: epic-stories (parallel sub-agents over a declared story DAG)

New flow script `flows/epic-stories.ts`: a higher model splits an epic
into stories with dependencies and file ownership, the operator approves
the persisted story plan, and parallel `pi` agents implement the stories in
per-story worktrees, merged into an epic branch in dependency order behind
the target's gates. Library seams: `specs/pending/epic-stories-flow-seams.md`.
Target repo: `specs/pending/internet-banking-portal-fixture.md`. Design
record: ADR 0013.

Driver: show that a flow can run several coding agents at once without
them stepping on each other, that each stays inside its story, that a story
waits for what it depends on, and that a cheap local coder (`pi`) can do
the typing while a stronger model does the splitting and the reviewing.

## Decisions (agreed 2026-09-11)

| Decision  | Choice                                                                                                                                                                                                                                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seats     | Reasoning: `claude` by default, `gemini` via `LLM4TS_REASONER` (resolved with `coderFromEnvironment`, unknown values fail typed). Coder: `pi`, overridable with `LLM4TS_CODER` for comparison runs. The reasoning seat generates the story plan, reviews each task, and judges each story.                                                          |
| Input     | `--repo <path>` plus the epic sentence as the remaining arguments. `--plan-only` writes the story plan and exits. `--concurrency <n>` (default 3), `--fail-fast`.                                                                                                                                                                                   |
| Approval  | The story plan is persisted under `<repo>/.llm4ts/epic-<hash>.md` before any coder runs; an existing file is used as is, so editing it by hand is the approval and the re-plan path. Validation failures are printed with every violation and stop the run.                                                                                         |
| Generator | The reasoning prompt carries the target's `CONTRIBUTING.md`, the kit's surface, the exemplar feature's file list, and the perimeter rules as hard constraints: disjoint `owned` sets, shared-surface changes only as dedicated stories, exactly one story owns `App.tsx`, and every story needing a new domain gets a contract story it depends on. |
| Delivery  | Epic branch `epic/<epic-id>` left in place; story branches kept for inspection; no PR, no merge to the default branch. Local `BoardSync` board and the epic report under `.llm4ts/`.                                                                                                                                                                |
| Estimates | Seats wrapped with `EstimatedUsage` as the convert flows do; every figure on the board and in the report carries the estimated marker.                                                                                                                                                                                                              |

## Demo epic: Conto e Bonifico

Epic sentence: "Add the retail customer's current account (Conto) with
balance and movements, and wire transfers (Bonifico) with beneficiary,
review, SCA confirmation, and history." The committed fixture story plan
under `flows/fixtures/epic-stories/conto-bonifico.md` is the expected
split; the live generator is prompted with the same sentence.

| #   | Story               | Owns                                                                                                   | Depends on |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------ | ---------- |
| 1   | `accounts-contract` | `src/contracts/accounts.ts`, its fake handlers and fixtures                                            | none       |
| 2   | `payments-contract` | `src/contracts/payments.ts`, stateful fake: beneficiaries, create, confirm (SCA), list, detail         | none       |
| 3   | `iban-field`        | `src/kit/iban-field.tsx` + test: formatting and mod-97 check                                           | none       |
| 4   | `conto-overview`    | `src/features/conto/overview/`: account picker, balance, details                                       | 1          |
| 5   | `conto-movimenti`   | `src/features/conto/movimenti/`: paged movements, filter, CSV export                                   | 1          |
| 6   | `bonifico-form`     | `src/features/bonifico/nuovo/`: form, review, SCA confirm, outcome                                     | 2, 3       |
| 7   | `bonifici-list`     | `src/features/bonifico/elenco/`: history with lifecycle badge, detail                                  | 2          |
| 8   | `home`              | `src/features/home/` and `src/App.tsx`: balance tile, last movements, quick transfer, recent transfers | 4, 5, 6, 7 |

Waves under the default cap: {1, 2, 3}, then {4, 5, 6, 7} three at a time,
then {8}. Story 3 is the shared-surface story; stories 4 and 5 share a
domain with disjoint directories; story 8 is the fan-in that owns the
composition point.

## Tasks

- [ ] Flow args (`--plan-only`, `--concurrency`, `--fail-fast`), seat
      selection with `LLM4TS_REASONER`, `EstimatedUsage` wrapping.
- [ ] Story-plan generation prompt and persistence; validation output.
- [ ] Composition of `implementStoriesFlow` with the runner's `contextFor`,
      the local board, the fixture's gate commands, and the judge.
- [ ] Story prompt template (description, `provides`, perimeter rules,
      `BLOCKED_ON` protocol, `CONTRIBUTING.md`, shared read-only excerpts
      under `Context` budgeting).
- [ ] Committed fixture story plan `conto-bonifico.md` and a deterministic
      test that it validates, yields the expected waves, and drives the
      executor with fakes to the expected board and report.
- [ ] `flows/README.md` row and section; `examples/internet-banking/RUNBOOK.md`
      (seed, warm cache, plan-only, inspect, run, crash-recovery rerun,
      what to look at on the board).
- [ ] Shell built-in flow registration (first-line description comment).

## Non-goals

Pull requests, merge to the default branch, board adapters beyond the local
one, real usage capture from CLI connectors, automatic re-planning, and
running the fixture's gates in llm4ts CI (the flow test uses fakes; the
live run is a workshop activity).
