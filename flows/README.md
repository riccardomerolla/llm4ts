# Flows

Runnable agent flows composed only from public package exports. Each flow is
a single self-contained script: it imports only `@llm4ts/*`, `effect`, and
`node:*` modules, and its first line is a `//` comment holding the flow's
one-line description. These scripts double as the built-in flows of the
`llm4ts` shell.

| Flow                     | What it does                                                | Requirements               |
| ------------------------ | ----------------------------------------------------------- | -------------------------- |
| `implement.ts`           | Persistent plan, branch, task review/fix, and commits       | selected CLI + Git         |
| `issue-pr.ts`            | GitHub issue assessment through pushed pull request         | selected CLI + GitHub      |
| `sdd.ts`                 | Spec → red tests → implementation → green verification      | selected CLI + Maven       |
| `local.ts`               | LM Studio reasoning followed by a local pi coding agent     | LM Studio + pi             |
| `judge-suite.ts`         | Three-run LLM-as-a-Judge evaluation with variance reporting | selected CLI               |
| `modernize-survey.ts`    | Phase 0 — inventory, dependency graph, triage, wave plan    | selected CLI + Git + pack  |
| `modernize-extract.ts`   | Phase 1 — legacy estate → judged, approved spec pack        | selected CLI + Git + pack  |
| `modernize-seed.ts`      | Phase 2 — seed the target from the approved pack (no LLM)   | Git + pack + legacy repo   |
| `modernize-implement.ts` | Phase 3 — implement the plan behind the pack's gates        | selected CLI + Git + build |
| `modernize-verify.ts`    | Phase 4 — equivalence vectors, replay, rule coverage        | selected CLI + replay cmd  |
| `modernize-review.ts`    | Phase 5 — lens review, fix specs, distilled pack lessons    | selected CLI + Git + pack  |
| `modernize-bench.ts`     | Measure an extraction run; report and project wave cost     | selected CLI + pack        |

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
`cursor`, and `opencode`. The inherited `LLM4ZIO_CODER` name remains supported
for migration.

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
survey → [human approves waves] → extract → [human approves the pack]
       → seed → implement → verify → review ⤴ (fix tasks re-enter implement)
```

Every phase reads a modernization **pack** (`@llm4ts/flow/Pack`): a directory
with a `pack.md` manifest (sources/programs regexes, gates, judge rubric,
`## Coverage:` unit rules, `## Survey:` edge rules, equivalence policy) plus
`prompts/` and `reviewers/` sidecars. `LLM4TS_PACK` selects one (default
`packs/cobol-springboot`), resolved against the launch directory first, then
against the flow script's own directory — so the built-in packs shipped with
`@llm4ts/shell` are found even when a flow is launched from an unrelated
directory. An absolute `LLM4TS_PACK` is used as-is.

Six reference packs ship, each pairing a legacy source technology with a
target stack, plus the [scaffold](fixtures/scaffolds/) that seeds an empty
target repository:

| Pack                                                 | Legacy → target                   | Scaffold                | Replay |
| ---------------------------------------------------- | --------------------------------- | ----------------------- | ------ |
| [`cobol-springboot`](packs/cobol-springboot/pack.md) | COBOL/JCL → Spring Boot service   | `spring-boot-service`   | yes    |
| [`cobol-kafka`](packs/cobol-kafka/pack.md)           | COBOL/JCL → Kafka Streams service | `kafka-streams-service` | yes    |
| [`ace-integration`](packs/ace-integration/pack.md)   | ACE msgflow/ESQL → Spring Boot    | `spring-boot-service`   | no     |
| [`ace-kafka`](packs/ace-kafka/pack.md)               | ACE msgflow/ESQL → Kafka Streams  | `kafka-streams-service` | yes    |
| [`jsp-bff-nextjs`](packs/jsp-bff-nextjs/pack.md)     | JSP/Java → Spring BFF + Next.js   | `spring-bff`            | no     |
| [`jsp-nextjs`](packs/jsp-nextjs/pack.md)             | JSP/Java → Next.js SPA            | `nextjs-spa`            | no     |

Packs without a `replay:` command run phases 0–3 and 5; phase 4 needs a
replay harness in the target repository to drive equivalence vectors.

Universal translation [pattern cards](patterns/) sit beside the packs and
apply to every run; a pack may add its own under `<pack>/patterns/` (as
`cobol-kafka` does for event-streaming idioms). Extraction tags each
program's traceability fragment with the cards its source matches, and
implementation injects exactly those cards.

Copy a pack and edit it for your estate — the manifest is the whole contract,
and `flows/test/pack.test.ts` shows what the flows require of it.

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
