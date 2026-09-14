# 4. Fork a built-in

The fastest way to a flow that does real work is to copy one that already
does. Any built-in becomes a project flow with one redirect, and the project
tier shadows the built-in of the same name, so pick a new name:

```bash
mkdir -p .llm4ts/flows
llm4ts view implement > .llm4ts/flows/my-implement.ts
```

Edit the first comment line so `llm4ts list` tells the two apart. Here is
the whole file you just copied:

<!-- prettier-ignore -->
```ts
// Persistent plan: plan the task, then implement, review, and commit one task at a time.
import { join } from "node:path"
import * as Effect from "effect/Effect"
import {
  coderFromEnv,
  defaultPlanPath,
  implementPlanFlow,
  makePlanStore,
  nodePlainFileStore,
  planFrom,
  resolveFlowInput,
  runFlowMain,
  runNode
} from "@llm4ts/runner"

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput(
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

runFlowMain(program)
```

## The anatomy, in five parts

1. **Input and plan path.** `resolveFlowInput` as in chapter 3, then
   `defaultPlanPath(prompt)` names `.llm4ts/plan-<hash>.md` so the same task
   text always finds its own plan.
2. **A store.** `makePlanStore(nodePlainFileStore)` reads and writes that
   plan file; swap the file store in tests for an in-memory one.
3. **`runNode`** with `coderFromEnv`, exactly the swap chapter 3 made.
4. **`planFrom(context.reasoning, prompt)`** asks the reasoning seat for a
   task list, but only when no plan exists yet; otherwise the file wins.
5. **`implementPlanFlow(context, options)`** is the loop from chapter 2's
   diagram: branch, then per task implement, review, fix, commit, tick.

## The knobs worth turning first

All of them are fields of the options object passed to `implementPlanFlow`:

| Field            | What it changes                                                                 |
| ---------------- | ------------------------------------------------------------------------------- |
| `system`         | The system prompt every coder turn sees. House rules go here.                   |
| `reviewers`      | The lenses the reviewer applies; each is a name, a system prompt, a file regex. |
| `lint`           | A gate run after every task, as a `ReviewResult` the fix loop acts on.          |
| `format`         | A formatter run before each commit.                                             |
| `maxRounds`      | How many review-and-fix rounds a task gets before the flow fails.               |
| `checkoutBranch` | `false` to commit on the current branch instead of the plan's own.              |
| `chatPerTask`    | `true` gives every task a fresh conversation instead of one shared chat.        |

The `lintCommand` helper in `@llm4ts/flow/Review` turns a shell command into
a `lint` gate, and `flows/sdd.ts` shows `reviewers`, `lint`, and a custom
task loop together. The [flow authoring guide](../flow-authoring.md#rung-2-a-persisted-plan-flow)
explains each option with its defaults.

## Run and compare

```bash
llm4ts list                                  # my-implement  [project]  ...
llm4ts run my-implement "the same task as chapter 2"
```

Because the plan path is a hash of the task text, a forked flow with the
same task text picks up the same plan file. Change the text, or delete the
plan, when you want a fresh start.

Next: [5. Your first pack](05-your-first-pack.md).
