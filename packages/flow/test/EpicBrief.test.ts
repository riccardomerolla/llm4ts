import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { OpenPoint } from "@llm4ts/flow/Decisions"
import {
  checkEpicBrief,
  Citation,
  ConsideredProgram,
  Disposed,
  EpicBrief,
  parseEpicBrief,
  providedPointers,
  renderBriefProblem,
  renderEpicBrief,
  ScopeItem,
  unanswered,
  type BriefProblem,
  type PackIndex
} from "@llm4ts/flow/EpicBrief"
import { EpicBriefInvalid } from "@llm4ts/flow/FlowError"

const sampleBrief = EpicBrief.make({
  epicId: "conto-corrente",
  status: "draft",
  request: "Current account: balance, movements",
  legacy: "~/legacy/ib-core",
  goal: "Customers see their balance and filter their movements in the new portal.",
  programs: [
    ConsideredProgram.make({ name: "CONTO_SALDO", reason: "balance inquiry" }),
    ConsideredProgram.make({ name: "CONTO_MOVIMENTI", reason: "movements list and filters" })
  ],
  scope: [
    ScopeItem.make({
      title: "Movements list with date and amount filters",
      citations: [
        Citation.make({ program: "CONTO_MOVIMENTI", scenario: "Filter movements by date range" }),
        Citation.make({ program: "CONTO_MOVIMENTI", scenario: "Filter movements by amount" })
      ]
    }),
    ScopeItem.make({
      title: "Balance card",
      citations: [Citation.make({ program: "CONTO_SALDO", scenario: "Show the available balance" })]
    }),
    ScopeItem.make({
      title: "Empty state for an account with no movements",
      citations: [],
      newBehaviour: "the legacy showed a blank table"
    })
  ],
  dropped: [
    Disposed.make({
      program: "CONTO_MOVIMENTI",
      scenario: "Export movements to fax",
      note: "dead: no caller since 2019"
    })
  ],
  provided: [
    Disposed.make({
      program: "CONTO_SALDO",
      scenario: "Session timeout warning",
      note: "src/kit/session/SessionGuard.tsx"
    })
  ],
  deferred: [],
  constraints: "Amounts are integer cents.\nUse the kit's table component.",
  openPoints: [
    OpenPoint.make({ number: 1, question: "Are pending movements shown with the booked ones?" }),
    OpenPoint.make({ number: 2, question: "Which date is the default range?", answer: "30 days" })
  ],
  feedback: ""
})

describe("the epic brief file", () => {
  it.effect("renders and parses back to the same brief", () =>
    Effect.gen(function* () {
      const text = renderEpicBrief(sampleBrief)
      assert.include(text, "# Epic brief: conto-corrente")
      assert.include(text, "Status: draft")
      assert.include(
        text,
        "- CONTO_MOVIMENTI › Export movements to fax — dead: no caller since 2019"
      )
      assert.include(text, "  - new: the legacy showed a blank table")
      const parsed = yield* parseEpicBrief(text)
      assert.strictEqual(renderEpicBrief(parsed), text)
      assert.strictEqual(parsed.scope.length, 3)
      assert.strictEqual(parsed.scope[0]?.citations.length, 2)
      assert.strictEqual(parsed.scope[2]?.newBehaviour, "the legacy showed a blank table")
      assert.strictEqual(parsed.provided[0]?.note, "src/kit/session/SessionGuard.tsx")
      assert.strictEqual(
        parsed.constraints,
        "Amounts are integer cents.\nUse the kit's table component."
      )
    })
  )

  it.effect("an unanswered point renders an empty answer line and counts as unanswered", () =>
    Effect.gen(function* () {
      const text = renderEpicBrief(sampleBrief)
      assert.match(text, /1\. Are pending movements shown with the booked ones\?\n {3}answer:\n/)
      const parsed = yield* parseEpicBrief(text)
      assert.deepStrictEqual(
        unanswered(parsed).map((point) => point.number),
        [1]
      )
    })
  )

  it.effect("a brief edited by hand still parses: spacing, order, long answers, prose", () =>
    Effect.gen(function* () {
      const edited = [
        "# Epic brief: conto-corrente",
        "Status:   approved",
        "",
        "Request: Current account",
        "Legacy: ~/legacy/ib-core",
        "",
        "## Goal",
        "",
        "First paragraph.",
        "",
        "- a bullet inside the goal is prose",
        "",
        "## In scope",
        "",
        "",
        "- Balance card",
        "    - CONTO_SALDO › Show the available balance",
        "",
        "## Legacy programs considered",
        "- CONTO_SALDO — balance inquiry",
        "",
        "## Open points",
        "1. Which currency formats",
        "   are required?",
        "   answer: EUR only,",
        "   with two decimals",
        "",
        "## Feedback",
        "Move the statement to this epic.",
        ""
      ].join("\n")
      const parsed = yield* parseEpicBrief(edited)
      assert.strictEqual(parsed.status, "approved")
      assert.strictEqual(parsed.goal, "First paragraph.\n\n- a bullet inside the goal is prose")
      assert.strictEqual(parsed.programs[0]?.name, "CONTO_SALDO")
      assert.strictEqual(parsed.scope[0]?.citations[0]?.scenario, "Show the available balance")
      assert.strictEqual(parsed.openPoints[0]?.question, "Which currency formats are required?")
      assert.strictEqual(parsed.openPoints[0]?.answer, "EUR only, with two decimals")
      assert.strictEqual(parsed.feedback, "Move the statement to this epic.")
      assert.deepStrictEqual(parsed.dropped, [])
      assert.deepStrictEqual(unanswered(parsed), [])
    })
  )

  it.effect(
    "a scenario title with a dash keeps the text after the first separator as the note",
    () =>
      Effect.gen(function* () {
        const text = [
          "# Epic brief: x",
          "Status: draft",
          "Request: r",
          "Legacy: l",
          "## Dropped",
          "- CONTO › Print the page — legacy only — nobody prints"
        ].join("\n")
        const parsed = yield* parseEpicBrief(text)
        assert.strictEqual(parsed.dropped[0]?.scenario, "Print the page")
        assert.strictEqual(parsed.dropped[0]?.note, "legacy only — nobody prints")
      })
  )

  it.effect("reports every violation at once, with line numbers", () =>
    Effect.gen(function* () {
      const broken = [
        "# Epic brief: x",
        "Status: maybe",
        "Request: r",
        "## Dropped",
        "- no separator here",
        "## Surprises",
        "- anything",
        "## In scope",
        "  - CONTO › orphan citation"
      ].join("\n")
      const error = yield* Effect.flip(parseEpicBrief(broken, "/repo/brief.md"))
      assert.instanceOf(error, EpicBriefInvalid)
      assert.strictEqual(error.path, "/repo/brief.md")
      const all = error.violations.join("\n")
      assert.include(all, "line 2")
      assert.include(all, "line 5")
      assert.include(all, "line 6")
      assert.include(all, "line 9")
      assert.include(all, "Legacy")
      assert.isAtLeast(error.violations.length, 5)
    })
  )
})

const pack: PackIndex = {
  programs: [
    {
      name: "CONTO_SALDO",
      summary: "Balance inquiry.",
      scenarios: ["Show the available balance", "Session timeout warning"]
    },
    {
      name: "CONTO_MOVIMENTI",
      summary: "Movements list.",
      scenarios: [
        "Filter movements by date range",
        "Filter movements by amount",
        "Export movements to fax"
      ]
    }
  ],
  refine: []
}
const pointers = new Set(["src/kit/session/SessionGuard.tsx"])
const kinds = (problems: ReadonlyArray<BriefProblem>): ReadonlyArray<string> =>
  problems.map((problem) => problem.kind).sort()
const withBrief = (change: Partial<ConstructorParameters<typeof EpicBrief>[0]>): EpicBrief =>
  EpicBrief.make({ ...sampleBrief, ...change })

describe("checking an epic brief", () => {
  it("a brief whose every scenario has one disposition and whose pointers exist is clean", () => {
    assert.deepStrictEqual(checkEpicBrief(sampleBrief, { pack, pointers }), [])
    assert.deepStrictEqual(providedPointers(sampleBrief), ["src/kit/session/SessionGuard.tsx"])
  })

  it("an unknown program and an unknown scenario are named, with the closest title", () => {
    const problems = checkEpicBrief(
      withBrief({
        dropped: [
          Disposed.make({
            program: "CONTO_MOVIMENTI",
            scenario: "export movements to FAX ",
            note: "dead"
          }),
          Disposed.make({ program: "GHOST", scenario: "Anything", note: "dead" })
        ]
      }),
      { pack, pointers }
    )
    const unknown = problems.find((problem) => problem.kind === "UnknownScenario")
    assert.strictEqual(
      unknown?.kind === "UnknownScenario" ? unknown.closest : undefined,
      "Export movements to fax"
    )
    assert.include(kinds(problems), "UnknownProgram")
    // The real title is then in no list.
    assert.include(kinds(problems), "Unaccounted")
  })

  it("a provided pointer that was not found is a problem", () => {
    const problems = checkEpicBrief(sampleBrief, { pack, pointers: new Set() })
    assert.deepStrictEqual(kinds(problems), ["MissingPointer"])
  })

  it("a dropped entry needs a reason, an uncited item needs `new:`", () => {
    const problems = checkEpicBrief(
      withBrief({
        dropped: [
          Disposed.make({
            program: "CONTO_MOVIMENTI",
            scenario: "Export movements to fax",
            note: ""
          })
        ],
        scope: [...sampleBrief.scope, ScopeItem.make({ title: "Mystery", citations: [] })]
      }),
      { pack, pointers }
    )
    assert.deepStrictEqual(kinds(problems), ["MissingReason", "MissingReason"])
  })

  it("a scenario in two lists, and one in none, are both reported", () => {
    const problems = checkEpicBrief(
      withBrief({
        dropped: [],
        deferred: [
          Disposed.make({
            program: "CONTO_SALDO",
            scenario: "Show the available balance",
            note: "later"
          })
        ]
      }),
      { pack, pointers }
    )
    assert.deepStrictEqual(kinds(problems), ["DuplicateDisposition", "Unaccounted"])
    const missing = problems.find((problem) => problem.kind === "Unaccounted")
    assert.strictEqual(
      missing?.kind === "Unaccounted" ? missing.scenario : undefined,
      "Export movements to fax"
    )
  })

  it("only the programs under consideration must be complete", () => {
    const narrowed = withBrief({
      programs: [ConsideredProgram.make({ name: "CONTO_SALDO", reason: "balance" })],
      scope: [
        ScopeItem.make({
          title: "Balance card",
          citations: [
            Citation.make({ program: "CONTO_SALDO", scenario: "Show the available balance" })
          ]
        })
      ],
      dropped: []
    })
    assert.deepStrictEqual(checkEpicBrief(narrowed, { pack, pointers }), [])
  })

  it("a scenario refine dropped cannot be in scope without an answered open point about it", () => {
    const refined: PackIndex = {
      ...pack,
      refine: [
        { program: "CONTO_MOVIMENTI", scenario: "Filter movements by amount", disposition: "drop" }
      ]
    }
    assert.deepStrictEqual(kinds(checkEpicBrief(sampleBrief, { pack: refined, pointers })), [
      "RefineConflict"
    ])
    const justified = withBrief({
      openPoints: [
        OpenPoint.make({
          number: 1,
          question:
            "Refine dropped CONTO_MOVIMENTI › Filter movements by amount; keep it in this epic?",
          answer: "yes, the business asked for it again"
        })
      ]
    })
    assert.deepStrictEqual(checkEpicBrief(justified, { pack: refined, pointers }), [])
  })

  it("an approved brief with an unanswered open point is refused", () => {
    const problems = checkEpicBrief(withBrief({ status: "approved" }), { pack, pointers })
    assert.deepStrictEqual(kinds(problems), ["ApprovedWithOpenPoints"])
    assert.include(problems.map(renderBriefProblem).join("\n"), "1")
  })
})
