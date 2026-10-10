import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { makeCliConnector, type CliConnectorShape } from "../Connector.ts"
import type { CliConnectorConfig } from "../ConnectorConfig.ts"
import { InvalidRequestError, ProviderError, type LlmError } from "../Errors.ts"
import { ConnectorCapabilities, ConnectorIds, LlmChunk, TokenUsage } from "../Models.ts"
import type { ProcessExecutorShape } from "../ProcessExecutor.ts"
import {
  atLeastVersion,
  effortWord,
  cumulativeUsage,
  failClassifiedCliError,
  jsonBooleanField,
  jsonField,
  jsonIntField,
  jsonStringField,
  optionalModelArgs,
  parseJsonLine,
  sortedFlagArgs,
  toolEventChunk,
  toolResultChunk,
  toolResultText,
  usageEventChunk,
  versionTriple,
  statusChunk
} from "./CliSupport.ts"

/**
 * The first pi whose `--tools` allowlist can be kept free of MCP tools: from
 * 1.0.4 `--tools read` keeps every MCP tool the user configured in
 * `~/.pi/agent/mcp.json` unless `--no-mcp` (new in that release) drops them,
 * and MCP tools are built in since 0.99.0. Below this a read-only seat can
 * reach any MCP write tool, so llm4ts refuses it (ADR 0010, ADR 0035).
 */
export const piReadOnlyFloor = "1.0.4"

/** Why this pi cannot hold a read-only seat, or nothing when it can. */
export const piReadOnlyProblem = (versionText: string): string | undefined => {
  const version = versionTriple(versionText)
  const floor = versionTriple(piReadOnlyFloor) ?? []
  if (version === undefined) {
    return (
      `could not read the pi version from '${versionText.trim()}'; a read-only seat needs ` +
      `pi >= ${piReadOnlyFloor}, whose --no-mcp keeps MCP tools out of the read allowlist`
    )
  }
  return atLeastVersion(version, floor)
    ? undefined
    : `pi ${version.join(".")} cannot enforce a read-only seat: --tools read keeps MCP tools ` +
        `until --no-mcp arrived in ${piReadOnlyFloor}; upgrade pi, or give the judge and ` +
        "reviewer seats to another harness"
}

/** The provider half of pi's `provider/model[:thinking]` model id. */
const providerOf = (model: string | undefined): string | undefined =>
  model === undefined ? undefined : model.split("/", 1)[0]

export const piExtraArgs = (config: CliConnectorConfig): ReadonlyArray<string> => [
  ...optionalModelArgs(config.model),
  // `noTools` takes precedence over `readOnly`: `--no-tools` disables tool
  // offering entirely (pi's own flag for it), while `--tools read` still
  // offers a read tool the model can invoke — fine for an interactive
  // session, unsafe for a one-shot complete() call with no tool-loop
  // continuation (see the field's doc comment on CliConnectorConfig).
  // `--no-tools` also drops MCP tools; `--tools read` keeps them (pi >= 1.0.4),
  // so a read-only seat adds `--no-mcp` (ADR 0035).
  ...(config.noTools ? ["--no-tools"] : config.readOnly ? ["--tools", "read", "--no-mcp"] : []),
  // `--thinking` is pi's effort flag (off, minimal, low, medium, high, xhigh).
  ...(config.effort === undefined ? [] : ["--thinking", effortWord(config.effort, "xhigh")]),
  // Isolation is partial (ADR 0029): project extensions and skills stay
  // out; pi still reads AGENTS.md from the working directory and its parents.
  // `--no-extensions` also drops the built-in llama.cpp provider (pi >=
  // 0.99.0), so a local model on it is re-enabled by name.
  ...(config.isolated
    ? [
        "--no-extensions",
        "--no-skills",
        ...(providerOf(config.model) === "llama.cpp" ? ["-e", "builtin:llama.cpp"] : [])
      ]
    : []),
  ...sortedFlagArgs(config.flags)
]

export const parsePiStreamLine = (line: string): ReadonlyArray<LlmChunk> => {
  const json = parseJsonLine(line)
  if (json === undefined) {
    return []
  }

  switch (jsonStringField(json, "type")) {
    case "message_update": {
      const event = jsonField(json, "assistantMessageEvent")
      const delta =
        jsonStringField(event, "type") === "text_delta"
          ? jsonStringField(event, "delta")
          : undefined
      return delta === undefined || delta.length === 0 ? [] : [LlmChunk.make({ delta })]
    }
    // A call nested in another (codemode) names its parent (ADR 0033).
    case "tool_execution_start": {
      const parent = jsonStringField(json, "parentToolCallId")
      return [
        toolEventChunk(
          jsonStringField(json, "toolName") ?? "",
          jsonField(json, "args"),
          jsonStringField(json, "toolCallId"),
          parent === undefined ? {} : { parent }
        )
      ]
    }
    case "tool_execution_end": {
      const parent = jsonStringField(json, "parentToolCallId")
      const durationMs = jsonIntField(json, "durationMs")
      return [
        toolResultChunk(jsonStringField(json, "toolCallId"), {
          failed: jsonField(json, "isError") === true,
          ...(parent === undefined ? {} : { parent }),
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(() => {
            const output = toolResultText(jsonField(jsonField(json, "result"), "content"))
            return output === undefined ? {} : { output }
          })()
        })
      ]
    }
    case "message_end":
    case "agent_end": {
      const message = jsonField(json, "message")
      // An aborted turn (a signal, a steer) is not a reply either.
      if (jsonStringField(message, "stopReason") === "aborted") {
        return [LlmChunk.make({ delta: "", metadata: { piError: "pi aborted the turn" } })]
      }
      // pi reports a provider refusal (a usage limit, an auth failure) as an
      // assistant message that stopped with an error and exits 0; without
      // this it reads as an empty, successful reply.
      if (jsonStringField(message, "stopReason") === "error") {
        return [
          LlmChunk.make({
            delta: "",
            metadata: {
              piError: jsonStringField(message, "errorMessage") ?? "pi stopped with an error"
            }
          })
        ]
      }
      const usage = jsonField(message, "usage")
      if (usage === undefined) {
        return []
      }
      const prompt = jsonIntField(usage, "input") ?? 0
      const completion = jsonIntField(usage, "output") ?? 0
      const cached = jsonIntField(usage, "cacheRead")
      return [
        usageEventChunk(
          undefined,
          TokenUsage.make({
            prompt,
            completion,
            total: prompt + completion,
            ...(cached === undefined || cached === 0 ? {} : { cached })
          })
        )
      ]
    }
    // A provider retry and a context compaction pause the turn: the lane
    // says so instead of looking stuck (ADR 0033).
    case "auto_retry_start":
      return [statusChunk("retrying", "start", jsonStringField(json, "errorMessage"))]
    case "auto_retry_end":
      return jsonBooleanField(json, "success") === false
        ? [
            LlmChunk.make({
              delta: "",
              metadata: {
                piError: jsonStringField(json, "finalError") ?? "pi retry failed"
              }
            })
          ]
        : [statusChunk("retrying", "end")]
    case "compaction_start":
      return [statusChunk("compacting", "start")]
    case "compaction_end":
      return [statusChunk("compacting", "end")]
    case "extension_error":
      return [
        LlmChunk.make({
          delta: "",
          metadata: {
            piError: jsonStringField(json, "error") ?? "pi extension error"
          }
        })
      ]
    default:
      return []
  }
}

export const makePiConnector = (
  config: CliConnectorConfig,
  executor: ProcessExecutorShape
): CliConnectorShape => {
  const cwd = config.workingDir ?? "."
  const extraArgs = piExtraArgs(config)

  // A read-only seat is only taken on a pi whose read allowlist can exclude
  // MCP tools (`piReadOnlyFloor`): the version answer decides before the
  // first turn, once per connector; a failed probe is retried on the next.
  let floorChecked = !config.readOnly
  const checkFloorOnce: Effect.Effect<void, LlmError> = Effect.suspend(() =>
    floorChecked
      ? Effect.void
      : Effect.flatMap(executor.run(["pi", "--version"], cwd, config.envVars), (result) => {
          const problem = piReadOnlyProblem([...result.stdout, ...result.stderr].join("\n"))
          return problem === undefined
            ? Effect.sync(() => {
                floorChecked = true
              })
            : Effect.fail(InvalidRequestError.make({ message: problem }))
        })
  )

  const complete = Effect.fn("@llm4ts/core/providers/PiConnector.complete")(function* (
    prompt: string
  ) {
    yield* checkFloorOnce
    const result = yield* executor.runWithStdin(
      ["pi", "-p", ...extraArgs],
      cwd,
      config.envVars,
      prompt
    )
    if (result.exitCode !== 0) {
      // pi explains a refusal on stderr (a usage error, a missing model, an
      // auth failure); stdout is empty then, so both streams are reported.
      const detail = [...result.stdout, ...result.stderr].join("\n").trim()
      if (detail.length === 0) {
        return yield* ProviderError.make({ message: `pi exited with code ${result.exitCode}` })
      }
      // A usage limit is typed, so a roster can take pi out of the round (ADR 0019).
      return yield* failClassifiedCliError("pi", `pi exited with code ${result.exitCode}`, detail)
    }
    return result.stdout.join("\n")
  })

  const completeStream = (prompt: string) =>
    Stream.fromEffect(checkFloorOnce).pipe(
      Stream.drain,
      Stream.concat(
        executor.runStreamingWithStdin(
          ["pi", "-p", "--mode", "json", ...extraArgs],
          cwd,
          config.envVars,
          prompt
        )
      ),
      Stream.flatMap((line) => Stream.fromIterable(parsePiStreamLine(line))),
      // pi reports usage per assistant message; a turn is all of them.
      cumulativeUsage,
      Stream.mapEffect((chunk) => {
        const message = chunk.metadata.piError
        return message === undefined
          ? Effect.succeed(chunk)
          : failClassifiedCliError("pi", "pi error", message)
      })
    )

  return makeCliConnector({
    id: ConnectorIds.Pi,
    interactionSupport: "InteractiveStdin",
    // `--tools read` is pi's documented comma-separated ALLOWLIST of tool
    // names: only `read` is enabled, so bash/edit/write are absent — a real
    // capability removal, the same mechanism class as claude's `--tools`.
    // `--no-mcp` keeps MCP tools out of it, and `checkFloorOnce` refuses a
    // read-only seat on a pi without that flag, so the grade holds.
    capabilities: ConnectorCapabilities.make({
      interactiveSessions: true,
      readOnlyEnforcement: "enforced",
      effort: "mapped",
      isolatedHeadless: "partial"
    }),
    // `--` ends the options (pi >= 0.84.3): a prompt starting with a dash
    // is a prompt, not a flag. Stdin paths need no separator.
    buildArgv: (prompt, _context) => ["pi", "-p", ...extraArgs, "--", prompt],
    buildInteractiveArgv: (_context) => ["pi", ...extraArgs],
    complete,
    completeStream,
    versionProbe: { executor, binary: "pi", cwd }
  })
}
