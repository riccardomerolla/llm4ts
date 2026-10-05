import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import {
  makeMemoryPlainFileStore,
  saveVersioned,
  type PlainFileStoreShape
} from "@llm4ts/flow/Persistence"
import { earlierStories } from "@llm4ts/flow/RefineRound"
import { StoryState, StoryStateVersion } from "@llm4ts/flow/Stories"
import { makeStoryPlanStore, Story, StoryPlan } from "@llm4ts/flow/StoryPlan"
import { epicProgressOf } from "../lib/epic-design.ts"
import {
  epicIdFor,
  epicOnDisk,
  epicUsage,
  epicsDir,
  landRounds,
  listEpics,
  loadRounds,
  parseEpicArgs,
  planRound,
  refineEpic,
  refinePlanInstructions,
  renderEpicList,
  roundDir,
  roundProgress,
  type EpicSummary
} from "../lib/epic-stories.ts"
import { nodePlainFileStore } from "@llm4ts/runner"
import { scripted } from "./support.ts"

const stateDir = "/repo/.llm4ts/epics/bank"

const story = (id: string, owned: ReadonlyArray<string>, dependsOn: ReadonlyArray<string> = []) =>
  Story.make({
    id,
    title: `Title of ${id}`,
    description: `do ${id}`,
    dependsOn: [...dependsOn],
    owned: [...owned],
    sharedReadOnly: [],
    provides: [`${id} done`]
  })

const epicPlan = StoryPlan.make({
  epicId: "bank",
  epic: "Conto e Bonifico",
  stories: [story("conto-screen", ["src/conto"]), story("app-shell", ["src/App.tsx"])]
})

const roundPlan = (round: number, ids: ReadonlyArray<string>) =>
  StoryPlan.make({
    epicId: "bank",
    epic: `feedback of round ${round}`,
    stories: ids.map((id) => story(id, [`src/fix/${id}.tsx`]))
  })

const merged = (files: PlainFileStoreShape, dir: string, id: string) =>
  saveVersioned(
    files,
    `${dir}/stories/${id}.json`,
    StoryStateVersion,
    StoryState,
    StoryState.make({
      id,
      hash: "h",
      branch: `story/bank/${id}`,
      worktree: `/wt/${id}`,
      status: "merged"
    })
  )

const proposalReply = {
  stories: [
    {
      id: "move-card",
      title: "Move the balance card",
      description: 'Answers "move the balance card above the list".',
      dependsOn: ["conto-screen"],
      owned: ["src/conto/Saldo.tsx", "src/conto/Saldo.test.tsx"],
      sharedReadOnly: [],
      provides: ["the balance card sits above the movements list"]
    }
  ],
  notPlanned: [{ item: "adjust the header", reason: "adjust how? say what should change" }]
}

describe("refine rounds: flags", () => {
  it.effect("--refine is a flag; the text after it stays for the shared parser", () =>
    Effect.gen(function* () {
      const flags = yield* parseEpicArgs([
        "--epic",
        "bank",
        "--refine",
        "--plan-only",
        "move the card"
      ])
      assert.isTrue(flags.refine)
      assert.isTrue(flags.planOnly)
      assert.strictEqual(flags.epic, "bank")
      assert.deepStrictEqual(flags.rest, ["move the card"])
      assert.isFalse((yield* parseEpicArgs(["Add Conto"])).refine)
      assert.isTrue((yield* parseEpicArgs(["--refine"])).refine)
      assert.include(epicUsage, "--refine")
    })
  )
})

describe("refine rounds: on disk", () => {
  it.effect("finds the rounds, their merged stories and what was not planned", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const files = memory.store
      const plans = makeStoryPlanStore(files)
      assert.deepStrictEqual(yield* loadRounds(files, stateDir), [])
      assert.strictEqual(roundDir(stateDir, 2), `${stateDir}/rounds/2`)
      yield* plans.save(`${roundDir(stateDir, 1)}/plan.md`, roundPlan(1, ["r1-a", "r1-b"]))
      yield* merged(files, roundDir(stateDir, 1), "r1-a")
      yield* files.writeAtomic(
        `${roundDir(stateDir, 1)}/not-planned.md`,
        "# Not planned in round 1\n\n- **adjust the header** — adjust how?\n"
      )
      yield* files.writeAtomic(`${roundDir(stateDir, 2)}/plan.md`, "someone broke this file")
      yield* plans.save(`${roundDir(stateDir, 3)}/plan.md`, roundPlan(3, ["r3-c"]))
      const rounds = yield* loadRounds(files, stateDir)
      assert.deepStrictEqual(
        rounds.map((round) => [
          round.round,
          round.plan?.stories.length,
          round.merged,
          round.notPlanned
        ]),
        [
          [1, 2, 1, 1],
          [2, undefined, 0, 0],
          [3, 1, 0, 0]
        ]
      )
      assert.strictEqual(rounds[0]?.stateDir, `${stateDir}/rounds/1`)
      assert.isUndefined(rounds[0]?.unreadable)
      assert.include(rounds[1]?.unreadable ?? "", `${stateDir}/rounds/2/plan.md`)
      assert.deepStrictEqual(roundProgress(rounds)[0], { round: 1, stories: 2, merged: 1 })
      assert.include(roundProgress(rounds)[1]?.unreadable ?? "", "rounds/2/plan.md")
    })
  )

  it.effect("a round plan that breaks the plan's rules is unreadable too", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* makeStoryPlanStore(memory.store).save(
        `${roundDir(stateDir, 1)}/plan.md`,
        StoryPlan.make({
          epicId: "bank",
          epic: "feedback",
          stories: [story("r1-a", ["src/x"]), story("r1-b", ["src/x/y.tsx"])]
        })
      )
      const [round] = yield* loadRounds(memory.store, stateDir)
      assert.include(round?.unreadable ?? "", "both own")
    })
  )

  it.effect("a missing plan between rounds is a broken round, not the end of the list", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* makeStoryPlanStore(memory.store).save(
        `${roundDir(stateDir, 2)}/plan.md`,
        roundPlan(2, ["r2-a"])
      )
      const rounds = yield* loadRounds(memory.store, stateDir)
      assert.deepStrictEqual(
        rounds.map((round) => [round.round, round.plan?.stories.length]),
        [
          [1, undefined],
          [2, 1]
        ]
      )
      assert.include(rounds[0]?.unreadable ?? "", `${stateDir}/rounds/1/plan.md is missing`)
    })
  )

  it.effect("rounds that cannot be read at all are reported on the epic, never dropped", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "llm4ts-rounds-"))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true }))
        )
        const epicState = join(epicsDir(root), "bank")
        yield* makeStoryPlanStore(nodePlainFileStore).save(join(epicState, "plan.md"), epicPlan)
        // A directory where the round's plan file should be: the read fails.
        yield* Effect.promise(() =>
          mkdir(join(roundDir(epicState, 1), "plan.md"), { recursive: true })
        )
        const [epic] = yield* listEpics(nodePlainFileStore, root)
        assert.strictEqual(epic?.rounds.length, 1)
        assert.include(epic?.rounds[0]?.unreadable ?? "", "rounds")
        assert.strictEqual(
          (yield* Effect.flip(landRounds("bank", "main", epic?.rounds ?? [])))._tag,
          "LandingFailed"
        )
      })
    )
  )

  it("--list and the coverage progress count the rounds", () => {
    const summary: EpicSummary = {
      dir: "bank-abc123",
      stateDir,
      epicId: "bank",
      epic: "Conto e Bonifico",
      stories: 2,
      merged: 2,
      landed: undefined,
      rounds: [
        {
          round: 1,
          stateDir: roundDir(stateDir, 1),
          plan: roundPlan(1, ["r1-a", "r1-b"]),
          merged: 2,
          notPlanned: 0,
          unreadable: undefined
        },
        {
          round: 2,
          stateDir: roundDir(stateDir, 2),
          plan: roundPlan(2, ["r2-a", "r2-b"]),
          merged: 1,
          notPlanned: 1,
          unreadable: undefined
        },
        {
          round: 3,
          stateDir: roundDir(stateDir, 3),
          plan: undefined,
          merged: 0,
          notPlanned: 0,
          unreadable: "rounds/3/plan.md: no plan"
        }
      ]
    }
    assert.include(
      renderEpicList([summary]),
      "- bank · 2/2 stories merged · finished, not landed · round 1: 2/2 merged · round 2: 1/2 merged, 1 not planned · round 3: unreadable plan  (--epic bank)"
    )
    assert.deepStrictEqual(epicProgressOf([summary]), [
      { epicId: "bank-abc123", planned: true, stories: 6, merged: 5, landed: false }
    ])
  })
})

describe("refine rounds: planning", () => {
  it("the planner is shown the earlier stories, the brief and what was left open", () => {
    const prompt = refinePlanInstructions({
      epicId: "bank",
      round: 2,
      guidance: "kit components only",
      earlier: earlierStories([epicPlan]),
      brief: "# Epic brief: bank",
      openItems: "- **adjust the header** — adjust how?"
    })
    assert.include(prompt, "- conto-screen: Title of conto-screen — owns: src/conto")
    assert.include(prompt, "provides: conto-screen done")
    assert.include(prompt, "# Epic brief: bank")
    assert.include(prompt, "- **adjust the header** — adjust how?")
    assert.include(prompt, "kit components only")
    assert.include(prompt, '"notPlanned"')
    assert.include(prompt, "r2-")
    const bare = refinePlanInstructions({
      epicId: "bank",
      round: 1,
      guidance: "g",
      earlier: []
    })
    assert.notInclude(bare, "Left unplanned")
    assert.notInclude(bare, "approved brief")
  })

  it.effect("writes the round's feedback, plan and not-planned list; the epic's plan stays", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const files = memory.store
      yield* makeStoryPlanStore(files).save(`${stateDir}/plan.md`, epicPlan)
      const before = yield* files.read(`${stateDir}/plan.md`)
      const seat = yield* scripted([proposalReply])
      const events = yield* makeCollectingFlowEvents
      const feedback = "Move the balance card above the list. Adjust the header."
      const planned = yield* planRound({
        files,
        reasoning: seat.service,
        events,
        stateDir,
        epicId: "bank",
        round: 1,
        feedback,
        guidance: "house rules",
        plans: [epicPlan]
      })
      // A path the epic's own story owns is free to claim; the merged dependency is dropped.
      assert.deepStrictEqual(
        planned.plan?.stories.map((entry) => [entry.id, entry.dependsOn, entry.owned[0]]),
        [["r1-move-card", [], "src/conto/Saldo.tsx"]]
      )
      assert.deepStrictEqual(
        planned.notPlanned.map((entry) => entry.item),
        ["adjust the header"]
      )
      const dir = roundDir(stateDir, 1)
      assert.strictEqual(yield* files.read(`${dir}/feedback.md`), `${feedback}\n`)
      assert.include((yield* files.read(`${dir}/plan.md`)) ?? "", "r1-move-card")
      assert.include((yield* files.read(`${dir}/not-planned.md`)) ?? "", "**adjust the header**")
      assert.strictEqual(yield* files.read(`${stateDir}/plan.md`), before)
      const [round] = yield* loadRounds(files, stateDir)
      assert.deepStrictEqual([round?.plan?.epic, round?.notPlanned], [feedback, 1])
      const prompt = (yield* seat.prompts)[0] ?? ""
      assert.include(prompt, feedback)
      assert.include(prompt, "owns: src/conto")
    })
  )

  it.effect("a round's readFirst anchors are pruned to paths in the repository", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const files = memory.store
      yield* makeStoryPlanStore(files).save(`${stateDir}/plan.md`, epicPlan)
      const seat = yield* scripted([
        {
          ...proposalReply,
          stories: proposalReply.stories.map((entry) => ({
            ...entry,
            readFirst: ["src/conto/Saldo.tsx", "src/ghost.ts", "../outside"]
          }))
        }
      ])
      const events = yield* makeCollectingFlowEvents
      const asked: Array<ReadonlyArray<string>> = []
      const planned = yield* planRound({
        files,
        reasoning: seat.service,
        events,
        stateDir,
        epicId: "bank",
        round: 1,
        feedback: "Move the balance card above the list.",
        guidance: "house rules",
        plans: [epicPlan],
        git: {
          listFiles: (paths) => {
            asked.push(paths)
            return Effect.succeed(["src/conto/Saldo.tsx"])
          }
        }
      })
      assert.deepStrictEqual(planned.plan?.stories[0]?.readFirst, ["src/conto/Saldo.tsx"])
      // The unsafe anchor never reached git.
      assert.deepStrictEqual(asked, [["src/conto/Saldo.tsx", "src/ghost.ts"]])
      const notes = (yield* events.recorded).flatMap((event) =>
        event._tag === "Info" ? [event.message] : []
      )
      assert.include(notes.join("\n"), "src/ghost.ts")
      assert.include(notes.join("\n"), "../outside")
    })
  )

  it.effect("the next round's planner reads what the previous round left unplanned", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const files = memory.store
      const first = roundPlan(1, ["r1-a"])
      yield* makeStoryPlanStore(files).save(`${roundDir(stateDir, 1)}/plan.md`, first)
      yield* files.writeAtomic(
        `${roundDir(stateDir, 1)}/not-planned.md`,
        "# Not planned in round 1\n\n- **adjust the header** — adjust how?\n"
      )
      const seat = yield* scripted([{ ...proposalReply, notPlanned: [] }])
      const events = yield* makeCollectingFlowEvents
      const planned = yield* planRound({
        files,
        reasoning: seat.service,
        events,
        stateDir,
        epicId: "bank",
        round: 2,
        feedback: "Header: make the title bold.",
        guidance: "house rules",
        plans: [epicPlan, first],
        brief: "# Epic brief: bank"
      })
      assert.deepStrictEqual(
        planned.plan?.stories.map((entry) => entry.id),
        ["r2-move-card"]
      )
      const prompt = (yield* seat.prompts)[0] ?? ""
      assert.include(prompt, "- **adjust the header** — adjust how?")
      assert.include(prompt, "- r1-a: Title of r1-a")
      assert.include(prompt, "# Epic brief: bank")
      // Nothing left out: the file says so, and replaces whatever a reused folder held.
      assert.include(
        (yield* files.read(`${roundDir(stateDir, 2)}/not-planned.md`)) ?? "",
        "Every feedback item was planned."
      )
      assert.strictEqual((yield* loadRounds(files, stateDir))[1]?.notPlanned, 0)
    })
  )

  it.effect("nothing is written for an empty proposal or a rejected one", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const files = memory.store
      const events = yield* makeCollectingFlowEvents
      const deps = {
        files,
        events,
        stateDir,
        epicId: "bank",
        round: 1,
        feedback: "Adjust the header.",
        guidance: "house rules",
        plans: [epicPlan]
      }
      const empty = yield* scripted([{ stories: [], notPlanned: proposalReply.notPlanned }])
      const nothing = yield* planRound({ ...deps, reasoning: empty.service })
      assert.isUndefined(nothing.plan)
      assert.strictEqual(nothing.notPlanned.length, 1)
      const clash = yield* scripted([
        {
          stories: [
            { ...proposalReply.stories[0], id: "a" },
            { ...proposalReply.stories[0], id: "b" }
          ],
          notPlanned: []
        }
      ])
      const rejected = yield* Effect.flip(planRound({ ...deps, reasoning: clash.service }))
      assert.strictEqual(rejected._tag, "StoryPlanInvalid")
      assert.include(rejected.message, "both own")
      assert.notInclude(rejected.message, "Adjust the header.")
      assert.deepStrictEqual(Object.keys(yield* memory.files), [])
    })
  )
})

describe("refine rounds: the run", () => {
  const summary: EpicSummary = {
    dir: "bank-abc123",
    stateDir,
    epicId: "bank",
    epic: "Conto e Bonifico",
    stories: 2,
    merged: 2,
    landed: undefined,
    rounds: []
  }

  it.effect("--refine works on an epic that has a plan, never on its feedback as a new epic", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* refineEpic({ _tag: "Existing", epic: summary }), summary)
      const briefOnly = yield* Effect.flip(
        refineEpic({ _tag: "Brief", dir: "carte", request: "Cards" })
      )
      assert.strictEqual(briefOnly._tag, "RefineRefused")
      assert.include(briefOnly.message, "epic 'carte' cannot be refined: it has no story plan yet")
      const none = yield* Effect.flip(refineEpic({ _tag: "Text", prompt: "the demo epic" }))
      assert.strictEqual(none._tag, "ScriptUsage")
      assert.include(none.message, "--refine needs a finished epic")
      assert.notInclude(none.message, "the demo epic")
    })
  )

  it("an epic rerun by its text is the same epic on disk, rounds included", () => {
    const text = "Conto e Bonifico"
    const onDisk = { ...summary, dir: epicIdFor(text) }
    assert.strictEqual(epicOnDisk({ _tag: "Existing", epic: summary }, [onDisk]), summary)
    assert.strictEqual(epicOnDisk({ _tag: "Text", prompt: text }, [summary, onDisk]), onDisk)
    assert.isUndefined(epicOnDisk({ _tag: "Text", prompt: "Cards" }, [summary, onDisk]))
    assert.isUndefined(epicOnDisk({ _tag: "Brief", dir: "carte", request: "Cards" }, [summary]))
  })

  it.effect("landing takes the rounds' plans, and refuses an unreadable one by name", () =>
    Effect.gen(function* () {
      const first = {
        round: 1,
        stateDir: roundDir(stateDir, 1),
        plan: roundPlan(1, ["r1-a"]),
        merged: 1,
        notPlanned: 0,
        unreadable: undefined
      }
      assert.deepStrictEqual(yield* landRounds("bank", "main", [first]), [
        { plan: first.plan, stateDir: first.stateDir }
      ])
      const refused = yield* Effect.flip(
        landRounds("bank", "main", [
          first,
          {
            round: 2,
            stateDir: roundDir(stateDir, 2),
            plan: undefined,
            merged: 0,
            notPlanned: 0,
            unreadable: "rounds/2/plan.md: no storyplan block"
          }
        ])
      )
      assert.strictEqual(refused._tag, "LandingFailed")
      assert.include(refused.message, "round 2's plan cannot be read (rounds/2/plan.md")
    })
  )

  it("the program decides, plans on the epic branch, runs the unit and lands with the rounds", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "epic-stories.ts"),
      "utf8"
    )
    const readme = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"),
      "utf8"
    )
    assert.include(readme, "### Refining a finished epic")
    assert.include(readme, "-- --refine")
    const program = source.slice(source.indexOf("export const runEpicStories"))
    assert.include(program, "runAction(")
    assert.include(program, "epicOnDisk(choice, epics)")
    assert.include(program, "refineEpic(")
    assert.include(program, "rounds: yield* landRounds(")
    // The planner reads the code as the person tried it.
    const dirty = program.indexOf("EpicCheckoutDirty.make(")
    assert.isAbove(dirty, 0)
    assert.isBelow(dirty, program.indexOf("context.git.checkoutOrCreate(epicBranch)"))
    const checkout = program.indexOf("context.git.checkoutOrCreate(epicBranch)")
    assert.isAbove(checkout, 0)
    assert.isAbove(program.indexOf("planRound("), checkout)
    // The executor, its board, judge and verifier all work on the chosen unit.
    assert.include(program, "plan: unit.plan")
    assert.include(program, "stateDir: unit.stateDir")
    assert.include(program, "makeLocalBoardSync(files, unit.stateDir, unit.label)")
    assert.notInclude(
      program.slice(program.indexOf("implementStoriesFlow(")),
      "              plan,\n"
    )
  })
})
