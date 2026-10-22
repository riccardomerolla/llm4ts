import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import type * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import type { ServeError } from "effect/http/HttpServerError"
import type { PersistenceError } from "@llm4ts/flow/FlowError"
import { nodeListTraces } from "@llm4ts/runner/Costs"
import { collectDoctorReport } from "@llm4ts/runner/Doctor"
import { httpProbe, rosterReport } from "@llm4ts/runner/ExecutorRoster"
import { interruptOnSignal, type SignalSource } from "@llm4ts/runner/FlowRunner"
import { nodePlainFileStore } from "@llm4ts/runner/NodePlainFileStore"
import { nodeTranscriptFiles } from "@llm4ts/runner/Transcripts"
import { nodeListEpics } from "@llm4ts/runner/Watch"
import { discoverFlows, type FlowTierPaths } from "./FlowCatalog.ts"
import { nodeFlowProcess, type FlowProcessShape } from "./FlowProcess.ts"
import type { OperatorConfig } from "./OperatorConfig.ts"
import { runOperatorServer } from "./OperatorServer.ts"
import type { OperatorDeps } from "./OperatorTools.ts"
import { makeRunSupervisor } from "./RunSupervisor.ts"

/**
 * The Node side of `llm4ts mcp` (ADR 0041): the operator's dependencies over
 * the real file system and processes, and `runMcp`, which serves until the
 * server fails or a SIGINT/SIGTERM interrupts it, then stops the flows it
 * started before returning.
 */

/** Everything `runMcp` needs besides the run supervisor, which it builds itself. */
export interface McpRuntime<E> {
  readonly operator: Omit<OperatorDeps, "supervisor">
  readonly flowProcess: FlowProcessShape
  /** The server; `runOperatorServer` on Node, a stand-in in tests. */
  readonly serve: (config: OperatorConfig, deps: OperatorDeps) => Effect.Effect<never, E>
  /** How long stopping a run waits after SIGINT before SIGTERM; the supervisor's default when absent. */
  readonly graceMs?: number
}

/**
 * Serves the operator until the server ends or a signal arrives. The first
 * SIGINT or SIGTERM interrupts the server; closing the scope then runs the
 * supervisor's finalizer, which stops every flow it started. A second signal
 * exits at once (130 or 143). The handlers are removed on the way out.
 */
export const runMcp = <E>(
  config: OperatorConfig,
  runtime: McpRuntime<E>,
  signals: SignalSource
): Effect.Effect<void, E | PersistenceError> => {
  const disposers: Array<() => void> = []
  return Effect.scoped(
    Effect.gen(function* () {
      const supervisor = yield* makeRunSupervisor({
        repos: config.repos,
        environment: runtime.operator.environment,
        files: runtime.operator.files,
        process: runtime.flowProcess,
        parallelRuns: config.parallelRuns,
        ...(runtime.graceMs === undefined ? {} : { graceMs: runtime.graceMs })
      })
      const fiber = yield* Effect.forkScoped(
        runtime.serve(config, { ...runtime.operator, supervisor })
      )
      disposers.push(interruptOnSignal(fiber, signals, "SIGINT"))
      disposers.push(interruptOnSignal(fiber, signals, "SIGTERM"))
      return yield* Fiber.join(fiber)
    })
  ).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        for (const dispose of disposers) dispose()
      })
    )
  )
}

/** A file's text, or `undefined` when it cannot be read (the `mcp` config and token file). */
export const nodeRead = (path: string): Effect.Effect<string | undefined> =>
  Effect.sync(() => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return undefined
    }
  })

/**
 * Relative paths of every regular file under a directory, recursively; never
 * directory names, and none when the directory is absent or unreadable.
 */
export const nodeListFiles = (directory: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  const walk = (relative: string): void => {
    let names: ReadonlyArray<{
      readonly name: string
      isDirectory(): boolean
      isFile(): boolean
    }>
    try {
      names = readdirSync(join(directory, relative), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of names) {
      const path = relative.length === 0 ? entry.name : join(relative, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else if (entry.isFile()) {
        found.push(path)
      }
    }
  }
  walk("")
  return found.sort()
}

/**
 * The operator's dependencies on Node. `tierPaths` gives the flow tiers for a
 * repository (the CLI's `shellTierPaths`, passed in to keep this module free
 * of the CLI).
 */
export const nodeOperatorRuntime = (
  config: OperatorConfig,
  tierPaths: (repoPath: string) => FlowTierPaths,
  environment: Readonly<Record<string, string | undefined>> = process.env
): McpRuntime<ServeError | Cause.IllegalArgumentError> => ({
  operator: {
    config,
    files: nodePlainFileStore,
    listTraces: nodeListTraces,
    listEpics: nodeListEpics,
    listFiles: nodeListFiles,
    transcripts: nodeTranscriptFiles,
    doctor: collectDoctorReport(),
    roster: (repoPath) =>
      rosterReport({ files: nodePlainFileStore, environment, workDir: repoPath }),
    probe: httpProbe,
    flows: (repoPath) =>
      discoverFlows(tierPaths(repoPath)).pipe(Effect.provide(NodeFileSystem.layer)),
    now: Clock.currentTimeMillis,
    environment
  },
  flowProcess: nodeFlowProcess,
  serve: runOperatorServer
})
