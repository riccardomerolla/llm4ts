import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import {
  ApiConnectorConfig,
  CliConnectorConfig,
  defaultReasoningConfig,
  type ConnectorConfig,
  type ConnectorConfigOf
} from "@llm4ts/core/ConnectorConfig"
import {
  ConnectorIds,
  apiProviderConnector,
  coderConnector,
  coderNames,
  connectorDefaultBaseUrl,
  connectorRow,
  connectorTable,
  offeredApiProviderNames,
  type ConnectorName
} from "@llm4ts/core/Models"
import { runStateDeniedPaths } from "@llm4ts/flow/RunState"
import { settingText, settingValue } from "@llm4ts/flow/Settings"
import { ScriptUsage } from "./FlowArgs.ts"

export const claude = CliConnectorConfig.make({
  connectorId: ConnectorIds.ClaudeCli,
  flags: {
    "permission-mode": "acceptEdits"
  }
})

export const codex = CliConnectorConfig.make({
  connectorId: ConnectorIds.Codex,
  flags: {
    sandbox: "workspace-write"
  }
})

export const gemini = CliConnectorConfig.make({
  connectorId: ConnectorIds.GeminiCli
})

export const pi = CliConnectorConfig.make({
  connectorId: ConnectorIds.Pi
})

export const antigravity = CliConnectorConfig.make({
  connectorId: ConnectorIds.AntigravityCli,
  flags: {
    mode: "accept-edits"
  }
})

export const grok = CliConnectorConfig.make({
  connectorId: ConnectorIds.Grok
})

export const cursor = CliConnectorConfig.make({
  connectorId: ConnectorIds.Cursor
})

export const opencode = CliConnectorConfig.make({
  connectorId: ConnectorIds.OpenCode
})

export const lmStudio = ApiConnectorConfig.make({
  connectorId: ConnectorIds.LmStudio,
  baseUrl: connectorTable.LmStudio.baseUrl
})

export const mlxLm = ApiConnectorConfig.make({
  connectorId: ConnectorIds.MlxLm,
  baseUrl: connectorTable.MlxLm.baseUrl
})

export const openAI = ApiConnectorConfig.make({
  connectorId: ConnectorIds.OpenAI
})

export const anthropic = ApiConnectorConfig.make({
  connectorId: ConnectorIds.Anthropic
})

export const geminiApi = ApiConnectorConfig.make({
  connectorId: ConnectorIds.GeminiApi
})

export const ollama = ApiConnectorConfig.make({
  connectorId: ConnectorIds.Ollama
})

export const mock = ApiConnectorConfig.make({
  connectorId: ConnectorIds.Mock,
  model: "mock"
})

// A connector without a preset here does not compile.
const presets: { readonly [K in ConnectorName]: ConnectorConfigOf<K> } = {
  OpenAI: openAI,
  Anthropic: anthropic,
  GeminiApi: geminiApi,
  LmStudio: lmStudio,
  Ollama: ollama,
  MlxLm: mlxLm,
  ClaudeCli: claude,
  GeminiCli: gemini,
  OpenCode: opencode,
  Codex: codex,
  Pi: pi,
  AntigravityCli: antigravity,
  Grok: grok,
  Cursor: cursor,
  Mock: mock
}

export function withModel(config: CliConnectorConfig, model: string): CliConnectorConfig
export function withModel(config: ApiConnectorConfig, model: string): ApiConnectorConfig
export function withModel(config: ConnectorConfig, model: string): ConnectorConfig
export function withModel(
  config: CliConnectorConfig | ApiConnectorConfig,
  model: string
): CliConnectorConfig | ApiConnectorConfig {
  return config instanceof CliConnectorConfig
    ? CliConnectorConfig.make({ ...config, model })
    : ApiConnectorConfig.make({ ...config, model })
}

export const withTurnLimit = (config: CliConnectorConfig, turnLimit: number): CliConnectorConfig =>
  CliConnectorConfig.make({
    ...config,
    turnLimit
  })

export const withEnvironment = (
  config: CliConnectorConfig,
  environment: Readonly<Record<string, string>>
): CliConnectorConfig =>
  CliConnectorConfig.make({
    ...config,
    envVars: {
      ...config.envVars,
      ...environment
    }
  })

export const asReadOnly = (config: CliConnectorConfig): CliConnectorConfig =>
  CliConnectorConfig.make({ ...config, readOnly: true })

// For a seat driven only through complete()/completeStream() — structured or
// reasoning calls with no tool-loop continuation — where even a read-only
// tool is unsafe: the model can reach for it mid-turn and resolve with no
// text instead of an error (see CliConnectorConfig.noTools's doc comment).
export const asToolless = (config: CliConnectorConfig): CliConnectorConfig =>
  CliConnectorConfig.make({ ...config, readOnly: true, noTools: true })

export const withTimeoutSeconds = (
  config: ApiConnectorConfig,
  seconds: number
): ApiConnectorConfig =>
  ApiConnectorConfig.make({
    ...config,
    timeout: Duration.seconds(seconds)
  })

const environmentApiKey = (
  config: ApiConnectorConfig,
  environment: Readonly<Record<string, string | undefined>>
): string | undefined => {
  const row = connectorRow(config.connectorId)
  return row?.kind === "Api"
    ? row.credentialVariables
        .map((variable) => environment[variable])
        .find((value) => value !== undefined)
    : undefined
}

export const enrichApiConnector = (
  config: ApiConnectorConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env
): ApiConnectorConfig => {
  const baseUrl = config.baseUrl ?? connectorDefaultBaseUrl(config.connectorId)
  const environmentKey = environmentApiKey(config, environment)
  return ApiConnectorConfig.make({
    ...config,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(config.apiKey !== undefined
      ? { apiKey: config.apiKey }
      : environmentKey === undefined
        ? {}
        : { apiKey: Redacted.make(environmentKey) })
  })
}

export const prepareConnector = (
  config: ConnectorConfig,
  workDir: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  deniedPaths: ReadonlyArray<string> = runStateDeniedPaths
): ConnectorConfig =>
  config instanceof ApiConnectorConfig
    ? enrichApiConnector(config, environment)
    : CliConnectorConfig.make({
        ...config,
        workingDir: workDir,
        // `LLM4TS_ISOLATED=1` asks every CLI seat of the run to leave the
        // repository's own harness material unloaded (ADR 0029).
        ...(settingValue("LLM4TS_ISOLATED", environment) ? { isolated: true } : {}),
        // Every CLI seat keeps out of the run's own state unless the seat
        // (or the run) says otherwise; the connector maps it to a deny
        // rule where its harness has one (`capabilities.pathDeny`).
        deniedPaths: config.deniedPaths ?? deniedPaths
      })

/** The API provider a name stands for (`LLM4TS_PROVIDER`, a roster executor's `harness`). */
export const apiPresetFor = (name: string): ApiConnectorConfig | undefined => {
  const connector = apiProviderConnector(name.trim().toLowerCase())
  return connector === undefined ? undefined : presets[connector]
}

const apiConnectorNamed = Effect.fnUntraced(function* (
  named: string,
  model: string | undefined
): Effect.fn.Return<ApiConnectorConfig, ScriptUsage> {
  const provider = named.toLowerCase()
  const preset = apiPresetFor(provider)
  if (preset === undefined) {
    return yield* ScriptUsage.make({
      message: `unknown LLM4TS_PROVIDER '${provider}'; expected ${offeredApiProviderNames.join("|")}`
    })
  }
  if (provider !== "mock" && model === undefined) {
    return yield* ScriptUsage.make({
      message: `LLM4TS_MODEL is required for provider '${provider}' (e.g. LLM4TS_MODEL=gpt-4o-mini)`
    })
  }
  return model === undefined ? preset : withModel(preset, model)
})

export const apiConnectorFromEnvironment = Effect.fn(
  "@llm4ts/runner/Connectors.apiConnectorFromEnvironment"
)(function* (
  environment: Readonly<Record<string, string | undefined>> = process.env
): Effect.fn.Return<ApiConnectorConfig, ScriptUsage> {
  return yield* apiConnectorNamed(
    settingText("LLM4TS_PROVIDER", environment) ?? "mock",
    settingValue("LLM4TS_MODEL", environment)
  )
})

export const coderIds: ReadonlyArray<string> = Object.freeze([...coderNames].sort())

export const coderFor = (name: string): CliConnectorConfig | undefined => {
  const connector = coderConnector(name.trim().toLowerCase())
  return connector === undefined ? undefined : presets[connector]
}

export interface SeatDefaults {
  /** The coder when `LLM4TS_CODER` is unset; claude when omitted. */
  readonly coder?: CliConnectorConfig
  /** The reasoner when `LLM4TS_REASONER` is unset; the coder seat when omitted. */
  readonly reasoner?: CliConnectorConfig
}

export interface Seats {
  readonly coder: CliConnectorConfig
  readonly reasoning: CliConnectorConfig
}

type Environment = Readonly<Record<string, string | undefined>>

const namedSeat = (
  variable: "LLM4TS_CODER" | "LLM4TS_REASONER",
  environment: Environment
): Effect.Effect<CliConnectorConfig | undefined, ScriptUsage> => {
  const requested = settingText(variable, environment)
  if (requested === undefined) {
    return Effect.succeed(undefined)
  }
  const preset = coderFor(requested)
  return preset === undefined
    ? Effect.fail(
        ScriptUsage.make({
          message: `unknown ${variable} '${requested}'; expected ${coderIds.join("|")}`
        })
      )
    : Effect.succeed(preset)
}

/**
 * The coder and reasoning seats of a flow that runs both, from `LLM4TS_CODER`
 * and `LLM4TS_REASONER`. An unknown name is a usage error naming the accepted
 * names, never another agent. A flow with one seat reads that one alone
 * (`coderFromEnvironment`, `reasonerFromEnvironment`).
 */
export const seatsFromEnvironment = Effect.fn("@llm4ts/runner/Connectors.seatsFromEnvironment")(
  function* (
    defaults: SeatDefaults = {},
    environment: Environment = process.env
  ): Effect.fn.Return<Seats, ScriptUsage> {
    const coder = (yield* namedSeat("LLM4TS_CODER", environment)) ?? defaults.coder ?? claude
    const reasoner = yield* namedSeat("LLM4TS_REASONER", environment)
    return { coder, reasoning: reasoner ?? defaults.reasoner ?? coder }
  }
)

/**
 * `LLM4TS_CODER` alone, for a flow that runs no separate reasoning seat. A
 * flow answers only for the seats it uses: a bad `LLM4TS_REASONER` is not
 * this flow's to refuse.
 */
export const coderFromEnvironment = (
  environment: Environment = process.env,
  fallback: CliConnectorConfig = claude
): Effect.Effect<CliConnectorConfig, ScriptUsage> =>
  Effect.map(namedSeat("LLM4TS_CODER", environment), (coder) => coder ?? fallback)

/** `LLM4TS_REASONER` alone, for a flow that edits nothing. */
export const reasonerFromEnvironment = (
  environment: Environment = process.env,
  fallback: CliConnectorConfig = claude
): Effect.Effect<CliConnectorConfig, ScriptUsage> =>
  Effect.map(namedSeat("LLM4TS_REASONER", environment), (reasoner) => reasoner ?? fallback)

const presetFlags = new Map<string, Readonly<Record<string, string>>>(
  Object.values(presets).flatMap((preset) =>
    preset instanceof CliConnectorConfig ? [[preset.connectorId.value, preset.flags]] : []
  )
)

const withModelUnlessSet = (config: ConnectorConfig, model: string | undefined): ConnectorConfig =>
  model === undefined || config.model !== undefined ? config : withModel(config, model)

/**
 * A key the seat carries with its preset's value takes the setting's value; a
 * key the flow set to something else keeps the flow's.
 */
const withFlagsUnlessSet = (
  config: ConnectorConfig,
  flags: Readonly<Record<string, string>> | undefined
): ConnectorConfig => {
  if (flags === undefined || !(config instanceof CliConnectorConfig)) {
    return config
  }
  const preset = presetFlags.get(config.connectorId.value) ?? {}
  const added = Object.entries(flags).filter(
    ([key]) => config.flags[key] === undefined || config.flags[key] === preset[key]
  )
  return CliConnectorConfig.make({
    ...config,
    flags: { ...config.flags, ...Object.fromEntries(added) }
  })
}

export interface SeatConfigs {
  readonly coder: ConnectorConfig
  readonly reasoning?: ConnectorConfig
  readonly reviewers?: ReadonlyArray<ConnectorConfig>
  readonly judgment?: ConnectorConfig
}

/**
 * `LLM4TS_CODER_MODEL`, `LLM4TS_CODER_FLAGS`, `LLM4TS_REASONING_MODEL` and
 * `LLM4TS_REASONING_FLAGS` on a flow's seats, so no flow reads them itself.
 *
 * The coder seat takes the coder settings. Every other seat (the reasoning
 * seat, reviewers, an explicit judgment seat) takes the reasoning settings
 * when it runs the reasoning seat's agent, then the coder's model when it runs
 * the coder's agent and still names none: a model name means something only to
 * its own agent. The coder's flags stay on the coder: a read-only seat never
 * inherits edit permissions. A model or a flag the flow set in code wins.
 */
export const withSeatSettings = <S extends SeatConfigs>(seats: S, environment: Environment): S => {
  const coderModel = settingValue("LLM4TS_CODER_MODEL", environment)
  const reasoningModel = settingValue("LLM4TS_REASONING_MODEL", environment)
  const reasoningFlags = settingValue("LLM4TS_REASONING_FLAGS", environment)
  const reasoning = defaultReasoningConfig(seats.coder, seats.reasoning)
  const runs = (config: ConnectorConfig, seat: ConnectorConfig) =>
    config.connectorId.value === seat.connectorId.value
  const other = (config: ConnectorConfig): ConnectorConfig => {
    const asReasoner = runs(config, reasoning)
      ? withModelUnlessSet(withFlagsUnlessSet(config, reasoningFlags), reasoningModel)
      : config
    return runs(config, seats.coder) ? withModelUnlessSet(asReasoner, coderModel) : asReasoner
  }
  return {
    ...seats,
    coder: withModelUnlessSet(
      withFlagsUnlessSet(seats.coder, settingValue("LLM4TS_CODER_FLAGS", environment)),
      coderModel
    ),
    reasoning: other(reasoning),
    ...(seats.reviewers === undefined ? {} : { reviewers: seats.reviewers.map(other) }),
    ...(seats.judgment === undefined ? {} : { judgment: other(seats.judgment) })
  }
}

/**
 * The judgment seat from the environment (ADR 0017): `LLM4TS_JUDGMENT_PROVIDER`
 * names an API provider the way `LLM4TS_PROVIDER` does, `LLM4TS_JUDGMENT_MODEL`
 * its model. Unset, the runner falls back to the reasoning seat.
 */
export const judgmentConnectorFromEnvironment = Effect.fn(
  "@llm4ts/runner/Connectors.judgmentConnectorFromEnvironment"
)(function* (
  environment: Readonly<Record<string, string | undefined>> = process.env
): Effect.fn.Return<ApiConnectorConfig | undefined, ScriptUsage> {
  const provider = settingText("LLM4TS_JUDGMENT_PROVIDER", environment)
  return provider === undefined
    ? undefined
    : yield* apiConnectorNamed(provider, settingValue("LLM4TS_JUDGMENT_MODEL", environment))
})
