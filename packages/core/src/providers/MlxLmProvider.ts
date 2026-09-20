import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { makeApiConnector, type ApiConnectorShape } from "../Connector.ts"
import { ConfigError, InvalidRequestError, ParseError, type LlmError } from "../Errors.ts"
import type { HttpClientShape } from "../HttpClient.ts"
import { normalizeLabelProbabilities } from "../LabelScoring.ts"
import type { LabelSequence, StructuredResult } from "../LlmService.ts"
import * as Result from "effect/Result"
import {
  ConnectorCapabilities,
  ConnectorIds,
  LabelDistribution,
  LlmChunk,
  TokenUsage,
  type JsonSchema,
  type LlmConfig
} from "../Models.ts"
import { parseFromText, withSchemaHint } from "../StructuredOutput.ts"
import {
  OpenAIChatChunk,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  OpenAIChatMessage,
  type OpenAITokenLogprob,
  type OpenAITopLogprob
} from "./OpenAIModels.ts"
import { openAIHistoryMessages } from "./OpenAIProvider.ts"

/**
 * `mlx-lm` (`python -m mlx_lm.server`): an OpenAI-compatible local server on
 * Apple Silicon that returns token log-probabilities. That makes it the
 * reference backend for label scoring (ADR 0017): one forward pass, one
 * output token, the distribution read off the labels. Streaming reuses the
 * OpenAI wire format; structured output is prompt-coerced because the
 * server has no grammar mode; tool calling is unsupported.
 *
 * Verified against mlx-lm 0.31.3 on 2026-09-19: `top_logprobs` is capped
 * at 11 and entries carry the token text, so labels match on text.
 */

const emptyHeaders: Readonly<Record<string, string>> = Object.freeze({})

/** The server's hard cap on `top_logprobs`. */
export const mlxLmTopLogprobs = 11

export const normalizeMlxLmBaseUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, "")
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -"/v1".length) : trimmed
}

/**
 * Byte-level BPE vocabularies spell a leading space as `Ġ` (GPT/Qwen) or
 * `▁` (SentencePiece); a label token may also carry real whitespace or a
 * different case. All of those are the same label.
 */
export const normalizeLabelToken = (token: string): string =>
  token
    .replace(/^[Ġ▁]+/, "")
    .trim()
    .toLowerCase()

/** Sum the probability mass of every top-k entry that spells one of the labels. */
export const labelMassFrom = (
  labels: ReadonlyArray<string>,
  top: ReadonlyArray<OpenAITopLogprob>
): Record<string, number> => {
  const byNormalized = new Map(labels.map((label) => [normalizeLabelToken(label), label]))
  const mass: Record<string, number> = {}
  for (const entry of top) {
    const label = byNormalized.get(normalizeLabelToken(entry.token))
    if (label !== undefined) {
      mass[label] = (mass[label] ?? 0) + Math.exp(entry.logprob)
    }
  }
  return mass
}

const decodeCompletion = (raw: string): Effect.Effect<OpenAIChatCompletionResponse, ParseError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OpenAIChatCompletionResponse))(raw).pipe(
    Effect.mapError((error) =>
      ParseError.make({
        message: `Failed to decode mlx-lm chat completion: ${String(error)}`,
        raw
      })
    )
  )

const decodeStreamChunk = (raw: string): Effect.Effect<OpenAIChatChunk, ParseError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(OpenAIChatChunk))(raw).pipe(
    Effect.mapError((error) =>
      ParseError.make({
        message: `Failed to parse mlx-lm stream chunk: ${String(error)}`,
        raw
      })
    )
  )

const usageOf = (response: OpenAIChatCompletionResponse): TokenUsage | undefined =>
  response.usage === undefined
    ? undefined
    : TokenUsage.make({
        prompt: response.usage.prompt_tokens ?? 0,
        completion: response.usage.completion_tokens ?? 0,
        total:
          response.usage.total_tokens ??
          (response.usage.prompt_tokens ?? 0) + (response.usage.completion_tokens ?? 0)
      })

/**
 * Read a shared-prefix reply, one `<n>: <label>` line per question, from
 * the generated tokens. The text is rebuilt token by token; whenever it
 * ends in a `<n>:` marker for the next expected question, the first
 * following token that spells one of that question's labels is that
 * question's answer position and its top-k is the distribution. A question
 * whose marker or label never appears fails on its own.
 */
export const labelSequenceFrom = (
  labelSets: ReadonlyArray<ReadonlyArray<string>>,
  tokens: ReadonlyArray<OpenAITokenLogprob>
): ReadonlyArray<Result.Result<LabelDistribution, ParseError>> => {
  const found: Array<LabelDistribution | undefined> = labelSets.map(() => undefined)
  let buffer = ""
  let expecting = 0
  let awaitingLabel = false
  for (const token of tokens) {
    const text = token.token.replace(/[Ġ▁]/g, " ")
    if (awaitingLabel) {
      const labels = labelSets[expecting] ?? []
      const normalized = normalizeLabelToken(token.token)
      if (normalized.length === 0) {
        continue
      }
      if (labels.some((label) => normalizeLabelToken(label) === normalized)) {
        const top = token.top_logprobs ?? [{ token: token.token, logprob: token.logprob }]
        const mass = labelMassFrom(labels, top)
        const total = Object.values(mass).reduce((sum, value) => sum + value, 0)
        if (total > 0) {
          found[expecting] = LabelDistribution.make({
            probabilities: Object.fromEntries(
              Object.entries(mass).map(([label, value]) => [label, value / total])
            ),
            method: "logprobs",
            support: Math.min(1, total)
          })
        }
        expecting += 1
        awaitingLabel = false
        buffer = ""
        continue
      }
      // Anything else before the label: keep scanning, but a new marker
      // means the answer for the previous question was skipped.
    }
    buffer += text
    const marker = /(\d+)\s*[:.)]\s*$/.exec(buffer)
    if (marker !== null) {
      const number = Number.parseInt(marker[1] ?? "", 10) - 1
      if (number >= expecting && number < labelSets.length) {
        expecting = number
        awaitingLabel = true
        buffer = ""
      }
    }
  }
  return labelSets.map((_, index) => {
    const distribution = found[index]
    return distribution === undefined
      ? Result.fail(
          ParseError.make({
            message: `question ${index + 1} of ${labelSets.length}: no label read in the batched reply`,
            raw: tokens
              .map((token) => token.token)
              .join("")
              .slice(0, 200)
          })
        )
      : Result.succeed(distribution)
  })
}

export const mlxLmCapabilities = (): ConnectorCapabilities =>
  ConnectorCapabilities.make({
    readOnlyEnforcement: "enforced",
    labelProbabilities: "logprobs"
  })

export const makeMlxLmProvider = (
  config: LlmConfig,
  httpClient: HttpClientShape
): ApiConnectorShape => {
  const baseUrl: Effect.Effect<string, ConfigError> =
    config.baseUrl === undefined
      ? Effect.fail(ConfigError.make({ message: "Missing baseUrl for mlx-lm provider" }))
      : Effect.succeed(normalizeMlxLmBaseUrl(config.baseUrl))

  const complete = (
    request: OpenAIChatCompletionRequest
  ): Effect.Effect<OpenAIChatCompletionResponse, LlmError> =>
    Effect.gen(function* () {
      const normalized = yield* baseUrl
      const raw = yield* httpClient.postJson(
        `${normalized}/v1/chat/completions`,
        JSON.stringify(request),
        emptyHeaders,
        config.timeout
      )
      return yield* decodeCompletion(raw)
    })

  const streamRequest = (
    messages: ReadonlyArray<OpenAIChatMessage>
  ): Stream.Stream<LlmChunk, LlmError> =>
    Stream.unwrap(
      Effect.map(baseUrl, (normalized) => {
        const request = OpenAIChatCompletionRequest.make({
          model: config.model,
          messages,
          temperature: config.temperature ?? 0.7,
          stream: true,
          ...(config.maxTokens === undefined ? {} : { max_tokens: config.maxTokens })
        })
        return httpClient
          .postJsonStreamSSE(
            `${normalized}/v1/chat/completions`,
            JSON.stringify(request),
            emptyHeaders,
            config.timeout
          )
          .pipe(
            Stream.mapEffect(decodeStreamChunk),
            Stream.flatMap((chunk) => {
              const choice = chunk.choices[0]
              const delta = choice?.delta?.content ?? ""
              const finishReason = choice?.finish_reason ?? undefined
              return delta.length > 0 || finishReason !== undefined
                ? Stream.succeed(
                    LlmChunk.make({
                      delta,
                      metadata: { provider: "mlx-lm", model: config.model },
                      ...(finishReason === undefined ? {} : { finishReason })
                    })
                  )
                : Stream.empty
            })
          )
      })
    )

  const executeStructuredWithUsage = <A, E, RD, RE>(
    prompt: string,
    schema: Schema.ConstraintCodec<A, E, RD, RE>,
    jsonSchema: JsonSchema
  ): Effect.Effect<StructuredResult<A>, LlmError, RD> =>
    Effect.gen(function* () {
      const response = yield* complete(
        OpenAIChatCompletionRequest.make({
          model: config.model,
          messages: [
            OpenAIChatMessage.make({ role: "user", content: withSchemaHint(prompt, jsonSchema) })
          ],
          temperature: config.temperature ?? 0.7,
          stream: false,
          ...(config.maxTokens === undefined ? {} : { max_tokens: config.maxTokens })
        })
      )
      const content = response.choices[0]?.message?.content?.trim() ?? ""
      const value = yield* parseFromText(content, schema, jsonSchema)
      const result: StructuredResult<A> = [value, usageOf(response), response.model]
      return result
    })

  /** One forward pass: the first generated position's top-k over the labels. */
  const scoreLabels = (
    prompt: string,
    labels: ReadonlyArray<string>
  ): Effect.Effect<LabelDistribution, LlmError> =>
    Effect.gen(function* () {
      const response = yield* complete(
        OpenAIChatCompletionRequest.make({
          model: config.model,
          messages: [OpenAIChatMessage.make({ role: "user", content: prompt })],
          temperature: 0,
          max_tokens: 1,
          stream: false,
          logprobs: true,
          top_logprobs: mlxLmTopLogprobs
        })
      )
      const top = response.choices[0]?.logprobs?.content?.[0]?.top_logprobs
      if (top === undefined) {
        return yield* ParseError.make({
          message: "mlx-lm returned no logprobs; is the server started with a text model?",
          raw: JSON.stringify(response.choices[0]?.message?.content ?? "")
        })
      }
      const usage = usageOf(response)
      return yield* normalizeLabelProbabilities(labels, labelMassFrom(labels, top), "logprobs", {
        ...(usage === undefined ? {} : { usage }),
        ...(response.model === undefined ? {} : { model: response.model })
      })
    })

  /** One call for several questions: enough tokens for one short line each, every position read. */
  const scoreLabelSequence = (
    prompt: string,
    labelSets: ReadonlyArray<ReadonlyArray<string>>
  ): Effect.Effect<LabelSequence, LlmError> =>
    Effect.gen(function* () {
      const response = yield* complete(
        OpenAIChatCompletionRequest.make({
          model: config.model,
          messages: [OpenAIChatMessage.make({ role: "user", content: prompt })],
          temperature: 0,
          max_tokens: labelSets.length * 8 + 4,
          stream: false,
          logprobs: true,
          top_logprobs: mlxLmTopLogprobs
        })
      )
      const tokens = response.choices[0]?.logprobs?.content
      if (tokens === undefined || tokens === null) {
        return yield* ParseError.make({
          message: "mlx-lm returned no logprobs; is the server started with a text model?",
          raw: JSON.stringify(response.choices[0]?.message?.content ?? "")
        })
      }
      const usage = usageOf(response)
      const sequence: LabelSequence = {
        entries: labelSequenceFrom(labelSets, tokens),
        ...(usage === undefined ? {} : { usage }),
        ...(response.model === undefined ? {} : { model: response.model })
      }
      return sequence
    })

  const isAvailable: Effect.Effect<boolean> =
    config.baseUrl === undefined
      ? Effect.succeed(false)
      : httpClient
          .get(`${normalizeMlxLmBaseUrl(config.baseUrl)}/v1/models`, emptyHeaders, config.timeout)
          .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }))

  return makeApiConnector({
    id: ConnectorIds.MlxLm,
    executeStream: (prompt) =>
      streamRequest([OpenAIChatMessage.make({ role: "user", content: prompt })]),
    executeStreamWithHistory: (messages) => streamRequest(openAIHistoryMessages(messages)),
    executeWithTools: () =>
      Effect.fail(InvalidRequestError.make({ message: "mlx-lm does not support tool calling" })),
    executeStructuredWithUsage,
    scoreLabels,
    scoreLabelSequence,
    isAvailable,
    capabilities: mlxLmCapabilities()
  })
}
