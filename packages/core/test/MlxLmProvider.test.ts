import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { makeRecordingHttpClient, type HttpRequest } from "@llm4ts/core/HttpClient"
import { LlmConfig, type JsonSchema } from "@llm4ts/core/Models"
import {
  labelMassFrom,
  makeMlxLmProvider,
  normalizeLabelToken,
  normalizeMlxLmBaseUrl
} from "@llm4ts/core/providers/MlxLmProvider"
import { OpenAIChatCompletionRequest } from "@llm4ts/core/providers/OpenAIModels"
import { collect } from "@llm4ts/core/Streaming"

const config = LlmConfig.make({
  provider: "MlxLm",
  model: "qwen3-4b",
  baseUrl: "http://mlx.test:8080/v1/"
})

const decodeRequest = (request: HttpRequest): Effect.Effect<OpenAIChatCompletionRequest, unknown> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OpenAIChatCompletionRequest))(request.body ?? "")

const completion = (choice: Record<string, unknown>): string =>
  JSON.stringify({
    id: "chatcmpl-1",
    model: "qwen3-4b",
    choices: [{ index: 0, finish_reason: "length", ...choice }],
    usage: { prompt_tokens: 26, completion_tokens: 1, total_tokens: 27 }
  })

const logprobsReply = (top: ReadonlyArray<{ token: string; logprob: number }>): string =>
  completion({
    message: { role: "assistant", content: top[0]?.token ?? "" },
    logprobs: {
      content: [{ token: top[0]?.token ?? "", logprob: top[0]?.logprob ?? 0, top_logprobs: top }]
    }
  })

const streamLine = (content: string): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-1",
    choices: [{ index: 0, delta: { content }, finish_reason: "stop" }]
  })}`

const personSchema = Schema.Struct({ name: Schema.String })
const personJsonSchema: JsonSchema = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"]
}

describe("MlxLmProvider", () => {
  it("normalizes base URLs and label tokens", () => {
    assert.strictEqual(normalizeMlxLmBaseUrl("http://localhost:8080/v1/"), "http://localhost:8080")
    assert.strictEqual(normalizeLabelToken("Ġyes"), "yes")
    assert.strictEqual(normalizeLabelToken(" Yes"), "yes")
    assert.strictEqual(normalizeLabelToken("▁B"), "b")
  })

  it("sums the mass of every spelling of a label and ignores the rest", () => {
    const mass = labelMassFrom(
      ["yes", "no"],
      [
        { token: "yes", logprob: Math.log(0.6) },
        { token: "Yes", logprob: Math.log(0.2) },
        { token: "Ġno", logprob: Math.log(0.1) },
        { token: "maybe", logprob: Math.log(0.1) }
      ]
    )
    assert.closeTo(mass["yes"] ?? 0, 0.8, 1e-9)
    assert.closeTo(mass["no"] ?? 0, 0.1, 1e-9)
    assert.isUndefined(mass["maybe"])
  })

  it.effect("scores labels in one forward pass with the logprobs method", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() =>
        Effect.succeed(
          logprobsReply([
            { token: "B", logprob: Math.log(0.7) },
            { token: "A", logprob: Math.log(0.2) },
            { token: "C", logprob: Math.log(0.05) },
            { token: "Answer", logprob: Math.log(0.05) }
          ])
        )
      )
      const provider = makeMlxLmProvider(config, recording.client)

      const distribution = yield* provider.scoreLabels("which?", ["A", "B", "C"])
      const [request] = yield* recording.recorded

      assert.strictEqual(distribution.method, "logprobs")
      // 0.05 of the mass went to "Answer": support says so.
      assert.closeTo(distribution.support, 0.95, 1e-9)
      assert.closeTo(distribution.probabilities["B"] ?? 0, 0.7 / 0.95, 1e-9)
      assert.closeTo(distribution.probabilities["A"] ?? 0, 0.2 / 0.95, 1e-9)
      assert.strictEqual(distribution.usage?.prompt, 26)
      assert.strictEqual(distribution.model, "qwen3-4b")
      assert.strictEqual(request?.url, "http://mlx.test:8080/v1/chat/completions")
      if (request !== undefined) {
        const body = yield* decodeRequest(request)
        assert.strictEqual(body.max_tokens, 1)
        assert.strictEqual(body.temperature, 0)
        assert.isTrue(body.logprobs)
        assert.strictEqual(body.top_logprobs, 11)
        assert.isFalse(body.stream)
      }
      assert.strictEqual(provider.capabilities.labelProbabilities, "logprobs")
    })
  )

  it.effect("fails typed when no offered label is in the top-k or logprobs are absent", () =>
    Effect.gen(function* () {
      const noLabels = yield* makeRecordingHttpClient(() =>
        Effect.succeed(logprobsReply([{ token: "maybe", logprob: 0 }]))
      )
      const missing = yield* Effect.flip(
        makeMlxLmProvider(config, noLabels.client).scoreLabels("which?", ["A", "B"])
      )
      assert.strictEqual(missing._tag, "ParseError")

      const noLogprobs = yield* makeRecordingHttpClient(() =>
        Effect.succeed(completion({ message: { role: "assistant", content: "A" } }))
      )
      const absent = yield* Effect.flip(
        makeMlxLmProvider(config, noLogprobs.client).scoreLabels("which?", ["A", "B"])
      )
      assert.strictEqual(absent._tag, "ParseError")
      assert.match(absent.message, /no logprobs/)
    })
  )

  it.effect("streams through the OpenAI-compatible endpoint", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(
        () => Effect.succeed("{}"),
        () => Stream.make(streamLine("hello from mlx"))
      )
      const provider = makeMlxLmProvider(config, recording.client)
      const response = yield* collect(provider.executeStream("hi"))
      assert.strictEqual(response.content, "hello from mlx")
      const [request] = yield* recording.recorded
      assert.strictEqual(request?.url, "http://mlx.test:8080/v1/chat/completions")
    })
  )

  it.effect("prompt-coerces structured output and reports usage", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() =>
        Effect.succeed(completion({ message: { role: "assistant", content: '{"name":"Ada"}' } }))
      )
      const provider = makeMlxLmProvider(config, recording.client)
      const [person, usage] = yield* provider.executeStructuredWithUsage(
        "a person",
        personSchema,
        personJsonSchema
      )
      assert.deepStrictEqual(person, { name: "Ada" })
      assert.strictEqual(usage?.total, 27)
      const [request] = yield* recording.recorded
      if (request !== undefined) {
        const body = yield* decodeRequest(request)
        assert.match(body.messages[0]?.content ?? "", /a person/)
        assert.isUndefined(body.response_format)
      }
    })
  )

  it.effect("rejects tools, probes /v1/models, and needs a base URL", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() => Effect.succeed('{"data":[]}'))
      const provider = makeMlxLmProvider(config, recording.client)
      const tools = yield* Effect.flip(provider.executeWithTools("x", []))
      assert.strictEqual(tools._tag, "InvalidRequestError")
      assert.isTrue(yield* provider.isAvailable)
      const [probe] = yield* recording.recorded
      assert.strictEqual(probe?.url, "http://mlx.test:8080/v1/models")

      const unconfigured = makeMlxLmProvider(
        LlmConfig.make({ provider: "MlxLm", model: "m" }),
        recording.client
      )
      assert.isFalse(yield* unconfigured.isAvailable)
      const error = yield* Effect.flip(unconfigured.scoreLabels("p", ["a"]))
      assert.strictEqual(error._tag, "ConfigError")
    })
  )
})
