import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo
} from "@temporalio/workflow"
import type {
  FlowRunInput,
  FlowRunResult,
  SteerInput,
  SteerResult,
  StorySteer
} from "./Contract.ts"
import {
  flowActivityOptions,
  steerActivityOptions,
  steerIdFor,
  type FlowActivityOverrides
} from "./Policy.ts"

/**
 * The workflow of the integration (ADR 0060). This file is loaded by
 * Temporal's workflow bundler into its sandbox, so it imports only
 * `@temporalio/workflow`, types, and the pure `Policy` module, and it is
 * written against Temporal's promise API: workflow code must be
 * deterministic and cannot run an Effect runtime.
 */

interface Activities {
  readonly runFlow: (input: FlowRunInput) => Promise<FlowRunResult>
  readonly steerRun: (input: SteerInput) => Promise<SteerResult>
}

/** Runs a story that failed in the live run again. */
export const retryStory = defineSignal<[StorySteer]>("retryStory")
/** Leaves a story out; `reason` is required. */
export const skipStory = defineSignal<[StorySteer]>("skipStory")

export interface FlowRunState {
  readonly phase: "running" | "completed" | "failed"
  /** Commands sent to the control inbox so far, oldest first. */
  readonly steered: ReadonlyArray<SteerResult>
}
export const flowRunState = defineQuery<FlowRunState>("flowRunState")

export interface FlowRunRequest extends FlowRunInput {
  readonly activity?: FlowActivityOverrides
}

/**
 * One flow run on one checkout. Cancelling the workflow stops the run and
 * closes the workflow only after the run is gone. `retryStory` and
 * `skipStory` reach the live epic through its control inbox.
 */
export async function flowRun(request: FlowRunRequest): Promise<FlowRunResult> {
  const { activity, ...input } = request
  const { runFlow } = proxyActivities<Activities>(flowActivityOptions(activity))
  const { steerRun } = proxyActivities<Activities>(steerActivityOptions)
  const workflowId = workflowInfo().workflowId

  let phase: FlowRunState["phase"] = "running"
  const steered: Array<SteerResult> = []
  let sent = 0
  let pending = 0
  const steer = async (action: SteerInput["action"], story: StorySteer): Promise<void> => {
    // The id is taken before the first await, so signals keep their order.
    sent += 1
    const id = steerIdFor(workflowId, sent)
    pending += 1
    try {
      steered.push(
        await steerRun({
          repo: input.repo,
          epic: story.epic,
          id,
          by: `temporal:${workflowId}`,
          action,
          story: story.story,
          ...(story.reason === undefined ? {} : { reason: story.reason })
        })
      )
    } finally {
      pending -= 1
    }
  }
  setHandler(retryStory, (story) => steer("retry", story))
  setHandler(skipStory, (story) => steer("skip", story))
  setHandler(flowRunState, () => ({ phase, steered: [...steered] }))

  try {
    const result = await runFlow(input)
    phase = "completed"
    return result
  } catch (error) {
    phase = "failed"
    throw error
  } finally {
    // A command accepted just before the run ended is still written.
    await condition(() => pending === 0)
  }
}
