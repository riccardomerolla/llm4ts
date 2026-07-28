import * as Effect from "effect/Effect"
import { collect } from "@llm4ts/core/Streaming"
import { FlowLlmError, type FlowError } from "@llm4ts/flow/FlowError"
import { AssistantMessage, Info } from "@llm4ts/flow/FlowEvents"
import type { FlowContextShape } from "@llm4ts/flow/FlowContext"
import { implementTaskLoop, stage } from "@llm4ts/flow/PlanExecution"
import type { Plan } from "@llm4ts/flow/Plan"
import type { PlanStoreShape } from "@llm4ts/flow/Persistence"

export const runExampleFlow = Effect.fn("@llm4ts/runner/ExampleFlow.run")(function* (
  context: FlowContextShape,
  store: PlanStoreShape,
  planPath: string,
  plan: Plan
): Effect.fn.Return<Plan, FlowError> {
  yield* stage(context.events, "branch", context.git.checkoutOrCreate(plan.epicId))
  const completed = yield* implementTaskLoop(store, context.events, planPath, plan, (task) =>
    collect(context.coder.executeStream(plan.taskPrompt(task))).pipe(
      Effect.mapError((cause) => FlowLlmError.make({ message: cause.message, cause })),
      Effect.flatMap((response) =>
        context.events.publish(AssistantMessage.make({ text: response.content }))
      ),
      Effect.andThen(context.git.commitAll(`Implement ${task.title}`)),
      Effect.tap((result) =>
        context.events.publish(Info.make({ message: `commit: ${result._tag}` }))
      ),
      Effect.asVoid
    )
  )
  return completed
})
