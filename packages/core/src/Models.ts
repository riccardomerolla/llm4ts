import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export const LlmProvider = Schema.Literals([
  "GeminiCli",
  "GeminiApi",
  "OpenAI",
  "Anthropic",
  "LmStudio",
  "Ollama",
  "MlxLm",
  "OpenCode",
  "Mock"
])
export type LlmProvider = typeof LlmProvider.Type

export class ConnectorId extends Schema.Class<ConnectorId>("ConnectorId")({
  value: Schema.String
}) {}

export const ConnectorIds = Object.freeze({
  OpenAI: new ConnectorId({ value: "openai" }),
  Anthropic: new ConnectorId({ value: "anthropic" }),
  GeminiApi: new ConnectorId({ value: "gemini-api" }),
  LmStudio: new ConnectorId({ value: "lm-studio" }),
  Ollama: new ConnectorId({ value: "ollama" }),
  MlxLm: new ConnectorId({ value: "mlx-lm" }),
  ClaudeCli: new ConnectorId({ value: "claude-cli" }),
  GeminiCli: new ConnectorId({ value: "gemini-cli" }),
  OpenCode: new ConnectorId({ value: "opencode" }),
  Codex: new ConnectorId({ value: "codex" }),
  Copilot: new ConnectorId({ value: "copilot" }),
  Pi: new ConnectorId({ value: "pi" }),
  AntigravityCli: new ConnectorId({ value: "antigravity-cli" }),
  Grok: new ConnectorId({ value: "grok" }),
  Cursor: new ConnectorId({ value: "cursor" }),
  Mock: new ConnectorId({ value: "mock" })
})

export const apiConnectorIds: ReadonlyArray<ConnectorId> = Object.freeze([
  ConnectorIds.OpenAI,
  ConnectorIds.Anthropic,
  ConnectorIds.GeminiApi,
  ConnectorIds.LmStudio,
  ConnectorIds.Ollama,
  ConnectorIds.MlxLm
])

export const cliConnectorIds: ReadonlyArray<ConnectorId> = Object.freeze([
  ConnectorIds.ClaudeCli,
  ConnectorIds.GeminiCli,
  ConnectorIds.OpenCode,
  ConnectorIds.Codex,
  ConnectorIds.Copilot,
  ConnectorIds.Pi,
  ConnectorIds.AntigravityCli,
  ConnectorIds.Grok,
  ConnectorIds.Cursor
])

export const connectorIds: ReadonlyArray<ConnectorId> = Object.freeze([
  ...apiConnectorIds,
  ...cliConnectorIds,
  ConnectorIds.Mock
])

export const defaultBaseUrl = (provider: LlmProvider): string | undefined => {
  switch (provider) {
    case "GeminiCli":
    case "Mock":
      return undefined
    case "GeminiApi":
      return "https://generativelanguage.googleapis.com"
    case "OpenAI":
      return "https://api.openai.com/v1"
    case "Anthropic":
      return "https://api.anthropic.com"
    case "LmStudio":
      return "http://localhost:1234/v1"
    case "Ollama":
      return "http://localhost:11434"
    case "MlxLm":
      return "http://localhost:8080"
    case "OpenCode":
      return "http://localhost:4096"
  }
}

const connectorProviderTable: Readonly<Record<string, LlmProvider>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  "gemini-api": "GeminiApi",
  "lm-studio": "LmStudio",
  ollama: "Ollama",
  "mlx-lm": "MlxLm",
  opencode: "OpenCode",
  "gemini-cli": "GeminiCli",
  mock: "Mock"
}

export const connectorProvider = (id: ConnectorId): LlmProvider | undefined =>
  connectorProviderTable[id.value]

export const connectorDefaultBaseUrl = (id: ConnectorId): string | undefined => {
  const provider = connectorProvider(id)
  return provider === undefined ? undefined : defaultBaseUrl(provider)
}

export const providerConnectorId = (provider: LlmProvider): ConnectorId => {
  switch (provider) {
    case "GeminiCli":
      return ConnectorIds.GeminiCli
    case "GeminiApi":
      return ConnectorIds.GeminiApi
    case "OpenAI":
      return ConnectorIds.OpenAI
    case "Anthropic":
      return ConnectorIds.Anthropic
    case "LmStudio":
      return ConnectorIds.LmStudio
    case "Ollama":
      return ConnectorIds.Ollama
    case "MlxLm":
      return ConnectorIds.MlxLm
    case "OpenCode":
      return ConnectorIds.OpenCode
    case "Mock":
      return ConnectorIds.Mock
  }
}

export const ConnectorKind = Schema.Literals(["Api", "Cli"])
export type ConnectorKind = typeof ConnectorKind.Type

export const MessageRole = Schema.Literals(["System", "User", "Assistant", "Tool"])
export type MessageRole = typeof MessageRole.Type

export class Message extends Schema.Class<Message>("Message")({
  role: MessageRole,
  content: Schema.String
}) {}

export class TokenUsage extends Schema.Class<TokenUsage>("TokenUsage")({
  prompt: Schema.Int,
  completion: Schema.Int,
  total: Schema.Int,
  cached: Schema.optionalKey(Schema.Int),
  // Cost as reported by the backend itself (e.g. the Claude CLI's
  // total_cost_usd). When present it is authoritative — consumers prefer
  // it over any pricing-table estimate.
  costUsd: Schema.optionalKey(Schema.Number)
}) {}

const emptyMetadata: Readonly<Record<string, string>> = Object.freeze({})

export class LlmResponse extends Schema.Class<LlmResponse>("LlmResponse")({
  content: Schema.String,
  usage: Schema.optionalKey(TokenUsage),
  metadata: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyMetadata))
  )
}) {}

export class LlmChunk extends Schema.Class<LlmChunk>("LlmChunk")({
  delta: Schema.String,
  finishReason: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(TokenUsage),
  metadata: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyMetadata))
  )
}) {}

export class StreamProgress extends Schema.Class<StreamProgress>("StreamProgress")({
  tokensProcessed: Schema.Int,
  tokensPerSecond: Schema.Number,
  elapsedMs: Schema.Int,
  estimatedRemainingMs: Schema.optionalKey(Schema.Int)
}) {}

/**
 * How much reasoning a seat is asked to spend (ADR 0029): one vocabulary
 * across harnesses, mapped by each connector to its own flag (`--effort`,
 * `--thinking`, `model_reasoning_effort`, `output_config.effort`,
 * `reasoning_effort`) or ignored where the harness has none. `max` becomes
 * `xhigh` on a harness without `max`. Nothing is sent when none is asked.
 */
export const Effort = Schema.Literals(["low", "medium", "high", "max"])
export type Effort = typeof Effort.Type

export class LlmConfig extends Schema.Class<LlmConfig>("LlmConfig")({
  provider: LlmProvider,
  model: Schema.String,
  baseUrl: Schema.optionalKey(Schema.String),
  apiKey: Schema.optionalKey(
    Schema.Redacted(Schema.String, {
      disallowJsonEncode: true
    })
  ),
  timeout: Schema.Duration.pipe(
    Schema.withConstructorDefault(Effect.succeed(Duration.seconds(300)))
  ),
  maxRetries: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(3))),
  requestsPerMinute: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(60))),
  burstSize: Schema.Int.pipe(Schema.withConstructorDefault(Effect.succeed(10))),
  acquireTimeout: Schema.Duration.pipe(
    Schema.withConstructorDefault(Effect.succeed(Duration.seconds(30)))
  ),
  temperature: Schema.optionalKey(Schema.Number),
  maxTokens: Schema.optionalKey(Schema.Int),
  /** Reasoning effort to ask of the backend (ADR 0029); absent keeps its default. */
  effort: Schema.optionalKey(Effort),
  /** Prompt-cache markers where the provider has them (Anthropic); default on. */
  promptCache: Schema.optionalKey(Schema.Boolean)
}) {}

export const withConfigDefaults = (config: LlmConfig): LlmConfig => {
  if (config.baseUrl !== undefined) {
    return config
  }

  const baseUrl = defaultBaseUrl(config.provider)
  return baseUrl === undefined ? config : new LlmConfig({ ...config, baseUrl })
}

export class ToolCall extends Schema.Class<ToolCall>("ToolCall")({
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.String
}) {}

const emptyToolCalls: ReadonlyArray<ToolCall> = Object.freeze([])

export class ToolCallResponse extends Schema.Class<ToolCallResponse>("ToolCallResponse")({
  content: Schema.optionalKey(Schema.String),
  toolCalls: Schema.Array(ToolCall).pipe(
    Schema.withConstructorDefault(Effect.succeed(emptyToolCalls))
  ),
  finishReason: Schema.String
}) {}

export const JsonSchema = Schema.Record(Schema.String, Schema.Json)
export type JsonSchema = typeof JsonSchema.Type

export class ToolDefinition extends Schema.Class<ToolDefinition>("ToolDefinition")({
  name: Schema.String,
  description: Schema.String,
  parameters: JsonSchema
}) {}

export const Availability = Schema.Literals(["Healthy", "Degraded", "Unhealthy", "Unknown"])
export type Availability = typeof Availability.Type

export const AuthStatus = Schema.Literals(["Valid", "Missing", "Invalid", "Unknown"])
export type AuthStatus = typeof AuthStatus.Type

export class HealthStatus extends Schema.Class<HealthStatus>("HealthStatus")({
  availability: Availability,
  authStatus: AuthStatus,
  latency: Schema.optionalKey(Schema.Duration)
}) {}

export const InteractionSupport = Schema.Literals(["InteractiveStdin", "ContinuationOnly"])
export type InteractionSupport = typeof InteractionSupport.Type

/**
 * How honestly a connector's `readOnly` mapping restricts the harness:
 * - "enforced": a real capability removal — the write tools are absent from
 *   the harness's advertised surface (a `--tools` allowlist, an OS sandbox),
 *   verified against the harness's own tool list.
 * - "advisory": an approval/permission MODE the harness may not treat as a
 *   capability gate. Upgrading to "enforced" requires observing the harness's
 *   advertised tool list with and without the flag.
 * - "ignored": the flag reaches no argv at all, or is indistinguishable from
 *   ignored in headless runs.
 */
export const ReadOnlyEnforcement = Schema.Literals(["enforced", "advisory", "ignored"])
export type ReadOnlyEnforcement = typeof ReadOnlyEnforcement.Type

/** Whether a connector maps `effort` to anything the harness reads. */
export const EffortSupport = Schema.Literals(["mapped", "ignored"])
export type EffortSupport = typeof EffortSupport.Type

/**
 * How completely a CLI connector's `isolated` mapping keeps the target
 * repository's own harness material (hooks, MCP servers, settings,
 * extensions, instruction files) out of a headless run (ADR 0029):
 * - "enforced": the harness documents a mode that loads none of it.
 * - "partial": some of it is kept out by flags; the rest (typically the
 *   repository's instruction file) is still read.
 * - "ignored": nothing reaches argv.
 */
export const IsolationEnforcement = Schema.Literals(["enforced", "partial", "ignored"])
export type IsolationEnforcement = typeof IsolationEnforcement.Type

/**
 * How a connector produces the per-label probabilities behind `scoreLabels`:
 * - "logprobs": read off the backend's token log-probabilities in one
 *   forward pass (a real distribution, still uncalibrated).
 * - "verbalized": the model writes the numbers itself in a JSON reply
 *   (typically overconfident; hold to a higher bar).
 * - "none": the connector cannot answer label questions at all.
 */
export const LabelProbabilities = Schema.Literals(["logprobs", "verbalized", "none"])
export type LabelProbabilities = typeof LabelProbabilities.Type

/** How a label distribution's numbers were extracted (see `LabelProbabilities`). */
export const LabelMethod = Schema.Literals(["logprobs", "verbalized", "sampled"])
export type LabelMethod = typeof LabelMethod.Type

/**
 * A probability per label, normalized over the labels the caller offered.
 * `support` is the probability mass the backend actually placed on those
 * labels before renormalization (1 when the numbers were declared over the
 * labels alone): a distribution renormalized from a sliver of mass is not
 * a confident one, and callers must not treat it as one.
 * `usage` is whatever the backend reported for the call, if anything.
 */
export class LabelDistribution extends Schema.Class<LabelDistribution>("LabelDistribution")({
  probabilities: Schema.Record(Schema.String, Schema.Number),
  method: LabelMethod,
  support: Schema.Number,
  usage: Schema.optionalKey(TokenUsage),
  model: Schema.optionalKey(Schema.String)
}) {}

export class ConnectorCapabilities extends Schema.Class<ConnectorCapabilities>(
  "ConnectorCapabilities"
)({
  streaming: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(true))),
  resumableSessions: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
  interactiveSessions: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
  askUser: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
  approval: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(false))),
  structuredOutput: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(true))),
  usageReporting: Schema.Boolean.pipe(Schema.withConstructorDefault(Effect.succeed(true))),
  labelProbabilities: LabelProbabilities.pipe(
    Schema.withConstructorDefault(Effect.succeed<LabelProbabilities>("verbalized"))
  ),
  readOnlyEnforcement: ReadOnlyEnforcement.pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadOnlyEnforcement>("advisory"))
  ),
  effort: EffortSupport.pipe(
    Schema.withConstructorDefault(Effect.succeed<EffortSupport>("ignored"))
  ),
  isolatedHeadless: IsolationEnforcement.pipe(
    Schema.withConstructorDefault(Effect.succeed<IsolationEnforcement>("ignored"))
  )
}) {}
