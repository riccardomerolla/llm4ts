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
 */
import * as Effect from "effect/Effect"
import { completeAndPublish } from "@llm4ts/flow/Flow"
import { FlowLlmError } from "@llm4ts/flow/FlowError"
import { pi, prepareConnector } from "@llm4ts/runner/Connectors"
import { resolveFlowInput } from "@llm4ts/runner/FlowArgs"
import { runFlowMain, runNode } from "@llm4ts/runner/FlowRunner"
import { runGeminiAcpBridge } from "@llm4ts/runner/NodeGeminiAcpBridge"
import { nodeProcessExecutor } from "@llm4ts/runner/NodeProcessExecutor"

const defaultPrompt =
  'Read package.json in this repository with your tools and reply with only its "name" field.'

const program = Effect.scoped(
  Effect.gen(function* () {
    const port = Number(process.env.LLM4TS_GEMINI_BRIDGE_PORT ?? "8731")
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
        "pi must already have a provider in ~/.pi/agent/models.json whose baseUrl " +
        `points at it (run \`llm4ts doctor\` with LLM4TS_GEMINI_BRIDGE=1 to check).\n`
    )

    const connector = prepareConnector(pi, input.workDir)

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
