import { assert, describe, it } from "@effect/vitest"
import * as Schema from "effect/Schema"
import { RefineRefused } from "@llm4ts/flow/FlowError"
import {
  assembleRound,
  countNotPlanned,
  earlierStories,
  NotPlanned,
  RefineProposal,
  renderNotPlanned,
  roundPrefix,
  runAction,
  type RoundProgress,
  type RunInputs
} from "@llm4ts/flow/RefineRound"
import { Story, StoryPlan, storyPlanViolations } from "@llm4ts/flow/StoryPlan"

const story = (id: string, owned: ReadonlyArray<string>, dependsOn: ReadonlyArray<string> = []) =>
  Story.make({
    id,
    title: id,
    description: `do ${id}`,
    dependsOn: [...dependsOn],
    owned: [...owned],
    sharedReadOnly: [],
    provides: [`${id} done`]
  })

const finished: RunInputs = {
  planned: true,
  stories: 3,
  merged: 3,
  landed: undefined,
  rounds: [],
  refine: false,
  feedback: "",
  land: false
}

const round = (number: number, stories: number, merged: number): RoundProgress => ({
  round: number,
  stories,
  merged
})

describe("what a run does", () => {
  it("without --refine it runs the plan, or the open round once the plan is merged", () => {
    assert.deepStrictEqual(runAction({ ...finished, merged: 1 }), { _tag: "RunPlan" })
    assert.deepStrictEqual(runAction(finished), { _tag: "RunPlan" })
    assert.deepStrictEqual(runAction({ ...finished, planned: false, stories: 0, merged: 0 }), {
      _tag: "RunPlan"
    })
    assert.deepStrictEqual(runAction({ ...finished, rounds: [round(1, 2, 2), round(2, 2, 1)] }), {
      _tag: "RunRound",
      round: 2
    })
    assert.deepStrictEqual(runAction({ ...finished, rounds: [round(1, 2, 2)] }), {
      _tag: "RunPlan"
    })
  })

  it("a round planned and never run is the open round", () => {
    const planned = { ...finished, rounds: [round(1, 2, 0)] }
    assert.deepStrictEqual(runAction(planned), { _tag: "RunRound", round: 1 })
    assert.deepStrictEqual(runAction({ ...planned, refine: true }), { _tag: "RunRound", round: 1 })
    const refused = runAction({ ...planned, refine: true, feedback: "move the card" })
    assert.strictEqual(refused._tag, "Refused")
    assert.match(refused._tag === "Refused" ? refused.reason : "", /round 1 is open/)
  })

  it("--refine with feedback plans the next round when everything before is merged", () => {
    assert.deepStrictEqual(runAction({ ...finished, refine: true, feedback: "move the card" }), {
      _tag: "PlanRound",
      round: 1
    })
    assert.deepStrictEqual(
      runAction({
        ...finished,
        rounds: [round(1, 2, 2), round(2, 1, 1)],
        refine: true,
        feedback: "remove the button"
      }),
      { _tag: "PlanRound", round: 3 }
    )
  })

  it("--refine is refused on an unplanned, unfinished or landed epic", () => {
    const reason = (inputs: RunInputs): string => {
      const action = runAction(inputs)
      return action._tag === "Refused" ? action.reason : `not refused: ${action._tag}`
    }
    const refine = { ...finished, refine: true, feedback: "move the card" }
    assert.match(reason({ ...refine, planned: false, stories: 0, merged: 0 }), /no story plan/)
    assert.match(reason({ ...refine, merged: 1 }), /1 of 3 stories merged/)
    assert.match(reason({ ...refine, landed: "main" }), /landed on main/)
  })

  it("--refine with neither feedback nor an open round is a usage error", () => {
    assert.strictEqual(runAction({ ...finished, refine: true, feedback: "  " })._tag, "Usage")
  })

  it("an unreadable round stops a refine and a plain rerun, naming it", () => {
    const broken: RoundProgress = {
      round: 1,
      stories: 0,
      merged: 0,
      unreadable: "rounds/1/plan.md: no storyplan block"
    }
    for (const inputs of [
      { ...finished, rounds: [broken] },
      { ...finished, rounds: [broken], refine: true, feedback: "move the card" }
    ]) {
      const action = runAction(inputs)
      assert.strictEqual(action._tag, "Refused")
      assert.match(action._tag === "Refused" ? action.reason : "", /rounds\/1\/plan\.md/)
    }
    // The plan's own unmerged stories still run.
    assert.deepStrictEqual(runAction({ ...finished, merged: 1, rounds: [broken] }), {
      _tag: "RunPlan"
    })
  })

  it("--land with feedback is a usage error: the feedback is never dropped", () => {
    const both = runAction({ ...finished, land: true, refine: true, feedback: "move the card" })
    assert.strictEqual(both._tag, "Usage")
    assert.match(both._tag === "Usage" ? both.message : "", /--refine.*--land/)
    // --refine with no text beside --land asks for nothing: the landing decides.
    assert.deepStrictEqual(runAction({ ...finished, land: true, refine: true }), { _tag: "Land" })
  })

  it("an unreadable round is fixed or removed as a folder, never by deleting its plan", () => {
    const action = runAction({
      ...finished,
      rounds: [{ round: 2, stories: 0, merged: 0, unreadable: "rounds/2/plan.md: broken" }]
    })
    assert.match(
      action._tag === "Refused" ? action.reason : "",
      /fix the plan, or delete the folder rounds\/2 and every later round/
    )
  })

  it("--land is always the landing's own decision", () => {
    assert.deepStrictEqual(runAction({ ...finished, land: true, rounds: [round(1, 2, 0)] }), {
      _tag: "Land"
    })
  })

  it("RefineRefused says what cannot be refined and why", () => {
    assert.strictEqual(
      RefineRefused.make({ epicId: "bank", reason: "the epic has landed on main" }).message,
      "epic 'bank' cannot be refined: the epic has landed on main"
    )
  })
})

describe("assembling a round", () => {
  const proposal = RefineProposal.make({
    stories: [
      story("move-card", ["src/conto/Saldo.tsx"], ["conto-screen"]),
      story("r2-remove-export", ["src/conto/Export.tsx"], ["move-card", "r1-older-fix"])
    ],
    notPlanned: []
  })
  const plan = assembleRound({
    epicId: "bank",
    round: 2,
    feedback: "Move the card. Remove the export button.",
    proposal,
    earlier: ["conto-screen", "r1-older-fix"]
  })

  it("prefixes ids once, keeps the epic id and carries the feedback", () => {
    assert.strictEqual(roundPrefix(2), "r2-")
    assert.strictEqual(plan.epicId, "bank")
    assert.strictEqual(plan.epic, "Move the card. Remove the export button.")
    assert.deepStrictEqual(
      plan.stories.map((entry) => entry.id),
      ["r2-move-card", "r2-remove-export"]
    )
  })

  it("rewrites dependencies within the round and drops those already merged", () => {
    assert.deepStrictEqual(plan.stories[0]?.dependsOn, [])
    assert.deepStrictEqual(plan.stories[1]?.dependsOn, ["r2-move-card"])
    assert.deepStrictEqual(storyPlanViolations(plan), [])
  })

  it("a story reusing an earlier story's id still gets a new one", () => {
    const reused = assembleRound({
      epicId: "bank",
      round: 1,
      feedback: "fix",
      proposal: RefineProposal.make({
        stories: [story("conto-screen", ["src/conto"])],
        notPlanned: []
      }),
      earlier: ["conto-screen"]
    })
    assert.deepStrictEqual(
      reused.stories.map((entry) => entry.id),
      ["r1-conto-screen"]
    )
  })

  it("paths stay exclusive within the round, free against earlier stories", () => {
    const clash = assembleRound({
      epicId: "bank",
      round: 1,
      feedback: "two fixes",
      proposal: RefineProposal.make({
        stories: [story("a", ["src/conto/Saldo.tsx"]), story("b", ["src/conto"], ["a"])],
        notPlanned: []
      }),
      earlier: []
    })
    assert.match(storyPlanViolations(clash).join("\n"), /both own/)
  })

  it("an unknown dependency is left for validation to reject", () => {
    const unknown = assembleRound({
      epicId: "bank",
      round: 1,
      feedback: "fix",
      proposal: RefineProposal.make({
        stories: [story("a", ["src/a"], ["nowhere"])],
        notPlanned: []
      }),
      earlier: []
    })
    assert.match(storyPlanViolations(unknown).join("\n"), /unknown story 'r1-nowhere'/)
  })
})

describe("what was not planned", () => {
  it("renders one line per item and counts them back", () => {
    const markdown = renderNotPlanned(1, [
      NotPlanned.make({ item: "adjust the\nheader", reason: "adjust how? say what changes" }),
      NotPlanned.make({ item: "the transfer is slow", reason: "no file to tie it to" })
    ])
    assert.match(markdown, /^# Not planned in round 1/)
    assert.match(markdown, /- \*\*adjust the header\*\* — adjust how\? say what changes/)
    assert.strictEqual(countNotPlanned(markdown), 2)
    assert.strictEqual(countNotPlanned(renderNotPlanned(1, [])), 0)
  })

  it("a proposal decodes without a not-planned list", () => {
    const decoded = Schema.decodeUnknownSync(RefineProposal)({
      stories: [{ id: "a", title: "a", description: "a", owned: ["src/a"] }]
    })
    assert.deepStrictEqual(decoded.notPlanned, [])
  })
})

describe("the earlier stories a planner is shown", () => {
  it("reduces every earlier plan to ids, titles, owned paths and provides", () => {
    const epic = StoryPlan.make({
      epicId: "bank",
      epic: "Conto",
      stories: [story("conto-screen", ["src/conto"])]
    })
    const first = StoryPlan.make({
      epicId: "bank",
      epic: "feedback",
      stories: [story("r1-move-card", ["src/conto/Saldo.tsx"])]
    })
    assert.deepStrictEqual(earlierStories([epic, first]), [
      {
        id: "conto-screen",
        title: "conto-screen",
        owned: ["src/conto"],
        provides: ["conto-screen done"]
      },
      {
        id: "r1-move-card",
        title: "r1-move-card",
        owned: ["src/conto/Saldo.tsx"],
        provides: ["r1-move-card done"]
      }
    ])
  })
})
