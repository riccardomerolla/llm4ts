# Flow Authoring Guide

## Who this is for

You've tried the [`@llm4ts/js` quickstart](../README.md#try-it-in-one-minute)
or run `npx llm4ts` from the terminal, and now you want to write a flow
directly against `runNode` — publishing your own events, reaching the
connector's raw streaming API, or composing more than one prompt in a single
Effect program. This guide assumes no prior Effect experience but does assume
you're comfortable reading TypeScript; each call in the walkthrough below is
explained as it appears.

This is example-driven, not a reference. For the full list of exports per
package, see the [API guide](api.md); for how the packages depend on each
other, see [Architecture](architecture.md). Everything here composes only
public subpath exports, the same constraint the [`examples/`](../examples/README.md)
scripts follow.

## The ladder

`examples/` climbs from a mock completion to HTTP providers, CLI coding
agents, persistent resumable plans, and full issue-to-PR automation. This
guide climbs the same ladder in prose, one rung per section. This first rung
covers the simplest flow there is: send one prompt, get one response,
publish it as an event.

## Rung 1: a one-shot prompt flow

This is `examples/basic.ts` verbatim. It runs with no credentials because it
uses the built-in mock connector:

```ts
import * as Effect from "effect/Effect"
import { ApiConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { ConnectorIds } from "@llm4ts/core/Models"
import { collect } from "@llm4ts/core/Streaming"
import { FlowLlmError } from "@llm4ts/flow/FlowError"
import { AssistantMessage } from "@llm4ts/flow/FlowEvents"
import { runNode } from "@llm4ts/runner/FlowRunner"

const prompt = process.argv.slice(2).join(" ").trim() || "Explain this repository."

const program = runNode(
  {
    workDir: process.cwd(),
    workspace: process.cwd(),
    userPrompt: prompt,
    coder: ApiConnectorConfig.make({
      connectorId: ConnectorIds.Mock
    })
  },
  (context) =>
    collect(context.coder.executeStream(prompt)).pipe(
      Effect.mapError(FlowLlmError.from),
      Effect.tap((response) =>
        context.events.publish(AssistantMessage.make({ text: response.content }))
      ),
      Effect.asVoid
    )
)

Effect.runFork(program)
```

Run it from a built workspace with:

```sh
pnpm --filter @llm4ts/examples basic -- "Draft a small implementation plan"
```

### Walking through each call

- **`ApiConnectorConfig.make({ connectorId: ConnectorIds.Mock })`** — builds a
  connector configuration. `ConnectorIds.Mock` selects the deterministic,
  credential-free connector from the identity table in
  `@llm4ts/core/Models`; swap it for `ConnectorIds.OpenAi`,
  `ConnectorIds.Anthropic`, and friends once you're ready to hit a real
  provider (see `docs/provider-capabilities.md` for what each one supports).
  This value is a plain, serializable config — no Effect layers to assemble.

- **`runNode(options, body)`** — the Node entry point from
  `@llm4ts/runner/FlowRunner`. It wires every Node-specific boundary (HTTP
  client, child processes, temp files, plan persistence, the connector
  registry) and resolves `options.coder` into a live connector before your
  `body` ever runs. `workDir` and `workspace` scope filesystem and git
  access for the flow; `userPrompt` seeds `context.userPrompt` for any node
  in the flow that wants it. `body` receives a `FlowContextShape` — here
  called `context` — carrying the resolved `coder`, an `events` hub, and the
  other flow dependencies.

- **`context.coder.executeStream(prompt)`** — calls the resolved connector
  directly and returns a stream of response chunks rather than a single
  value. Streaming is the connector's native shape; use it when you want to
  render partial output as it arrives.

- **`collect(...)`** — from `@llm4ts/core/Streaming`, drains that chunk
  stream into a single assembled response (content, usage, finish reason).
  Reach for this whenever you just need the final text, as in this example.

- **`Effect.mapError(FlowLlmError.from)`** — normalizes whatever error shape
  the connector or stream produced into `FlowLlmError`, the flow layer's
  typed failure for LLM calls. Every node in a flow is expected to fail with
  a member of `FlowError`, never a bare `Error`, so callers can pattern-match
  on failures instead of catching exceptions.

- **`Effect.tap((response) => context.events.publish(...))`** — runs a side
  effect on success without changing the value flowing through the pipe.
  `context.events` is the flow's event hub; publishing an `AssistantMessage`
  (from `@llm4ts/flow/FlowEvents`) is how a flow node reports the model's
  reply to anything consuming the flow — terminal rendering, trace
  recording, or your own subscriber.

- **`Effect.asVoid`** — discards the response value so the node's return
  type is `void`; this program cares about the publish side effect, not the
  return value.

- **`Effect.runFork(program)`** — executes the assembled Effect as a
  detached fiber. This is the one place in the file anything actually runs;
  everything above it only describes the program.

### The shorter equivalent: `completeAndPublish`

The `collect` → `mapError` → `tap`/`publish` sequence above is common enough
that `@llm4ts/flow/Flow` exports it as `completeAndPublish(service, events,
prompt)`. Swapping it in collapses the body to one call:

```ts
import * as Effect from "effect/Effect"
import { ApiConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { ConnectorIds } from "@llm4ts/core/Models"
import { completeAndPublish } from "@llm4ts/flow/Flow"
import { runNode } from "@llm4ts/runner/FlowRunner"

const prompt = process.argv.slice(2).join(" ").trim() || "Explain this repository."

const program = runNode(
  {
    workDir: process.cwd(),
    workspace: process.cwd(),
    userPrompt: prompt,
    coder: ApiConnectorConfig.make({
      connectorId: ConnectorIds.Mock
    })
  },
  (context) => completeAndPublish(context.coder, context.events, prompt)
)

Effect.runFork(program)
```

Reach for the explicit `collect`/`mapError`/`tap` form when you need to
inspect the response before publishing, publish a different event, or chain
more work off the result; reach for `completeAndPublish` when a node's whole
job is "ask once, publish the answer."

`examples/api-provider.ts` builds on this same `completeAndPublish` call but
swaps the mock connector for a real one: it resolves the prompt and
workspace via `resolveExampleInput`, picks a real provider connector via
`apiConnectorFromEnvironment`, passes `environment: process.env` to
`runNode` so the connector can read provider credentials, and drives the
whole program through the `runExampleMain` helper (all three from
`examples/support.ts`) instead of a bare `Effect.runFork`. See
`examples/api-provider.ts` and the [examples ladder](../examples/README.md)
for that extension. Rung 2 below climbs in a different direction: from one
prompt-and-response to a persisted, multi-task plan.

## Rung 2: a persisted-plan flow

This is `examples/implement.ts` verbatim. Unlike rung 1, it needs a real
coding-agent CLI (`claude`, `codex`, `gemini`, `pi`, `agy`, `grok`, `cursor`,
or `opencode`) authenticated on your machine, and it writes to Git — it
creates a branch, runs the agent, and commits:

```ts
import { join } from "node:path"
import * as Effect from "effect/Effect"
import { implementPlanFlow } from "@llm4ts/flow/Flow"
import { defaultPlanPath } from "@llm4ts/flow/Plan"
import { planFrom } from "@llm4ts/flow/Planner"
import { makePlanStore } from "@llm4ts/flow/Persistence"
import { coderFromEnv } from "@llm4ts/runner/Connectors"
import { runNode } from "@llm4ts/runner/FlowRunner"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { resolveExampleInput, runExampleMain } from "./support.ts"

const program = Effect.gen(function* () {
  const input = yield* resolveExampleInput(
    "Add a multiply function to the calculator, including focused tests."
  )
  const planPath = join(input.workDir, defaultPlanPath(input.prompt))
  const store = makePlanStore(nodePlainFileStore)

  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder: coderFromEnv(process.env),
      environment: process.env
    },
    (context) =>
      implementPlanFlow(context, {
        store,
        planPath,
        plan: planFrom(context.reasoning, input.prompt),
        system: "Implement one task at a time in the current repository."
      })
  )
})

runExampleMain(program)
```

Run it against a scratch repository with:

```sh
LLM4TS_CODER=codex \
pnpm --filter @llm4ts/examples implement -- \
  --repo /path/to/repository \
  "Add a multiply function with tests"
```

### The new pieces

- **`defaultPlanPath(input.prompt)`** — from `@llm4ts/flow/Plan`, derives a
  deterministic path, `.llm4ts/plan-<hash>.md`, from a stable hash of the
  prompt text. The same prompt always maps to the same file, which is what
  lets a rerun find and resume an in-progress plan instead of starting a
  fresh one.

- **`makePlanStore(nodePlainFileStore)`** — from `@llm4ts/flow/Persistence`,
  wraps a `PlainFileStoreShape` (here, `nodePlainFileStore`, the Node
  filesystem implementation) with plan-specific `save`/`load`/`recoverOrCreate`
  operations. Plans persist as the same Markdown checklist rendered by
  `Plan#render` — human-readable and diffable, not a private binary or JSON
  blob.

- **`coderFromEnv(process.env)`** — from `@llm4ts/runner/Connectors`, reads
  `LLM4TS_CODER` (or the legacy `LLM4ZIO_CODER`) and returns the matching CLI
  connector config (`claude` by default). This is the same `coder` slot rung
  1 filled with `ApiConnectorConfig.make({ connectorId: ConnectorIds.Mock })`
  — here it resolves to a CLI coding agent instead of an HTTP provider.

- **`planFrom(context.reasoning, input.prompt)`** — from
  `@llm4ts/flow/Planner`, is called immediately here, but calling it only
  builds an `Effect` value; nothing runs yet. That `Effect` is passed to
  `implementPlanFlow`, which runs it only if no plan is already on disk.
  `context.reasoning` is a second,
  independent connector resolved by `runNode` alongside `context.coder` —
  the model that drafts the task breakdown need not be the same model (or
  even the same kind of connector) that implements each task.

- **`implementPlanFlow(context, options)`** — from `@llm4ts/flow/Flow`, is
  the spine this whole rung is built on. Everything below describes what it
  does with `store`, `planPath`, `plan`, and `system`.

### Recovering or creating the plan

`implementPlanFlow` starts with `options.store.recoverOrCreate(planPath,
options.plan)`. `recoverOrCreate` tries `load(planPath)` first: if a plan
file already exists there, it parses the Markdown checklist and returns it
as-is — the `plan` effect you passed in (`planFrom(...)`) is never run, so
no reasoning call happens on a resumed run. Only when nothing is stored does
it run `create` (the `planFrom` effect), then `save` the freshly rendered
Markdown to `planPath` before returning it. Combined with the deterministic
path from `defaultPlanPath`, this is what makes reruns of the same prompt
resumable: plan once, then every subsequent invocation against the same
prompt and workspace picks the persisted plan back up.

### The branch, task-loop, and commit cycle

With a plan in hand, `implementPlanFlow` drives three stages:

1. **Branch.** Unless `checkoutBranch` is set to `false`, it calls
   `context.git.checkoutOrCreate(plan.epicId)` — checking out the epic's
   branch if it already exists (a resumed run) or creating it fresh. All
   work for this plan happens on that one branch.
2. **Task loop.** `implementTaskLoop` walks `plan.tasks` in order and skips
   any already marked `completed` — which is exactly how a resumed run
   avoids redoing finished work. For each remaining task it runs, inside a
   `stage(...)` that publishes `StageStarted`/`StageCompleted`/`StageFailed`
   events:
   - `coder.ask(plan.taskPrompt(task))` — a multi-turn `Chat` (from
     `makeChat(context.coder, { system })`) asks the coding agent to
     implement the task, prefixed with the plan's `brief` if one is set.
   - `context.git.diffAll` checks whether the agent actually changed
     anything; a task that produced no diff is logged and skipped rather
     than reviewed or committed (idempotent re-implementation of an
     already-satisfied task is a no-op, not an empty commit).
   - `reviewAndFixLoop` runs the configured reviewers (`minimalReviewers` by
     default) against the diff and has the coder address their feedback,
     iterating up to `maxRounds`. An optional `lint` gate can abort the task
     with `FlowAborted` if it is still failing after review settles, which
     stops the flow before committing broken code.
   - `context.git.commitAll(...)` commits everything with a message from
     `commitMessage` (default: `` `${epicId}: ${task.title}` ``).
     After each task, the loop marks it complete on an in-memory copy of the
     plan and calls `store.save(planPath, current)` — persisting the updated
     checklist immediately, one task at a time, not just at the end.
3. **Return.** The final, fully-completed `Plan` is returned once every task
   has run.

Because completion is written back to `planPath` after every single task,
killing the process mid-run and rerunning the same script picks up on the
next incomplete task: `recoverOrCreate` loads the partially-completed plan,
the branch checkout finds the epic branch already there, and the task loop
skips everything already marked done.

### How this rung builds on rung 1

The spine is unchanged — the same `runNode`/`FlowContextShape` entry point,
the same idea of a `coder` connector resolved before your body runs. Three
things are new:

- **A second connector role.** Rung 1 only ever touched `context.coder`.
  This rung also uses `context.reasoning` — a separate connector for
  drafting the plan, decoupled from whichever agent implements it.
- **Multi-turn, not one-shot.** Rung 1's body was a single
  `executeStream`/`collect` call. Here, `makeChat(context.coder, ...)`
  gives each task a `Chat` that can hold a conversation (system prompt,
  follow-up review feedback) across more than one call, and
  `reviewAndFixLoop` uses exactly that to iterate.
- **State survives the process.** Rung 1 has no persisted state — every run
  starts from nothing and does one thing. This rung's plan file and Git
  branch are exactly what let a long-running, many-task change survive an
  interruption and resume where it left off, at the cost of needing a real
  filesystem, Git repository, and coding-agent CLI instead of the
  credential-free mock connector.

`examples/issue-pr.ts` and `examples/sdd.ts` climb further from here — see
the [examples ladder](../examples/README.md).

## Rung 3: a custom spine from primitives

`implementPlanFlow` covers the common case, but some flows need policy it
deliberately does not model: per-task gate switching, hard invariants like
"the first task must produce a red test", or a different diff source per
review. For those, compose the same primitives the Flow module itself is
built from: `stage`, `implementTaskLoop`, `reviewAndFixLoop`, `lintCommand`,
and `makeChat`. `examples/sdd.ts` is the canonical custom spine — a
specification-driven flow whose first task must encode the spec as failing
tests before any production code is written.

### Per-task gates

Gates are plain `Effect`s produced by `lintCommand`; build as many as you
need and choose between them per task:

<!-- prettier-ignore -->
```ts
const coderChat = yield* makeChat(context.coder, {
  system:
    "Implement one task at a time. The committed specification is the contract; do not weaken its tests."
})
const testGate = lintCommand(
  nodeProcessExecutor,
  context.events,
  ["mvn", "-q", "test"],
  input.workDir
)
const compileGate = lintCommand(
  nodeProcessExecutor,
  context.events,
  ["mvn", "-q", "test-compile"],
  input.workDir
)
const firstTitle = planWithSpec.tasks[0]?.title
```

### The task loop

The loop itself is `implementTaskLoop` with your own per-task body: ask the
coder, review with the gate that fits the task, enforce your invariants,
then let runtime-owned Git commit:

<!-- prettier-ignore -->
```ts
yield* implementTaskLoop(store, context.events, planPath, planWithSpec, (task) =>
  Effect.gen(function* () {
    const testsTask = task.title === firstTitle
    yield* coderChat.ask(planWithSpec.taskPrompt(task))
    yield* reviewAndFixLoop({
      reviewers: minimalReviewers,
      reviewerService: context.reviewers[0] ?? context.reasoning,
      coder: coderChat,
      taskTitle: task.title,
      currentDiff: context.git.diffAll,
      events: context.events,
      lint: testsTask ? compileGate : testGate,
      parallelism: 1
    })
    if (testsTask) {
      const red = yield* testGate
      if (red.isClean) {
        return yield* FlowAborted.make({
          message:
            "the new tests pass before implementation; the specification is not encoded by a red test"
        })
      }
    }
    yield* context.git.commitAll(`${planWithSpec.epicId}: ${task.title}`)
  })
)
```

Details worth copying:

- **`currentDiff: context.git.diffAll`** — reviewers must see untracked new
  files, and plain `git diff` does not show them. Use `diffAll` in review
  loops.
- **Gate switching** (`lint: testsTask ? compileGate : testGate`) — the
  red-test task can only be expected to compile; every later task must pass
  the full test suite.
- **Invariants after review.** The `red.isClean` check runs after the review
  loop settles: bounded review and commit-worthiness are separate judgments.
  `FlowAborted` fails the task rather than committing a violation.
- **The formatter step.** When a gate includes a format check, wire
  `reviewAndFixLoop`'s `format` option to your formatter (best-effort, never
  fails the flow). A headless coding agent can edit files but usually cannot
  run your formatter — deterministic tools should do deterministic work.

## Testing a flow

Flows are functions over `FlowContextShape`, so they test without any LLM,
network, git binary, or filesystem: fake services in, assertions on what the
flow did out. `@llm4ts/flow` ships the persistence fakes
(`makeMemoryPlainFileStore`, `makeMemoryWorkspace`); a fake `GitToolShape`
records branches and commits; a mock `LlmServiceShape` scripts the coder and
reviewer seats. From `packages/flow/test/Flow.test.ts`:

<!-- prettier-ignore -->
```ts
const store = makePlanStore(memory.store)
const plan = Plan.make({
  epicId: "epic-1",
  tasks: [
    Task.make({ title: "first task", description: "do the first thing" }),
    Task.make({ title: "second task", description: "do the second thing" })
  ]
})
const context: FlowContextShape = {
  reasoning: cleanReviewer,
  coder: coderService(asked),
  git: makeFakeGit(gitLog),
  hosting: failingHosting,
  events,
  reviewers: [cleanReviewer],
  coderCapabilities: ConnectorCapabilities.make({}),
  userPrompt: "implement the plan",
  workDir: "/repo",
  workspace: "/repo"
}

const completed = yield* implementPlanFlow(context, {
  store,
  planPath: ".llm4ts/plan.md",
  plan: Effect.succeed(plan)
})
```

Assert on observable behavior: the branches and commit messages the fake git
recorded, the prompts the mock coder received, the persisted plan's completed
flags, and published events. The same file shows the negative cases worth
copying — a red gate must not commit, and an empty diff must skip review.

## Where to go next

- [`examples/README.md`](../examples/README.md) — the runnable ladder these
  rungs came from.
- [`docs/api.md`](api.md) — the full module reference.
- [`docs/provider-capabilities.md`](provider-capabilities.md) — which
  connectors support which features.
