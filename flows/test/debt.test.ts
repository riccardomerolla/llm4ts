import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { Info, makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import { makeMemoryPlainFileStore, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import { EpicReport, judgeVerdictPath, StoryOutcome } from "@llm4ts/flow/Stories"
import { Story, StoryPlan } from "@llm4ts/flow/StoryPlan"
import {
  debtPath,
  epicStoriesOptions,
  hardenOptions,
  paidPath,
  parseStoriesFlags,
  testsDebtAfterUnit
} from "../lib/debt.ts"
import { deferringTestsJudge, rubricStoryJudge, type EpicUnitContext } from "../lib/epic-stories.ts"

const plan = StoryPlan.make({
  epicId: "e",
  epic: "Accounts.",
  stories: [
    Story.make({
      id: "a",
      title: "A",
      description: "a",
      owned: ["src/a"],
      acceptance: ["shows the balance", "lists movements"]
    }),
    Story.make({ id: "b", title: "B", description: "b", owned: ["src/b"], acceptance: ["x"] }),
    Story.make({ id: "c", title: "C", description: "c", owned: ["src/c"], acceptance: ["y"] }),
    Story.make({
      id: "esb",
      title: "ESB",
      description: "esb",
      owned: ["esb"],
      acceptance: ["z"],
      testsDeferred: "runs only on an ACE server"
    })
  ]
})

const report = EpicReport.make({
  epicId: "e",
  epicBranch: "epic/e",
  estimated: true,
  stories: [
    StoryOutcome.make({ id: "a", title: "A", status: "done" }),
    StoryOutcome.make({ id: "b", title: "B", status: "done" }),
    StoryOutcome.make({ id: "c", title: "C", status: "failed", reason: "gates red" }),
    StoryOutcome.make({ id: "esb", title: "ESB", status: "done" })
  ]
})

/** A judge.json as the executor's verdict cache writes it. */
const verdictFile = (testsScore: number, reasoning: string): string =>
  JSON.stringify({
    fingerprint: "f",
    result: {
      issues: [],
      summary: "judge",
      dimensions: [
        { id: "provides", score: 2, max: 2 },
        { id: "tests", score: testsScore, max: 2 }
      ],
      ...(testsScore < 2
        ? { excused: [{ id: "tests", score: testsScore, max: 2, reasoning }] }
        : {})
    }
  })

const unitWith = (files: PlainFileStoreShape) =>
  Effect.gen(function* () {
    const events = yield* makeCollectingFlowEvents
    const unit: EpicUnitContext = {
      plan,
      stateDir: "/e",
      epicStateDir: "/e",
      workDir: "/repo",
      appDir: ".",
      files,
      events,
      testGate: undefined
    }
    return {
      unit,
      infos: Effect.map(events.recorded, (all) =>
        all.flatMap((event) => (event instanceof Info ? [event.message] : []))
      )
    }
  })

describe("epic-stories --defer-tests debt (ADR 0045)", () => {
  it.effect("owes the tests of each merged story whose judge excused them", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* memory.store.writeAtomic(judgeVerdictPath("/e", "a"), verdictFile(0, "no test at all"))
      yield* memory.store.writeAtomic(judgeVerdictPath("/e", "b"), verdictFile(2, ""))
      yield* memory.store.writeAtomic(judgeVerdictPath("/e", "c"), verdictFile(0, "failed story"))
      yield* memory.store.writeAtomic(judgeVerdictPath("/e", "esb"), verdictFile(0, "plan defers"))
      const { unit, infos } = yield* unitWith(memory.store)
      yield* testsDebtAfterUnit(unit, report)
      const debt = (yield* memory.files)[debtPath("/e")] ?? ""
      assert.include(debt, "# Debt — e")
      assert.include(debt, "## a")
      assert.include(debt, "judge scored tests 0/2: no test at all")
      assert.include(debt, "- [ ] test: shows the balance")
      assert.include(debt, "- [ ] test: lists movements")
      // Tests at full, a failed story, and a story the plan exempts owe nothing.
      assert.notInclude(debt, "## b")
      assert.notInclude(debt, "## c")
      assert.notInclude(debt, "## esb")
      assert.include(
        yield* infos,
        "debt: 2 tests owed by 1 story — read it, then run epic-stories --harden (/e/debt.md)"
      )
    })
  )

  it.effect("writes nothing when every merged story was held to its tests", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* memory.store.writeAtomic(judgeVerdictPath("/e", "a"), verdictFile(2, ""))
      const { unit, infos } = yield* unitWith(memory.store)
      yield* testsDebtAfterUnit(unit, report)
      assert.isUndefined((yield* memory.files)[debtPath("/e")])
      assert.deepStrictEqual(yield* infos, [])
    })
  )

  it.effect("a story a hardening round paid owes nothing again", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* memory.store.writeAtomic(judgeVerdictPath("/e", "a"), verdictFile(1, "thin"))
      yield* memory.store.writeAtomic(paidPath("/e"), "## a\n- [ ] test: shows the balance\n")
      const { unit } = yield* unitWith(memory.store)
      yield* testsDebtAfterUnit(unit, report)
      assert.isUndefined((yield* memory.files)[debtPath("/e")])
    })
  )
})

describe("epic-stories --defer-tests and --harden flags (ADR 0045)", () => {
  it.effect("--defer-tests is the flow's own; LLM4TS_DEFER_TESTS sets it too", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* parseStoriesFlags(["--defer-tests", "--epic", "e"], {}), {
        deferTests: true,
        harden: false,
        argv: ["--epic", "e"]
      })
      assert.isTrue((yield* parseStoriesFlags([], { LLM4TS_DEFER_TESTS: "1" })).deferTests)
      assert.isFalse((yield* parseStoriesFlags([], {})).deferTests)
    })
  )

  it.effect("--harden becomes --refine", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* parseStoriesFlags(["--harden", "--epic", "e"], {}), {
        deferTests: false,
        harden: true,
        argv: ["--refine", "--epic", "e"]
      })
    })
  )

  it.effect("--harden with --defer-tests is a usage error", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(parseStoriesFlags(["--harden", "--defer-tests"], {}))
      assert.isTrue(Exit.isFailure(exit))
      const env = yield* Effect.exit(parseStoriesFlags(["--harden"], { LLM4TS_DEFER_TESTS: "on" }))
      assert.isTrue(Exit.isFailure(env))
    })
  )

  it("each flag picks its policy", () => {
    const plain = epicStoriesOptions({ deferTests: false, harden: false, argv: [] })
    assert.strictEqual(plain.storyJudge, rubricStoryJudge)
    assert.isUndefined(plain.afterUnit)
    assert.isUndefined(plain.stories)

    const deferring = epicStoriesOptions({ deferTests: true, harden: false, argv: [] })
    assert.strictEqual(deferring.storyJudge, deferringTestsJudge)
    assert.isDefined(deferring.afterUnit)
    const memory = Effect.runSync(makeMemoryPlainFileStore())
    const { unit } = Effect.runSync(unitWith(memory.store))
    assert.strictEqual(deferring.stories?.(unit).judgeBar, "defer-tests")

    assert.strictEqual(
      epicStoriesOptions({ deferTests: false, harden: true, argv: [] }),
      hardenOptions
    )
  })
})
