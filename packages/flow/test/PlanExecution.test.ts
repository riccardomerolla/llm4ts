import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { FlowAborted } from "@llm4ts/flow/FlowError"
import { makeCollectingFlowEvents, makeFlowEventHub } from "@llm4ts/flow/FlowEvents"
import {
  implementTaskGraph,
  implementTaskLoop,
  satisfiesOf,
  stage,
  type AsideOutcome
} from "@llm4ts/flow/PlanExecution"
import { kindAttribute, withKindSpan } from "@llm4ts/flow/Spans"
import { recordingTracer } from "./support/RecordingTracer.ts"
import { Plan, Task } from "@llm4ts/flow/Plan"
import { makePlanStore, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"

const memoryFiles = (state: Ref.Ref<Readonly<Record<string, string>>>): PlainFileStoreShape => ({
  read: (path) => Ref.get(state).pipe(Effect.map((files) => files[path])),
  writeAtomic: (path, contents) => Ref.update(state, (files) => ({ ...files, [path]: contents })),
  append: (path, contents) =>
    Ref.update(state, (files) => ({
      ...files,
      [path]: `${files[path] ?? ""}${contents}`
    })),
  remove: (path) =>
    Ref.update(state, (files) =>
      Object.fromEntries(Object.entries(files).filter(([candidate]) => candidate !== path))
    ),
  hashSha256: (_path) => Effect.succeed("")
})

describe("implementTaskLoop", () => {
  it.effect("skips completed tasks, runs in order, and persists every transition", () =>
    Effect.gen(function* () {
      const files = yield* Ref.make<Readonly<Record<string, string>>>({})
      const events = yield* makeCollectingFlowEvents
      const ran = yield* Ref.make<ReadonlyArray<string>>([])
      const plan = Plan.make({
        epicId: "epic",
        tasks: [
          Task.make({
            title: "a",
            description: "",
            completed: true
          }),
          Task.make({ title: "b", description: "" }),
          Task.make({ title: "c", description: "" })
        ]
      })
      const store = makePlanStore(memoryFiles(files))
      const result = yield* implementTaskLoop(store, events, "plan.md", plan, (task) =>
        Ref.update(ran, (current) => [...current, task.title])
      )
      const disk = yield* store.load("plan.md")
      const recorded = yield* events.recorded

      assert.deepStrictEqual(yield* Ref.get(ran), ["b", "c"])
      assert.isTrue(result.tasks.every((task) => task.completed))
      assert.deepStrictEqual(disk, result)
      assert.deepStrictEqual(
        recorded.map((event) => event._tag),
        [
          "TasksPlanned",
          "TaskStarted",
          "StageStarted",
          "StageCompleted",
          "TaskCompleted",
          "TaskStarted",
          "StageStarted",
          "StageCompleted",
          "TaskCompleted"
        ]
      )
    })
  )

  it("reads the criteria a task satisfies from its description", () => {
    assert.deepStrictEqual(satisfiesOf("Add the route.\nSatisfies: 2"), [2])
    // The planner writes JSON, so the line is usually one line.
    assert.deepStrictEqual(satisfiesOf("Add the route. Satisfies: 2"), [2])
    assert.deepStrictEqual(satisfiesOf("Ship it; satisfies: 1 and 4."), [1, 4])
    assert.deepStrictEqual(satisfiesOf("Tests.\n\nSatisfies: 1, 3"), [1, 3])
    assert.isUndefined(satisfiesOf("No criteria here"))
    assert.isUndefined(satisfiesOf("Satisfies: n/a"))
  })

  it.effect("announces the plan, then each unfinished task's position, title and criteria", () =>
    Effect.gen(function* () {
      const files = yield* Ref.make<Readonly<Record<string, string>>>({})
      const events = yield* makeCollectingFlowEvents
      const plan = Plan.make({
        epicId: "S01",
        tasks: [
          Task.make({ title: "route", description: "Satisfies: 1", completed: true }),
          Task.make({ title: "cookie", description: "Wire it.\nSatisfies: 2" }),
          Task.make({ title: "docs", description: "" })
        ]
      })
      yield* implementTaskLoop(
        makePlanStore(memoryFiles(files)),
        events,
        "plan.md",
        plan,
        () => Effect.void
      )
      const recorded = yield* events.recorded
      const planned = recorded[0]
      assert.strictEqual(planned?._tag, "TasksPlanned")
      if (planned?._tag === "TasksPlanned") {
        assert.deepStrictEqual(
          planned.tasks.map((task) => [task.title, task.completed, task.satisfies]),
          [
            ["route", true, [1]],
            ["cookie", false, [2]],
            ["docs", false, undefined]
          ]
        )
      }
      const tasks = recorded.flatMap((event) =>
        event._tag === "TaskStarted" || event._tag === "TaskCompleted"
          ? [`${event._tag} ${event.index}/${event.count} ${event.title}`]
          : []
      )
      assert.deepStrictEqual(tasks, [
        "TaskStarted 2/3 cookie",
        "TaskCompleted 2/3 cookie",
        "TaskStarted 3/3 docs",
        "TaskCompleted 3/3 docs"
      ])
      const started = recorded.find((event) => event._tag === "TaskStarted")
      assert.deepStrictEqual(started?._tag === "TaskStarted" ? started.satisfies : [], [2])
    })
  )

  it.effect(
    "threads the accumulated plan-so-far into each task, reflecting prior completions",
    () =>
      Effect.gen(function* () {
        const files = yield* Ref.make<Readonly<Record<string, string>>>({})
        const events = yield* makeCollectingFlowEvents
        const seen = yield* Ref.make<ReadonlyArray<ReadonlyArray<boolean>>>([])
        const plan = Plan.make({
          epicId: "epic",
          tasks: [
            Task.make({ title: "a", description: "" }),
            Task.make({ title: "b", description: "" }),
            Task.make({ title: "c", description: "" })
          ]
        })
        const store = makePlanStore(memoryFiles(files))
        yield* implementTaskLoop(store, events, "plan.md", plan, (_task, planSoFar) =>
          Ref.update(seen, (current) => [...current, planSoFar.tasks.map((task) => task.completed)])
        )

        // Task "a" runs against a plan where nothing is completed yet; task "b"
        // runs after "a" has been marked complete but before "b" itself has;
        // task "c" sees both "a" and "b" done but not itself — proving
        // `planSoFar` reflects prior-task completion, not the current task's,
        // and advances in the same order the loop processes tasks.
        assert.deepStrictEqual(yield* Ref.get(seen), [
          [false, false, false],
          [true, false, false],
          [true, true, false]
        ])
      })
  )

  it.effect("stops on failure and leaves completed progress resumable", () =>
    Effect.gen(function* () {
      const files = yield* Ref.make<Readonly<Record<string, string>>>({})
      const events = yield* makeCollectingFlowEvents
      const store = makePlanStore(memoryFiles(files))
      const plan = Plan.make({
        epicId: "epic",
        tasks: [
          Task.make({ title: "a", description: "" }),
          Task.make({ title: "b", description: "" }),
          Task.make({ title: "c", description: "" })
        ]
      })
      const failure = FlowAborted.make({ message: "stop" })
      const result = yield* Effect.result(
        implementTaskLoop(store, events, "plan.md", plan, (task) =>
          task.title === "b" ? Effect.fail(failure) : Effect.void
        )
      )
      const disk = yield* store.load("plan.md")
      const recorded = yield* events.recorded

      assert.strictEqual(result._tag === "Failure" ? result.failure : undefined, failure)
      assert.isTrue(disk?.tasks[0]?.completed)
      assert.isFalse(disk?.tasks[1]?.completed)
      assert.strictEqual(recorded.at(-1)?._tag, "StageFailed")
    })
  )
})

describe("stage spans", () => {
  it.effect("every stage is a CHAIN span unless told otherwise, failed when the stage fails", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const { tracer, spans } = recordingTracer()
      yield* withKindSpan(
        "run",
        { kind: "CHAIN" },
        Effect.gen(function* () {
          yield* stage(events, "story plan", Effect.void)
          yield* Effect.flip(
            stage(events, "story a", Effect.fail(new Error("boom")), { kind: "AGENT", root: true })
          )
        })
      ).pipe(Effect.withTracer(tracer))
      const [, plan, story] = spans()
      assert.deepStrictEqual(
        [plan?.name, plan?.attributes[kindAttribute], plan?.root, plan?.failed],
        ["story plan", "CHAIN", false, false]
      )
      assert.deepStrictEqual(
        [story?.name, story?.attributes[kindAttribute], story?.root, story?.failed],
        ["story a", "AGENT", true, true]
      )
    })
  )
})

describe("implementTaskGraph (ADR 0034)", () => {
  const fan = (): Plan =>
    Plan.make({
      epicId: "S01",
      tasks: [
        Task.make({ title: "a", description: "" }),
        Task.make({ title: "b", description: "Depends on: 1" }),
        Task.make({ title: "c", description: "Depends on: 1" }),
        Task.make({ title: "d", description: "Depends on: 2, 3" })
      ]
    })

  const run = (
    plan: Plan,
    outcome: (title: string, tries: number) => AsideOutcome,
    concurrency = 2
  ) =>
    Effect.gen(function* () {
      const files = yield* Ref.make<Readonly<Record<string, string>>>({})
      const events = yield* makeCollectingFlowEvents
      const home = yield* Ref.make<ReadonlyArray<string>>([])
      const aside = yield* Ref.make<ReadonlyArray<string>>([])
      const store = makePlanStore(memoryFiles(files))
      const result = yield* implementTaskGraph(
        store,
        events,
        "plan.md",
        plan,
        (task) => Ref.update(home, (titles) => [...titles, task.title]),
        {
          concurrency,
          aside: ({ node, announce, exclusive }) =>
            Effect.gen(function* () {
              const tries = (yield* Ref.get(aside)).filter((t) => t === node.task.title).length
              yield* Ref.update(aside, (titles) => [...titles, node.task.title])
              const answer = outcome(node.task.title, tries)
              if (answer !== "declined") {
                yield* announce({ executor: "codex", clone: 2 })
              }
              return yield* exclusive(Effect.succeed(answer))
            })
        }
      )
      return {
        result,
        disk: yield* store.load("plan.md"),
        home: yield* Ref.get(home),
        aside: yield* Ref.get(aside),
        recorded: yield* events.recorded
      }
    })

  it.effect("runs independent tasks beside the held coder and merges them in", () =>
    Effect.gen(function* () {
      const { result, disk, home, aside, recorded } = yield* run(fan(), () => "merged")
      assert.isTrue(result.tasks.every((task) => task.completed))
      assert.deepStrictEqual(disk, result)
      assert.deepStrictEqual(home, ["a", "b", "d"])
      assert.deepStrictEqual(aside, ["c"])
      const parallel = recorded.find(
        (event) => event._tag === "TaskStarted" && event.parallel === true
      )
      assert.deepStrictEqual(
        parallel?._tag === "TaskStarted"
          ? [parallel.index, parallel.title, parallel.executor, parallel.clone]
          : [],
        [3, "c", "codex", 2]
      )
      const completed = recorded.flatMap((event) =>
        event._tag === "TaskCompleted" ? [event.index] : []
      )
      assert.deepStrictEqual([...completed].sort(), [1, 2, 3, 4])
    })
  )

  it.effect("gives a declined task to the held coder", () =>
    Effect.gen(function* () {
      const { result, home, aside } = yield* run(fan(), () => "declined")
      assert.isTrue(result.tasks.every((task) => task.completed))
      assert.deepStrictEqual(aside, ["c"])
      assert.deepStrictEqual(home, ["a", "b", "c", "d"])
    })
  )

  it.effect("reruns a conflicting task at home after the others", () =>
    Effect.gen(function* () {
      const plan = Plan.make({
        epicId: "S01",
        tasks: [
          Task.make({ title: "a", description: "" }),
          Task.make({ title: "b", description: "Depends on: 1" }),
          Task.make({ title: "c", description: "Depends on: 1" }),
          Task.make({ title: "e", description: "Depends on: 2" })
        ]
      })
      const { result, home, aside } = yield* run(plan, (title) =>
        title === "c" ? "conflict" : "merged"
      )
      assert.isTrue(result.tasks.every((task) => task.completed))
      assert.deepStrictEqual(aside, ["c"])
      // e (ready after b) runs before the conflicted c.
      assert.deepStrictEqual(home, ["a", "b", "e", "c"])
    })
  )

  it.effect("never sets a task aside in a plan that is a chain", () =>
    Effect.gen(function* () {
      const chain = Plan.make({
        epicId: "S01",
        tasks: [
          Task.make({ title: "a", description: "" }),
          Task.make({ title: "b", description: "" })
        ]
      })
      const { home, aside } = yield* run(chain, () => "merged")
      assert.deepStrictEqual(home, ["a", "b"])
      assert.deepStrictEqual(aside, [])
    })
  )

  it.effect("holds one coder only at a task concurrency of 1", () =>
    Effect.gen(function* () {
      const { home, aside } = yield* run(fan(), () => "merged", 1)
      assert.deepStrictEqual(home, ["a", "b", "c", "d"])
      assert.deepStrictEqual(aside, [])
    })
  )

  it.effect("fails when a task at home fails, and stops the tasks aside", () =>
    Effect.gen(function* () {
      const files = yield* Ref.make<Readonly<Record<string, string>>>({})
      const events = yield* makeCollectingFlowEvents
      const error = yield* Effect.flip(
        implementTaskGraph(
          makePlanStore(memoryFiles(files)),
          events,
          "plan.md",
          fan(),
          (task) =>
            task.title === "b" ? Effect.fail(FlowAborted.make({ message: "red" })) : Effect.void,
          { concurrency: 2, aside: () => Effect.never }
        )
      )
      assert.strictEqual(error._tag, "Aborted")
    })
  )
})
