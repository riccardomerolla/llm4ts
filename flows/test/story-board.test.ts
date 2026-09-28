import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { dimensionQuestion } from "@llm4ts/core/eval/Judge"
import { makeFakeJudgment } from "@llm4ts/core/judgment/FakeJudgment"
import { origins, scoreAnswer, type Answer } from "@llm4ts/core/judgment/Schemas"
import {
  makeCollectingFlowEvents,
  type BlackboardRun,
  type JudgmentObserved
} from "@llm4ts/flow/FlowEvents"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import type { StorySeats } from "@llm4ts/flow/Stories"
import { Story, StoryPlan } from "@llm4ts/flow/StoryPlan"
import { storyDimensions } from "../lib/epic-stories.ts"
import { boardStoryJudge, makeStoryBoard, storyBriefOf } from "../lib/story-board.ts"
import { idleContext, replying } from "./support.ts"

const story = Story.make({
  id: "conto",
  title: "Current account",
  description: "Balance and movements",
  owned: ["src/features/conto/"],
  provides: ["GET /api/conto"],
  dependsOn: ["kit"]
})
const kit = Story.make({
  id: "kit",
  title: "Kit",
  description: "shared",
  owned: ["src/kit/"],
  provides: ["Money type"]
})
const plan = StoryPlan.make({ epicId: "e1", epic: "Epic", stories: [kit, story] })

const dimension = (name: string) => {
  const found = storyDimensions.find((d) => d.name === name)
  if (found === undefined) throw new Error(`no dimension ${name}`)
  return found
}

/** A fake answer fully on one level; `support` below 0.5 makes the policy hold it. */
const level = (name: string, index: 0 | 1 | 2, support = 1): Answer =>
  scoreAnswer(dimensionQuestion(dimension(name)), { [String(index)]: 1 }, origins.fake(), support)

const allTop: Record<string, Answer> = Object.fromEntries(
  storyDimensions.map((d) => [d.name, level(d.name, 2)])
)

const judgeWith = (answers: Record<string, Answer>, failures: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeJudgment({ answers, failures })
    const events = yield* makeCollectingFlowEvents
    const memory = yield* makeMemoryPlainFileStore()
    const judge = yield* boardStoryJudge({
      plan,
      budget: 10_000,
      reasoning: replying(""),
      events,
      files: memory.store,
      houseRules: "kit components only",
      judgment: fake.judgment
    })
    const seats: StorySeats = { context: idleContext(events) }
    return { fake, events, judge, seats }
  })

describe("the story board ruleset", () => {
  it.effect("is valid, with three imports, two exports and six rules", () =>
    Effect.gen(function* () {
      const board = yield* makeStoryBoard()
      assert.deepStrictEqual(board.imports, ["story.brief", "story.diff", "story.houseRules"])
      assert.deepStrictEqual(board.exports, ["story.mergeable", "story.issues"])
      assert.strictEqual(board.rules.length, 6)
      assert.deepStrictEqual(board.warnings, [])
      assert.include(board.describe(), "bar:")
    })
  )

  it("the brief carries the dependencies' declared interface", () => {
    const brief = storyBriefOf(story, plan)
    assert.deepStrictEqual(brief.dependencies, [{ id: "kit", provides: ["Money type"] }])
  })

  it.effect("four top scores merge; the run and every answer are published", () =>
    Effect.gen(function* () {
      const { fake, events, judge, seats } = yield* judgeWith(allTop)
      const verdict = yield* judge(story, "+ code", seats)
      assert.isTrue(verdict.isClean)
      assert.strictEqual(verdict.summary, "story-board:conto")
      const seen = yield* events.recorded
      const run = seen.find((e): e is BlackboardRun => e._tag === "BlackboardRun")
      assert.strictEqual(run?.ruleset, "story-board")
      assert.strictEqual(
        run?.result.trace.find((f) => f.rule === "story-judge")?.judgment?.backend,
        "fake"
      )
      const observed = seen.filter((e): e is JudgmentObserved => e._tag === "JudgmentObserved")
      assert.strictEqual(observed.length, 4)
      assert.isTrue(
        observed.every((o) => o.consumer === "story-board" && o.outcome._tag === "StoryBoard")
      )
      const requests = yield* fake.recorded
      assert.strictEqual(requests.length, 1)
      const state = String(requests[0]?.state)
      assert.include(state, "Money type")
      assert.include(state, "+ code")
      assert.include(state, "kit components only")
    })
  )

  it.effect("one dimension at level 1 is not mergeable, with one issue naming it", () =>
    Effect.gen(function* () {
      const { judge, seats } = yield* judgeWith({ ...allTop, scope: level("scope", 1) })
      const verdict = yield* judge(story, "+ code", seats)
      assert.isFalse(verdict.isClean)
      assert.deepStrictEqual(
        verdict.issues.map((i) => i.title),
        ["judge[conto]: scope scored 1.0"]
      )
      assert.strictEqual(verdict.issues[0]?.severity, "Critical")
    })
  )

  it.effect("an expected score of exactly 1.5 passes the score bar", () =>
    Effect.gen(function* () {
      const half = scoreAnswer(
        dimensionQuestion(dimension("tests")),
        { "1": 0.5, "2": 0.5 },
        origins.fake()
      )
      const { judge, seats } = yield* judgeWith({ ...allTop, tests: half })
      const verdict = yield* judge(story, "+ code", seats)
      // 0.5 confidence is held by the policy, so the only issue is "unsure", never "scored".
      assert.isTrue(verdict.issues.every((i) => !i.title.includes("scored")))
      assert.deepStrictEqual(
        verdict.issues.map((i) => i.title),
        ["judge[conto]: unsure about tests"]
      )
    })
  )

  it.effect("a passing score whose decision is not act is an 'unsure' issue", () =>
    Effect.gen(function* () {
      const { judge, seats } = yield* judgeWith({
        ...allTop,
        "house-style": level("house-style", 2, 0.1)
      })
      const verdict = yield* judge(story, "+ code", seats)
      assert.isFalse(verdict.isClean)
      assert.deepStrictEqual(
        verdict.issues.map((i) => i.title),
        ["judge[conto]: unsure about house-style"]
      )
    })
  )

  it.effect("a dimension the backend could not score fails the round, naming it", () =>
    Effect.gen(function* () {
      const { judge, seats } = yield* judgeWith(allTop, { tests: "no logprobs" })
      const error = yield* Effect.flip(judge(story, "+ code", seats))
      assert.include(error.message, "tests")
      assert.include(error.message, "conto")
      assert.notInclude(error.message, "+ code")
    })
  )
})
