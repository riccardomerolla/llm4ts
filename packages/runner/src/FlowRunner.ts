import { join } from "node:path"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { ConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { CliConnectorConfig, defaultReasoningConfig } from "@llm4ts/core/ConnectorConfig"
import type { ConnectorRegistryShape } from "@llm4ts/core/ConnectorRegistry"
import type { HttpClientShape } from "@llm4ts/core/HttpClient"
import type { JudgmentBackend } from "@llm4ts/core/judgment/Schemas"
import type { JudgmentShape } from "@llm4ts/core/judgment/Judgment"
import { LlmJudgmentConfig, makeLlmJudgment } from "@llm4ts/core/judgment/LlmJudgment"
import { makeTypeSafeJudgment } from "@llm4ts/core/judgment/TypeSafeJudgment"
import * as Redacted from "effect/Redacted"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { ConnectorCapabilities, TokenUsage } from "@llm4ts/core/Models"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import type { TemporaryFilesShape } from "@llm4ts/core/TemporaryFiles"
import type { GeminiCliExecutorShape } from "@llm4ts/core/providers/GeminiCliProvider"
import { createConnectorRegistry } from "@llm4ts/core/providers/ConnectorFactories"
import { ConnectorIds } from "@llm4ts/core/Models"
import { ProviderError } from "@llm4ts/core/Errors"
import { makeCostTracker, type CostTracker } from "@llm4ts/flow/CostTracker"
import { runGeminiAcpBridge } from "./NodeGeminiAcpBridge.ts"
import {
  bridgeModelProblem,
  defaultReadPiModelsJson,
  geminiBridgePort,
  resolveBridgeModel
} from "./PiModels.ts"
import {
  appendCostRecord,
  checkCostBudget,
  CostLedgerFileName,
  makeCostRecord,
  type CostBudget
} from "@llm4ts/flow/CostLedger"
import { estimatedUsageOptionsFromEnv, makeEstimatedUsageMeter } from "@llm4ts/flow/EstimatedUsage"
import { FlowLlmError, describeFlowError, type FlowError } from "@llm4ts/flow/FlowError"
import {
  FlowEvents,
  FlowEventsValues,
  Info,
  TokensUsed,
  makeFlowEventHub,
  type FlowEventHub
} from "@llm4ts/flow/FlowEvents"
import { FlowContext, type FlowContextShape } from "@llm4ts/flow/FlowContext"
import { makeFlowRecorder } from "@llm4ts/flow/FlowRecorder"
import { makeJudgmentLog, type JudgmentLogShape } from "@llm4ts/flow/JudgmentLog"
import { makeGitHubTool } from "@llm4ts/flow/GitHubTool"
import { makeGitTool } from "@llm4ts/flow/GitTool"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { makeTransientRetry } from "@llm4ts/flow/TransientRetry"
import { nodeHttpClient } from "./NodeHttpClient.ts"
import { nodeGeminiCliExecutor } from "./NodeGeminiCliExecutor.ts"
import { nodePlainFileStore } from "./NodePlainFileStore.ts"
import { nodeProcessExecutor } from "./NodeProcessExecutor.ts"
import { nodeTemporaryFiles } from "./NodeTemporaryFiles.ts"
import { prepareConnector } from "./Connectors.ts"
import {
  consumeTerminalEvents,
  formatDurationMs,
  makeTerminalSurface,
  type TerminalSurface,
  type Verbosity
} from "./Terminal.ts"

const describeSeat = (config: ConnectorConfig): string => {
  const model = config.model === undefined ? "" : ` (${config.model})`
  const readOnly = config instanceof CliConnectorConfig && config.readOnly ? " read-only" : ""
  return `${config.connectorId.value}${model}${readOnly}`
}

export interface FlowRunnerDependencies {
  readonly registry: ConnectorRegistryShape
  readonly process: ProcessExecutorShape
  readonly files: PlainFileStoreShape
  /** pi's own model config (ADR 0016), injectable so a test never reads $HOME. */
  readonly readPiModelsJson?: () => string | undefined
  /** For the hosted TypeSafe judgment backend; defaults to the Node client. */
  readonly http?: HttpClientShape
}

export interface NodeConnectorDependencies {
  readonly http: HttpClientShape
  readonly process: ProcessExecutorShape
  readonly temporaryFiles: TemporaryFilesShape
  readonly geminiCli: GeminiCliExecutorShape
}

export const nodeFlowRunnerDependencies = (): FlowRunnerDependencies => ({
  process: nodeProcessExecutor,
  files: nodePlainFileStore,
  http: nodeHttpClient,
  registry: createConnectorRegistry({
    http: nodeHttpClient,
    process: nodeProcessExecutor,
    temporaryFiles: nodeTemporaryFiles,
    geminiCli: nodeGeminiCliExecutor
  })
})

export interface FlowRunnerOptions {
  readonly workDir: string
  readonly workspace: string
  readonly userPrompt: string
  readonly coder: ConnectorConfig
  readonly reasoning?: ConnectorConfig
  readonly reviewers?: ReadonlyArray<ConnectorConfig>
  /**
   * The seat typed judgments run on (ADR 0017). Defaults to the reasoning
   * seat; point it at a small non-thinking model for one-token label scoring.
   */
  readonly judgment?: ConnectorConfig
  /**
   * `llm` (default) answers on the judgment seat; `typesafe` uses the hosted
   * Jev model with `TYPESAFE_API_KEY` from the environment. Unset, the
   * environment's `LLM4TS_JUDGMENT_BACKEND` decides, then `llm`.
   */
  readonly judgmentBackend?: JudgmentBackend
  /** Persist judgment observations under workDir/.llm4ts/judgments; off by default. */
  readonly judgmentLog?: boolean
  /**
   * Meter every seat with `EstimatedUsage`, so a backend that reports no
   * token counts still yields usage — counted from characters and
   * labelled `estimated:<model>`, never mixed with measured usage. Default
   * `true`; `false`, or `LLM4TS_ESTIMATE_USAGE=0` in the environment, leaves
   * the seats raw and those runs accrue nothing.
   */
  readonly estimateUsage?: boolean
  /**
   * Where the run's trace goes. Default `workDir/.llm4ts/trace-<start ms>.jsonl`
   * while `persistRun` holds.
   */
  readonly tracePath?: string
  /**
   * Append-only ledger (`CostLedger`) that receives one `CostRecord` per run
   * that accrued usage, so `llm4ts costs` and budgets can look across runs.
   * Default `workDir/.llm4ts/costs.jsonl` while `persistRun` holds.
   */
  readonly costLedgerPath?: string
  /**
   * `false` writes neither the trace nor the ledger unless their paths are
   * given explicitly. Default `true`: every run leaves its record under
   * `workDir/.llm4ts/`, which `llm4ts costs` and replay read back.
   */
  readonly persistRun?: boolean
  readonly runId?: string
  readonly verbosity?: Verbosity
  readonly surface?: TerminalSurface
  readonly environment?: Readonly<Record<string, string | undefined>>
  /**
   * Optional cost ceiling. Checked after the flow body completes, from the
   * usage the run's CostTracker accrued: exceeding it fails the run with a
   * typed BudgetExceeded. Note that enforcement is only as good as the
   * usage events published — backends without usage reporting accrue
   * nothing (see the connector capability matrix).
   */
  readonly budget?: CostBudget
}

export interface FlowRunnerBundle {
  readonly context: FlowContextShape
  readonly events: FlowEventHub
  /** The run's cost tracker, already subscribed to `events`. */
  readonly tracker: CostTracker
  readonly runId: string
  readonly judgmentLog?: JudgmentLogShape
}

const truthy = (value: string | undefined): boolean =>
  value !== undefined && ["1", "true", "yes"].includes(value.trim().toLowerCase())

const switchedOff = (value: string | undefined): boolean =>
  value !== undefined && ["0", "false", "no", "off"].includes(value.trim().toLowerCase())

const isPiSeat = (config: ConnectorConfig | undefined): config is CliConnectorConfig =>
  config instanceof CliConnectorConfig && config.connectorId.value === ConnectorIds.Pi.value

/**
 * Start the ADR 0016 bridge for a `pi`-coder run, scoped to that run, and
 * return the mapping that points pi's seats at it.
 *
 * Opting in with `LLM4TS_GEMINI_BRIDGE` but leaving pi unable to reach the
 * bridge is the failure this whole feature exists to avoid, so an
 * unresolvable model fails the run here rather than surfacing as pi's own
 * "No API key found" several layers down. A seat that already names a model
 * is left alone: an explicit choice outranks the default.
 */
const geminiBridgeSeats = Effect.fn("@llm4ts/runner/FlowRunner.geminiBridgeSeats")(function* (
  options: FlowRunnerOptions,
  dependencies: FlowRunnerDependencies,
  environment: Readonly<Record<string, string | undefined>>
): Effect.fn.Return<(config: ConnectorConfig) => ConnectorConfig, FlowError, Scope.Scope> {
  const identity = (config: ConnectorConfig): ConnectorConfig => config
  if (!truthy(environment.LLM4TS_GEMINI_BRIDGE)) {
    return identity
  }
  // The reasoning seat defaults to the coder, so a pi coder makes this a pi
  // run even when nothing else names pi.
  const seats = [options.coder, options.reasoning, ...(options.reviewers ?? [])]
  if (!seats.some(isPiSeat)) {
    return identity
  }

  const port = geminiBridgePort(environment)
  const readPiModelsJson = dependencies.readPiModelsJson ?? defaultReadPiModelsJson
  const resolution = resolveBridgeModel(
    readPiModelsJson(),
    port,
    environment.LLM4TS_GEMINI_BRIDGE_MODEL
  )
  const problem = bridgeModelProblem(resolution, port)
  if (problem !== undefined || resolution._tag !== "Resolved") {
    return yield* FlowLlmError.from(
      ProviderError.make({ message: problem ?? "no bridge model available" })
    )
  }
  const model = resolution.model

  yield* runGeminiAcpBridge({
    port: Number(port),
    cwd: options.workDir,
    executor: dependencies.process,
    ...(environment.LLM4TS_GEMINI_MODEL === undefined
      ? {}
      : { model: environment.LLM4TS_GEMINI_MODEL })
  }).pipe(Effect.mapError(FlowLlmError.from))

  return (config: ConnectorConfig): ConnectorConfig =>
    isPiSeat(config) && config.model === undefined
      ? CliConnectorConfig.make({ ...config, model })
      : config
})

export const makeFlowRunnerContext = Effect.fn("@llm4ts/runner/FlowRunner.makeContext")(function* (
  options: FlowRunnerOptions,
  dependencies: FlowRunnerDependencies
): Effect.fn.Return<FlowRunnerBundle, FlowError, Scope.Scope> {
  const events = yield* makeFlowEventHub()
  const runId = options.runId ?? `run-${(yield* Clock.currentTimeMillis).toString()}`
  const judgmentLog =
    options.judgmentLog === true
      ? yield* makeJudgmentLog({ files: dependencies.files, root: options.workDir, runId })
      : undefined
  if (judgmentLog !== undefined) yield* judgmentLog.consume(events)
  const tracker = yield* makeCostTracker()
  yield* tracker.consume(events)
  const reasoning = defaultReasoningConfig(options.coder, options.reasoning)
  // Bound to this run's scope: the bridge subprocess and its server go away
  // with the run, matching every other long-lived subprocess here (ADR 0016).
  const bridged = yield* geminiBridgeSeats(
    options,
    dependencies,
    options.environment ?? process.env
  )
  // Every seat retries transient provider failures and flaky streams (an
  // empty response or malformed tool call), announcing each attempt on the
  // run's events. Without the wrapper one hiccup from a CLI agent failed the
  // whole stage, silently.
  const resilient = (service: LlmServiceShape): Effect.Effect<LlmServiceShape> =>
    makeTransientRetry(service).pipe(Effect.provideService(FlowEvents, events))
  // A readOnly seat on a harness whose mapping is not a real capability
  // removal is a request, not a restriction (ADR 0010) — say so on the run's
  // events instead of pretending, so consumers can pick reviewer seats on
  // `capabilities.readOnlyEnforcement`.
  const announceReadOnlyGrade = (
    configuration: ConnectorConfig,
    connector: { readonly capabilities: { readonly readOnlyEnforcement: string } }
  ): Effect.Effect<void> =>
    configuration instanceof CliConnectorConfig &&
    configuration.readOnly &&
    connector.capabilities.readOnlyEnforcement !== "enforced"
      ? events.publish(
          FlowEventsValues.CapabilityUnenforceable(
            `readOnly requested from '${configuration.connectorId.value}', but its harness mapping ` +
              `is ${connector.capabilities.readOnlyEnforcement} — the flag is a request, not a ` +
              "capability removal"
          )
        )
      : Effect.void
  // Every seat is metered, so no run is silently free: a backend that reports
  // no token counts (`capabilities.usageReporting` false) is estimated from
  // character counts and labelled `estimated:<model>`, which is what makes
  // `TokensUsed` — and therefore cost summaries, budgets, the ledger, and
  // `llm4ts costs` — answer for those seats at all. Measured usage always
  // wins; the estimate only fills a gap the backend left. Metering here rather
  // than in each flow also covers the seats a flow never touches directly,
  // notably the judgment seat and the worktree seats `contextFor` rebinds.
  const runEnvironment = options.environment ?? process.env
  const estimateOptions = estimatedUsageOptionsFromEnv(runEnvironment)
  const meterUsage = options.estimateUsage ?? !switchedOff(runEnvironment.LLM4TS_ESTIMATE_USAGE)
  const metered = (service: LlmServiceShape): Effect.Effect<LlmServiceShape> =>
    meterUsage
      ? Effect.map(makeEstimatedUsageMeter(service, estimateOptions), (meter) => meter.service)
      : Effect.succeed(service)
  // The spread keeps everything the connector carries beyond the service
  // methods — notably `capabilities`, which the flow context exposes. The
  // meter decorates the retrying seat, so an estimate reflects the attempt
  // that actually succeeded, and it sees `scoreLabelSequence` when the
  // connector has one (the retry wrapper does not carry it).
  const resolveSeat = (configuration: ConnectorConfig) =>
    dependencies.registry.resolve(configuration).pipe(
      Effect.mapError(FlowLlmError.from),
      Effect.flatMap((connector) =>
        announceReadOnlyGrade(configuration, connector).pipe(
          Effect.andThen(
            Effect.flatMap(resilient(connector), (retrying) => {
              const seat = { ...connector, ...retrying }
              return Effect.map(metered(seat), (measured) => ({ ...seat, ...measured }))
            })
          )
        )
      )
    )
  // Judgment usage is metered like any chat (ADR 0005 amendment) and every
  // fallback from label scoring to the verbalized path is announced.
  const judgmentHooks = {
    onUsage: (usage: TokenUsage, model: string | undefined) =>
      events.publish(
        new TokensUsed({ agent: "judgment", usage, ...(model === undefined ? {} : { model }) })
      ),
    onFallback: (key: string, reason: string) =>
      events.publish(
        new Info({ message: `judgment '${key}' fell back to verbalized scoring: ${reason}` })
      )
  }
  const judgmentFor = (
    seat: LlmServiceShape,
    seatConfig: ConnectorConfig,
    environment: Readonly<Record<string, string | undefined>>
  ): Effect.Effect<JudgmentShape, FlowError> => {
    const backend =
      options.judgmentBackend ??
      (environment.LLM4TS_JUDGMENT_BACKEND?.trim().toLowerCase() === "typesafe"
        ? "typesafe"
        : "llm")
    if (backend !== "typesafe") {
      return Effect.succeed(
        makeLlmJudgment(
          seat,
          LlmJudgmentConfig.make({
            connector: seatConfig.connectorId.value,
            ...(seatConfig.model === undefined ? {} : { model: seatConfig.model }),
            // LLM4TS_JUDGMENT_BATCHING=shared-prefix sends each request's state
            // once with every question; anything else keeps them independent.
            ...(environment.LLM4TS_JUDGMENT_BATCHING?.trim().toLowerCase() === "shared-prefix"
              ? { batching: "shared-prefix" as const }
              : {})
          }),
          judgmentHooks
        )
      )
    }
    const key = environment.TYPESAFE_API_KEY?.trim()
    if (key === undefined || key.length === 0) {
      return Effect.fail(
        FlowLlmError.from(
          ProviderError.make({
            message: "judgment backend 'typesafe' needs TYPESAFE_API_KEY in the environment"
          })
        )
      )
    }
    return Effect.succeed(
      makeTypeSafeJudgment(
        { apiKey: Redacted.make(key), onUsage: judgmentHooks.onUsage },
        dependencies.http ?? nodeHttpClient
      )
    )
  }
  const seatsFor = Effect.fn("@llm4ts/runner/FlowRunner.seatsFor")(function* (
    workDir: string
  ): Effect.fn.Return<
    {
      readonly coder: LlmServiceShape & { readonly capabilities: ConnectorCapabilities }
      readonly reasoning: LlmServiceShape
      readonly reviewers: ReadonlyArray<LlmServiceShape>
      readonly judgment: JudgmentShape
    },
    FlowError,
    Scope.Scope
  > {
    const environment = options.environment ?? process.env
    const coder = yield* resolveSeat(prepareConnector(bridged(options.coder), workDir, environment))
    const reasoningService = yield* resolveSeat(
      prepareConnector(bridged(reasoning), workDir, environment)
    )
    const reviewers = yield* Effect.forEach(options.reviewers ?? [], (configuration) =>
      resolveSeat(prepareConnector(bridged(configuration), workDir, environment))
    )
    // The judgment seat defaults to the reasoning seat's service itself, so
    // an unconfigured run resolves nothing extra.
    const judgmentSeat =
      options.judgment === undefined
        ? reasoningService
        : yield* resolveSeat(prepareConnector(bridged(options.judgment), workDir, environment))
    const judgment = yield* judgmentFor(judgmentSeat, options.judgment ?? reasoning, environment)
    return { coder, reasoning: reasoningService, reviewers, judgment }
  })
  const contextAt = (
    workDir: string,
    seats: {
      readonly coder: LlmServiceShape & { readonly capabilities: ConnectorCapabilities }
      readonly reasoning: LlmServiceShape
      readonly reviewers: ReadonlyArray<LlmServiceShape>
      readonly judgment: JudgmentShape
    },
    rebind: boolean
  ): FlowContextShape =>
    FlowContext.of({
      reasoning: seats.reasoning,
      coder: seats.coder,
      judgment: seats.judgment,
      git: makeGitTool(dependencies.process, workDir, events),
      hosting: makeGitHubTool(dependencies.process, workDir, events),
      events,
      reviewers: seats.reviewers,
      coderCapabilities: seats.coder.capabilities,
      userPrompt: options.userPrompt,
      workDir,
      workspace: options.workspace,
      // Rebinding is one level deep: a story worktree's context has no
      // `contextFor` of its own — nothing in the design nests worktrees.
      ...(rebind
        ? {
            contextFor: (directory: string) =>
              Effect.map(seatsFor(directory), (rebound) => contextAt(directory, rebound, false))
          }
        : {})
    })
  const seats = yield* seatsFor(options.workDir)
  return {
    events,
    tracker,
    runId,
    ...(judgmentLog === undefined ? {} : { judgmentLog }),
    context: contextAt(options.workDir, seats, true)
  }
})

export const runWithBundle = Effect.fn("@llm4ts/runner/FlowRunner.runWithBundle")(function* <
  A,
  E,
  R
>(
  bundle: FlowRunnerBundle,
  options: FlowRunnerOptions,
  body: (context: FlowContextShape) => Effect.Effect<A, E, R>,
  dependencies: FlowRunnerDependencies = nodeFlowRunnerDependencies()
): Effect.fn.Return<A, E | FlowError, R | Scope.Scope> {
  const startedAt = yield* Clock.currentTimeMillis
  const environment = options.environment ?? process.env
  const verbosity = options.verbosity ?? "Normal"
  const persistRun = options.persistRun ?? true
  const tracePath =
    options.tracePath ??
    (persistRun ? join(options.workDir, ".llm4ts", `trace-${startedAt}.jsonl`) : undefined)
  const costLedgerPath =
    options.costLedgerPath ??
    (persistRun ? join(options.workDir, ".llm4ts", CostLedgerFileName) : undefined)
  const tracker = bundle.tracker
  const surface = options.surface ?? (yield* makeTerminalSurface(environment))
  const palette = surface.palette
  const terminal = yield* consumeTerminalEvents(bundle.events, surface, verbosity, {
    timestamps: environment.LLM4TS_TIMESTAMPS === "1" || environment.LLM4TS_TIMESTAMPS === "true"
  })
  if (verbosity !== "Quiet") {
    const reviewers = options.reviewers ?? []
    const seats = [
      `coder ${describeSeat(options.coder)}`,
      `reasoning ${describeSeat(defaultReasoningConfig(options.coder, options.reasoning))}`,
      ...(reviewers.length === 0 ? [] : [`reviewers ${reviewers.map(describeSeat).join(", ")}`])
    ].join(" · ")
    yield* surface.log(palette.info(`${seats} · ${options.workDir}`))
    if (tracePath !== undefined) {
      yield* surface.log(
        palette.info(
          `trace ${tracePath}${options.runId === undefined ? "" : ` · run ${options.runId}`}`
        )
      )
    }
  }
  const recorder =
    tracePath === undefined
      ? undefined
      : yield* makeFlowRecorder(dependencies.files, tracePath, bundle.runId)
  if (recorder !== undefined) {
    yield* recorder.consume(bundle.events)
  }
  yield* surface.setStatus("preparing flow")
  const budget = options.budget
  const enforceBudget =
    budget === undefined
      ? Effect.void
      : Effect.gen(function* () {
          yield* tracker.awaitDrained(bundle.events)
          const cells = yield* tracker.cells
          const at = new Date(yield* Clock.currentTimeMillis).toISOString()
          yield* checkCostBudget(
            makeCostRecord({
              runId: options.runId ?? "run",
              at,
              repo: options.workDir,
              prompt: options.userPrompt,
              cells
            }),
            budget
          )
        })
  // Runs without usage leave no record: a ledger line of zeros would only
  // inflate run counts for backends that report nothing.
  const appendLedger =
    costLedgerPath === undefined
      ? Effect.void
      : Effect.gen(function* () {
          const cells = yield* tracker.cells
          if (cells.length === 0) {
            return
          }
          yield* appendCostRecord(
            dependencies.files,
            costLedgerPath,
            makeCostRecord({
              runId: bundle.runId,
              at: new Date(startedAt).toISOString(),
              repo: options.workDir,
              prompt: options.userPrompt,
              cells
            })
          )
        }).pipe(
          Effect.catch((error) =>
            surface.log(palette.fail(`cost ledger not written: ${describeFlowError(error)}`))
          )
        )
  return yield* body(bundle.context).pipe(
    Effect.provideService(FlowContext, bundle.context),
    Effect.andThen((value) => Effect.as(enforceBudget, value)),
    Effect.ensuring(
      Effect.all(
        [
          terminal.awaitDrained(),
          tracker.awaitDrained(bundle.events),
          recorder === undefined ? Effect.void : recorder.awaitDrained(bundle.events),
          bundle.judgmentLog === undefined
            ? Effect.void
            : bundle.judgmentLog.awaitDrained(bundle.events)
        ],
        { concurrency: "unbounded" }
      ).pipe(
        Effect.andThen(appendLedger),
        Effect.andThen(surface.setStatus(undefined)),
        Effect.andThen(tracker.summary),
        Effect.flatMap((summary) => surface.log(`\n${summary}`))
      )
    ),
    Effect.tapError((error) =>
      Effect.gen(function* () {
        const finishedAt = yield* Clock.currentTimeMillis
        yield* surface.setStatus(undefined)
        yield* surface.log(
          `\n${palette.fail(
            `flow failed after ${formatDurationMs(finishedAt - startedAt)}: ${describeFlowError(error)}`
          )}`
        )
        if (tracePath !== undefined) {
          yield* surface.log(palette.info(`trace ${tracePath}`))
        }
      })
    ),
    Effect.tap(() =>
      Effect.gen(function* () {
        const finishedAt = yield* Clock.currentTimeMillis
        const stats = yield* terminal.stats
        const stages =
          stats.stagesCompleted + stats.stagesFailed === 0
            ? ""
            : ` · ${stats.stagesCompleted} stage${stats.stagesCompleted === 1 ? "" : "s"}${
                stats.stagesFailed === 0 ? "" : ` (${stats.stagesFailed} failed)`
              }`
        yield* surface.setStatus(undefined)
        yield* surface.log(
          `\n${palette.stageDone(
            `flow completed in ${formatDurationMs(finishedAt - startedAt)}${stages}`
          )}`
        )
      })
    )
  )
})

export const runEmbedded = Effect.fn("@llm4ts/runner/FlowRunner.runEmbedded")(function* <A, E, R>(
  options: FlowRunnerOptions,
  body: (context: FlowContextShape) => Effect.Effect<A, E, R>,
  dependencies: FlowRunnerDependencies = nodeFlowRunnerDependencies()
): Effect.fn.Return<A, E | FlowError, R | Scope.Scope> {
  const bundle = yield* makeFlowRunnerContext(options, dependencies)
  return yield* runWithBundle(bundle, options, body, dependencies)
})

export const runNode = <A, E, R>(
  options: FlowRunnerOptions,
  body: (context: FlowContextShape) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | FlowError, R> => Effect.scoped(runEmbedded(options, body))

const mainErrorMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : String(error)

export const runFlowMain = <E>(program: Effect.Effect<void, E>): void => {
  Effect.runFork(
    program.pipe(
      Effect.match({
        onFailure: (error) =>
          Effect.sync(() => {
            process.stderr.write(`${mainErrorMessage(error)}\n`)
            process.exitCode = 1
          }),
        onSuccess: () => Effect.void
      }),
      Effect.flatten
    )
  )
}
