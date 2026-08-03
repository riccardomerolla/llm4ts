import * as Effect from "effect/Effect"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { collect } from "@llm4ts/core/Streaming"
import { withToolActivity } from "./Activity.ts"
import { makeChat, type Chat } from "./Chat.ts"
import type { FlowContextShape } from "./FlowContext.ts"
import { FlowAborted, FlowLlmError, type FlowError } from "./FlowError.ts"
import { AssistantMessage, Info, TokensUsed, type FlowEventsShape } from "./FlowEvents.ts"
import type { Plan, Task } from "./Plan.ts"
import type { PlanStoreShape } from "./Persistence.ts"
import { implementTaskLoop, stage } from "./PlanExecution.ts"
import { minimalReviewers, reviewAndFixLoop, type ReviewResult } from "./Review.ts"
import type { Reviewer } from "./Reviewer.ts"

export { publishUsage, structuredAndPublish } from "./Usage.ts"

export const flowReviewer = (context: FlowContextShape): LlmServiceShape =>
  context.reviewers[0] ?? context.reasoning

export const completeAndPublish = Effect.fn("@llm4ts/flow/Flow.completeAndPublish")(function* (
  service: LlmServiceShape,
  events: FlowEventsShape,
  prompt: string
): Effect.fn.Return<string, FlowLlmError> {
  const response = yield* collect(withToolActivity(events, service.executeStream(prompt))).pipe(
    Effect.mapError(FlowLlmError.from)
  )
  if (response.usage !== undefined) {
    yield* events.publish(
      TokensUsed.make({
        agent: "assistant",
        usage: response.usage,
        ...(response.metadata.model === undefined ? {} : { model: response.metadata.model })
      })
    )
  }
  yield* events.publish(AssistantMessage.make({ text: response.content }))
  return response.content
})

export interface ImplementPlanOptions {
  readonly store: PlanStoreShape
  readonly planPath: string
  readonly plan: Effect.Effect<Plan, FlowError>
  readonly system?: string
  /**
   * When true, each task gets a fresh Chat (system prompt plus the plan's
   * current render, showing prior tasks' completion status); that task's
   * review-fix rounds share the same Chat. When false or omitted (default),
   * one Chat is shared across every task in the plan.
   */
  readonly chatPerTask?: boolean
  readonly reviewers?: ReadonlyArray<Reviewer>
  readonly commitMessage?: (plan: Plan, task: Task) => string
  readonly checkoutBranch?: boolean
  readonly maxRounds?: number
  readonly lint?: Effect.Effect<ReviewResult, FlowError>
  readonly format?: Effect.Effect<void, FlowError>
  /**
   * What to do when a task produces no file changes and the coder does not
   * confirm TASK_ALREADY_SATISFIED. "fail" (default) aborts the flow —
   * the safe reading when nothing downstream re-checks the work. "complete"
   * marks the task complete with an Info notice — for pipelines whose final
   * state is judged downstream anyway (a CI gate, a fresh-context review),
   * where one unconfirmed no-op should not sink otherwise-finished work.
   */
  readonly noopTaskPolicy?: "fail" | "complete"
}

const defaultCommitMessage = (plan: Plan, task: Task): string => `${plan.epicId}: ${task.title}`

const composeSystem = (base: string | undefined, note: string): string =>
  [base, note].filter((part): part is string => part !== undefined && part.length > 0).join("\n\n")

export const implementPlanFlow = Effect.fn("@llm4ts/flow/Flow.implementPlan")(function* (
  context: FlowContextShape,
  options: ImplementPlanOptions
): Effect.fn.Return<Plan, FlowError> {
  const plan = yield* options.store.recoverOrCreate(options.planPath, options.plan)
  if (options.checkoutBranch !== false) {
    yield* stage(context.events, "branch", context.git.checkoutOrCreate(plan.epicId))
  }
  let sharedCoder: Chat | undefined
  if (options.chatPerTask !== true) {
    sharedCoder = yield* makeChat(context.coder, {
      events: context.events,
      agent: "coder",
      ...(options.system === undefined ? {} : { system: options.system })
    })
  }

  return yield* implementTaskLoop(
    options.store,
    context.events,
    options.planPath,
    plan,
    (task, planSoFar) =>
      Effect.gen(function* () {
        // `sharedCoder`'s definedness mirrors `options.chatPerTask !== true`
        // above: when it's set, every task reuses it; when it's undefined,
        // chatPerTask is active and each task builds its own fresh Chat.
        let coder: Chat
        if (sharedCoder !== undefined) {
          coder = sharedCoder
        } else {
          coder = yield* makeChat(context.coder, {
            events: context.events,
            agent: "coder",
            system: composeSystem(options.system, planSoFar.render)
          })
        }
        // `plan.taskPrompt` deliberately reads the frozen `plan` captured at
        // the top of this function: a task prompt only needs that task's own
        // details. `planSoFar`, threaded through by implementTaskLoop, is the
        // single source of truth for completion progress instead.
        yield* coder.ask(plan.taskPrompt(task))
        const produced = yield* context.git.diffAll
        if (produced.trim().length === 0) {
          // An empty diff is ambiguous: the task may be genuinely satisfied
          // already, or the coder may simply have produced nothing. Ask
          // explicitly instead of inferring from absence; a task that
          // produces no changes and no confirmation fails rather than being
          // silently marked complete.
          const confirmation = yield* coder.ask(
            [
              "Your previous turn produced no file changes.",
              `If the task "${task.title}" is already fully satisfied by the current state of the repository, reply with exactly TASK_ALREADY_SATISFIED and nothing else.`,
              "Otherwise, implement the task now."
            ].join("\n")
          )
          const afterConfirmation = yield* context.git.diffAll
          if (afterConfirmation.trim().length === 0) {
            if (confirmation.includes("TASK_ALREADY_SATISFIED")) {
              yield* context.events.publish(
                Info.make({
                  message: `task "${task.title}" confirmed already satisfied; skipping review and commit`
                })
              )
              return
            }
            if (options.noopTaskPolicy === "complete") {
              yield* context.events.publish(
                Info.make({
                  message: `task "${task.title}" produced no changes without confirming TASK_ALREADY_SATISFIED; marking complete per noopTaskPolicy`
                })
              )
              return
            }
            return yield* FlowAborted.make({
              message: `task "${task.title}" produced no changes and did not confirm TASK_ALREADY_SATISFIED; failing instead of marking it complete`
            })
          }
        }
        yield* reviewAndFixLoop({
          reviewers: options.reviewers ?? minimalReviewers,
          reviewerService: flowReviewer(context),
          coder,
          taskTitle: task.title,
          currentDiff: context.git.diffAll,
          events: context.events,
          ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
          ...(options.lint === undefined ? {} : { lint: options.lint }),
          ...(options.format === undefined ? {} : { format: options.format })
        })
        if (options.lint !== undefined) {
          const gate = yield* options.lint
          if (!gate.isClean) {
            return yield* FlowAborted.make({
              message: [
                `task "${task.title}": the lint gate is still failing after review settled; refusing to commit`,
                ...gate.issues.map((issue) => {
                  const detail =
                    issue.description.length === 0 ? "" : `\n${issue.description.slice(-2000)}`
                  return `- [${issue.severity}] ${issue.title}${detail}`
                })
              ].join("\n")
            })
          }
        }
        yield* context.git.commitAll((options.commitMessage ?? defaultCommitMessage)(plan, task))
      })
  )
})
