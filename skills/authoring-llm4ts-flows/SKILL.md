---
name: authoring-llm4ts-flows
description: Use when asked to write, scaffold, fork, or change an llm4ts flow — a TypeScript script under .llm4ts/flows/ that the `llm4ts` CLI discovers and runs — including customising a built-in flow's prompt, gates, reviewers, or plan loop.
---

# Authoring llm4ts flows

A flow is one TypeScript file. It imports only `@llm4ts/*`, `effect`, and
`node:*`; its first `//` comment line is its description; the `llm4ts` CLI
(package `@llm4ts/shell`, Node 22+) discovers it by file name under
`.llm4ts/flows/` of the launch directory and runs it with type stripping.
No `npm install` is needed: `@llm4ts/*` and `effect` resolve from the
shell's own installation unless the project pins its own copies.

## When to use

- The user wants a new flow, a hello/skeleton flow, or a variant of a
  built-in flow (`implement`, `sdd`, `issue-pr`, `epic-stories`, ...).
- NOT for running an existing flow on a task: that is the `using-llm4ts`
  skill. NOT for modernization packs: that is `authoring-llm4ts-packs`.

## Step 1: start from the hello flow

Write `.llm4ts/flows/<name>.ts` with this content, changing the first line
and the default prompt. Keep the shape: every export named here exists and
this exact text runs.

```ts
// Hello: send one prompt to the configured provider and print the answer.
import * as Effect from "effect/Effect"
import { completeAndPublish } from "@llm4ts/flow/Flow"
import { apiConnectorFromEnvironment } from "@llm4ts/runner/Connectors"
import { resolveFlowInput } from "@llm4ts/runner/FlowArgs"
import { runFlowMain, runNode } from "@llm4ts/runner/FlowRunner"

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("Say hello and name one thing you can do.")
  const coder = yield* apiConnectorFromEnvironment()
  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder,
      environment: process.env
    },
    (context) => completeAndPublish(context.coder, context.events, input.prompt)
  )
})

runFlowMain(program)
```

- `resolveFlowInput(default)` parses the task text and `--repo` that
  `llm4ts run` forwards; `input.workDir` is the target repository.
- `apiConnectorFromEnvironment()` reads `LLM4TS_PROVIDER` (default `mock`,
  no credentials) and `LLM4TS_MODEL`.
- `runNode(input, body)` wires HTTP, processes, temp files, persistence, and
  connectors; `body` receives `context` with `coder`, `reasoning`,
  `reviewers`, `events`, `git`, `workspace`. Never build Effect layers.
- `completeAndPublish(service, events, prompt)` asks once and publishes the
  answer. `runFlowMain(program)` renders events and sets the exit code.

## Step 2: verify offline, then with the real agent

```bash
npx -y @llm4ts/shell list                     # <name>  [project]  <description>
npx -y @llm4ts/shell run <name> "<task>"      # mock provider: canned answer, exit 0
```

To drive the user's coding agent instead of an API provider, replace the
`coder` line and add the import; `LLM4TS_CODER` selects the CLI (`claude`
default, `codex`, `gemini`, `pi`, `agy`, `grok`, `cursor`, `opencode`):

```ts
import { coderFromEnv } from "@llm4ts/runner/Connectors"
// ...
const coder = coderFromEnv(process.env)
```

Do not run a coder-driven flow against the user's real repository as a
test; use the mock provider, or a throwaway directory, and report the
command for the user to run.

## Step 3: for plan → code → review → commit, fork a built-in

The installed shell ships every built-in flow's source. Read it instead of
recalling the API from memory; it matches the installed version:

```bash
npx -y @llm4ts/shell view implement > .llm4ts/flows/<name>.ts
npx -y @llm4ts/shell view sdd          # reviewers, lint gate, custom task loop
```

Then change the first comment line and the fields of the options object
passed to `implementPlanFlow`:

| Field            | Effect                                                              |
| ---------------- | ------------------------------------------------------------------- |
| `system`         | System prompt for every coder turn (house rules)                    |
| `reviewers`      | Review lenses: `{ name, systemPrompt, files? }` via `Reviewer.make` |
| `lint`           | Gate after each task; `lintCommand(...)` from `@llm4ts/flow/Review` |
| `format`         | Formatter before each commit                                        |
| `maxRounds`      | Review-and-fix rounds before the task fails                         |
| `checkoutBranch` | `false` to commit on the current branch                             |
| `chatPerTask`    | `true` for a fresh conversation per task                            |

State persists under `.llm4ts/` of the target repository
(`plan-<hash>.md`, `trace-<timestamp>.jsonl`); re-running the same command
resumes unchecked tasks.

## Rules

- Import only public subpaths (`@llm4ts/flow/Flow`, `@llm4ts/runner/FlowRunner`,
  ...). If a `llm4ts view` of a built-in does not import it, do not guess it.
- Do not use `any`, type assertions, or `Effect.runFork` inside a flow;
  `runFlowMain` is the only edge.
- Name the flow file so it does not shadow a built-in unless shadowing is
  the intent (`llm4ts list` shows shadows).
- Editor types are optional: `npm i -D @llm4ts/runner @llm4ts/flow @llm4ts/core effect@beta`,
  all `@llm4ts/*` on the shell's version and `effect` pinned exactly.
- Exit codes: 0 done, 1 a stage failed, 2 usage error. `unknown flow` means
  the file is not under `.llm4ts/flows/` of the launch directory or has no
  `.ts` extension.
- `llm4ts` with no arguments opens a menu that needs a terminal; never
  invoke it headlessly.
