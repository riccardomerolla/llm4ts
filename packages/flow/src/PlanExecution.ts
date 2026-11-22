import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Queue from "effect/Queue"
import * as Semaphore from "effect/Semaphore"
import {
  Info,
  StageCompleted,
  StageFailed,
  StageStarted,
  TaskCompleted,
  TaskStarted,
  TasksPlanned,
  type FlowEventsShape
} from "./FlowEvents.ts"
import { withKindSpan, type SpanOptions } from "./Spans.ts"
import { FlowAborted, describeFlowError, type FlowError } from "./FlowError.ts"
import { taskGraph, type Plan, type Task, type TaskNode } from "./Plan.ts"
import type { PlanStoreShape, TaskAttemptsShape } from "./Persistence.ts"
import { pathWithin } from "./StoryPlan.ts"

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
  // The planner writes JSON, so the line is usually the description's last sentence.
  const match = /\bSatisfies:\s*([^\n]*)/iu.exec(description)
  if (match === null) {
    return undefined
  }
  const numbers = (match[1] ?? "")
    .split(/[^\d]+/u)
    .filter((part) => part.length > 0)
    .map((part) => Number.parseInt(part, 10))
    .filter((number) => Number.isInteger(number) && number > 0)
  return numbers.length === 0 ? undefined : numbers
}

const withSatisfies = (description: string): { readonly satisfies?: ReadonlyArray<number> } => {
  const satisfies = satisfiesOf(description)
  return satisfies === undefined ? {} : { satisfies }
}

/** What a task's run is told about the runs before it (ADR 0056). */
export interface TaskAttempt {
  /** Earlier runs of this task that a dead process cut off; 0 on a first run. */
  readonly cutOff: number
}

/**
 * Runs a task under the plan's cut-off journal: marked before, unmarked when
 * it ends while the process lives. `lock` keeps tasks that run at once from
 * writing the journal over each other.
 */
const journaled = <A, E, R>(
  attempts: TaskAttemptsShape | undefined,
  lock: Semaphore.Semaphore,
  events: FlowEventsShape,
  task: Task,
  run: (attempt: TaskAttempt) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | FlowError, R> => {
  if (attempts === undefined) {
    return run({ cutOff: 0 })
  }
  return Effect.gen(function* () {
    const cutOff = yield* lock.withPermit(attempts.begin(task.title))
    if (cutOff > 0) {
      yield* events.publish(
        Info.make({
          message: `task "${task.title}": ${cutOff} earlier run(s) were cut off before they finished`
        })
      )
    }
    return yield* Effect.onExit(run({ cutOff }), (exit) =>
      Effect.ignore(lock.withPermit(attempts.end(task.title, Exit.isSuccess(exit))))
    )
  })
}

export const implementTaskLoop = Effect.fn("@llm4ts/flow/PlanExecution.implementTaskLoop")(
  function* <E, R>(
    store: PlanStoreShape,
    events: FlowEventsShape,
    planPath: string,
    plan: Plan,
    perTask: (task: Task, planSoFar: Plan, attempt: TaskAttempt) => Effect.Effect<void, E, R>
  ): Effect.fn.Return<Plan, E | FlowError, R> {
    let current = plan
    const attempts = store.attempts?.(planPath)
    const lock = yield* Semaphore.make(1)
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
        const planSoFar = current
        yield* stage(
          events,
          task.title,
          journaled(attempts, lock, events, task, (attempt) => perTask(task, planSoFar, attempt))
        )
        current = current.complete(task.title)
        yield* store.save(planPath, current)
        yield* events.publish(TaskCompleted.make({ index, count, title: task.title }))
      }
    }
    return current
  }
)

// ---- Tasks beside the held coder (ADR 0034) -----------------------------------

/**
 * How a task tried beside the held coder ended: `merged` into the story,
 * `declined` (no free coder, or it could not finish there) or `conflict`
 * (its merge back conflicted). The last two go back to the held coder; a
 * conflicting task runs after the others, on the merged state.
 */
export type AsideOutcome = "merged" | "declined" | "conflict"

/**
 * Whether a task may run aside while `running` tasks are in flight (ADR 0034
 * amendment): only when it and each of them declare `Owns:` and no path of
 * one lies within a path of another. An undeclared footprint could be any
 * file, so it waits its turn.
 */
export const mayRunBeside = (node: TaskNode, running: ReadonlyArray<TaskNode>): boolean =>
  node.owns.length > 0 &&
  running.every(
    (other) =>
      other.owns.length > 0 &&
      !other.owns.some((theirs) =>
        node.owns.some((ours) => pathWithin(ours, theirs) || pathWithin(theirs, ours))
      )
  )

export interface AsideRequest {
  readonly node: TaskNode
  /** The plan's size, for `task n/m`. */
  readonly count: number
  readonly planSoFar: Plan
  /** What the task's run is told about the runs before it (ADR 0056). */
  readonly attempt: TaskAttempt
  /** Runs `effect` while no task runs at home: the merge back into the story. */
  readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Says the task started, on the coder it got; call it once that coder is held. */
  readonly announce: (coder: {
    readonly executor?: string
    readonly clone?: number
  }) => Effect.Effect<void>
}

export interface ParallelTasks<E, R> {
  /** Coders one story may hold at once, its own included; 1 runs every task at home. */
  readonly concurrency: number
  readonly aside: (request: AsideRequest) => Effect.Effect<AsideOutcome, E, R>
}

/** A task's run that ended: at home (`undefined`) or aside (its outcome). */
interface Finished<E> {
  readonly kind: "home" | "aside"
  readonly node: TaskNode
  readonly exit: Exit.Exit<AsideOutcome | undefined, E>
}

/**
 * The task loop over the plan's graph (ADR 0034): the held coder runs one
 * ready task at a time, in plan order, as `implementTaskLoop` does; up to
 * `concurrency - 1` other ready tasks are offered to `aside`, which runs
 * each on another coder and merges it back under `exclusive`. A task is
 * ready when the tasks it depends on are complete; a plan whose every task
 * depends on the one before runs exactly as `implementTaskLoop`.
 */
export const implementTaskGraph = Effect.fn("@llm4ts/flow/PlanExecution.implementTaskGraph")(
  function* <E, R, E2, R2>(
    store: PlanStoreShape,
    events: FlowEventsShape,
    planPath: string,
    plan: Plan,
    perTask: (task: Task, planSoFar: Plan, attempt: TaskAttempt) => Effect.Effect<void, E, R>,
    parallel: ParallelTasks<E2, R2>
  ): Effect.fn.Return<Plan, E | E2 | FlowError, R | R2> {
    const graph = taskGraph(plan)
    const count = graph.length
    yield* events.publish(
      TasksPlanned.make({
        tasks: plan.tasks.map((task) => ({
          title: task.title,
          completed: task.completed,
          ...withSatisfies(task.description)
        }))
      })
    )
    let current = plan
    const done = new Set(graph.filter((node) => node.task.completed).map((node) => node.index))
    /** Tasks that go to the held coder only, and those that wait for every other one. */
    const homeOnly = new Set<number>()
    const last = new Set<number>()
    const running = new Map<number, "home" | "aside">()
    const fibers: Array<Fiber.Fiber<unknown, unknown>> = []
    const finished = yield* Queue.unbounded<Finished<E | E2 | FlowError>>()
    const home = yield* Semaphore.make(1)
    const attempts = store.attempts?.(planPath)
    const journal = yield* Semaphore.make(1)
    const exclusive = <A, EX, RX>(effect: Effect.Effect<A, EX, RX>) => home.withPermit(effect)

    const started = (
      node: TaskNode,
      extra: Partial<Pick<TaskStarted, "parallel" | "executor" | "clone">> = {}
    ) =>
      events.publish(
        TaskStarted.make({
          index: node.index,
          count,
          title: node.task.title,
          ...withSatisfies(node.task.description),
          ...extra
        })
      )
    const complete = (node: TaskNode) =>
      Effect.gen(function* () {
        current = current.complete(node.task.title)
        yield* store.save(planPath, current)
        done.add(node.index)
        yield* events.publish(
          TaskCompleted.make({ index: node.index, count, title: node.task.title })
        )
      })

    while (done.size < count) {
      const ready = graph.filter(
        (node) =>
          !done.has(node.index) &&
          !running.has(node.index) &&
          node.dependsOn.every((index) => done.has(index))
      )
      if (![...running.values()].includes("home")) {
        const pick = ready.find((node) => !last.has(node.index)) ?? ready[0]
        if (pick !== undefined) {
          running.set(pick.index, "home")
          const snapshot = current
          fibers.push(
            yield* Effect.forkChild(
              exclusive(
                Effect.andThen(
                  started(pick),
                  stage(
                    events,
                    pick.task.title,
                    journaled(attempts, journal, events, pick.task, (attempt) =>
                      perTask(pick.task, snapshot, attempt)
                    )
                  )
                )
              ).pipe(
                Effect.as(undefined),
                Effect.exit,
                Effect.flatMap((exit) => Queue.offer(finished, { kind: "home", node: pick, exit }))
              )
            )
          )
        }
      }
      for (const node of ready) {
        if (running.size >= parallel.concurrency) {
          break
        }
        if (running.has(node.index) || homeOnly.has(node.index)) {
          continue
        }
        const beside = graph.filter((other) => running.has(other.index))
        if (!mayRunBeside(node, beside)) {
          continue
        }
        running.set(node.index, "aside")
        const request = (attempt: TaskAttempt): AsideRequest => ({
          node,
          count,
          planSoFar: current,
          attempt,
          exclusive,
          announce: (coder) =>
            started(node, {
              parallel: true,
              ...(coder.executor === undefined ? {} : { executor: coder.executor }),
              ...(coder.clone === undefined ? {} : { clone: coder.clone })
            })
        })
        fibers.push(
          yield* Effect.forkChild(
            journaled(attempts, journal, events, node.task, (attempt) =>
              parallel.aside(request(attempt))
            ).pipe(
              Effect.exit,
              Effect.flatMap((exit) => Queue.offer(finished, { kind: "aside", node, exit }))
            )
          )
        )
      }
      if (running.size === 0) {
        return yield* FlowAborted.make({
          message: `plan ${plan.epicId}: no task can start, though ${count - done.size} are not done`
        })
      }
      const next = yield* Queue.take(finished)
      running.delete(next.node.index)
      if (Exit.isFailure(next.exit)) {
        yield* Fiber.interruptAll(fibers)
        return yield* Effect.failCause(next.exit.cause)
      }
      if (next.kind === "home") {
        yield* complete(next.node)
      } else if (next.exit.value === "merged") {
        yield* complete(next.node)
      } else {
        homeOnly.add(next.node.index)
        if (next.exit.value === "conflict") {
          last.add(next.node.index)
        }
      }
    }
    return current
  }
)
