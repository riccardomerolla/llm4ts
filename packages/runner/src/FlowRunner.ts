import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { ConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { CliConnectorConfig, defaultReasoningConfig } from "@llm4ts/core/ConnectorConfig"
import type { ConnectorRegistryShape } from "@llm4ts/core/ConnectorRegistry"
import type { HttpClientShape } from "@llm4ts/core/HttpClient"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import type { TemporaryFilesShape } from "@llm4ts/core/TemporaryFiles"
import type { GeminiCliExecutorShape } from "@llm4ts/core/providers/GeminiCliProvider"
import { createConnectorRegistry } from "@llm4ts/core/providers/ConnectorFactories"
import { makeCostTracker, type CostTracker } from "@llm4ts/flow/CostTracker"
import { checkCostBudget, makeCostRecord, type CostBudget } from "@llm4ts/flow/CostLedger"
import { FlowLlmError, describeFlowError, type FlowError } from "@llm4ts/flow/FlowError"
import {
  FlowEvents,
  FlowEventsValues,
  makeFlowEventHub,
  type FlowEventHub
} from "@llm4ts/flow/FlowEvents"
import { FlowContext, type FlowContextShape } from "@llm4ts/flow/FlowContext"
import { makeFlowRecorder } from "@llm4ts/flow/FlowRecorder"
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
  readonly tracePath?: string
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
}

export const makeFlowRunnerContext = Effect.fn("@llm4ts/runner/FlowRunner.makeContext")(function* (
  options: FlowRunnerOptions,
  dependencies: FlowRunnerDependencies
): Effect.fn.Return<FlowRunnerBundle, FlowError, Scope.Scope> {
  const events = yield* makeFlowEventHub()
  const tracker = yield* makeCostTracker()
  yield* tracker.consume(events)
  const coderConfig = prepareConnector(
    options.coder,
    options.workDir,
    options.environment ?? process.env
  )
  const reasoning = defaultReasoningConfig(options.coder, options.reasoning)
  const reasoningPrepared = prepareConnector(
    reasoning,
    options.workDir,
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
  // The spread keeps everything the connector carries beyond the service
  // methods — notably `capabilities`, which the flow context exposes.
  const resolveSeat = (configuration: ConnectorConfig) =>
    dependencies.registry.resolve(configuration).pipe(
      Effect.mapError(FlowLlmError.from),
      Effect.flatMap((connector) =>
        announceReadOnlyGrade(configuration, connector).pipe(
          Effect.andThen(
            Effect.map(resilient(connector), (retrying) => ({ ...connector, ...retrying }))
          )
        )
      )
    )
  const coder = yield* resolveSeat(coderConfig)
  const reasoningService = yield* resolveSeat(reasoningPrepared)
  const reviewers = yield* Effect.forEach(options.reviewers ?? [], (configuration) =>
    resolveSeat(
      prepareConnector(configuration, options.workDir, options.environment ?? process.env)
    )
  )
  return {
    events,
    tracker,
    context: FlowContext.of({
      reasoning: reasoningService,
      coder,
      git: makeGitTool(dependencies.process, options.workDir, events),
      hosting: makeGitHubTool(dependencies.process, options.workDir, events),
      events,
      reviewers,
      coderCapabilities: coder.capabilities,
      userPrompt: options.userPrompt,
      workDir: options.workDir,
      workspace: options.workspace
    })
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
    if (options.tracePath !== undefined) {
      yield* surface.log(
        palette.info(
          `trace ${options.tracePath}${options.runId === undefined ? "" : ` · run ${options.runId}`}`
        )
      )
    }
  }
  const recorder =
    options.tracePath === undefined
      ? undefined
      : yield* makeFlowRecorder(
          dependencies.files,
          options.tracePath,
          options.runId ?? `run-${(yield* Clock.currentTimeMillis).toString()}`
        )
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
  return yield* body(bundle.context).pipe(
    Effect.provideService(FlowContext, bundle.context),
    Effect.andThen((value) => Effect.as(enforceBudget, value)),
    Effect.ensuring(
      Effect.all(
        [
          terminal.awaitDrained(),
          tracker.awaitDrained(bundle.events),
          recorder === undefined ? Effect.void : recorder.awaitDrained(bundle.events)
        ],
        { concurrency: "unbounded" }
      ).pipe(
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
        if (options.tracePath !== undefined) {
          yield* surface.log(palette.info(`trace ${options.tracePath}`))
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
