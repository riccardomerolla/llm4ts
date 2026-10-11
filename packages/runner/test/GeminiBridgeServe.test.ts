import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { makeProcessExecutor } from "@llm4ts/core/ProcessExecutor"
import { makeFakeTemporaryFiles } from "@llm4ts/core/TemporaryFiles"
import {
  jsonArray,
  jsonField,
  jsonStringField,
  parseJsonLine
} from "@llm4ts/core/providers/CliSupport"
import { makeGeminiBridgeProgram, piProviderSnippet } from "@llm4ts/runner/GeminiBridgeServe"
import { nodeHttpClient } from "@llm4ts/runner/NodeHttpClient"

const geminiReplying = (reply: string) =>
  makeProcessExecutor({
    run: () => Effect.die("not used"),
    runStreaming: () => Stream.empty,
    runStreamingWithStdin: () =>
      Stream.make(
        JSON.stringify({ type: "message", role: "assistant", content: reply, delta: true }),
        JSON.stringify({ type: "result", status: "success", stats: {} })
      )
  })

describe("llm4ts gemini-bridge (ADR 0037)", () => {
  it.effect("serves the OpenAI route until stopped, and says how to point pi at it", () =>
    Effect.gen(function* () {
      const lines = yield* Ref.make<ReadonlyArray<string>>([])
      const temporary = yield* makeFakeTemporaryFiles()
      const answer = yield* Ref.make("")
      yield* makeGeminiBridgeProgram(
        { port: 0, mode: "model", model: "gemini-3.8-flash" },
        {
          executor: geminiReplying("Hello from flash."),
          temporaryFiles: temporary.temporaryFiles,
          systemPolicies: [],
          log: (line) => Ref.update(lines, (seen) => [...seen, line]),
          // Stands in for Ctrl-C: one request through the running bridge, then stop.
          until: (baseUrl) =>
            Effect.flatMap(
              nodeHttpClient.postJson(
                `${baseUrl}/v1/chat/completions`,
                JSON.stringify({
                  model: "gemini-3.8-flash",
                  messages: [{ role: "user", content: "hi" }]
                }),
                {},
                Duration.seconds(5)
              ),
              (body) => Ref.set(answer, body)
            ).pipe(Effect.orDie)
        }
      )
      const message = jsonField(
        jsonArray(jsonField(parseJsonLine(yield* Ref.get(answer)), "choices"))[0],
        "message"
      )
      assert.strictEqual(jsonStringField(message, "content"), "Hello from flash.")
      const printed = (yield* Ref.get(lines)).join("\n")
      assert.match(printed, /listening on http:\/\/127\.0\.0\.1:\d+\/v1/u)
      assert.include(printed, '"api": "openai-completions"')
      assert.include(printed, "pi --model gemini-bridge/gemini-3.8-flash")
      assert.include(printed, "Ctrl-C")
    })
  )

  it("writes pi's provider entry for the mode and port", () => {
    const openai = piProviderSnippet("model", 8731, "gemini-3.8-flash")
    assert.include(openai, '"baseUrl": "http://127.0.0.1:8731/v1"')
    assert.include(openai, '"api": "openai-completions"')
    const acp = piProviderSnippet("acp", 9000, "gemini-3.8-flash")
    assert.include(acp, '"baseUrl": "http://127.0.0.1:9000"')
    assert.include(acp, '"api": "anthropic-messages"')
  })

  it.effect("refuses model mode where a system admin policy would override the bridge's", () =>
    Effect.gen(function* () {
      const temporary = yield* makeFakeTemporaryFiles()
      const error = yield* Effect.flip(
        makeGeminiBridgeProgram(
          { port: 0, mode: "model" },
          {
            executor: geminiReplying(""),
            temporaryFiles: temporary.temporaryFiles,
            systemPolicies: ["/etc/gemini-cli/policies/bank.toml"],
            log: () => Effect.void,
            until: () => Effect.void
          }
        )
      )
      assert.include(error.message, "/etc/gemini-cli/policies/bank.toml")
    })
  )
})
