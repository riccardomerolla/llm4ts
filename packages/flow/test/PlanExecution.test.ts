import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { FlowAborted } from "@llm4ts/flow/FlowError"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import { implementTaskLoop } from "@llm4ts/flow/PlanExecution"
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
        ["StageStarted", "StageCompleted", "StageStarted", "StageCompleted"]
      )
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
