import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Plan, Task, defaultPlanPath, parsePlan } from "@llm4ts/flow/Plan"
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
