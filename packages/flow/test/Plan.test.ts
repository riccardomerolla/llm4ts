import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  Plan,
  Task,
  defaultPlanPath,
  parsePlan,
  dependsOnOf,
  ownsOf,
  taskGraph,
  hasParallelTasks
} from "@llm4ts/flow/Plan"
import { llm4tsDirectory, repoId } from "@llm4ts/flow/WorkspaceLayout"

describe("Plan", () => {
  it.effect("renders and parses mixed task state and a codebase brief", () =>
    Effect.gen(function* () {
      const plan = Plan.make({
        epicId: "add-multiply",
        tasks: [
          Task.make({
            title: "Add multiply",
            description: "Implement multiply(a, b).",
            completed: true
          }),
          Task.make({
            title: "Test it",
            description: "Cover edge cases."
          })
        ],
        brief: "Modules: core, flow.\nBuild: pnpm test."
      })
      const parsed = yield* parsePlan(plan.render)

      assert.deepStrictEqual(parsed, plan)
      assert.strictEqual(parsed.nextIncomplete?.title, "Test it")
      assert.strictEqual(
        parsed.taskPrompt(parsed.tasks[1] ?? Task.make({ title: "", description: "" })),
        "Modules: core, flow.\nBuild: pnpm test.\n\n---\n\nCover edge cases."
      )
    })
  )

  it.effect("completes only the matching task and rejects malformed Markdown", () =>
    Effect.gen(function* () {
      const plan = Plan.make({
        epicId: "epic",
        tasks: [
          Task.make({ title: "a", description: "one" }),
          Task.make({ title: "b", description: "two" })
        ]
      })
      const completed = plan.complete("a")
      const error = yield* Effect.flip(parsePlan("# not a plan"))

      assert.isTrue(completed.tasks[0]?.completed)
      assert.isFalse(completed.tasks[1]?.completed)
      assert.strictEqual(error._tag, "PlanParse")
    })
  )

  it("derives deterministic plan paths and collision-safe workspace namespaces", () => {
    assert.strictEqual(defaultPlanPath("same"), defaultPlanPath("same"))
    assert.notStrictEqual(defaultPlanPath("same"), defaultPlanPath("different"))
    assert.strictEqual(repoId("/control", "/control"), undefined)
    assert.match(repoId("/control", "/a/calc") ?? "", /^calc-/)
    assert.notStrictEqual(repoId("/control", "/a/calc"), repoId("/control", "/b/calc"))
    assert.strictEqual(llm4tsDirectory("/control", "/control"), "/control/.llm4ts")
    assert.match(llm4tsDirectory("/control", "/projects/calc"), /^\/control\/\.llm4ts\/calc-/)
  })
})

describe("task graph (ADR 0034)", () => {
  const task = (title: string, description: string, completed = false): Task =>
    Task.make({ title, description, completed })

  it("reads Depends on and Owns lines, one-line or not", () => {
    assert.deepStrictEqual(dependsOnOf("Wire it.\nDepends on: 1, 3", 4), [1, 3])
    assert.deepStrictEqual(dependsOnOf("Wire it. Depends on: 2. Satisfies: 1", 4), [2])
    assert.deepStrictEqual(dependsOnOf("Depends on: none", 3), [])
    // No line: the previous task, so an old plan runs in order.
    assert.deepStrictEqual(dependsOnOf("Wire it.", 3), [2])
    assert.deepStrictEqual(dependsOnOf("Wire it.", 1), [])
    // Only earlier tasks count: a forward or self reference is dropped.
    assert.deepStrictEqual(dependsOnOf("Depends on: 1, 3, 5", 3), [1])
    assert.deepStrictEqual(ownsOf("Owns: src/session/*, test/session.test.ts\nSatisfies: 2"), [
      "src/session/*",
      "test/session.test.ts"
    ])
    assert.deepStrictEqual(ownsOf("Add it."), [])
  })

  it("builds the graph of a plan and says whether any task can run beside another", () => {
    const chain = Plan.make({
      epicId: "S01",
      tasks: [task("a", ""), task("b", ""), task("c", "")]
    })
    assert.deepStrictEqual(
      taskGraph(chain).map((node) => [node.index, node.dependsOn]),
      [
        [1, []],
        [2, [1]],
        [3, [2]]
      ]
    )
    assert.isFalse(hasParallelTasks(chain))
    const fan = Plan.make({
      epicId: "S01",
      tasks: [task("a", ""), task("b", "Depends on: 1"), task("c", "Depends on: 1")]
    })
    assert.isTrue(hasParallelTasks(fan))
  })
})
