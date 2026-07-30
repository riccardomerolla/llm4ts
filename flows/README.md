# Flows

Runnable agent flows composed only from public package exports. Each flow is
a single self-contained script: it imports only `@llm4ts/*`, `effect`, and
`node:*` modules, and its first line is a `//` comment holding the flow's
one-line description. These scripts double as the built-in flows of the
`llm4ts` shell.

| Flow             | What it does                                                | Requirements          |
| ---------------- | ----------------------------------------------------------- | --------------------- |
| `implement.ts`   | Persistent plan, branch, task review/fix, and commits       | selected CLI + Git    |
| `issue-pr.ts`    | GitHub issue assessment through pushed pull request         | selected CLI + GitHub |
| `sdd.ts`         | Spec → red tests → implementation → green verification      | selected CLI + Maven  |
| `local.ts`       | LM Studio reasoning followed by a local pi coding agent     | LM Studio + pi        |
| `judge-suite.ts` | Three-run LLM-as-a-Judge evaluation with variance reporting | selected CLI          |

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

## Judge suite

```sh
LLM4TS_CODER=claude \
pnpm --filter @llm4ts/flows judge-suite -- \
  "You can return an unopened item within 30 days with its receipt."
```
