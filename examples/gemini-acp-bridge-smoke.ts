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
 * exists to avoid. `LLM4TS_GEMINI_BRIDGE_MODEL` overrides the default when
 * that entry is keyed differently; the name only routes pi to the bridge
 * (the bridge echoes it back), while `LLM4TS_GEMINI_MODEL` picks the model
 * gemini itself actually reasons with.
 */
import * as Effect from "effect/Effect"
import { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { completeAndPublish } from "@llm4ts/flow/Flow"
import { FlowLlmError } from "@llm4ts/flow/FlowError"
import { pi, prepareConnector } from "@llm4ts/runner/Connectors"
import { resolveFlowInput } from "@llm4ts/runner/FlowArgs"
import { runFlowMain, runNode } from "@llm4ts/runner/FlowRunner"
import { runGeminiAcpBridge } from "@llm4ts/runner/NodeGeminiAcpBridge"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"

const defaultPrompt =
  'Read package.json in this repository with your tools and reply with only its "name" field.'

/** Matches the `models.json` entry documented in docs/configuration.md. */
const defaultBridgeModel = "gemini-bridge/gemini-2.5-pro"

const program = Effect.scoped(
  Effect.gen(function* () {
    const port = Number(process.env.LLM4TS_GEMINI_BRIDGE_PORT ?? "8731")
    const bridgeModel = process.env.LLM4TS_GEMINI_BRIDGE_MODEL ?? defaultBridgeModel
    const input = yield* resolveFlowInput(defaultPrompt)

    const bridge = yield* runGeminiAcpBridge({
      port,
      cwd: input.workDir,
      executor: nodeProcessExecutor,
      ...(process.env.LLM4TS_GEMINI_MODEL === undefined
        ? {}
        : { model: process.env.LLM4TS_GEMINI_MODEL })
    }).pipe(Effect.mapError((error) => FlowLlmError.from(error)))

    process.stderr.write(
      `Gemini ACP bridge listening on ${bridge.baseUrl}\n` +
        `Running pi with --model ${bridgeModel}; that provider must already exist in ` +
        "~/.pi/agent/models.json with a baseUrl pointing at the bridge " +
        "(run `llm4ts doctor` with LLM4TS_GEMINI_BRIDGE=1 to check).\n"
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
