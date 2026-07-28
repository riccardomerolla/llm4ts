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
      Effect.mapError((cause) => FlowLlmError.make({ message: cause.message, cause })),
      Effect.tap((response) =>
        context.events.publish(AssistantMessage.make({ text: response.content }))
      ),
      Effect.asVoid
    )
)

Effect.runFork(program)
