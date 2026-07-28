import * as Effect from "effect/Effect"
import { AssistantMessage, Info } from "@llm4ts/flow/FlowEvents"
import { lmStudio, pi, withModel, withTimeoutSeconds } from "@llm4ts/runner/Connectors"
import { runNode } from "@llm4ts/runner/FlowRunner"
import { completeAndPublish, resolveExampleInput, runExampleMain } from "./support.ts"

const reasoningModel = process.env.LLM4TS_REASONING_MODEL ?? "qwen/qwen3-coder-30b"
const coderModel = process.env.LLM4TS_CODER_MODEL ?? reasoningModel

const program = Effect.gen(function* () {
  const input = yield* resolveExampleInput(
    "Add a multiply function to the calculator, including focused tests."
  )
  yield* runNode(
    {
      workDir: input.workDir,
      workspace: input.workspace,
      userPrompt: input.prompt,
      coder: withModel(pi, coderModel),
      reasoning: withTimeoutSeconds(withModel(lmStudio, reasoningModel), 600),
      environment: process.env
    },
    (context) =>
      Effect.gen(function* () {
        yield* context.events.publish(Info.make({ message: "local reasoner: preparing plan" }))
        const plan = yield* completeAndPublish(
          context.reasoning,
          context.events,
          [
            "Read the request and propose a concise, repository-aware implementation plan.",
            "Call out the exact files and tests the coding agent should inspect.",
            "",
            input.prompt
          ].join("\n")
        )
        yield* context.events.publish(
          AssistantMessage.make({ text: "Handing the local plan to pi." })
        )
        yield* completeAndPublish(
          context.coder,
          context.events,
          [
            "Implement the request in the current repository.",
            "Use this plan as guidance, but verify it against the actual code. Run relevant tests and summarize the result.",
            "",
            "Request:",
            input.prompt,
            "",
            "Plan:",
            plan
          ].join("\n")
        )
      })
  )
})

runExampleMain(program)
