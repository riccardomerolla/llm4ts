import { assert, describe, it } from "@effect/vitest"
import { buildLedger, inheritedFrom, type EpicProgress } from "@llm4ts/flow/CoverageLedger"
import { OpenPoint } from "@llm4ts/flow/Decisions"
import {
  Citation,
  ConsideredProgram,
  Disposed,
  EpicBrief,
  renderBriefProblem,
  ScopeItem,
  type BriefProblem,
  type PackIndex
} from "@llm4ts/flow/EpicBrief"

export const pack: PackIndex = {
  programs: [
    { name: "P", summary: "Program P.", scenarios: ["s1", "s2", "s3", "s4", "s5", "s6"] },
    { name: "Q", summary: "Program Q.", scenarios: ["q1", "q2"] }
  ],
  refine: []
}

type Parts = Partial<ConstructorParameters<typeof EpicBrief>[0]>

export const briefOf = (
  epicId: string,
  status: "draft" | "approved",
  parts: Parts = {}
): EpicBrief =>
  EpicBrief.make({
    epicId,
    status,
    request: epicId,
    legacy: "/legacy",
    goal: "",
    programs: [ConsideredProgram.make({ name: "P", reason: "" })],
    scope: [],
    dropped: [],
    provided: [],
    deferred: [],
    constraints: "",
    openPoints: [],
    feedback: "",
    ...parts
  })

export const inScope = (title: string, ...scenarios: ReadonlyArray<string>): ScopeItem =>
  ScopeItem.make({
    title,
    citations: scenarios.map((scenario) => Citation.make({ program: "P", scenario }))
  })

export const out = (scenario: string, note: string, program = "P"): Disposed =>
  Disposed.make({ program, scenario, note })

const kept = (problem: BriefProblem): OpenPoint =>
  OpenPoint.make({
    number: 1,
    question: `[check] ${renderBriefProblem(problem)}`,
    answer: "keep: on purpose"
  })

const ledgerOf = (
  briefs: ReadonlyArray<EpicBrief>,
  epics: ReadonlyArray<EpicProgress> = [],
  legacy?: string
) =>
  buildLedger({
    pack,
    briefs: briefs.map((brief) => ({ epicId: brief.epicId, brief })),
    epics,
    ...(legacy === undefined ? {} : { legacy })
  })

const entry = (ledger: ReturnType<typeof ledgerOf>, scenario: string) => {
  const found = ledger.entries.find((candidate) => candidate.scenario === scenario)
  if (found === undefined) throw new Error(`no entry for ${scenario}`)
  return found
}

describe("the coverage ledger", () => {
  it("gives every scenario of the pack a status from the approved briefs", () => {
    const ledger = ledgerOf([
      briefOf("A", "approved", {
        scope: [inScope("Item one", "s1")],
        dropped: [out("s2", "dead")],
        provided: [out("s3", "src/kit/x.ts")],
        deferred: [out("s4", "next epic")]
      }),
      briefOf("D", "draft", { scope: [inScope("Draft item", "s5")] })
    ])
    assert.strictEqual(ledger.entries.length, 8)
    assert.deepStrictEqual(
      ["s1", "s2", "s3", "s4", "s5", "s6", "q1"].map((name) => entry(ledger, name).status),
      ["in-scope", "dropped", "provided", "deferred", "proposed", "unclaimed", "unclaimed"]
    )
    assert.deepStrictEqual(entry(ledger, "s1").owners, ["A"])
    assert.strictEqual(entry(ledger, "s1").claims[0]?.note, "Item one")
    assert.strictEqual(entry(ledger, "s1").delivery, "approved")
    assert.strictEqual(entry(ledger, "s3").claims[0]?.note, "src/kit/x.ts")
    assert.isFalse(entry(ledger, "s5").claims[0]?.approved)
    assert.isUndefined(entry(ledger, "s2").delivery)
  })

  it("a deferred scenario claimed by another epic is a hand-over, with its history", () => {
    const claimed = ledgerOf([
      briefOf("A", "approved", { deferred: [out("s4", "next epic")] }),
      briefOf("B", "approved", { scope: [inScope("Statements", "s4")] })
    ])
    assert.strictEqual(entry(claimed, "s4").status, "in-scope")
    assert.deepStrictEqual(entry(claimed, "s4").owners, ["B"])
    assert.strictEqual(entry(claimed, "s4").claims.length, 2)
    // Deferred by one, then dropped by another: decided, not a conflict.
    const dropped = ledgerOf([
      briefOf("A", "approved", { deferred: [out("s4", "next epic")] }),
      briefOf("B", "approved", { dropped: [out("s4", "no longer needed")] })
    ])
    assert.strictEqual(entry(dropped, "s4").status, "dropped")
    assert.deepStrictEqual(entry(dropped, "s4").owners, ["B"])
  })

  it("approved briefs that disagree are a conflict; a draft is only listed", () => {
    const ledger = ledgerOf([
      briefOf("A", "approved", { scope: [inScope("Item", "s1")] }),
      briefOf("B", "approved", { dropped: [out("s1", "dead")] }),
      briefOf("C", "draft", { scope: [inScope("Again", "s1")] })
    ])
    assert.strictEqual(entry(ledger, "s1").status, "conflict")
    assert.deepStrictEqual(entry(ledger, "s1").owners, ["A", "B"])
    assert.strictEqual(entry(ledger, "s1").claims.length, 3)
    assert.strictEqual(ledger.totals.conflicts, 1)
  })

  it("two approved owners conflict, unless one of them kept the scenario on purpose", () => {
    const both = [
      briefOf("A", "approved", { scope: [inScope("Item", "s1")] }),
      briefOf("B", "approved", { scope: [inScope("Item too", "s1")] })
    ]
    assert.strictEqual(entry(ledgerOf(both), "s1").status, "conflict")
    const shared = ledgerOf([
      both[0] ?? briefOf("A", "approved"),
      briefOf("B", "approved", {
        scope: [inScope("Item too", "s1")],
        openPoints: [kept({ kind: "AlreadyOwned", program: "P", scenario: "s1", epic: "A" })]
      })
    ])
    assert.strictEqual(entry(shared, "s1").status, "in-scope")
    assert.deepStrictEqual(entry(shared, "s1").owners, ["A", "B"])
    // In scope against another epic's drop, kept on purpose by the in-scope brief.
    const overruled = ledgerOf([
      briefOf("A", "approved", {
        scope: [inScope("Item", "s1")],
        openPoints: [
          kept({
            kind: "ContradictsBrief",
            program: "P",
            scenario: "s1",
            epic: "B",
            here: "in scope",
            disposition: "dropped"
          })
        ]
      }),
      briefOf("B", "approved", { dropped: [out("s1", "dead")] })
    ])
    assert.strictEqual(entry(overruled, "s1").status, "in-scope")
    assert.deepStrictEqual(entry(overruled, "s1").owners, ["A"])
  })

  it("two briefs that agree are not a conflict; dropped against provided is", () => {
    const agree = ledgerOf([
      briefOf("A", "approved", { dropped: [out("s2", "dead")] }),
      briefOf("B", "approved", { dropped: [out("s2", "dead indeed")] })
    ])
    assert.strictEqual(entry(agree, "s2").status, "dropped")
    assert.deepStrictEqual(entry(agree, "s2").owners, ["A", "B"])
    const differ = ledgerOf([
      briefOf("A", "approved", { dropped: [out("s2", "dead")] }),
      briefOf("B", "approved", { provided: [out("s2", "src/x.ts")] })
    ])
    assert.strictEqual(entry(differ, "s2").status, "conflict")
  })

  it("claims on what the pack no longer has are stale; another legacy's brief is skipped", () => {
    const ledger = ledgerOf(
      [
        briefOf("A", "approved", {
          dropped: [out("renamed since", "dead"), out("z1", "dead", "ZZ")]
        }),
        briefOf("X", "approved", { legacy: "/other-legacy", dropped: [out("s2", "dead")] })
      ],
      [],
      "/legacy"
    )
    assert.deepStrictEqual(
      ledger.stale.map((claim) => [claim.epicId, claim.program, claim.scenario]),
      [
        ["A", "P", "renamed since"],
        ["A", "ZZ", "z1"]
      ]
    )
    assert.deepStrictEqual(ledger.skipped, ["X"])
    assert.strictEqual(entry(ledger, "s2").status, "unclaimed")
  })

  it("an in-scope scenario carries its epic's delivery state", () => {
    const briefs = [briefOf("A", "approved", { scope: [inScope("Item", "s1")] })]
    const state = (progress: ReadonlyArray<EpicProgress>) =>
      entry(ledgerOf(briefs, progress), "s1").delivery
    const base = { epicId: "A", planned: true, stories: 4, merged: 0, landed: false }
    assert.strictEqual(state([]), "approved")
    assert.strictEqual(state([base]), "planned")
    assert.strictEqual(state([{ ...base, merged: 2 }]), "in-progress")
    assert.strictEqual(state([{ ...base, merged: 4, landed: true }]), "landed")
    assert.deepStrictEqual(ledgerOf(briefs, [{ ...base, landed: true }]).briefs, [
      { epicId: "A", status: "approved", delivery: "landed" }
    ])
  })

  it("totals add up: accounted plus remaining is every scenario", () => {
    const ledger = ledgerOf(
      [
        briefOf("A", "approved", {
          scope: [inScope("Item one", "s1")],
          dropped: [out("s2", "dead")],
          provided: [out("s3", "src/kit/x.ts")],
          deferred: [out("s4", "next epic")]
        }),
        briefOf("D", "draft", { scope: [inScope("Draft item", "s5")] })
      ],
      [{ epicId: "A", planned: true, stories: 2, merged: 2, landed: true }]
    )
    assert.deepStrictEqual(ledger.totals, {
      scenarios: 8,
      accounted: 3,
      delivered: 3,
      remaining: 5,
      conflicts: 0
    })
    assert.deepStrictEqual(
      ledger.programs.find((program) => program.program === "P"),
      {
        program: "P",
        scenarios: 6,
        inScope: 1,
        dropped: 1,
        provided: 1,
        deferred: 1,
        proposed: 1,
        unclaimed: 1,
        conflicts: 0
      }
    )
    assert.strictEqual(ledger.programs.find((program) => program.program === "Q")?.unclaimed, 2)
  })

  it("what other epics decided is the approved claims, never a draft's", () => {
    const inherited = inheritedFrom(
      ledgerOf([
        briefOf("A", "approved", {
          scope: [inScope("Item one", "s1")],
          deferred: [out("s4", "next epic")]
        }),
        briefOf("D", "draft", { dropped: [out("s5", "maybe dead")] })
      ])
    )
    assert.deepStrictEqual(inherited, [
      { program: "P", scenario: "s1", epic: "A", disposition: "in-scope", note: "Item one" },
      { program: "P", scenario: "s4", epic: "A", disposition: "deferred", note: "next epic" }
    ])
  })
})
