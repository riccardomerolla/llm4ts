import { join } from "node:path"
import * as Effect from "effect/Effect"
import { makeChat } from "@llm4ts/flow/Chat"
import { defaultPlanPath } from "@llm4ts/flow/Plan"
import { implementTaskLoop, stage } from "@llm4ts/flow/PlanExecution"
import { planFrom } from "@llm4ts/flow/Planner"
import { makePlanStore } from "@llm4ts/flow/Persistence"
import { minimalReviewers, reviewAndFixLoop } from "@llm4ts/flow/Review"
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
      Effect.gen(function* () {
        const plan = yield* store.recoverOrCreate(
          planPath,
          planFrom(context.reasoning, input.prompt)
        )
        yield* stage(context.events, "branch", context.git.checkoutOrCreate(plan.epicId))
        const coder = yield* makeChat(context.coder, {
          system: "Implement one task at a time in the current repository."
        })
        yield* implementTaskLoop(store, context.events, planPath, plan, (task) =>
          Effect.gen(function* () {
            yield* coder.ask(plan.taskPrompt(task))
            yield* reviewAndFixLoop({
              reviewers: minimalReviewers,
              reviewerService: context.reviewers[0] ?? context.reasoning,
              coder,
              taskTitle: task.title,
              currentDiff: context.git.diff,
              events: context.events
            })
            yield* context.git.commitAll(`${plan.epicId}: ${task.title}`)
          })
        )
      })
  )
})

runExampleMain(program)
