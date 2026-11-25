import * as Schema from "effect/Schema"

/**
 * What crosses Temporal's boundary (ADR 0060): activity inputs and results. Everything here lands in workflow history, which is
 * persisted in plain text, so nothing here may carry a secret.
 *
 * Workflow code imports these as types only: the workflow bundle must not
 * pull `effect` in.
 */

const SettingsMap = Schema.Record(Schema.String, Schema.String)

/** One `llm4ts run` on a checkout. */
export const FlowRunInput = Schema.Struct({
  /** Absolute path of the checkout on the worker's machine. */
  repo: Schema.String,
  /** The flow's name, as `llm4ts list` shows it. */
  flow: Schema.String,
  /** Flags of `llm4ts run` itself, before the flow's name (`--roster none`). */
  runFlags: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The flow's own arguments. */
  args: Schema.Array(Schema.String),
  /** `LLM4TS_*` settings for this run; a secret setting is refused. */
  settings: Schema.optionalKey(SettingsMap)
})
export type FlowRunInput = typeof FlowRunInput.Type

/** How a flow run that the activity reports as done ended. */
export const FlowRunResult = Schema.Struct({
  /** The run that did the work: its trace and its cost lines carry this id. */
  runId: Schema.String,
  tracePath: Schema.String,
  outcome: Schema.Literal("completed"),
  /** The activity attempt that returned this result. */
  attempt: Schema.Int,
  /** True when the work was done by a run an earlier attempt started. */
  adopted: Schema.Boolean
})
export type FlowRunResult = typeof FlowRunResult.Type

/** A command for a live epic's control inbox (ADR 0057). */
export const SteerInput = Schema.Struct({
  repo: Schema.String,
  /** The epic's state folder name under `.llm4ts/epics/`. */
  epic: Schema.String,
  /** Stable per command: a retried activity writes the command once. */
  id: Schema.String,
  /** Recorded, not authenticated. */
  by: Schema.String,
  action: Schema.Literals(["retry", "skip"]),
  story: Schema.String,
  /** Why the story is skipped; required for `skip`. */
  reason: Schema.optionalKey(Schema.String)
})
export type SteerInput = typeof SteerInput.Type

export const SteerResult = Schema.Struct({
  id: Schema.String,
  /** False when the log already held a command with this id. */
  written: Schema.Boolean
})
export type SteerResult = typeof SteerResult.Type

/** A story to retry or skip, as a workflow signal carries it. */
export interface StorySteer {
  readonly epic: string
  readonly story: string
  readonly reason?: string
}

/** Why an activity attempt did not end with a completed run. */
export const FailureType = Schema.Literals([
  /** The request cannot run as written. Final. */
  "InvalidRequest",
  /** The flow ran and ended failed: a red epic, a failed gate, a stopped plan. Final. */
  "FlowFailed",
  /** A task was cut off too often and is not started again (ADR 0056). Final. */
  "TaskCutOff",
  /** Another run is writing the checkout (ADR 0058). Retried. */
  "CheckoutBusy",
  /** The run was interrupted or its process died before it ended. Retried. */
  "RunCutOff",
  /** The `llm4ts` process could not be started or ended before a run began. Retried. */
  "LaunchFailed"
])
export type FailureType = typeof FailureType.Type

/** The typed failure of the activity programs; mapped to an `ApplicationFailure` at the boundary. */
export class FlowRunFailure extends Schema.TaggedError<FlowRunFailure>()("FlowRunFailure", {
  type: FailureType,
  retryable: Schema.Boolean,
  message: Schema.String,
  runId: Schema.optionalKey(Schema.String)
}) {}
