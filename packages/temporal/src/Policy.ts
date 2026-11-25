import type { FailureType } from "./Contract.ts"

/**
 * The rules of the integration as plain data and pure functions (ADR 0060),
 * so they are tested without a Temporal server and are safe to load into a
 * workflow bundle: nothing here imports a runtime module.
 */

/** Failures a retry cannot change; the retry policy never retries them. */
export const finalFailures: ReadonlyArray<FailureType> = [
  "InvalidRequest",
  "FlowFailed",
  "TaskCutOff"
]

export const isRetryable = (type: FailureType): boolean => !finalFailures.includes(type)

/** A duration as Temporal reads it. */
type Span = `${number} ${"second" | "seconds" | "minute" | "minutes" | "hour" | "hours"}`

export interface FlowActivityOptions {
  readonly startToCloseTimeout: Span
  readonly heartbeatTimeout: Span
  readonly cancellationType: "WAIT_CANCELLATION_COMPLETED"
  readonly retry: {
    readonly initialInterval: Span
    readonly backoffCoefficient: number
    readonly maximumInterval: Span
    readonly maximumAttempts: number
    readonly nonRetryableErrorTypes: Array<string>
  }
}

export interface FlowActivityOverrides {
  /** How long one attempt may run; default 24 hours. */
  readonly startToCloseTimeout?: Span
  /** Attempts in all, the first included; default 4. */
  readonly maximumAttempts?: number
}

/**
 * Options of the `runFlow` activity.
 *
 * - `WAIT_CANCELLATION_COMPLETED`: a cancelled workflow closes only after the
 *   activity has stopped its flow, so the next workflow never meets a live run.
 * - A short heartbeat timeout: the worker delivers a cancellation with a
 *   heartbeat's answer, and it throttles heartbeats to a fraction of this.
 * - A bounded retry: attempts end, and a failure a retry cannot change is
 *   not retried at all.
 */
export const flowActivityOptions = (
  overrides: FlowActivityOverrides = {}
): FlowActivityOptions => ({
  startToCloseTimeout: overrides.startToCloseTimeout ?? "24 hours",
  heartbeatTimeout: "20 seconds",
  cancellationType: "WAIT_CANCELLATION_COMPLETED",
  retry: {
    initialInterval: "10 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
    maximumAttempts: overrides.maximumAttempts ?? 4,
    nonRetryableErrorTypes: [...finalFailures]
  }
})

/** Options of the `steerRun` activity: a short file append, safe to repeat. */
export const steerActivityOptions: {
  readonly startToCloseTimeout: Span
  readonly retry: FlowActivityOptions["retry"]
} = {
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "10 seconds",
    maximumAttempts: 5,
    nonRetryableErrorTypes: ["InvalidRequest"]
  }
}

/**
 * Worker options the activity relies on, in milliseconds. The default
 * heartbeat throttle is 80% of the heartbeat timeout, capped at 60 s; this
 * cap keeps a cancellation from waiting longer than five seconds for the
 * next heartbeat.
 */
export const workerDefaults = {
  maxHeartbeatThrottleInterval: 5_000,
  defaultHeartbeatThrottleInterval: 5_000
} as const

/** How the `llm4ts` process and its run ended. */
export interface RunEnding {
  /** The process's exit code; absent when a signal ended it. */
  readonly exitCode?: number
  /** The trace's last line, when the run wrote one. */
  readonly ended?: { readonly outcome: string; readonly error?: string }
  /** Another run holds the checkout now. */
  readonly busy: boolean
}

export type Verdict =
  | { readonly _tag: "Completed" }
  | { readonly _tag: "Failed"; readonly type: FailureType; readonly message: string }

/**
 * What an ending means. The exit code alone is not trusted: a run counts as
 * completed only when the process exited 0 and its trace says `completed`.
 */
export const classifyEnding = (ending: RunEnding): Verdict => {
  const { ended, exitCode } = ending
  if (ended === undefined) {
    if (ending.busy) {
      return {
        _tag: "Failed",
        type: "CheckoutBusy",
        message: "another run is writing the checkout"
      }
    }
    return exitCode === undefined || exitCode === 0 || exitCode >= 128
      ? {
          _tag: "Failed",
          type: "RunCutOff",
          message: "the run's process ended before the run wrote how it ended"
        }
      : {
          _tag: "Failed",
          type: "LaunchFailed",
          message: `llm4ts exited ${exitCode} before a run began`
        }
  }
  if (ended.outcome === "completed") {
    return exitCode === 0 || exitCode === undefined
      ? { _tag: "Completed" }
      : {
          _tag: "Failed",
          type: "FlowFailed",
          message: `the run recorded completed but llm4ts exited ${exitCode}`
        }
  }
  if (ended.outcome === "interrupted") {
    return { _tag: "Failed", type: "RunCutOff", message: "the run was interrupted" }
  }
  if (ended.error === "CheckoutBusy") {
    return { _tag: "Failed", type: "CheckoutBusy", message: "another run is writing the checkout" }
  }
  if (ended.error === "TaskCutOff") {
    return {
      _tag: "Failed",
      type: "TaskCutOff",
      message: "a task was cut off too often and is not started again"
    }
  }
  return {
    _tag: "Failed",
    type: "FlowFailed",
    message: `the run ended failed${ended.error === undefined ? "" : ` (${ended.error})`}`
  }
}

const safe = (text: string): string => text.replace(/[^A-Za-z0-9._-]/g, "_")

/**
 * The run id of one activity attempt. It is derived, not random: a worker
 * that died before its first heartbeat still names the same run when the
 * attempt is looked for.
 */
export const runIdFor = (workflowId: string, activityId: string, attempt: number): string =>
  `tw-${safe(workflowId)}-${safe(activityId)}-${attempt}`

/** The id of the nth command a workflow sends to a control inbox. */
export const steerIdFor = (workflowId: string, sequence: number): string =>
  `tw-${safe(workflowId)}-steer-${sequence}`

/** Variables of a Temporal worker that no process below the flow has a use for. */
export const withheldFromChildren = "TEMPORAL_*"

/** A drop list (ADR 0059) with the worker's own variables added. */
export const dropListWith = (names: ReadonlyArray<string> | undefined): string =>
  [...new Set([...(names ?? []).map((name) => name.trim()), withheldFromChildren])]
    .filter((name) => name.length > 0)
    .join(",")
