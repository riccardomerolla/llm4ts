import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { ConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { CliConnectorConfig, defaultReasoningConfig } from "@llm4ts/core/ConnectorConfig"
import type { ConnectorRegistryShape } from "@llm4ts/core/ConnectorRegistry"
import type { HttpClientShape } from "@llm4ts/core/HttpClient"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import type { TemporaryFilesShape } from "@llm4ts/core/TemporaryFiles"
import type { GeminiCliExecutorShape } from "@llm4ts/core/providers/GeminiCliProvider"
import { createConnectorRegistry } from "@llm4ts/core/providers/ConnectorFactories"
import { makeCostTracker } from "@llm4ts/flow/CostTracker"
import { FlowLlmError, type FlowError } from "@llm4ts/flow/FlowError"
import { makeFlowEventHub, type FlowEventHub } from "@llm4ts/flow/FlowEvents"
import { FlowContext, type FlowContextShape } from "@llm4ts/flow/FlowContext"
import { makeFlowRecorder } from "@llm4ts/flow/FlowRecorder"
import { makeGitHubTool } from "@llm4ts/flow/GitHubTool"
import { makeGitTool } from "@llm4ts/flow/GitTool"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
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
}

export interface FlowRunnerBundle {
  readonly context: FlowContextShape
  readonly events: FlowEventHub
}

export const makeFlowRunnerContext = Effect.fn("@llm4ts/runner/FlowRunner.makeContext")(function* (
  options: FlowRunnerOptions,
  dependencies: FlowRunnerDependencies
): Effect.fn.Return<FlowRunnerBundle, FlowError> {
  const events = yield* makeFlowEventHub()
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
  const coder = yield* dependencies.registry
    .resolve(coderConfig)
    .pipe(Effect.mapError(FlowLlmError.from))
  const reasoningService = yield* dependencies.registry
    .resolve(reasoningPrepared)
    .pipe(Effect.mapError(FlowLlmError.from))
  const reviewers = yield* Effect.forEach(options.reviewers ?? [], (configuration) =>
    dependencies.registry
      .resolve(prepareConnector(configuration, options.workDir, options.environment ?? process.env))
      .pipe(Effect.mapError(FlowLlmError.from))
  )
  return {
    events,
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
  const tracker = yield* makeCostTracker()
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
  yield* tracker.consume(bundle.events)
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
  return yield* body(bundle.context).pipe(
    Effect.provideService(FlowContext, bundle.context),
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
            `flow failed after ${formatDurationMs(finishedAt - startedAt)}: ${
              error instanceof Error ? error.message : String(error)
            }`
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
