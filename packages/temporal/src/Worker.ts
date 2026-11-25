import { fileURLToPath } from "node:url"
import { makeFlowActivities, type FlowActivities, type FlowActivityTimings } from "./Activities.ts"
import type { FlowHost } from "./FlowHost.ts"
import { makeNodeFlowHost, type NodeFlowHostOptions } from "./NodeFlowHost.ts"
import { workerDefaults } from "./Policy.ts"

/**
 * What a Temporal worker needs to run llm4ts flows (ADR 0060), as plain
 * options for `Worker.create` from `@temporalio/worker`:
 *
 *     const worker = await Worker.create({ ...flowWorkerOptions(), connection, taskQueue })
 *
 * The package does not depend on `@temporalio/worker`: the worker process is
 * the application's.
 */
export interface FlowWorkerOptions {
  /** The file Temporal's bundler loads the workflow from. */
  readonly workflowsPath: string
  readonly activities: FlowActivities
  /** Milliseconds. */
  readonly maxHeartbeatThrottleInterval: number
  /** Milliseconds. */
  readonly defaultHeartbeatThrottleInterval: number
}

export interface FlowWorkerSettings extends NodeFlowHostOptions {
  /** A host other than the Node one; `cli` and `environment` are then ignored. */
  readonly host?: FlowHost
  readonly timings?: FlowActivityTimings
}

export const flowWorkerOptions = (settings: FlowWorkerSettings = {}): FlowWorkerOptions => ({
  workflowsPath: fileURLToPath(new URL("./Workflows.js", import.meta.url)),
  activities: makeFlowActivities(settings.host ?? makeNodeFlowHost(settings), settings.timings),
  ...workerDefaults
})
