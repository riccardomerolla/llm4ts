import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { makeHttpClient, makeRecordingHttpClient } from "@llm4ts/core/HttpClient"
import {
  ProcessResult,
  makeFakeProcessExecutor,
  makeProcessExecutor,
  processCommandKey
} from "@llm4ts/core/ProcessExecutor"

const timeout = Duration.seconds(5)
const noHeaders: Readonly<Record<string, string>> = Object.freeze({})

describe("HttpClient", () => {
  it.effect("derives line and SSE streaming from postJson", () =>
    Effect.gen(function* () {
      const client = makeHttpClient({
        postJson: (_url, _body, _headers, _timeout) =>
          Effect.succeed('data: {"delta":"one"}\r\ndata: \ndata: [DONE]\ndata: {"delta":"two"}')
      })

      const lines = yield* Stream.runCollect(
        client.postJsonStream("/chat", "{}", noHeaders, timeout)
      )
      const sse = yield* Stream.runCollect(
        client.postJsonStreamSSE("/chat", "{}", noHeaders, timeout)
      )

      assert.strictEqual(lines.length, 4)
      assert.deepStrictEqual(sse, ['{"delta":"one"}', '{"delta":"two"}'])
    })
  )

  it.effect("uses typed unsupported defaults for optional operations", () =>
    Effect.gen(function* () {
      const client = makeHttpClient({
        postJson: (_url, _body, _headers, _timeout) => Effect.succeed("{}")
      })

      const getError = yield* Effect.flip(client.get("/health", noHeaders, timeout))
      const sendError = yield* Effect.flip(
        client.send("PATCH", "/item", "{}", noHeaders, "application/json", timeout)
      )

      assert.strictEqual(getError._tag, "InvalidRequestError")
      assert.strictEqual(sendError._tag, "InvalidRequestError")
    })
  )

  it.effect("records complete requests in deterministic fakes", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient((request) =>
        Effect.succeed(`${request.method} ${request.url}`)
      )

      const get = yield* recording.client.get(
        "/health",
        { Authorization: "redacted-test-value" },
        timeout
      )
      const patch = yield* recording.client.send(
        "PATCH",
        "/items/1",
        '[{"op":"replace"}]',
        noHeaders,
        "application/json-patch+json",
        timeout
      )
      const requests = yield* recording.recorded

      assert.strictEqual(get, "GET /health")
      assert.strictEqual(patch, "PATCH /items/1")
      assert.strictEqual(requests.length, 2)
      assert.strictEqual(requests[1]?.contentType, "application/json-patch+json")
      assert.strictEqual(requests[1]?.body, '[{"op":"replace"}]')
    })
  )
})

describe("ProcessExecutor", () => {
  it.effect("returns canned results and preserves non-zero exits as data", () =>
    Effect.gen(function* () {
      const command = ["tool", "--check"]
      const result = ProcessResult.make({
        stdout: ["out"],
        stderr: ["warning"],
        exitCode: 7
      })
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([[processCommandKey(command), result]])
      })

      const actual = yield* fake.executor.run(command, "/repo", {
        TEST_MODE: "true"
      })
      const recorded = yield* fake.recorded

      assert.deepStrictEqual(actual, result)
      assert.strictEqual(actual.exitCode, 7)
      assert.strictEqual(recorded.length, 1)
      assert.deepStrictEqual(recorded[0]?.argv, command)
      assert.strictEqual(recorded[0]?.cwd, "/repo")
    })
  )

  it.effect("fails unknown captured commands but streams unknown commands as empty", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeProcessExecutor()
      const error = yield* Effect.flip(fake.executor.run(["unknown"], "/tmp", noHeaders))
      const lines = yield* Stream.runCollect(
        fake.executor.runStreaming(["unknown"], "/tmp", noHeaders)
      )

      assert.strictEqual(error._tag, "ProviderError")
      assert.deepStrictEqual(lines, [])
    })
  )

  it.effect("streams canned output and records streaming invocations", () =>
    Effect.gen(function* () {
      const command = ["tail", "-f"]
      const fake = yield* makeFakeProcessExecutor({
        streamResponses: new Map([[processCommandKey(command), ["line1", "line2", "line3"]]])
      })

      const lines = yield* Stream.runCollect(fake.executor.runStreaming(command, "/tmp", noHeaders))
      const recorded = yield* fake.recorded

      assert.deepStrictEqual(lines, ["line1", "line2", "line3"])
      assert.isTrue(recorded[0]?.streaming)
    })
  )

  it.effect("stdin variants delegate to the base primitives by default", () =>
    Effect.gen(function* () {
      const executor = makeProcessExecutor({
        run: (_argv, _cwd, _envVars) =>
          Effect.succeed(ProcessResult.make({ stdout: ["captured"], exitCode: 0 })),
        runStreaming: (_argv, _cwd, _envVars) => Stream.make("streamed")
      })

      const captured = yield* executor.runWithStdin(["cat"], "/tmp", noHeaders, "input")
      const streamed = yield* Stream.runCollect(
        executor.runStreamingWithStdin(["cat"], "/tmp", noHeaders, "input")
      )

      assert.deepStrictEqual(captured.stdout, ["captured"])
      assert.deepStrictEqual(streamed, ["streamed"])
    })
  )

  it.effect("reports unsupported bidirectional sessions as typed failures", () =>
    Effect.gen(function* () {
      const executor = makeProcessExecutor({
        run: (_argv, _cwd, _envVars) =>
          Effect.succeed(ProcessResult.make({ stdout: [], exitCode: 0 })),
        runStreaming: (_argv, _cwd, _envVars) => Stream.empty
      })
      const error = yield* Effect.flip(
        Effect.scoped(executor.runBidirectional(["plain-tool"], "/tmp", noHeaders))
      )

      assert.strictEqual(error._tag, "InvalidRequestError")
      assert.match(error.message, /plain-tool/)
    })
  )
})
