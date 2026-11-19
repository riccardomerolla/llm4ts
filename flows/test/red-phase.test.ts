import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { LlmChunk } from "@llm4ts/core/Models"
import { makeCollectingFlowEvents, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { ReviewIssue, ReviewResult } from "@llm4ts/flow/Review"
import type { StorySeats } from "@llm4ts/flow/Stories"
import { Story, StoryPlan } from "@llm4ts/flow/StoryPlan"
import { generateStoryPlan, testOnlyStories, type EpicUnitContext } from "../lib/epic-stories.ts"
import { needsRedPhase, storiesTestFirst } from "../lib/red-phase.ts"
import { idleContext, idleGit, replying, scripted } from "./support.ts"

const conto = Story.make({
  id: "conto",
  title: "Current account",
  description: "Show the balance and the movements.",
  owned: ["src/conto"],
  acceptance: ["shows the balance", "lists the movements"]
})

const plan = StoryPlan.make({ epicId: "e", epic: "Accounts.", stories: [conto] })

const bothTags = 'it("[conto#1] shows the balance")\nit("[conto#2] lists the movements")'

/** A coder that records every turn it is given. */
const recording = (turns: Ref.Ref<ReadonlyArray<string>>): LlmServiceShape => {
  const answer = (prompt: string) =>
    Stream.unwrap(
      Effect.as(
        Ref.update(turns, (all) => [...all, prompt]),
        Stream.make(LlmChunk.make({ delta: "done", finishReason: "stop" }))
      )
    )
  return {
    ...replying("done"),
    executeStream: answer,
    executeStreamWithHistory: (messages) => answer(messages.at(-1)?.content ?? "")
  }
}

/**
 * A story's checkout: `tests` is the test file's text (absent: none written),
 * `gate` the test gate's verdict (absent: the gates name no test command).
 */
const setup = (options: { readonly tests?: string; readonly gate?: "red" | "green" }) =>
  Effect.gen(function* () {
    const memory = yield* makeMemoryPlainFileStore()
    const events = yield* makeCollectingFlowEvents
    const turns = yield* Ref.make<ReadonlyArray<string>>([])
    if (options.tests !== undefined) {
      yield* memory.store.writeAtomic("/wt/conto/src/conto/conto.test.ts", options.tests)
    }
    const gate = options.gate
    const unit: EpicUnitContext = {
      plan,
      stateDir: "/repo/.llm4ts/epics/e",
      epicStateDir: "/repo/.llm4ts/epics/e",
      workDir: "/repo",
      appDir: ".",
      files: memory.store,
      events,
      testGate:
        gate === undefined
          ? undefined
          : () =>
              Effect.succeed(
                ReviewResult.make({
                  issues:
                    gate === "red"
                      ? [
                          ReviewIssue.make({
                            severity: "Critical",
                            title: "2 failed",
                            description: ""
                          })
                        ]
                      : [],
                  summary: ""
                })
              )
    }
    const reviewer = yield* scripted([
      { issues: [], summary: "clean" },
      { issues: [], summary: "clean" }
    ])
    const seats: StorySeats = {
      context: {
        ...idleContext(events),
        coder: recording(turns),
        reasoning: reviewer.service,
        git: {
          ...idleGit,
          uncommittedFiles: Effect.succeed(
            options.tests === undefined ? [] : ["src/conto/conto.test.ts"]
          ),
          diffAll: Effect.succeed("diff --git a/src/conto/conto.test.ts b/src/conto/conto.test.ts")
        }
      }
    }
    const run = (story: Story = conto) =>
      storiesTestFirst(undefined)(unit).redPhase?.(story, seats, "/wt/conto", "system", events) ??
      Effect.die("no red phase")
    return { run, events, turns }
  })

const infos = (events: {
  readonly recorded: Effect.Effect<ReadonlyArray<{ readonly _tag: string }>>
}) =>
  Effect.map(events.recorded, (all) =>
    all.flatMap((event) =>
      event._tag === "Info" && "message" in event && typeof event.message === "string"
        ? [event.message]
        : []
    )
  )

describe("epic-stories red phase (ADR 0053)", () => {
  it.effect("tests written first, proved red by the test gate, frozen", () =>
    Effect.gen(function* () {
      const { run, events, turns } = yield* setup({ tests: bothTags, gate: "red" })
      const red = yield* run()
      assert.deepStrictEqual(red.frozen, ["src/conto/conto.test.ts"])
      assert.deepStrictEqual(red.parked, [])
      assert.include((yield* Ref.get(turns))[0] ?? "", "MUST FAIL now")
      const checked = (yield* events.recorded).flatMap((event) =>
        event._tag === "CriterionChecked" ? [`${event.tag}:${event.status}`] : []
      )
      assert.deepStrictEqual(checked, ["[conto#1]:red", "[conto#2]:red"])
    })
  )

  it.effect("tests that pass before implementation are noted, not parked", () =>
    Effect.gen(function* () {
      const { run, events } = yield* setup({ tests: bothTags, gate: "green" })
      const red = yield* run()
      assert.deepStrictEqual(red.parked, [])
      const said = (yield* infos(events)).join("\n")
      assert.include(said, "pass before implementation ([conto#1], [conto#2])")
    })
  )

  it.effect("an outcome no test names is noted and the story goes on", () =>
    Effect.gen(function* () {
      const { run, events, turns } = yield* setup({
        tests: 'it("[conto#1] shows the balance")',
        gate: "red"
      })
      const red = yield* run()
      assert.deepStrictEqual(red.frozen, ["src/conto/conto.test.ts"])
      // One more turn asked for the missing tag.
      assert.include((yield* Ref.get(turns))[1] ?? "", "[conto#2]")
      assert.include((yield* infos(events)).join("\n"), "no test names [conto#2]")
    })
  )

  it.effect("a red phase that writes no test fails the story", () =>
    Effect.gen(function* () {
      const { run } = yield* setup({ gate: "red" })
      const failed = yield* Effect.flip(run())
      assert.strictEqual(failed._tag, "StoryFailed")
      assert.include(failed.message, "no test was written")
    })
  )

  it.effect("without a test gate the tests are written but not run", () =>
    Effect.gen(function* () {
      const { run, events } = yield* setup({ tests: bothTags })
      const red = yield* run()
      assert.deepStrictEqual(red.frozen, ["src/conto/conto.test.ts"])
      assert.include((yield* infos(events)).join("\n"), "written but not run")
    })
  )

  it.effect("a story excused from tests, rewriting tests, or with no criteria skips it", () =>
    Effect.gen(function* () {
      const { run, turns } = yield* setup({ tests: bothTags, gate: "red" })
      for (const story of [
        Story.make({ ...conto, testsDeferred: "runs only on an ACE server" }),
        Story.make({ ...conto, testsChange: true }),
        Story.make({ ...conto, acceptance: [] })
      ]) {
        assert.isFalse(needsRedPhase(story))
        assert.deepStrictEqual(yield* run(story), { frozen: [], parked: [] })
      }
      assert.deepStrictEqual(yield* Ref.get(turns), [])
      assert.isTrue(needsRedPhase(conto))
    })
  )
})

describe("epic-stories story plan: no test-only story (ADR 0053)", () => {
  const story = (id: string, owned: ReadonlyArray<string>) => ({
    id,
    title: id,
    description: id,
    dependsOn: [],
    owned,
    sharedReadOnly: [],
    readFirst: [],
    acceptance: [],
    provides: []
  })
  const withTests = {
    epicId: "e",
    epic: "x",
    stories: [story("conto", ["src/conto"]), story("tests", ["tests/", "src/app.test.tsx"])]
  }
  const folded = { epicId: "e", epic: "x", stories: [story("conto", ["src/conto"])] }

  it("names the stories that own nothing but tests, unless they rewrite tests", () => {
    assert.deepStrictEqual(
      testOnlyStories(
        StoryPlan.make({
          ...withTests,
          stories: withTests.stories.map((entry) => Story.make(entry))
        })
      ),
      ["tests"]
    )
    const migration = StoryPlan.make({
      ...withTests,
      stories: withTests.stories.map((entry) =>
        Story.make(entry.id === "tests" ? { ...entry, testsChange: true } : entry)
      )
    })
    assert.deepStrictEqual(testOnlyStories(migration), [])
  })

  const generate = (replies: ReadonlyArray<unknown>, events: FlowEventsShape) =>
    Effect.gen(function* () {
      const planner = yield* scripted(replies)
      const generated = yield* generateStoryPlan(planner.service, events, "Accounts.", "e", "")
      return { generated, prompts: yield* planner.prompts }
    })

  it.effect("asks the planner once more when a story only writes tests", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const { generated, prompts } = yield* generate([withTests, folded], events)
      assert.strictEqual(prompts.length, 2)
      assert.include(prompts[0] ?? "", "No story only writes tests")
      assert.include(prompts[1] ?? "", "stories that only write tests: tests")
      assert.deepStrictEqual(
        generated.stories.map((entry) => entry.id),
        ["conto"]
      )
      assert.strictEqual(generated.epic, "Accounts.")
    })
  )

  it.effect("keeps a plan that still has one, and says so", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const { generated } = yield* generate([withTests, withTests], events)
      assert.deepStrictEqual(testOnlyStories(generated), ["tests"])
      assert.include((yield* infos(events)).join("\n"), "tests only write tests")
    })
  )
})
