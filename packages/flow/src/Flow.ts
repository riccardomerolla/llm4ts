import * as Effect from "effect/Effect"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { collect } from "@llm4ts/core/Streaming"
import { makeChat } from "./Chat.ts"
import type { FlowContextShape } from "./FlowContext.ts"
import { FlowLlmError, type FlowError } from "./FlowError.ts"
import { AssistantMessage, type FlowEventsShape } from "./FlowEvents.ts"
import type { Plan, Task } from "./Plan.ts"
import type { PlanStoreShape } from "./Persistence.ts"
import { implementTaskLoop, stage } from "./PlanExecution.ts"
import { minimalReviewers, reviewAndFixLoop, type ReviewResult } from "./Review.ts"
import type { Reviewer } from "./Reviewer.ts"

export const flowReviewer = (context: FlowContextShape): LlmServiceShape =>
  context.reviewers[0] ?? context.reasoning

export const completeAndPublish = Effect.fn("@llm4ts/flow/Flow.completeAndPublish")(function* (
  service: LlmServiceShape,
  events: FlowEventsShape,
  prompt: string
): Effect.fn.Return<string, FlowLlmError> {
  const response = yield* collect(service.executeStream(prompt)).pipe(
    Effect.mapError(FlowLlmError.from)
  )
  yield* events.publish(AssistantMessage.make({ text: response.content }))
  return response.content
})

export interface ImplementPlanOptions {
  readonly store: PlanStoreShape
  readonly planPath: string
  readonly plan: Effect.Effect<Plan, FlowError>
  readonly system?: string
  readonly reviewers?: ReadonlyArray<Reviewer>
  readonly commitMessage?: (plan: Plan, task: Task) => string
  readonly checkoutBranch?: boolean
  readonly maxRounds?: number
  readonly lint?: Effect.Effect<ReviewResult, FlowError>
  readonly format?: Effect.Effect<void, FlowError>
}

const defaultCommitMessage = (plan: Plan, task: Task): string => `${plan.epicId}: ${task.title}`

export const implementPlanFlow = Effect.fn("@llm4ts/flow/Flow.implementPlan")(function* (
  context: FlowContextShape,
  options: ImplementPlanOptions
): Effect.fn.Return<Plan, FlowError> {
  const plan = yield* options.store.recoverOrCreate(options.planPath, options.plan)
  if (options.checkoutBranch !== false) {
    yield* stage(context.events, "branch", context.git.checkoutOrCreate(plan.epicId))
  }
  const coder = yield* makeChat(context.coder, {
    ...(options.system === undefined ? {} : { system: options.system })
  })
  return yield* implementTaskLoop(options.store, context.events, options.planPath, plan, (task) =>
    Effect.gen(function* () {
      yield* coder.ask(plan.taskPrompt(task))
      yield* reviewAndFixLoop({
        reviewers: options.reviewers ?? minimalReviewers,
        reviewerService: flowReviewer(context),
        coder,
        taskTitle: task.title,
        currentDiff: context.git.diff,
        events: context.events,
        ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
        ...(options.lint === undefined ? {} : { lint: options.lint }),
        ...(options.format === undefined ? {} : { format: options.format })
      })
      yield* context.git.commitAll((options.commitMessage ?? defaultCommitMessage)(plan, task))
    })
  )
})
