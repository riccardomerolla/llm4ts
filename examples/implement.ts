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
