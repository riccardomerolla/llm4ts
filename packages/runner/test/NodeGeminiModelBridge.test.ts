import { request as httpRequest } from "node:http"
import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { makeProcessExecutor, type ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import { makeFakeTemporaryFiles } from "@llm4ts/core/TemporaryFiles"
import {
  jsonArray,
  jsonField,
  jsonStringField,
  parseJsonLine,
  type JsonValue
} from "@llm4ts/core/providers/CliSupport"
import { nodeHttpClient } from "@llm4ts/runner/NodeHttpClient"
import { geminiBridgeMode } from "@llm4ts/runner/PiModels"
import { handleChatCompletion, runGeminiModelBridge } from "@llm4ts/runner/NodeGeminiModelBridge"

interface Call {
  readonly argv: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly stdin: string
}

/** Gemini CLI's stream-json for one reply, with the stats this CLI reports. */
const geminiLines = (reply: string): ReadonlyArray<string> => [
  JSON.stringify({ type: "init", model: "gemini-3.8-flash", session_id: "s" }),
  JSON.stringify({ type: "message", role: "assistant", content: reply, delta: true }),
  JSON.stringify({
    type: "result",
    status: "success",
    stats: { input_tokens: 1200, output_tokens: 40, cached: 600, total_tokens: 1840 }
  })
]

/** A fake `gemini` answering each call with the next reply, recording what it was given. */
const fakeGemini = (replies: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Call>>([])
    const executor: ProcessExecutorShape = makeProcessExecutor({
      run: () => Effect.die("not used"),
      runStreaming: () => Stream.empty,
      runStreamingWithStdin: (argv, _cwd, env, stdin) =>
        Stream.unwrap(
          Effect.map(
            Ref.modify(calls, (seen) => [seen.length, [...seen, { argv, env, stdin }]]),
            (index) => Stream.fromIterable(geminiLines(replies[index] ?? "no reply scripted"))
          )
        )
    })
    return { calls, executor }
  })

const streamingRequest = {
  model: "gemini-3.8-flash",
  messages: [
    { role: "system", content: "You are pi." },
    { role: "user", content: "Show me package.json" }
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } }
      }
    }
  ]
}

const request: JsonValue = streamingRequest

/** A POST with headers fetch would not let a caller set (Host), answering its status. */
const rawPost = (
  port: number,
  body: string,
  headers: Readonly<Record<string, string>>
): Effect.Effect<number> =>
  Effect.callback((resume) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers }
      },
      (incoming) => {
        incoming.resume()
        incoming.on("end", () => resume(Effect.succeed(incoming.statusCode ?? 0)))
      }
    )
    outgoing.on("error", () => resume(Effect.succeed(0)))
    outgoing.end(body)
  })

describe("Gemini model bridge (ADR 0037)", () => {
  it.effect("runs one locked-down gemini call: pi's prompt, no tools, no sub-agents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gemini = yield* fakeGemini([
          '<tool_call>{"name": "read", "arguments": {"path": "package.json"}}</tool_call>'
        ])
        const temporary = yield* makeFakeTemporaryFiles("/tmp/bridge-file")
        const outcome = yield* handleChatCompletion(
          { executor: gemini.executor, temporaryFiles: temporary.temporaryFiles, cwd: "/scratch" },
          request
        )
        assert.deepStrictEqual(outcome.reply, {
          _tag: "ToolCall",
          text: "",
          name: "read",
          arguments: { path: "package.json" }
        })
        assert.strictEqual(outcome.usage.prompt_tokens, 1800)
        assert.strictEqual(outcome.usage.prompt_tokens_details.cached_tokens, 600)
        const [call] = yield* Ref.get(gemini.calls)
        assert.deepStrictEqual(call?.argv, [
          "gemini",
          "--model=gemini-3.8-flash",
          "--output-format",
          "stream-json",
          "-e",
          "none",
          "--admin-policy",
          "/tmp/bridge-file"
        ])
        assert.strictEqual(call?.env.GEMINI_SYSTEM_MD, "/tmp/bridge-file")
        assert.strictEqual(call?.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, "/tmp/bridge-file")
        assert.include(call?.stdin ?? "", "[user]\nShow me package.json")
        const written = (yield* temporary.files).map((file) => file.contents).join("\n---\n")
        assert.include(written, "You are pi.")
        assert.include(written, 'toolName = "*"')
        assert.include(written, '"enableAgents":false')
      })
    )
  )

  it.effect("asks once more after a malformed call, then gives up and returns text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixed = yield* fakeGemini([
          '<tool_call>{"name": "glob", "arguments": {}}</tool_call>',
          '<tool_call>{"name": "read", "arguments": {"path": "a.ts"}}</tool_call>'
        ])
        const temporary = yield* makeFakeTemporaryFiles()
        const config = {
          executor: fixed.executor,
          temporaryFiles: temporary.temporaryFiles,
          cwd: "/s"
        }
        const first = yield* handleChatCompletion(config, request)
        assert.strictEqual(first.reply._tag, "ToolCall")
        const calls = yield* Ref.get(fixed.calls)
        assert.strictEqual(calls.length, 2)
        assert.include(calls[1]?.stdin ?? "", "is not one of the available tools")
        // Both calls' tokens are charged.
        assert.strictEqual(first.usage.completion_tokens, 80)

        const stubborn = yield* fakeGemini(["<tool_call>{oops", "<tool_call>{still"])
        const second = yield* handleChatCompletion(
          { ...config, executor: stubborn.executor },
          request
        )
        assert.deepStrictEqual(second.reply._tag, "Malformed")
        assert.strictEqual((yield* Ref.get(stubborn.calls)).length, 2)
      })
    )
  )

  it.effect("refuses to start when a system admin policy would override its own", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gemini = yield* fakeGemini([])
        const temporary = yield* makeFakeTemporaryFiles()
        const error = yield* Effect.flip(
          runGeminiModelBridge({
            port: 0,
            executor: gemini.executor,
            temporaryFiles: temporary.temporaryFiles,
            cwd: "/scratch",
            systemPolicies: ["/etc/gemini-cli/policies/bank.toml"]
          })
        )
        assert.include(error.message, "/etc/gemini-cli/policies/bank.toml")
        assert.include(error.message, "--admin-policy")
      })
    )
  )

  it.effect("serves /v1/chat/completions, streaming as pi asks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gemini = yield* fakeGemini(["All done.", "Done again."])
        const temporary = yield* makeFakeTemporaryFiles()
        const bridge = yield* runGeminiModelBridge({
          port: 0,
          executor: gemini.executor,
          temporaryFiles: temporary.temporaryFiles,
          cwd: "/scratch",
          systemPolicies: []
        })
        const plain = yield* nodeHttpClient.postJson(
          `${bridge.baseUrl}/v1/chat/completions`,
          JSON.stringify(request),
          {},
          Duration.seconds(5)
        )
        const body = parseJsonLine(plain)
        const message = jsonField(jsonArray(jsonField(body, "choices"))[0], "message")
        assert.strictEqual(jsonStringField(message, "content"), "All done.")

        const streamed = yield* nodeHttpClient.postJson(
          `${bridge.baseUrl}/v1/chat/completions`,
          JSON.stringify({ ...streamingRequest, stream: true }),
          {},
          Duration.seconds(5)
        )
        const events = streamed
          .split("\n\n")
          .map((block) => block.replace(/^data: /u, "").trim())
          .filter((data) => data.length > 0)
        assert.strictEqual(events.at(-1), "[DONE]")
        assert.isTrue(events.some((data) => data.includes('"content":"Done again."')))
      })
    )
  )

  it("reads the bridge mode: ACP by default, model on request, anything else refused", () => {
    assert.deepStrictEqual(geminiBridgeMode({}), { _tag: "Mode", mode: "acp" })
    assert.deepStrictEqual(geminiBridgeMode({ LLM4TS_GEMINI_BRIDGE_MODE: " Model " }), {
      _tag: "Mode",
      mode: "model"
    })
    const unknown = geminiBridgeMode({ LLM4TS_GEMINI_BRIDGE_MODE: "openai" })
    assert.strictEqual(unknown._tag, "Unknown")
  })

  it.effect("refuses a model name that could pass Gemini CLI a flag", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gemini = yield* fakeGemini(["hi"])
        const temporary = yield* makeFakeTemporaryFiles()
        const config = {
          executor: gemini.executor,
          temporaryFiles: temporary.temporaryFiles,
          cwd: "/s"
        }
        for (const model of ["--yolo", "-y", "flash --yolo", "a/../b", ""]) {
          const error = yield* Effect.flip(
            handleChatCompletion(config, { ...streamingRequest, model })
          )
          assert.strictEqual(error._tag, "InvalidRequestError", model)
        }
        assert.strictEqual((yield* Ref.get(gemini.calls)).length, 0)
      })
    )
  )

  it.effect("answers only JSON requests without a browser origin", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gemini = yield* fakeGemini(["hi"])
        const temporary = yield* makeFakeTemporaryFiles()
        const bridge = yield* runGeminiModelBridge({
          port: 0,
          executor: gemini.executor,
          temporaryFiles: temporary.temporaryFiles,
          cwd: "/scratch",
          systemPolicies: []
        })
        const url = `${bridge.baseUrl}/v1/chat/completions`
        const body = JSON.stringify(streamingRequest)
        const fromPage = yield* Effect.result(
          nodeHttpClient.postJson(
            url,
            body,
            { Origin: "https://evil.example" },
            Duration.seconds(5)
          )
        )
        assert.strictEqual(fromPage._tag, "Failure")
        const asText = yield* Effect.result(
          nodeHttpClient.send("POST", url, body, {}, "text/plain", Duration.seconds(5))
        )
        assert.strictEqual(asText._tag, "Failure")
        // A rebound DNS name pointing at 127.0.0.1 still names another host.
        const rebound = yield* rawPost(bridge.port, body, { Host: "evil.example" })
        assert.strictEqual(rebound, 403)
        // The same raw request naming the loopback host is served.
        assert.strictEqual(
          yield* rawPost(bridge.port, body, { Host: `127.0.0.1:${bridge.port}` }),
          200
        )
        // Only the loopback request reached Gemini.
        assert.strictEqual((yield* Ref.get(gemini.calls)).length, 1)
      })
    )
  )

  it.effect("asks for the token when one is set", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gemini = yield* fakeGemini(["hi"])
        const temporary = yield* makeFakeTemporaryFiles()
        const bridge = yield* runGeminiModelBridge({
          port: 0,
          executor: gemini.executor,
          temporaryFiles: temporary.temporaryFiles,
          cwd: "/scratch",
          systemPolicies: [],
          token: "s3cret"
        })
        const url = `${bridge.baseUrl}/v1/chat/completions`
        const body = JSON.stringify(streamingRequest)
        const without = yield* Effect.result(
          nodeHttpClient.postJson(url, body, {}, Duration.seconds(5))
        )
        assert.strictEqual(without._tag, "Failure")
        const withToken = yield* Effect.result(
          nodeHttpClient.postJson(
            url,
            body,
            { Authorization: "Bearer s3cret" },
            Duration.seconds(5)
          )
        )
        assert.strictEqual(withToken._tag, "Success")
      })
    )
  )
})
