import * as Effect from "effect/Effect"
import { completeAndPublish } from "@llm4ts/flow/Flow"
import { apiConnectorFromEnvironment } from "@llm4ts/runner/Connectors"
import { resolveFlowInput } from "@llm4ts/runner/FlowArgs"
import { runFlowMain, runNode } from "@llm4ts/runner/FlowRunner"

const program = Effect.gen(function* () {
  const input = yield* resolveFlowInput("Explain the architecture of this repository.")
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

runFlowMain(program)
