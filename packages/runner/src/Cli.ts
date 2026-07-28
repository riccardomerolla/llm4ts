import { join } from "node:path"
import * as Effect from "effect/Effect"
import { FlowLlmError, type FlowError } from "@llm4ts/flow/FlowError"
import { AssistantMessage } from "@llm4ts/flow/FlowEvents"
import { collect } from "@llm4ts/core/Streaming"
import { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { coderFromEnv } from "./Connectors.ts"
import { parseFlowArgs, readFlowPrompt, resolveFlowRepo, type ScriptUsage } from "./FlowArgs.ts"
import { runNode } from "./FlowRunner.ts"
import { parseVerbosity } from "./Terminal.ts"

export const makeCliProgram = (
  argv: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  workspace = process.cwd(),
  defaultPrompt?: string
): Effect.Effect<void, ScriptUsage | FlowError> => {
  const parsed = parseFlowArgs(argv)
  if (!parsed.ok) {
    return Effect.fail(parsed.error)
  }
  return Effect.gen(function* () {
    const prompt = yield* readFlowPrompt(parsed.value, defaultPrompt)
    const workDir = yield* resolveFlowRepo(parsed.value, workspace)
    const selected = coderFromEnv(environment)
    const coder = CliConnectorConfig.make({
      ...selected,
      workingDir: workDir
    })
    const timestamp = Date.now()
    yield* runNode(
      {
        workDir,
        workspace,
        userPrompt: prompt,
        coder,
        verbosity: parseVerbosity(environment.LLM4TS_VERBOSITY),
        tracePath: join(workDir, ".llm4ts", `trace-${timestamp}.jsonl`),
        runId: timestamp.toString()
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
  })
}
