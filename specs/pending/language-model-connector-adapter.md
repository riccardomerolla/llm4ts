# `effect/ai` LanguageModel as a connector backend

Let any `effect/ai` `LanguageModel` (and therefore any `@effect/ai-*`
provider package) become an llm4ts API connector through one adapter,
`fromLanguageModel`, that produces `ApiConnectorPrimitives` for
`makeApiConnector`. The parity surface (`LlmService`) does not move; the
judgment layer keeps its optional log-probability path. Assessment of
2026-10-12 against `node_modules/effect/src/ai/LanguageModel.ts` at the
pinned `effect` 4.0.0; no ADR, parity note only.

Driver: every API provider in `packages/core/src/providers/` is hand-rolled
HTTP (`AnthropicProvider.ts`, `OpenAIProvider.ts`, `GeminiApiProvider.ts`,
`LmStudioProvider.ts`, `OllamaProvider.ts`, `MlxLmProvider.ts`). `effect/ai`
ships inside the `effect` package llm4ts already pins, with Anthropic,
OpenAI, OpenAI-compatible and OpenRouter adapters as separate packages. An
adapter buys OpenRouter and future providers with no new request code, and
a second implementation of Anthropic and OpenAI to compare against.

## Decisions

| Decision     | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seam         | `fromLanguageModel(id, options)` in `packages/core/src/Connector.ts` returns `ApiConnectorPrimitives`; callers pass it to `makeApiConnector`. No second connector shape.                                                                                                                                                                                                                                                                       |
| Input        | A `LanguageModel` service value (`effect/ai/LanguageModel`), obtained by the caller from a provider layer; core never imports a provider package.                                                                                                                                                                                                                                                                                              |
| Stream       | `executeStream(prompt)` maps `streamText` parts to `LlmChunk`: `text-delta` to `delta`; `finish` to `finishReason` plus `usage` (`Response.Usage` to `TokenUsage`, `cached` from the provider's cached-input count when present); `reasoning-delta` to a chunk with `metadata.kind = reasoning`; tool parts to `metadata.kind = tool_use`, as `CliSupport.ts` already does for CLIs.                                                           |
| History      | `executeStreamWithHistory(messages)` builds a `Prompt` from `Message` roles (`System`, `User`, `Assistant`); a `Tool` role, if ever present, is flattened through `flattenHistory`.                                                                                                                                                                                                                                                            |
| Tools        | `executeWithTools(prompt, tools)` builds a dynamic `Toolkit` from `ToolDefinition` (name, description, JSON schema), calls `generateText` with `toolChoice: "auto"`, returns `ToolCallResponse` without executing anything (llm4ts executes tools itself, through `CapabilityGuard`).                                                                                                                                                          |
| Structured   | `executeStructuredWithUsage(prompt, schema, jsonSchema)` calls `generateObject` with the llm4ts codec; the `jsonSchema` argument is ignored because `effect/ai` derives its own through `codecTransformer`; a provider that rejects the derived schema fails as `InvalidRequestError`.                                                                                                                                                         |
| Labels       | No native `scoreLabels`: `makeApiConnector` supplies the verbalized path from `LabelScoring.ts`; capabilities report `labelProbabilities: "verbalized"`.                                                                                                                                                                                                                                                                                       |
| Errors       | `AiError` to `LlmError` by tag: `RateLimitError` to `RateLimitError` (retry-after carried), `QuotaExhaustedError` to `UsageLimitError`, `AuthenticationError` to `AuthenticationError`, `InvalidRequestError`/`UnsupportedSchemaError`/`ContentPolicyError` to `InvalidRequestError`, `StructuredOutputError`/`InvalidOutputError` to `ParseError`, the rest to `ProviderError`. Messages pass through `Redaction` before they reach an error. |
| Availability | `isAvailable` is a caller-supplied effect (default `Effect.succeed(true)`); `healthCheck` stays `timedHealthCheck` over it.                                                                                                                                                                                                                                                                                                                    |
| Identity     | New rows in the `ConnectorIds` table in `Models.ts` only for providers the runner presets (`OpenRouter` first); a flow script may wrap any model under an existing id.                                                                                                                                                                                                                                                                         |
| Telemetry    | The adapter does not install `effect/ai` span transformers; llm4ts's own OTLP export (ADR 0026) keeps emitting the GenAI attributes at the chat seam. Duplicated spans are a later measurement.                                                                                                                                                                                                                                                |
| Runner       | `@effect/ai-openrouter` and `@effect/ai-openai-compat` as optional peer dependencies of `@llm4ts/runner`, pinned exactly; `apiPresetFor("openrouter")` builds the layer when the package resolves and fails with `ConfigError` naming the package when it does not. Core gains no dependency.                                                                                                                                                  |
| Stability    | `effect/ai` is marked unstable inside a stable package. The adapter's tests run against `LanguageModel.make` with a fake, so an `effect` bump that moves the API fails here first; `docs/parity.md` and the Effect pin note record it.                                                                                                                                                                                                         |

## Modules

- `packages/core/src/Connector.ts`: `fromLanguageModel`, part mapping,
  error mapping, prompt building; exported from `@llm4ts/core/Connector`.
- `packages/core/src/Models.ts`: `ConnectorIds.OpenRouter`, provider and
  base URL row.
- `packages/runner/src/Connectors.ts`, `ConnectorFactories.ts`: the
  `openrouter` preset over the optional package; `apiConnectorFromEnvironment`
  reads `OPENROUTER_API_KEY`.
- `docs/provider-capabilities.md`: one row; `docs/configuration.md`: the
  preset; `docs/api.md`: the adapter.
- `examples/`: a flow script wrapping an `@effect/ai-anthropic` model under
  the existing `Anthropic` id, for a side-by-side with the hand-rolled
  provider.

## Tasks

- [ ] `fromLanguageModel` with the stream, history, tools, structured and
      error mappings; tests with a `LanguageModel.make` fake for each
      primitive, including a reasoning part, a tool call and every mapped
      `AiError`.
- [ ] Capabilities and verbalized labels through `makeApiConnector`; the
      judgment path test reuses the fake.
- [ ] `ConnectorIds.OpenRouter` and the identity row; `Models.test.ts`.
- [ ] Runner preset over the optional package with the `ConfigError` path
      tested by a fake resolver.
- [ ] The example flow script and a pack-smoke check that the optional
      packages are not required to install `@llm4ts/runner`.
- [ ] `docs/provider-capabilities.md`, `docs/configuration.md`,
      `docs/api.md`, `docs/parity.md` additive note, CHANGELOG.

## Tests

Deterministic with a fake `LanguageModel` (no provider package, no
network): stream parts fold to the same `LlmChunk` sequence the Anthropic
provider test expects for the same transcript; `executeWithTools` returns
the tool call unexecuted; `generateObject` decodes through the llm4ts
codec; each `AiError` lands on its `LlmError`; the OpenRouter preset fails
typed when the package is absent.

## Non-goals

Replacing the hand-rolled providers (a later decision after the
side-by-side); executing tools through `effect/ai`'s `Toolkit` handlers;
`effect/ai`'s MCP server; embeddings; `scoreLabels` from `effect/ai`
(it exposes no log-probabilities).
