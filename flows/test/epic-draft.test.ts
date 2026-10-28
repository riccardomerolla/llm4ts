import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { FlowAborted } from "@llm4ts/flow/FlowError"
import { Info, makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import { makeMemoryPlainFileStore, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { ReviewIssue, ReviewResult } from "@llm4ts/flow/Review"
import { deferredPath, EpicReport, StoryOutcome } from "@llm4ts/flow/Stories"
import { Story, StoryPlan } from "@llm4ts/flow/StoryPlan"
import {
  debtPath,
  draftAfterUnit,
  draftPlanInstructions,
  generateDraftPlan,
  hardenAfterUnit,
  hardenFeedback,
  paidPath,
  renderDebt
} from "../lib/epic-draft.ts"
import type { EpicUnitContext } from "../lib/epic-stories.ts"
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

const plan = StoryPlan.make({
  epicId: "e",
  epic: "Accounts.",
  stories: [
    Story.make({
      id: "a",
      title: "A",
      description: "a",
      owned: ["src/a"],
      acceptance: ["shows the balance"]
    }),
    Story.make({
      id: "b",
      title: "B",
      description: "b",
      owned: ["src/b"],
      acceptance: ["sends a transfer"]
    })
  ]
})
const report = EpicReport.make({
  epicId: "e",
  epicBranch: "epic/e",
  estimated: true,
  stories: [
    StoryOutcome.make({ id: "a", title: "A", status: "done" }),
    StoryOutcome.make({ id: "b", title: "B", status: "failed", reason: "gates red" })
  ]
})

const red = ReviewResult.make({
  issues: [ReviewIssue.make({ severity: "Critical", title: "FAIL src/a.test.ts > balance" })],
  summary: "gates"
})

const unitWith = (
  files: PlainFileStoreShape,
  testGate: EpicUnitContext["testGate"]
): Effect.Effect<{
  readonly unit: EpicUnitContext
  readonly infos: Effect.Effect<ReadonlyArray<string>>
}> =>
  Effect.gen(function* () {
    const events = yield* makeCollectingFlowEvents
    return {
      unit: {
        plan,
        stateDir: "/e",
        epicStateDir: "/e",
        workDir: "/repo",
        appDir: ".",
        files,
        events,
        testGate
      },
      infos: Effect.map(events.recorded, (all) =>
        all.flatMap((event) => (event instanceof Info ? [event.message] : []))
      )
    }
  })

describe("epic-draft debt", () => {
  it("lists only merged stories, each outcome as a test owed", () => {
    const text = renderDebt(plan, report, undefined, undefined)
    assert.include(text, "# Debt — e")
    assert.include(text, "## a")
    assert.include(text, "- [ ] test: shows the balance")
    assert.notInclude(text, "## b")
    assert.notInclude(text, "sends a transfer")
  })

  it("appends deferred findings and the skipped test gate's failures", () => {
    const text = renderDebt(plan, report, "- [Warning] naming", "FAIL src/a.test.ts > balance")
    assert.include(text, "## Deferred findings")
    assert.include(text, "- [Warning] naming")
    assert.include(text, "## Test gate on the epic checkout (skipped while drafting)")
    assert.include(text, "FAIL src/a.test.ts > balance")
  })

  it.effect("records the skipped test gate's failures", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* memory.store.writeAtomic(deferredPath("/e", "a"), "- [Warning] naming")
      const { unit, infos } = yield* unitWith(memory.store, () => Effect.succeed(red))
      yield* draftAfterUnit(false)(unit, report)
      const debt = (yield* memory.files)[debtPath("/e")] ?? ""
      assert.include(debt, "FAIL src/a.test.ts > balance")
      assert.include(debt, "- [Warning] naming")
      assert.include(
        yield* infos,
        "debt: 1 test owed, 1 deferred finding, test gate red — run epic-draft --harden (/e/debt.md)"
      )
    })
  )

  it.effect("with --with-tests the test gate is not rerun", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const { unit, infos } = yield* unitWith(memory.store, () =>
        Effect.fail(FlowAborted.make({ message: "the test gate must not run" }))
      )
      yield* draftAfterUnit(true)(unit, report)
      assert.include((yield* memory.files)[debtPath("/e")] ?? "", "shows the balance")
      assert.include(
        yield* infos,
        "debt: 1 test owed, no deferred findings — run epic-draft --harden (/e/debt.md)"
      )
    })
  )

  it.effect("an empty draft writes no debt", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const { unit, infos } = yield* unitWith(memory.store, () =>
        Effect.succeed(ReviewResult.make({ issues: [], summary: "" }))
      )
      const nothingMerged = EpicReport.make({ ...report, stories: [] })
      yield* draftAfterUnit(false)(unit, nothingMerged)
      assert.isUndefined((yield* memory.files)[debtPath("/e")])
      assert.deepStrictEqual(yield* infos, [])
    })
  )
})

describe("epic-draft --harden", () => {
  it.effect("plans every open debt list, with the text first", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* memory.store.writeAtomic("/e/plan.md", "plan")
      yield* memory.store.writeAtomic(debtPath("/e"), "## a\n- [ ] test: shows the balance")
      yield* memory.store.writeAtomic("/e/rounds/1/plan.md", "round")
      yield* memory.store.writeAtomic(debtPath("/e/rounds/1"), "## c\n- [ ] test: lists cards")
      const feedback = yield* hardenFeedback("/e", "focus on a", memory.store)
      assert.include(feedback, "Pay this epic's draft debt")
      assert.isBelow(feedback.indexOf("focus on a"), feedback.indexOf("shows the balance"))
      assert.include(feedback, "lists cards")
    })
  )

  it.effect("refuses when there is no debt and no text", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* memory.store.writeAtomic("/e/plan.md", "plan")
      yield* memory.store.writeAtomic(debtPath("/e"), "")
      // epic-stories' runAction answers empty feedback with a usage error.
      assert.strictEqual(yield* hardenFeedback("/e", "", memory.store), "")
      assert.strictEqual(yield* hardenFeedback("/e", "free text", memory.store), "free text")
    })
  )

  it.effect("moves consumed debt to debt.paid.md once the round settles", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* memory.store.writeAtomic("/e/plan.md", "plan")
      yield* memory.store.writeAtomic(debtPath("/e"), "## a\n- [ ] test: shows the balance")
      yield* memory.store.writeAtomic("/e/rounds/1/plan.md", "round")
      const { unit } = yield* unitWith(memory.store, undefined)
      const round = { ...unit, stateDir: "/e/rounds/1" }

      yield* hardenAfterUnit(round, report)
      assert.include((yield* memory.files)[debtPath("/e")] ?? "", "shows the balance")

      const settled = EpicReport.make({
        ...report,
        stories: report.stories.filter((story) => story.status === "done")
      })
      yield* hardenAfterUnit(round, settled)
      const files = yield* memory.files
      assert.strictEqual(files[debtPath("/e")], "")
      assert.include(files[paidPath("/e")] ?? "", "shows the balance")
      assert.strictEqual(yield* hardenFeedback("/e", "", memory.store), "")
    })
  )
})
