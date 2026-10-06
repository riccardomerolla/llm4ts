import * as Effect from "effect/Effect"
import { StageCompleted, StageFailed, StageStarted, type FlowEventsShape } from "./FlowEvents.ts"
import { withKindSpan, type SpanOptions } from "./Spans.ts"
import { describeFlowError, type FlowError } from "./FlowError.ts"
import type { Plan, Task } from "./Plan.ts"
import type { PlanStoreShape } from "./Persistence.ts"

const errorMessage = describeFlowError

/**
 * A named step of a flow: published as StageStarted/Completed/Failed for the
 * terminal, the trace and the profile, and a span of `span.kind` (CHAIN by
 * default) for OpenTelemetry (ADR 0026).
 */
export const stage = <A, E, R>(
  events: FlowEventsShape,
  name: string,
  effect: Effect.Effect<A, E, R>,
  span: SpanOptions = { kind: "CHAIN" }
): Effect.Effect<A, E, R> =>
  withKindSpan(
    name,
    span,
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
