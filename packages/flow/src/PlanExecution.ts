import * as Effect from "effect/Effect"
import {
  StageCompleted,
  StageFailed,
  StageStarted,
  TaskCompleted,
  TaskStarted,
  TasksPlanned,
  type FlowEventsShape
} from "./FlowEvents.ts"
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

/** The acceptance criteria a task's description names: `Satisfies: 1, 3` → `[1, 3]` (ADR 0033). */
export const satisfiesOf = (description: string): ReadonlyArray<number> | undefined => {
  const match = /^\s*Satisfies:\s*(.+)$/imu.exec(description)
  if (match === null) {
    return undefined
  }
  const numbers = (match[1] ?? "")
    .split(/[,\s]+/u)
    .map((part) => Number.parseInt(part, 10))
    .filter((number) => Number.isInteger(number) && number > 0)
  return numbers.length === 0 ? undefined : numbers
}

const withSatisfies = (description: string): { readonly satisfies?: ReadonlyArray<number> } => {
  const satisfies = satisfiesOf(description)
  return satisfies === undefined ? {} : { satisfies }
}

export const implementTaskLoop = Effect.fn("@llm4ts/flow/PlanExecution.implementTaskLoop")(
  function* <E, R>(
    store: PlanStoreShape,
    events: FlowEventsShape,
    planPath: string,
    plan: Plan,
    perTask: (task: Task, planSoFar: Plan) => Effect.Effect<void, E, R>
  ): Effect.fn.Return<Plan, E | FlowError, R> {
    let current = plan
    const count = plan.tasks.length
    yield* events.publish(
      TasksPlanned.make({
        tasks: plan.tasks.map((task) => ({
          title: task.title,
          completed: task.completed,
          ...withSatisfies(task.description)
        }))
      })
    )
    for (const [position, task] of plan.tasks.entries()) {
      if (!task.completed) {
        const index = position + 1
        yield* events.publish(
          TaskStarted.make({ index, count, title: task.title, ...withSatisfies(task.description) })
        )
        yield* stage(events, task.title, perTask(task, current))
        current = current.complete(task.title)
        yield* store.save(planPath, current)
        yield* events.publish(TaskCompleted.make({ index, count, title: task.title }))
      }
    }
    return current
  }
)
