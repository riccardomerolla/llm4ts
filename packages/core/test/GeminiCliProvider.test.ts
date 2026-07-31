import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { CliConnectorConfig, DockerSandbox } from "@llm4ts/core/ConnectorConfig"
import { ConfigError } from "@llm4ts/core/Errors"
import { ConnectorIds, LlmConfig, Message } from "@llm4ts/core/Models"
import {
  GeminiCliError,
  GeminiCliExecutionContext,
  GeminiCliInit,
  GeminiCliMessage,
  GeminiCliResult,
  GeminiCliToolResult,
  GeminiCliToolUse,
  GeminiStreamStats,
  buildGeminiArgs,
  extractGeminiCliResponse,
  geminiCliExecutionContextFrom,
  geminiProcessEnv,
  geminiQuotaDiagnostic,
  geminiSandboxEnvValue,
  geminiTurnLimitSettingsJson,
  isKnownGeminiStderrNoise,
  makeGeminiCliProvider,
  parseGeminiCliStreamEvent,
  parseGeminiStreamStats,
  validateGeminiExitCode,
  validateGeminiStreamExit,
  withGeminiStderrDiagnostic,
  type GeminiCliExecutorShape,
  type GeminiCliStreamEvent
} from "@llm4ts/core/providers/GeminiCliProvider"
import { collect } from "@llm4ts/core/Streaming"

const config = LlmConfig.make({
  provider: "GeminiCli",
  model: "gemini-2.5-flash"
})

const executor = (
  events: ReadonlyArray<GeminiCliStreamEvent>,
  options: {
    readonly installed?: boolean
    readonly complete?: string
  } = {}
): GeminiCliExecutorShape => ({
  checkGeminiInstalled:
    options.installed === false
      ? Effect.fail(
          ConfigError.make({
            message: "gemini-cli not installed"
          })
        )
      : Effect.void,
  runGeminiProcess: (_prompt, _config, _context) =>
    Effect.succeed(options.complete ?? '{"response":"complete"}'),
  runGeminiProcessStream: (_prompt, _config, _context) => Stream.fromIterable(events)
})

describe("Gemini CLI configuration", () => {
  it("projects generic config, builds stdin-oriented argv, and maps sandbox environment", () => {
    const context = geminiCliExecutionContextFrom(
      CliConnectorConfig.make({
        connectorId: ConnectorIds.GeminiCli,
        workingDir: "/repo",
        readOnly: true,
        turnLimit: 7,
        sandbox: DockerSandbox.make({ image: "gemini-sandbox" })
      })
    )
    const args = buildGeminiArgs(
      config,
      GeminiCliExecutionContext.make({
        ...context,
        includeDirectories: ["/a", "/a", "/b"]
      }),
      "stream-json"
    )

    assert.strictEqual(context.cwd, "/repo")
    assert.strictEqual(context.turnLimit, 7)
    assert.isTrue(context.readOnly)
    assert.isFalse(args.includes("-p"))
    assert.deepStrictEqual(args.slice(0, 4), ["-m", "gemini-2.5-flash", "--approval-mode", "plan"])
    assert.strictEqual(args.filter((value) => value === "/a").length, 1)
    assert.isTrue(args.includes("-s"))
    assert.strictEqual(geminiSandboxEnvValue("SeatbeltMacOS"), "sandbox-exec")
    assert.deepStrictEqual(geminiProcessEnv(context, "/tmp/turns.json"), {
      GEMINI_CLI_TRUST_WORKSPACE: "true",
      GEMINI_SANDBOX: "docker",
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: "/tmp/turns.json"
    })
    assert.strictEqual(geminiTurnLimitSettingsJson(48), '{"model":{"maxSessionTurns":48}}')
  })
})

describe("Gemini CLI session stats", () => {
  // The real CLI reports per-model session metrics rather than flat totals;
  // parsing only the flat shape is what left every gemini run reporting
  // "cost: no usage reported" despite the CLI counting tokens.
  const realResult = JSON.stringify({
    type: "result",
    status: "success",
    stats: {
      models: {
        "gemini-2.5-pro": {
          api: { totalRequests: 2, totalErrors: 0, totalLatencyMs: 4200 },
          tokens: {
            input: 900,
            prompt: 1000,
            candidates: 300,
            thoughts: 200,
            tool: 0,
            cached: 100,
            total: 1500
          }
        }
      },
      tools: { totalCalls: 1 },
      files: { totalLinesAdded: 0, totalLinesRemoved: 0 }
    }
  })

  it("decodes per-model token metrics", () => {
    const event = parseGeminiCliStreamEvent(realResult)
    assert.deepStrictEqual(
      event._tag === "Result" ? event.stats : undefined,
      // prompt is the UNCACHED input (the pricing table bills cached
      // separately) and thinking tokens bill as output.
      GeminiStreamStats.make({
        inputTokens: 900,
        outputTokens: 500,
        totalTokens: 1500,
        cached: 100
      })
    )
  })

  it("sums every model a run touched and derives a missing input count", () => {
    assert.deepStrictEqual(
      parseGeminiStreamStats({
        models: {
          "gemini-2.5-pro": { tokens: { prompt: 500, cached: 100, candidates: 40, total: 540 } },
          "gemini-2.5-flash": { tokens: { input: 200, candidates: 10, total: 210 } }
        }
      }),
      GeminiStreamStats.make({
        inputTokens: 600,
        outputTokens: 50,
        totalTokens: 750,
        cached: 100
      })
    )
  })

  it("reports no counts when neither shape carries token metrics", () => {
    assert.isUndefined(parseGeminiStreamStats(undefined))
    assert.deepStrictEqual(
      parseGeminiStreamStats({ tools: { totalCalls: 1 } }),
      GeminiStreamStats.make({})
    )
  })

  it.effect("keeps a countless run free of invented usage", () =>
    Effect.gen(function* () {
      const provider = makeGeminiCliProvider(
        config,
        executor([
          GeminiCliMessage.make({ role: "assistant", content: "done", delta: true }),
          parseGeminiCliStreamEvent('{"type":"result","status":"success","stats":{"tools":{}}}')
        ])
      )
      const response = yield* collect(provider.executeStream("hello"))

      assert.isUndefined(response.usage)
    })
  )

  it.effect("surfaces per-model usage through the streaming provider", () =>
    Effect.gen(function* () {
      const event = parseGeminiCliStreamEvent(realResult)
      const provider = makeGeminiCliProvider(
        config,
        executor([
          GeminiCliInit.make({ model: "gemini-2.5-pro" }),
          GeminiCliMessage.make({ role: "assistant", content: "done", delta: true }),
          event
        ])
      )
      const response = yield* collect(provider.executeStream("hello"))

      assert.strictEqual(response.usage?.prompt, 900)
      assert.strictEqual(response.usage?.completion, 500)
      assert.strictEqual(response.usage?.total, 1500)
      assert.strictEqual(response.usage?.cached, 100)
    })
  )
})

describe("Gemini CLI parsing", () => {
  it("extracts headless envelopes, errors, pretty JSON, and plain fallback text", () => {
    assert.deepStrictEqual(extractGeminiCliResponse('{"response":"final"}'), {
      ok: true,
      value: "final"
    })
    assert.deepStrictEqual(
      extractGeminiCliResponse(
        '{"response":null,"error":{"type":"rate_limit","message":"Quota exceeded","code":429}}'
      ),
      {
        ok: false,
        error: "Gemini CLI returned an error (type=rate_limit, code=429): Quota exceeded"
      }
    )
    assert.deepStrictEqual(
      extractGeminiCliResponse('Loaded cached credentials.\n{\n  "response": "pretty"\n}'),
      { ok: true, value: "pretty" }
    )
    assert.deepStrictEqual(
      extractGeminiCliResponse("Loading extension: tools\n## Analysis\n\nPlain response."),
      { ok: true, value: "## Analysis\n\nPlain response." }
    )
    assert.isFalse(
      extractGeminiCliResponse("Loaded cached credentials.\nLoading extension: tools").ok
    )
  })

  it("decodes real init, message, tool, result, and defensive error shapes", () => {
    const events = [
      parseGeminiCliStreamEvent(
        '{"type":"init","model":"gemini-3-flash-preview","session_id":"s1"}'
      ),
      parseGeminiCliStreamEvent(
        '{"type":"message","role":"assistant","content":"hello","delta":true}'
      ),
      parseGeminiCliStreamEvent(
        '{"type":"tool_use","tool_name":"read_file","tool_id":"t1","parameters":{"file_path":"sample.txt"}}'
      ),
      parseGeminiCliStreamEvent(
        '{"type":"tool_result","tool_id":"t1","status":"success","output":"file body"}'
      ),
      parseGeminiCliStreamEvent(
        '{"type":"result","status":"success","stats":{"total_tokens":15,"input_tokens":10,"output_tokens":5}}'
      )
    ]

    assert.strictEqual(events[0]?._tag, "Init")
    assert.strictEqual(events[1]?._tag, "Message")
    assert.strictEqual(
      events[2]?._tag === "ToolUse" ? events[2].input : undefined,
      '{"file_path":"sample.txt"}'
    )
    assert.strictEqual(
      events[3]?._tag === "ToolResult" ? events[3].content : undefined,
      "file body"
    )
    assert.strictEqual(events[4]?._tag, "Result")
    assert.deepStrictEqual(
      events[4]?._tag === "Result" ? events[4].stats : undefined,
      GeminiStreamStats.make({ totalTokens: 15, inputTokens: 10, outputTokens: 5 }),
      "the flat stats shape this parser shipped with must keep decoding"
    )
    const error = parseGeminiCliStreamEvent('{"type":"error","detail":"unmodelled"}')
    assert.strictEqual(error._tag, "Error")
    assert.strictEqual(
      error._tag === "Error" ? error.message : undefined,
      '{"type":"error","detail":"unmodelled"}'
    )
  })

  it("recognizes stderr noise and preserves quota diagnostics", () => {
    const quota =
      "TerminalQuotaError: You have exhausted your capacity. Your quota will reset after 21h1m53s."
    assert.isTrue(isKnownGeminiStderrNoise("YOLO mode is enabled."))
    assert.isFalse(isKnownGeminiStderrNoise(quota))
    assert.strictEqual(geminiQuotaDiagnostic(["stack", quota]), quota)

    const enriched = withGeminiStderrDiagnostic(
      GeminiCliError.make({
        message: "[API Error: An unknown error occurred.]"
      }),
      [quota]
    )
    assert.strictEqual(enriched._tag, "Error")
    assert.match(enriched._tag === "Error" ? (enriched.message ?? "") : "", /21h1m53s/)
  })
})

describe("GeminiCliProvider", () => {
  const successEvents: ReadonlyArray<GeminiCliStreamEvent> = [
    GeminiCliInit.make({
      model: "gemini-2.5-pro",
      sessionId: "s1"
    }),
    GeminiCliToolUse.make({
      toolName: "read_file",
      toolId: "t1",
      input: '{"path":"/foo"}'
    }),
    GeminiCliToolResult.make({
      toolId: "t1",
      status: "success",
      content: "body"
    }),
    GeminiCliMessage.make({
      role: "assistant",
      content: "Hello world",
      delta: true
    }),
    GeminiCliResult.make({
      status: "success",
      stats: GeminiStreamStats.make({
        totalTokens: 15,
        inputTokens: 10,
        outputTokens: 5
      })
    })
  ]

  it.effect("emits model/session metadata, tools, text, and terminal usage", () =>
    Effect.gen(function* () {
      const provider = makeGeminiCliProvider(config, executor(successEvents))
      const response = yield* collect(provider.executeStream("hello"))
      const chunks = yield* Stream.runCollect(provider.executeStream("hello"))

      assert.strictEqual(response.content, "Hello world")
      assert.strictEqual(response.usage?.total, 15)
      assert.strictEqual(response.metadata.model, "gemini-2.5-pro")
      assert.strictEqual(response.metadata.session_id, "s1")
      assert.strictEqual(chunks[0]?.metadata.event, "tool_use")
      assert.strictEqual(chunks[1]?.metadata.event, "tool_result")
      assert.strictEqual(chunks[2]?.delta, "Hello world")
      assert.strictEqual(chunks[3]?.finishReason, "stop")
    })
  )

  it.effect("collects structured output through the rich stream path", () =>
    Effect.gen(function* () {
      const provider = makeGeminiCliProvider(
        config,
        executor([
          GeminiCliInit.make({ model: "gemini-2.5-pro" }),
          GeminiCliMessage.make({
            role: "assistant",
            content: '{"summary":"streamed"}',
            delta: true
          }),
          GeminiCliResult.make({
            status: "success",
            stats: GeminiStreamStats.make({
              totalTokens: 3,
              inputTokens: 2,
              outputTokens: 1
            })
          })
        ])
      )
      const [value, usage, model] = yield* provider.executeStructuredWithUsage(
        "return it",
        Schema.Struct({ summary: Schema.String }),
        {}
      )

      assert.deepStrictEqual(value, { summary: "streamed" })
      assert.strictEqual(usage?.prompt, 2)
      assert.strictEqual(model, "gemini-2.5-pro")
    })
  )

  it.effect("enriches deterministic empty structured responses", () =>
    Effect.gen(function* () {
      const provider = makeGeminiCliProvider(
        config,
        executor([
          GeminiCliInit.make({ model: "gemini-2.5-pro" }),
          GeminiCliResult.make({
            status: "success",
            stats: GeminiStreamStats.make({
              totalTokens: 90_000,
              inputTokens: 90_000,
              outputTokens: 0
            })
          })
        ])
      )
      const error = yield* Effect.flip(
        provider.executeStructured("judge this", Schema.Struct({ summary: Schema.String }), {})
      )

      assert.match(error.message, /empty response/)
      assert.match(error.message, /model=gemini-2.5-pro/)
      assert.match(error.message, /output_tokens=0/)
    })
  )

  it.effect("formats history and rejects system-only histories", () =>
    Effect.gen(function* () {
      const captured = yield* Ref.make("")
      const provider = makeGeminiCliProvider(config, {
        ...executor([
          GeminiCliMessage.make({
            role: "assistant",
            content: "ok",
            delta: true
          }),
          GeminiCliResult.make({ status: "success" })
        ]),
        runGeminiProcessStream: (prompt) =>
          Stream.concat(
            Stream.fromEffect(Ref.set(captured, prompt)).pipe(Stream.drain),
            Stream.fromIterable([
              GeminiCliMessage.make({
                role: "assistant",
                content: "ok",
                delta: true
              }),
              GeminiCliResult.make({ status: "success" })
            ])
          )
      })

      yield* Stream.runDrain(
        provider.executeStreamWithHistory([
          Message.make({ role: "System", content: "rules" }),
          Message.make({ role: "User", content: "hello" }),
          Message.make({ role: "Assistant", content: "hi" })
        ])
      )
      assert.strictEqual(
        yield* Ref.get(captured),
        "[SYSTEM CONTEXT]\nrules\n---\n\n**User:** hello\n\n**Assistant:** hi"
      )

      const error = yield* Effect.flip(
        Stream.runCollect(
          provider.executeStreamWithHistory([Message.make({ role: "System", content: "only" })])
        )
      )
      assert.strictEqual(error._tag, "InvalidRequestError")
    })
  )

  it.effect("classifies stream errors and special process exit codes", () =>
    Effect.gen(function* () {
      const provider = makeGeminiCliProvider(
        config,
        executor([
          GeminiCliError.make({
            message: "You have exhausted your capacity. Your quota will reset after 21h."
          })
        ])
      )
      const usageError = yield* Effect.flip(Stream.runCollect(provider.executeStream("hello")))
      assert.strictEqual(usageError._tag, "UsageLimitError")

      const invalid = yield* Effect.flip(validateGeminiExitCode(42, "bad input"))
      assert.strictEqual(invalid._tag, "InvalidRequestError")
      const turnLimit = yield* Effect.flip(validateGeminiExitCode(53, "turn cap", 3))
      assert.strictEqual(turnLimit._tag, "TurnLimitError")
      if (turnLimit._tag === "TurnLimitError") {
        assert.strictEqual(turnLimit.limit, 3)
      }

      const stderrQuota = yield* Effect.flip(
        validateGeminiStreamExit(
          0,
          ["You have exhausted your capacity. Your quota will reset after 21h."],
          false
        )
      )
      assert.strictEqual(stderrQuota._tag, "UsageLimitError")
    })
  )

  it.effect("reports health and availability from the executor probe", () =>
    Effect.gen(function* () {
      const available = makeGeminiCliProvider(config, executor([]))
      const unavailable = makeGeminiCliProvider(config, executor([], { installed: false }))

      assert.isTrue(yield* available.isAvailable)
      assert.isFalse(yield* unavailable.isAvailable)
      assert.strictEqual((yield* unavailable.healthCheck).availability, "Unhealthy")
    })
  )
})
