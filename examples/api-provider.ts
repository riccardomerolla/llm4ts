import * as Effect from "effect/Effect"
import { runNode } from "@llm4ts/runner/FlowRunner"
import {
  apiConnectorFromEnvironment,
  completeAndPublish,
  resolveExampleInput,
  runExampleMain
} from "./support.ts"

const program = Effect.gen(function* () {
  const input = yield* resolveExampleInput("Explain the architecture of this repository.")
  const connector = yield* apiConnectorFromEnvironment()
  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder: connector,
      environment: process.env
    },
    (context) => completeAndPublish(context.coder, context.events, input.prompt)
  )
})

runExampleMain(program)
