import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Record from "effect/Record"
import * as Schema from "effect/Schema"

export const LlmProvider = Schema.Literals([
  "GeminiCli",
  "GeminiApi",
  "OpenAI",
  "Anthropic",
  "LmStudio",
  "Ollama",
  "MlxLm",
  "Mock"
])
export type LlmProvider = typeof LlmProvider.Type

export class ConnectorId extends Schema.Class<ConnectorId>("ConnectorId")({
  value: Schema.String
}) {}

export const ConnectorKind = Schema.Literals(["Api", "Cli"])
export type ConnectorKind = typeof ConnectorKind.Type

interface ConnectorIdentity {
  readonly id: string
  /** The `LlmConfig` provider it serves. Such a row sits under the provider's own name. */
  readonly provider?: LlmProvider
  readonly baseUrl?: string
  /**
   * What an operator may write for it: a coder name on a CLI row
   * (`LLM4TS_CODER`, `LLM4TS_REASONER`), a provider name on an API row
   * (`LLM4TS_PROVIDER`). The first is the one help and menus show. Empty
   * means it is not offered under any name.
   */
  readonly names: ReadonlyArray<string>
}

export interface ApiConnectorRow extends ConnectorIdentity {
  readonly kind: "Api"
  /** Environment variables that may hold its key; the first one set wins. */
  readonly credentialVariables: ReadonlyArray<string>
  /** Answers without a backend, so it is no part of `apiConnectorIds`. */
  readonly simulated?: true
}

export interface CliConnectorRow extends ConnectorIdentity {
  readonly kind: "Cli"
  /** The program it spawns, and the one looked for on `PATH`. */
  readonly executable: string
}

export type ConnectorRow = ApiConnectorRow | CliConnectorRow

/**
 * Every connector's identity, one row each. The id lists, the provider
 * mappings and the names an operator may write are all read from here; the
 * factories (`providers/ConnectorFactories.ts`) and the runner's presets are
 * records keyed by these names, so a row without either does not compile.
 */
export const connectorTable = {
  OpenAI: {
    id: "openai",
    kind: "Api",
    provider: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    credentialVariables: ["OPENAI_API_KEY"],
    names: ["openai"]
  },
  Anthropic: {
    id: "anthropic",
    kind: "Api",
    provider: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    credentialVariables: ["ANTHROPIC_API_KEY"],
    names: ["anthropic"]
  },
  GeminiApi: {
    id: "gemini-api",
    kind: "Api",
    provider: "GeminiApi",
    baseUrl: "https://generativelanguage.googleapis.com",
    credentialVariables: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    names: ["gemini", "gemini-api"]
  },
  LmStudio: {
    id: "lm-studio",
    kind: "Api",
    provider: "LmStudio",
    baseUrl: "http://localhost:1234/v1",
    credentialVariables: [],
    names: ["lm-studio", "lmstudio"]
  },
  Ollama: {
    id: "ollama",
    kind: "Api",
    provider: "Ollama",
    baseUrl: "http://localhost:11434",
    credentialVariables: [],
    names: ["ollama"]
  },
  MlxLm: {
    id: "mlx-lm",
    kind: "Api",
    provider: "MlxLm",
    baseUrl: "http://localhost:8080",
    credentialVariables: [],
    names: ["mlx-lm", "mlxlm", "mlx"]
  },
  ClaudeCli: {
    id: "claude-cli",
    kind: "Cli",
    executable: "claude",
    names: ["claude", "claude-cli"]
  },
  GeminiCli: {
    id: "gemini-cli",
    kind: "Cli",
    provider: "GeminiCli",
    executable: "gemini",
    names: ["gemini", "gemini-cli"]
  },
  OpenCode: { id: "opencode", kind: "Cli", executable: "opencode", names: ["opencode"] },
  Codex: { id: "codex", kind: "Cli", executable: "codex", names: ["codex"] },
  Pi: { id: "pi", kind: "Cli", executable: "pi", names: ["pi"] },
  AntigravityCli: {
    id: "antigravity-cli",
    kind: "Cli",
    executable: "agy",
    names: ["agy", "antigravity", "antigravity-cli"]
  },
  Grok: { id: "grok", kind: "Cli", executable: "grok", names: ["grok"] },
  Cursor: { id: "cursor", kind: "Cli", executable: "cursor-agent", names: ["cursor"] },
  Mock: {
    id: "mock",
    kind: "Api",
    provider: "Mock",
    credentialVariables: [],
    simulated: true,
    names: ["mock"]
  }
} as const satisfies Readonly<Record<string, ConnectorRow>>

export type ConnectorName = keyof typeof connectorTable
type RowOf<K extends ConnectorName> = (typeof connectorTable)[K]

export type CliConnectorName = {
  [K in ConnectorName]: RowOf<K>["kind"] extends "Cli" ? K : never
}[ConnectorName]
export type ApiConnectorName = Exclude<ConnectorName, CliConnectorName>

/** Every name `LLM4TS_CODER` and `LLM4TS_REASONER` read. */
export type CoderName = RowOf<CliConnectorName>["names"][number]
/** Every name `LLM4TS_PROVIDER` and `LLM4TS_JUDGMENT_PROVIDER` read. */
export type ApiProviderName = RowOf<ApiConnectorName>["names"][number]

type OfferedCoder = {
  [K in CliConnectorName]: RowOf<K>["names"] extends readonly [] ? never : K
}[CliConnectorName]

const rows: Readonly<Record<ConnectorName, ConnectorRow>> = connectorTable
const providerRows: { readonly [P in LlmProvider]: ConnectorRow & { readonly provider: P } } =
  connectorTable
const names = Record.keys(connectorTable)

export const isCliConnectorName = (name: ConnectorName): name is CliConnectorName =>
  rows[name].kind === "Cli"

export const ConnectorIds: Readonly<Record<ConnectorName, ConnectorId>> = Object.freeze(
  Record.map(connectorTable, (row) => new ConnectorId({ value: row.id }))
)

const idsWhere = (keep: (row: ConnectorRow) => boolean): ReadonlyArray<ConnectorId> =>
  Object.freeze(names.filter((name) => keep(rows[name])).map((name) => ConnectorIds[name]))

export const apiConnectorIds: ReadonlyArray<ConnectorId> = idsWhere(
  (row) => row.kind === "Api" && row.simulated !== true
)

export const cliConnectorIds: ReadonlyArray<ConnectorId> = idsWhere((row) => row.kind === "Cli")

export const connectorIds: ReadonlyArray<ConnectorId> = Object.freeze([
  ...apiConnectorIds,
  ...cliConnectorIds,
  ...idsWhere((row) => row.kind === "Api" && row.simulated === true)
])

const rowsById = new Map<string, ConnectorRow>(names.map((name) => [rows[name].id, rows[name]]))

export const connectorRow = (id: ConnectorId): ConnectorRow | undefined => rowsById.get(id.value)

export const defaultBaseUrl = (provider: LlmProvider): string | undefined =>
  providerRows[provider].baseUrl

export const connectorProvider = (id: ConnectorId): LlmProvider | undefined =>
  connectorRow(id)?.provider

export const connectorDefaultBaseUrl = (id: ConnectorId): string | undefined =>
  connectorRow(id)?.baseUrl

export const providerConnectorId = (provider: LlmProvider): ConnectorId => ConnectorIds[provider]

const namedConnectors = <K extends ConnectorName>(keys: ReadonlyArray<K>): ReadonlyMap<string, K> =>
  new Map(keys.flatMap((key) => rows[key].names.map((name) => [name, key] as const)))

const cliNames = names.filter(isCliConnectorName)
const apiNames = names.filter((name) => !isCliConnectorName(name))
const coderConnectors = namedConnectors(cliNames)
const apiProviderConnectors = namedConnectors(apiNames)

/** The CLI connector a coder name stands for; the name as written, lower case. */
export const coderConnector = (name: string): CliConnectorName | undefined =>
  coderConnectors.get(name)

/** The API connector a provider name stands for; the name as written, lower case. */
export const apiProviderConnector = (name: string): ApiConnectorName | undefined =>
  apiProviderConnectors.get(name)

export const coderNames: ReadonlyArray<CoderName> = cliNames.flatMap(
  (name) => connectorTable[name].names
)

export const apiProviderNames: ReadonlyArray<ApiProviderName> = apiNames.flatMap(
  (name) => connectorTable[name].names
)

/** Every variable an API connector reads its key from. Names only, never a value. */
export const credentialVariables: ReadonlyArray<string> = apiNames.flatMap(
  (name) => connectorTable[name].credentialVariables
)

export const cliExecutable = <K extends CliConnectorName>(name: K): RowOf<K>["executable"] =>
  connectorTable[name].executable

const inOrder =
  <All extends string>() =>
  <const L extends ReadonlyArray<All>>(
    list: L,
    ..._missing: [Exclude<All, L[number]>] extends [never] ? [] : [missing: Exclude<All, L[number]>]
  ): L =>
    list

/** The coding agents help and menus offer, in the order they show them. */
export const offeredCoders = inOrder<OfferedCoder>()([
  "ClaudeCli",
  "Codex",
  "GeminiCli",
  "Pi",
  "AntigravityCli",
  "Grok",
  "Cursor",
  "OpenCode"
])

/** The API providers help and errors offer, in the order they show them. */
export const offeredApiProviders = inOrder<ApiConnectorName>()([
  "Mock",
  "OpenAI",
  "Anthropic",
  "GeminiApi",
  "LmStudio",
  "Ollama",
  "MlxLm"
])

export const offeredCoderNames = offeredCoders.map((name) => connectorTable[name].names[0])

export const offeredApiProviderNames = offeredApiProviders.map(
  (name) => connectorTable[name].names[0]
)

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

export const JsonSchema = Schema.Record(Schema.String, Schema.Json)
export type JsonSchema = typeof JsonSchema.Type

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
 * How a CLI connector keeps the harness out of the paths a seat is denied
 * (`CliConnectorConfig.deniedPaths`; by default the run's own state under
 * `.llm4ts/`):
 * - "enforced": the harness denies the path at the filesystem (a sandbox
 *   mount, a path check on every tool, the shell included).
 * - "partial": the harness denies what its rule can see — the file tools by
 *   path, the shell by matching the command text — so a path spelled
 *   another way (`..`, a variable, a glob) can slip past.
 * - "ignored": the harness has no per-path rule; nothing reaches argv and
 *   only the contract text in the prompt keeps the model out.
 */
export const PathDenyEnforcement = Schema.Literals(["enforced", "partial", "ignored"])
export type PathDenyEnforcement = typeof PathDenyEnforcement.Type

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
  ),
  pathDeny: PathDenyEnforcement.pipe(
    Schema.withConstructorDefault(Effect.succeed<PathDenyEnforcement>("ignored"))
  )
}) {}
