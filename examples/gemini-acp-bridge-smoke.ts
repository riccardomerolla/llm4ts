/**
 * Live integration smoke test for ADR 0016 (docs/adr/0016-gemini-acp-bridge.md).
 *
 * Not part of `pnpm test`: it needs a real, authenticated `gemini` CLI
 * (`gemini --experimental-acp` must work) and a real `pi` CLI whose
 * `~/.pi/agent/models.json` already has a custom provider pointing at this
 * bridge's port (see docs/configuration.md — llm4ts never writes that file
 * for you; `llm4ts doctor` only reports whether it's already pointed here).
 * Run it on the machine (or remote server) that has both installed:
 *
 *   pnpm build
 *   LLM4TS_GEMINI_BRIDGE_PORT=8731 \
 *     pnpm --filter @llm4ts/examples gemini-acp-bridge-smoke
 *
 * It starts the bridge, then runs `pi` as llm4ts's own `pi` coder connector
 * (the real end-to-end path: llm4ts -> pi -> the bridge -> gemini's OAuth
 * session) with a prompt that requires pi to actually call a tool, so a
 * clean exit proves the whole chain — not just that the bridge answers a
 * synthetic HTTP request.
 *
 * `pi` selects a provider per invocation with `--model <provider>/<model>`,
 * so the run must name the bridge-backed entry from `models.json`
 * explicitly: without it pi uses its own default model and fails with "No
 * API key found for selected model", which is the one thing this bridge
 * exists to avoid. Which entry that is depends on how the user keyed their
 * own config, so this script reads it rather than assuming a name — a
 * guessed default just trades that failure for "Model not found".
 * `LLM4TS_GEMINI_BRIDGE_MODEL` names it outright when the config offers
 * more than one. The value only routes pi (the bridge echoes it back);
 * `LLM4TS_GEMINI_MODEL` picks the model gemini itself reasons with.
 */
import * as Effect from "effect/Effect"
import { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { completeAndPublish } from "@llm4ts/flow/Flow"
import { FlowLlmError } from "@llm4ts/flow/FlowError"
import { pi, prepareConnector } from "@llm4ts/runner/Connectors"
import {
  bridgeModelProblem,
  defaultReadPiModelsJson,
  geminiBridgePort,
  piModelsConfig,
  resolveBridgeModel,
  type BridgeModelResolution
} from "@llm4ts/runner/Doctor"
import { ScriptUsage, resolveFlowInput } from "@llm4ts/runner/FlowArgs"
import { runFlowMain, runNode } from "@llm4ts/runner/FlowRunner"
import { runGeminiAcpBridge } from "@llm4ts/runner/NodeGeminiAcpBridge"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"

const defaultPrompt =
  'Read package.json in this repository with your tools and reply with only its "name" field.'

/**
 * Resolution is shared with the flow runner (`LLM4TS_GEMINI_BRIDGE`), so this
 * script and a real `llm4ts run` choose — and refuse — the same way.
 */
const resolveModel = (
  candidates: BridgeModelResolution,
  port: string
): Effect.Effect<string, ScriptUsage> => {
  const problem = bridgeModelProblem(candidates, port)
  return problem === undefined && candidates._tag === "Resolved"
    ? Effect.succeed(candidates.model)
    : Effect.fail(ScriptUsage.make({ message: problem ?? "no bridge model available" }))
}

const program = Effect.scoped(
  Effect.gen(function* () {
    const port = geminiBridgePort(process.env)
    const modelsJson = defaultReadPiModelsJson()
    const { refs, problems } = piModelsConfig(modelsJson, port)
    const bridgeable = refs.filter((entry) => entry.bridged && entry.authConfigured)
    process.stderr.write(
      problems.length > 0
        ? `~/.pi/agent/models.json fails pi's schema, so pi loads none of it:\n` +
            `${problems.map((problem) => `  ${problem}`).join("\n")}\n`
        : bridgeable.length === 0
          ? `No usable bridge model in ~/.pi/agent/models.json for port ${port}.\n`
          : `Bridge models available on port ${port}:\n` +
            `${bridgeable.map((entry) => `  ${entry.ref}`).join("\n")}\n`
    )
    const bridgeModel = yield* resolveModel(
      resolveBridgeModel(modelsJson, port, process.env.LLM4TS_GEMINI_BRIDGE_MODEL),
      port
    )
    const input = yield* resolveFlowInput(defaultPrompt)

    const bridge = yield* runGeminiAcpBridge({
      port: Number(port),
      cwd: input.workDir,
      executor: nodeProcessExecutor,
      ...(process.env.LLM4TS_GEMINI_MODEL === undefined
        ? {}
        : { model: process.env.LLM4TS_GEMINI_MODEL })
    }).pipe(Effect.mapError((error) => FlowLlmError.from(error)))

    process.stderr.write(
      `Gemini ACP bridge listening on ${bridge.baseUrl}\n` +
        `Running pi with --model ${bridgeModel}\n`
    )

    const connector = prepareConnector(
      CliConnectorConfig.make({ ...pi, model: bridgeModel }),
      input.workDir
    )

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

    process.stderr.write("\nsmoke test passed: pi completed a turn via the gemini ACP bridge\n")
  })
)

runFlowMain(program)
