import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { draftPlanInstructions, generateDraftPlan } from "../lib/epic-draft.ts"
import { scripted } from "./support.ts"

describe("epic-draft plan", () => {
  it("the draft cut overrides the tests rule and keeps acceptance", () => {
    const text = draftPlanInstructions("e", "rules")
    assert.include(text, "Draft cut (this run is epic-draft")
    assert.include(text, "No story writes or owns test files now")
    assert.include(text, "`acceptance` still lists two to six outcomes")
    assert.include(text, "Leave `testsDeferred` out")
  })

  it.effect("generateDraftPlan keeps our epic id and text", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const events = yield* makeCollectingFlowEvents
      const reasoning = yield* scripted([
        {
          epicId: "ignored",
          epic: "ignored",
          stories: [
            {
              id: "conto",
              title: "Current account",
              description: "Balance.",
              dependsOn: [],
              owned: ["src/conto"],
              sharedReadOnly: [],
              readFirst: [],
              acceptance: ["shows the balance"],
              provides: []
            }
          ]
        }
      ])
      const plan = yield* generateDraftPlan({
        reasoning: reasoning.service,
        events,
        epic: "Accounts.",
        epicId: "e",
        guidance: "",
        brief: undefined,
        orientation: undefined,
        files: memory.store,
        stateDir: "/s"
      })
      assert.strictEqual(plan.epicId, "e")
      assert.strictEqual(plan.epic, "Accounts.")
      assert.deepStrictEqual(plan.stories[0]?.acceptance, ["shows the balance"])
      const [prompt] = yield* reasoning.prompts
      assert.include(prompt ?? "", "Draft cut")
    })
  )
})
