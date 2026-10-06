# Flows

Runnable agent flows composed only from public package exports. Each flow is
a single self-contained script: it imports only `@llm4ts/*`, `effect`, and
`node:*` modules, and its first line is a `//` comment holding the flow's
one-line description. These scripts double as the built-in flows of the
`llm4ts` shell.

| Flow                        | What it does                                                                                                                        | Requirements                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `hello.ts`                  | One prompt to the configured provider, mock by default                                                                              | none                              |
| `implement.ts`              | Persistent plan, branch, task review/fix, and commits                                                                               | selected CLI + Git                |
| `epic-design.ts`            | Legacy extract pack + target repo → an approved epic brief for `epic-stories`                                                       | reasoner CLI                      |
| `epic-stories.ts`           | Epic → story DAG → parallel coders in worktrees → epic branch                                                                       | reasoner CLI + pi + Git           |
| `epic-retro.ts`             | A failed `epic-stories` run → diagnosis per story and fixes the next run applies once approved                                      | reasoner CLI                      |
| `issue-pr.ts`               | GitHub issue assessment through pushed pull request                                                                                 | selected CLI + GitHub             |
| `sdd.ts`                    | Spec → red tests → implementation → green verification                                                                              | selected CLI + Maven              |
| `local.ts`                  | LM Studio reasoning followed by a local pi coding agent                                                                             | LM Studio + pi                    |
| `judge-suite.ts`            | Three-run LLM-as-a-Judge evaluation with variance reporting                                                                         | selected CLI                      |
| `modernize-survey.ts`       | Phase 0 — inventory, dependency graph, triage, wave plan                                                                            | selected CLI + Git + pack         |
| `modernize-extract.ts`      | Phase 1 — legacy estate → judged, approved spec pack                                                                                | selected CLI + Git + pack         |
| `modernize-refine.ts`       | Phase 1.5 (optional) — prune, deepen, consolidate the pack                                                                          | selected CLI + Git + pack         |
| `modernize-pack-upgrade.ts` | Check a pack an older llm4ts extracted against the current rules; mark what to re-extract (no LLM)                                  | Git + pack                        |
| `modernize-seed.ts`         | Phase 2 — seed the target from the approved pack (no LLM)                                                                           | Git + pack + legacy repo          |
| `modernize-implement.ts`    | Phase 3 — implement the plan behind the pack's gates                                                                                | selected CLI + Git + build        |
| `modernize-verify.ts`       | Phase 4 — equivalence vectors, replay, rule coverage                                                                                | selected CLI + replay cmd         |
| `port-files.ts`             | Port a code base file by file on the work queue: one source per implementer, two votes, a fixer, a `PORT STATUS` trailer, a pilot   | selected CLI + porting pack + Git |
| `port-compile.ts`           | Compiler diagnostics as a work queue: one unit per fixer, one rebuild per round, until dry                                          | selected CLI + porting pack + Git |
| `port-guide.ts`             | Audit the rulebook: dimension auditors, three refuters per finding, a trial port by the rules and natively; a patch behind approval | reasoner CLI + porting pack       |
| `port-ledger.ts`            | Classify every unit the pack names into `ledger.tsv` with evidence; implementers trust it over local guessing                       | reasoner CLI + porting pack + Git |
| `port-tests.ts`             | The differential tier: every test file on the legacy build, then the target; diverge/crash/hang → one fixer each; rebuild per round | selected CLI + porting pack + Git |
| `modernize-review.ts`       | Phase 5 — lens review, fix specs, distilled pack lessons                                                                            | selected CLI + Git + pack         |
| `modernize-bench.ts`        | Measure an extraction run; report and project wave cost                                                                             | selected CLI + pack               |
| `modernize-pack-check.ts`   | Phase -1 — load a pack, match its rules against an estate                                                                           | pack + estate (no LLM)            |
| `pack-fork.ts`              | Fork a pack into one describing a real target repo's own conventions (not part of the legacy modernize sequence — no legacy repo)   | selected CLI + Git + pack         |

These flows deliberately invoke real providers or installed coding CLIs and
are not part of the default test suite. Build the packages once before
running flows from the workspace:

```sh
pnpm build
```

Every flow accepts `--repo <path>` to target a repository and takes the task
text as its remaining arguments:

```sh
pnpm --filter @llm4ts/flows implement -- \
  --repo /path/to/repository \
  "Add a multiply function with tests"
```

> **Run these commands from the llm4ts checkout.** `pnpm --filter` resolves
> the package against the pnpm workspace at the _current directory_ — invoked
> from anywhere else (for example from the repository you are targeting) pnpm
> prints `No projects found in "<dir>"` and exits **without running the
> flow**. That message comes from pnpm, not from a connector — it is not a
> Gemini/Google Cloud "No project found" error. Either `cd` into the llm4ts
> checkout, point pnpm at it with `pnpm -C /path/to/llm4ts --filter …`, or use
> the installed CLI, which works from any directory:
>
> ```sh
> llm4ts run modernize-survey --repo /path/to/legacy-estate
> ```

## Seed a complete workflow

`examples/seed.sh` copies a minimal starter into a new directory, initializes
a clean `main` branch, commits the baseline, and prints the complete flow
command. The flow remains in this workspace; no llm4ts source is copied into
the target repository.

```sh
examples/seed.sh implement
examples/seed.sh sdd /path/to/new-project
examples/seed.sh local
```

Pass `--run` to seed and immediately start the live flow:

```sh
LLM4TS_CODER=codex examples/seed.sh implement --run
LLM4TS_CODER=codex examples/seed.sh sdd /path/to/new-project --run
```

For issue-to-PR, supply a real issue reference. The new repository must also
have a GitHub `origin` remote before the flow reaches its push stage:

```sh
examples/seed.sh issue-pr /path/to/new-project \
  --prompt "owner/repository#42"
```

Available mappings:

| Flow                 | Starter          | Baseline verification |
| -------------------- | ---------------- | --------------------- |
| `implement`, `local` | Rust calculator  | `cargo test`          |
| `issue-pr`           | Scala calculator | `sbt test`            |
| `sdd`                | Java todo CLI    | `mvn test`            |

An explicit destination must be empty; the script refuses to merge a starter
into an existing project. Without a destination it creates a temporary
directory. `--run` invokes real coding agents and may edit, commit, push, or
open a pull request according to the selected flow.

## Persistent implementation

The implementation flow defaults to Claude Code. It stores the generated plan
under the target repository's `.llm4ts/` directory, resumes completed tasks on
rerun, creates the plan's epic branch, and commits each reviewed task. Select
another installed, authenticated agent with `LLM4TS_CODER`:

```sh
LLM4TS_CODER=codex \
pnpm --filter @llm4ts/flows implement -- \
  --repo /path/to/repository \
  "Add a multiply function with tests"
```

Accepted values are `claude`, `codex`, `gemini`, `pi`, `agy`, `grok`,
`cursor`, and `opencode`. The inherited `LLM4ZIO_CODER` name is no longer read
for migration.

## Designing an epic from a legacy analysis

`epic-design` is for the common modernization case: the legacy application
has been through `modernize-extract`, and what you want to build in the
target is a slice, not a program-by-program conversion. Some legacy code is
dead, some behaviour the target stack already provides. The flow distils the
extract pack into an **epic brief** with you, and `epic-stories` plans from
the approved brief.

```sh
LLM4TS_LEGACY_REPO=~/legacy/ib-core \
  llm4ts run epic-design --repo ~/work/portal "Current account: balance, movements, statements"
```

- It runs rooted at the **target** repository. `LLM4TS_LEGACY_REPO` must hold
  `docs/modernization/` (the extract pack); it refuses to start without it.
  `LLM4TS_PACK` describes the target stack when the target is new.
- The brief is a file, `.llm4ts/epics/<epic-id>/brief.md`, and the file is
  the state. Its sections: Goal, Legacy programs considered, In scope,
  Dropped, Provided by the target, Deferred, Constraints, Open points,
  Feedback. Evidence is cited as `PROGRAM › scenario title`.
- One run does one thing, decided from the file:
  - no brief: select the relevant programs, propose, check, write a draft;
  - answers or feedback in the file: revise it (your direct edits stay);
  - unanswered open points and no feedback: stop and name them;
  - `Status: approved`: validate it and print the `epic-stories` command.
- Checks run on every proposal and on the approved brief: every citation
  exists in the pack, every "provided" pointer exists in the target, every
  dropped or deferred entry has a reason, and **every scenario of every
  program the brief considers has exactly one disposition**. A scenario
  `modernize-refine` dropped comes back only when you answer its `[check]`
  open point with `keep: <why>`; that answer stays in the brief as the record. What one fix round cannot clear is written into the brief as a
  `[check]` open point; nothing is hidden.
- **Briefs of one repository are read together** (the coverage ledger).
  What the approved briefs of other epics decided is inherited: a scenario
  they dropped or found in the target is not restated, one they own is not
  proposed again, and one they deferred is offered to the new brief.
  Deciding otherwise is a `[check]` open point naming the other epic,
  resolved like any override: move the scenario out, or answer
  `keep: <why>`. Drafts bind nothing.
- `-- --coverage` writes `.llm4ts/epics/coverage.md` without calling a
  model: how many scenarios of the legacy pack are accounted for, delivered
  and remaining, a table per program, and the lists that need someone:
  conflicts between approved briefs, scenarios still deferred, unclaimed
  ones, what drafts propose, and citations the pack no longer has.
- Approve by setting `Status: approved`, then:
  `llm4ts run epic-stories --repo ~/work/portal -- --epic <epic-id>`. The
  planner reads the brief in place of a one-line epic; a draft brief stops
  `epic-stories` rather than being ignored. `--list` shows the briefs;
  `--epic <id>` resumes one without retyping the text.

## Parallel stories from an epic

`epic-stories` is the parallel sub-agent flow (ADR 0013). A reasoning seat
splits the epic into stories with a declared dependency graph and declared
file ownership, the plan is persisted for approval, and coders implement the
stories at the same time, each in its own git worktree, merged into an epic
branch in dependency order behind the target's gates:

```sh
pnpm --filter @llm4ts/flows epic-stories -- \
  --repo /path/to/portal \
  "Add the current account (Conto) and wire transfers (Bonifico)"
```

- Through the shell, the flow's own flags go after `--`, which ends the
  shell's flag parsing: `llm4ts run epic-stories --repo <path> -- --plan-only "…"`.
- `--plan-only` writes (or re-validates) `.llm4ts/epics/<epic-id>/plan.md`
  and stops. An existing plan file always wins over regeneration: editing
  it is the approval and the re-plan path.
- `--land[=<branch>]` lands the finished epic on `main` (or `<branch>`) and
  runs no stories. It refuses while any story is unmerged, merges the target
  into the epic branch first, lets the coder resolve conflicts and red gates
  for up to three rounds, and only then merges the epic into the target
  (a merge commit). If it gives up, the target is untouched. After landing,
  the story worktrees and fully merged story branches are removed
  (`--keep-worktrees` keeps them). The epic's record stays: plan, board,
  report, story states, traces.
- What the reviewers and the judge found is written per story under
  `.llm4ts/epics/<epic-id>/stories/`: `<id>.findings.md` lists every review
  round of every task and every judge round with its scores and issues, for
  people to read; `<id>.judge.json` holds the judge's last verdict beside a
  fingerprint of what it judged, and `<id>.review/<lens>.json` each lens's
  last answer beside the task and diff. A rerun that finds the same diff
  reuses those answers instead of asking the model again (the judge on its
  first round; a round after a revision always asks). Findings that were not
  cleared are also the `Revision n` tasks on `<id>.plan.md`.
- Each epic lives in its own folder under `.llm4ts/epics/`, named after its
  text. `--list` shows them (stories merged, landed or not), and
  `--epic <id>` works on one by id without retyping its text. With neither
  text nor `--epic`, the run takes the one epic not landed yet. When several
  are open, or all have landed, it stops with the list instead of guessing.
- `--concurrency <n>` (default 3) caps the stories implemented at once;
  `--fail-fast` stops at the first failed story instead of putting its
  dependents on hold (`waiting` on the board until it is fixed and rerun).
- `LLM4TS_REASONER` (default `claude`, or `gemini`) splits, reviews every
  task and judges every story; `LLM4TS_CODER` (default `pi`) implements.
  `LLM4TS_REASONING_MODEL` / `LLM4TS_CODER_MODEL` pick their models (pi
  takes `provider/model`, e.g. `openai-codex/gpt-5.5`).
  `LLM4TS_CODER_FLAGS` / `LLM4TS_REASONING_FLAGS` add CLI flags to a seat
  (`key=value;key`). `LLM4TS_GATES="cmd; cmd"` overrides the default
  `pnpm` gates (`typecheck`, `lint`, `test`, `build` — each only when the
  app's `package.json` defines that script, and the run lists them); `LLM4TS_WORKTREE_SETUP` (default `pnpm install --offline`)
  prepares each story worktree, which starts as a fresh checkout without
  dependencies.
- Gates run on the `node` on the PATH that launched `llm4ts`, not on the one
  the app pins (`.nvmrc`, `.node-version`, `package.json` `engines.node`):
  the run checks that node against the pin before its first gate and stops,
  naming both, when they disagree (`llm4ts doctor` shows the same line
  under `gates:`). pnpm's `use-node-version` in the app's `.npmrc` passes
  outright, since pnpm then runs that Node itself. `LLM4TS_NODE_CHECK=off`
  skips the check.
- Setup and gates run in the application folder: `LLM4TS_APP_DIR`
  (e.g. `frontend`) when set; otherwise the repository root when it has a
  `package.json`, else its one first-level subfolder that has one (a Next.js
  app under `frontend/`). The coder is told where the application lives.
- `LLM4TS_SETUP_AGENT=1`: when a worktree's setup fails, the story's coder
  gets one turn to make it ready (install, warm the store, generate
  clients), without touching tracked files; setup then runs again as the
  check, and a second failure fails the story with both outputs. Off by
  default; outages go to the outage retry instead.
- Story worktrees live BESIDE the repository, in
  `<repo>.worktrees/<epic-id>/<story-id>` (`LLM4TS_WORKTREE_ROOT` moves
  them). Nested inside it, a coder's parent directory was the epic checkout,
  and coders ran commands there. A worktree left under an older root moves
  on resume, uncommitted work included. The epic checkout must stay clean:
  the run refuses to start on a dirty one, and a change that appears there
  mid-run stops new stories from starting, naming the stray paths.
- A resumed story first merges the epic branch in (conflicting hunks take
  the epic's side), and does so again before its judge: a story is never
  built on, or judged against, code the epic no longer has.
- The perimeter is a gate: each task's stray paths go back to the coder
  before anything is committed. The task plan is checked too: a task that
  names another story's paths (registering a screen in `src/App.tsx`) is
  re-planned, then dropped. Before the judge, stray paths the coder does not
  revert are restored from the epic branch.
- A story that needs unplanned work replies `BLOCKED_ON: …`. A claim the
  plan refutes (the path is the story's own, a merged dependency's, or a
  later story's) and a claim the reasoning seat rejects after reading the
  named files send the coder back once with the reason. Any other claim fails
  typed as a missing dependency. A merge conflict fails typed and is aborted.
  Rerunning skips merged stories and resumes the rest.
- When the coder's serving engine goes down (a local server restarting after
  a GPU crash, or failing to load its model), requests wait on a slower
  retry budget (15 s doubling to 2 min, five tries). If the story still
  fails, the flow polls the engine (LM Studio `127.0.0.1:1234/v1/models`,
  Ollama `:11434/api/tags`, or `LLM4TS_CODER_HEALTH_URL`) and retries the
  story once it answers. It does not fail the next story on the same outage.
- Output: the epic branch `epic/<epic-id>` left in place, story branches
  `story/<epic-id>/<story-id>`, the board and `report.md` under
  `.llm4ts/epics/<epic-id>/`. Every usage figure is an estimate.

### After a red run: `epic-retro`

When a run ends with failed or waiting stories it prints the one command
that reads what it left behind:

```sh
llm4ts run epic-retro --repo ~/work/portal -- --epic <id>   # the epic's latest run; --run <runId> picks another
```

Code digests the run's trace, its transcripts when it was started with
`--transcript`, the board, the report and each story's plan, findings and
judge verdict into `.llm4ts/epics/<epic-id>/retro/<runId>.digest.md`
(written first, capped by `LLM4TS_RETRO_CHARS`, default 60 000). One
read-only seat (the judge seat, `LLM4TS_REASONER`) turns the digest into a
proposal: per failed story a diagnosis and exactly one fix — tasks appended
to its plan, an edit to its entry in `plan.md` (which restarts it from a
fresh worktree), a refine round, or nothing — plus run advice (a seat on an
old CLI, Node mismatch, transcripts off) and, only where llm4ts itself
misbehaved, advice for the library in `retro/<runId>-library.md`. Code
validates the proposal (unknown stories, paths outside the repository, tasks
for a story that never planned, edits that change nothing are dropped and
listed) and writes `retro/<runId>.md`, which ends in `- [ ] Approved`.

Tick it and rerun `epic-stories --epic <id>`: before any story runs, the
approved fixes are applied — tasks as `Retro <runId>: <title>` on the
story's plan, story edits saved to `plan.md` so the executor restarts that
story — the report gets `- [x] Applied <date>`, and the run says what
changed. Unapproved reports are ignored; a report whose proposal no longer
fits the plan is skipped with a note, never a failure. A `refine` item is
printed with the feedback to give `--refine`. Nothing a retro writes is
committed to the target (ADR 0023).

### Refining a finished epic

When every story is merged and you have tried the epic branch, feedback
becomes a **refine round** (ADR 0021): follow-up stories planned from your
text and run on the same `epic/<epic-id>` branch, before landing.

```sh
llm4ts run epic-stories --repo /path/to/portal -- --refine \
  "Move the balance card above the movements list. Remove the export button.
   The transfer form loses the amount when the IBAN is rejected."
```

- With `--refine` the text is the feedback, not an epic's text. The epic is
  the one `--epic <id>` names, or the one epic not landed yet.
- The reasoning seat reads the code on the epic branch and returns
  follow-up stories plus a **not planned** list: items that are unclear,
  contradict each other or cannot be tied to a file, each with the question
  to answer. Nothing is guessed. Answer them in the next round's feedback.
- A round lives in `.llm4ts/epics/<epic-id>/rounds/<n>/`: `feedback.md`,
  `plan.md`, `not-planned.md`, and its own story states, board and
  `report.md`. The epic's own plan and record are never rewritten.
- `--refine --plan-only "…"` plans the round and stops; editing
  `rounds/<n>/plan.md` is the approval. A plain rerun (no `--refine`)
  finishes the open round.
- Follow-up stories may claim files the merged stories own. Within a round
  paths stay exclusive, so items that need the same file go into one story.
  Story ids are prefixed `r<n>-`; branches are
  `story/<epic-id>/r1-move-card`.
- Rounds are sequential: `--refine` is refused while a story of the plan or
  of an earlier round is unmerged, and on an epic that has landed.
- `--land` waits for every round: it refuses while a round story is
  unmerged, and afterwards removes the rounds' worktrees and branches too.
  `--list` shows each round (`round 1: 3/3 merged, 1 not planned`).
- Gates, seats, roster, concurrency and the story judge are the ones of the
  epic. `epic-stories-board` refines the same way.

### The story judge as a ruleset (fork)

`epic-stories-board` is `epic-stories` with one difference: each story is
judged by a blackboard ruleset (ADR 0020, `flows/lib/story-board.ts`)
instead of the rubric judge. A `judge` rule scores the four dimensions
(provides, scope, house-style, tests) with the Judgment service; `decide`
turns each answer into act, caution or hold; and the `bar` rule merges the
story only when every dimension scores at least 1.5 of 2 **and** is an
`act`. Anything else comes back to the coder as issues, one per dimension.
Every round's run is in the trace (`BlackboardRun`) and every answer in
`.llm4ts/judgments/story-board.jsonl`. Same flags and environment as
`epic-stories`; the judgment seat is `LLM4TS_JUDGMENT_PROVIDER` /
`LLM4TS_JUDGMENT_MODEL`, or the reasoning seat.

### A pool of executors

With a roster file (`~/.config/llm4ts/roster.json`, overridden by id by
`<repo>/.llm4ts/roster.json`), every seat of every flow is served from a
pool of executors (ADR 0019). Each executor is a harness plus a model, with
the roles it takes (`planner`, `coder`, `reviewer`, `judge`, `verifier`),
its slots and a priority per role:

```json
{
  "executors": [
    {
      "id": "pi-lmstudio",
      "harness": "pi",
      "model": "lmstudio/qwen/qwen3.6-35b-a3b:medium",
      "roles": ["coder"],
      "slots": 1,
      "priority": 1,
      "health": "http://127.0.0.1:1234/v1/models"
    },
    {
      "id": "claude",
      "harness": "claude",
      "model": "claude-sonnet-5",
      "roles": ["coder", "reviewer", "judge", "verifier", "planner"],
      "slots": 3,
      "priority": { "coder": 3, "default": 1 }
    }
  ]
}
```

- A story holds one coder for its lifetime. Reviewer, judge and verifier
  calls lease an executor per call, never the one coding the story, unless
  nobody else can take the role, every executor that could is held by a
  coder, or every one is out of the round (paused, over quota, down); then
  the story's own executor takes the call, on a free slot of its own when it
  has one, and the run says "not independent", and why. A call only ever
  waits for another call to end. Give an executor that codes and reasons at
  least two slots to keep its reviews independent.
- Lower priority first; equal priorities take turns. An executor that codes
  and reasons keeps one slot for reasoning (`coderSlots`).
- A usage limit, three rate limits in 10 minutes, a serving engine that is
  down, or a harness that is not signed in takes an executor out of the
  round, for the right time (`cooldown` per executor). A story whose coder
  goes out hands over to the next coder, at most twice. When nobody can
  serve, the run waits for the first to come back.
- `llm4ts roster` shows the pool and who is out; `llm4ts roster pause <id>
[--for 2h]` and `resume <id>` control it across runs. `llm4ts run
--roster none` ignores it, `--executors a,b` narrows it.
- `env` values reference variables (`"${LEMONADE_API_KEY}"`), never secrets;
  provider settings stay in each harness's own config. API providers
  (`lm-studio`, `ollama`, `openai`, …) may reason but not code.

The demo roster is `examples/internet-banking/roster.example.json`. A roster
for Google Vertex AI with a service-account key, and how to configure each
harness for it, is in `docs/vertex-service-account.md`
(`examples/vertex/roster.example.json`).

### Local models

A local server (LM Studio, Ollama) generates one reply at a time. Run with
`--concurrency 1` (the flow warns otherwise), load the model with a context
of at least 128K, and keep it loaded (no idle TTL):

```sh
# pi on LM Studio
LLM4TS_CODER_MODEL=lmstudio/qwen/qwen3.6-35b-a3b:medium \
  llm4ts run epic-stories --repo ~/demo/portal -- --concurrency 1 "…"

# claude CLI on LM Studio's Anthropic-compatible endpoint (both seats go
# local unless LLM4TS_REASONER names another CLI)
ANTHROPIC_BASE_URL=http://127.0.0.1:1234 ANTHROPIC_AUTH_TOKEN=lmstudio \
LLM4TS_CODER=claude LLM4TS_CODER_MODEL=qwen/qwen3.6-35b-a3b \
  llm4ts run epic-stories --repo ~/demo/portal -- --concurrency 1 "…"
```

When a chat's replayed history outgrows the window, the coder is retried
once with the current turn only. Its earlier work is in the working tree.

The demo epic and its target are in
[`examples/internet-banking/RUNBOOK.md`](../examples/internet-banking/RUNBOOK.md);
the expected split is committed as `fixtures/epic-stories/conto-bonifico.md`.

## GitHub issue to pull request

This workflow reads the issue, asks the reasoner whether it is actionable,
persists an accepted plan by issue number, reviews and commits each task, pushes
the branch, and opens a PR. A blocked assessment is posted back to the issue.
It performs real Git and GitHub writes:

```sh
LLM4TS_CODER=claude \
pnpm --filter @llm4ts/flows issue-pr -- \
  --repo /path/to/repository \
  "owner/repository#42"
```

The selected CLI and `gh` must already be authenticated.

## Spec-driven development

The SDD flow persists a Markdown specification in both the plan brief and
`specs/<epic>.md`. Its first task must create compiling but failing tests;
subsequent tasks are reviewed behind `mvn -q test`, and a final verification
stage refuses to finish while acceptance tests are red.

By default it uses Gemini Pro for specification/planning and Gemini Flash for
coding/review. Override the model IDs or select one CLI for every role:

```sh
LLM4TS_REASONING_MODEL=gemini-3-pro-preview \
LLM4TS_CODER_MODEL=gemini-2.5-flash \
pnpm --filter @llm4ts/flows sdd -- \
  --repo /path/to/maven-repository \
  "Add due dates and mark overdue items"
```

```sh
LLM4TS_CODER=codex \
pnpm --filter @llm4ts/flows sdd -- \
  --repo /path/to/maven-repository \
  "Add due dates and mark overdue items"
```

## Fully local

Start LM Studio on port 1234 with a model loaded, install `pi` plus its LM Studio
bridge, then run:

```sh
LLM4TS_REASONING_MODEL=qwen/qwen3-coder-30b \
LLM4TS_CODER_MODEL=qwen/qwen3-coder-30b \
pnpm --filter @llm4ts/flows local -- \
  --repo /path/to/repository \
  "Add a multiply function with tests"
```

This mirrors the two-seat shape of `llm4zio`'s `local.sc`: the reasoning call
produces repository-aware guidance and the pi agent performs the edits.

## Legacy modernization

Six phases take a legacy estate to a spec-driven, equivalence-proven
replacement. Phases 0–1 run rooted at the **legacy** repository; phases 2–5
run rooted at the **target** repository, behind an enforced clean-room wall
that refuses to start if any legacy source is reachable there.

```text
pack-check → survey → [human approves waves] → extract → [human approves the pack]
           → seed → implement → verify → review ⤴ (fix tasks re-enter implement)
```

`modernize-pack-check` is the phase before the first paid one: it loads the
pack exactly as survey and extract do, matches every `sources:`, `programs:`,
`## Coverage:` and `## Survey:` rule against the estate at `--repo`, prints a
sample of the units each rule captured, and lists likely mistakes (a rule
capturing nothing, a missing prompt sidecar, a scaffold path that does not
exist) as warnings. It makes no model call, so it is the place to iterate on
a new pack's regexes before spending a survey run:

```sh
llm4ts run modernize-pack-check --pack packs/my-pack --repo /path/to/legacy-estate
```

Every phase reads a modernization **pack** (`@llm4ts/flow/Pack`): a directory
with a `pack.md` manifest (sources/programs regexes, an optional `exclude:`
regex, gates, judge rubric, `## Coverage:` unit rules, `## Survey:` edge
rules, equivalence policy) plus `prompts/` and `reviewers/` sidecars. Packs
ship in **kits** (ADR 0014), the directories under [`kits/`](../kits/README.md)
that bundle them with their scaffolds and pattern cards. `--pack` on
`llm4ts run`, or `LLM4TS_PACK`, selects one (default `cobol-springboot`): a
bare pack name resolved across the kits in the project, global, and built-in
tiers, `kit/pack` to name one kit, or a directory holding `pack.md` for a
pack still being written. `llm4ts kits` lists what is available.

The estate-reading phases (survey, extract, bench) read legacy sources with
an 8 MiB per-file cap — legacy estates routinely carry multi-megabyte
programs and generated copybooks. A `read bytes exceeded limit` failure
names the offending file; raise the cap with `LLM4TS_MAX_READ_BYTES=<bytes>`
when an estate legitimately exceeds it.

Discovery is bounded the same way, and sized for estates (20 000 files for
the estate-reading phases, 1 000 elsewhere). Only files the pack's `sources:`
regex matches — minus its optional `exclude:` regex — are returned and
counted, and version-control, dependency, and build-output directories
(`.git`, `node_modules`, `target`, `build`, `dist`, …) are never entered, so
a J2EE tree full of jars and compiled classes does not spend the cap before
the first JSP is seen. When an estate still overflows, the survey aborts with
the three knobs spelled out: narrow `sources:`/`exclude:` in the pack,
replace the pruned directory list with `LLM4TS_EXCLUDE_DIRS=<names>`, or
raise the cap with `LLM4TS_MAX_DISCOVER_RESULTS=<count>`.

The survey's two reasoning prompts (graph refine, triage) name no technology
themselves: the pack contributes the stack-specific paragraph through the
`prompts/survey-refine.md` and `prompts/survey-triage.md` sidecars (where a
COBOL pack talks about dynamic CALLs and JCL symbolic parameters, a J2EE pack
talks about web.xml mappings, includes, forwards, and ajax targets), and the
graph's provenance is stated from the pack's own `## Survey:` rule names. A
pack without the sidecars gets a neutral default.

Seven reference packs ship in the two built-in kits,
[`mainframe-java`](../kits/mainframe-java/README.md) (COBOL/JCL and ACE to
Spring Boot and Kafka Streams) and
[`j2ee-nextjs`](../kits/j2ee-nextjs/README.md) (JSP to Next.js, which also
ships the `convert-page` and `convert-all` flows). Each kit README lists its
packs, scaffolds, and replay support.

Packs without a `replay:` command run phases 0–3 and 5; phase 4 needs a
replay harness in the target repository to drive equivalence vectors.

Translation pattern cards come from two decks: the kit's `patterns/` and the
pack's own `<pack>/patterns/` (as `cobol-kafka` adds for event-streaming
idioms). Extraction tags each program's traceability fragment with the cards
its source matches, and implementation injects exactly those cards.

Copy a pack and edit it for your estate — the manifest is the whole contract,
and `kits/test/packs.test.ts` shows what the flows require of it.

### Phase 0 — survey

```sh
pnpm --filter @llm4ts/flows modernize-survey -- --repo /path/to/legacy-estate
```

Writes `docs/modernization/{inventory.md,graph.json,wave-plan.md}` and
commits. The graph is regex-derived first, then an evidence-gated LLM pass
adds the edges regexes miss (`LLM4TS_GRAPH_REFINE=off` skips it). When
`bench-results.jsonl` exists next to the launch directory, the plan carries a
measured cost projection. A human reviews the plan and flips `- [x] Approved`.

### Phase 1 — extract

```sh
LLM4TS_WAVE=wave-1 \
pnpm --filter @llm4ts/flows modernize-extract -- --repo /path/to/legacy-estate
```

Per program and resumable: one structured analyst call writes the spec,
feature, traceability, and mapping fragments, then a layered gate
(deterministic `SpecChecks` + a per-program LLM judge, verdicts cached under
`gate/` and re-judged only when content changes) must clear before the pack
gets its unchecked approval marker.

A pack that declares `spec-schema: pagespec` (`j2ee-nextjs-spa` does) has every
program spec's ```json pagespec block decoded by the gate before any judge
runs; an undecodable block is a per-program finding the fix turn repairs,
so the converter never meets one.

With `LLM4TS_WAVE` set, the coverage half of that gate is scoped to the
wave: only units the wave's own program files capture must appear in the
traceability matrix, and units captured elsewhere (another wave's programs,
an estate-wide descriptor such as `web.xml`) are listed as not gating this
wave. Once every wave is extracted, one more run without `LLM4TS_WAVE`
resumes instantly and enforces coverage across the whole estate.

The programs of a wave are independent — each analyst reads its own source
and resolved closure and writes its own four files — so
`LLM4TS_EXTRACT_CONCURRENCY=<n>` extracts and judges `n` at once (default 1).
Every program still gets its own commit, scoped to its four files rather than
`git add -A`, and a failure lets the programs already in flight finish and
land before it surfaces; a rerun resumes only what is missing. Concurrency
divides wall time, not tokens: the cost figures and the bench projection are
unchanged, and the bound exists for the coder seat's quota, not for
correctness.

### Phase 2 — seed (deterministic, no model calls)

```sh
LLM4TS_LEGACY_REPO=/path/to/legacy-estate \
pnpm --filter @llm4ts/flows modernize-seed -- --repo /path/to/target
```

Refuses to run until the spec pack is approved. Scaffolds an empty target from
the pack, copies specs/features/indexes across the wall — never legacy source
— re-parses the plan as a hard validation, and writes the provenance manifest
(`LLM4TS_APPROVER` records who approved).

### Phase 3 — implement

```sh
pnpm --filter @llm4ts/flows modernize-implement -- --repo /path/to/target
```

Implements each plan task behind the pack's `build`/`test` gates with the
pack's reviewer lenses, committing per task. The first task must leave the
acceptance tests red. Pattern cards cited by the specs are injected as an
advisory playbook. A spec-compliance judge then scores the branch
(`LLM4TS_JUDGE_ROUNDS`, default 2) before an optional push and PR.

### Phase 4 — verify

```sh
pnpm --filter @llm4ts/flows modernize-verify -- --repo /path/to/target
```

Generates equivalence vectors per program from the specs (resumable), replays
them through the pack's `replay:` command, diffs observations under the pack's
comparison policy, and reports rule-by-rule coverage against the frozen
`rules.txt`. Failures are triaged into fix specs plus plan tasks and the phase
exits non-zero until every vector is green.

The replay command must print a JSON array of observations on stdout. Field
values may be any JSON scalar — `{"ZSTC": 0}` is as acceptable as
`{"ZSTC": "0"}` — and are rendered to strings before comparison, with `null`
read as no value (empty). Because JSON numbers carry no trailing zeros, emit
fixed-precision fields (money, `PIC 9(5)V99`) as **strings** so `0.10` does not
arrive as `0.1` and diff against the expected value.

### Phase 5 — review

```sh
pnpm --filter @llm4ts/flows modernize-review -- --repo /path/to/target
```

Runs the full reviewer roster plus the pack's lenses over the branch diff,
scores it, and distils the findings into fixes (which become plan tasks),
improvements, and generalizable lessons appended to the pack's `lessons.md`.

### Benchmarking

```sh
pnpm --filter @llm4ts/flows modernize-bench -- --repo /path/to/fixture-copy
```

Measures an extraction run over a disposable fixture and appends a
`BenchRecord` to `bench-results.jsonl`. `LLM4TS_BENCH_MODE=report` (with
optional `LLM4TS_BENCH_PROJECT=<programs>`) renders the comparison report and
the per-wave projection the survey embeds.

## Judge suite

```sh
LLM4TS_CODER=claude \
pnpm --filter @llm4ts/flows judge-suite -- \
  "You can return an unopened item within 30 days with its receipt."
```
