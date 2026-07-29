import * as Effect from "effect/Effect"
import { StageCompleted, StageFailed, StageStarted, type FlowEventsShape } from "./FlowEvents.ts"
import type { FlowError } from "./FlowError.ts"
import type { Plan, Task } from "./Plan.ts"
import type { PlanStoreShape } from "./Persistence.ts"

const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : String(error)

export const stage = <A, E, R>(
  events: FlowEventsShape,
  name: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  events.publish(StageStarted.make({ stage: name })).pipe(
    Effect.andThen(effect),
    Effect.tap(() => events.publish(StageCompleted.make({ stage: name }))),
    Effect.tapError((error) =>
      events.publish(
        StageFailed.make({
          stage: name,
          message: errorMessage(error)
        })
      )
    )
  )

export const implementTaskLoop = Effect.fn("@llm4ts/flow/PlanExecution.implementTaskLoop")(
  function* <E, R>(
    store: PlanStoreShape,
    events: FlowEventsShape,
    planPath: string,
    plan: Plan,
    perTask: (task: Task, planSoFar: Plan) => Effect.Effect<void, E, R>
  ): Effect.fn.Return<Plan, E | FlowError, R> {
    let current = plan
    for (const task of plan.tasks) {
      if (!task.completed) {
        yield* stage(events, task.title, perTask(task, current))
        current = current.complete(task.title)
        yield* store.save(planPath, current)
      }
    }
    return current
  }
)
