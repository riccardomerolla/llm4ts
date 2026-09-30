import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { OpenPoint } from "@llm4ts/flow/Decisions"
import {
  Citation,
  ConsideredProgram,
  Disposed,
  EpicBrief,
  parseEpicBrief,
  renderEpicBrief,
  ScopeItem,
  unanswered
} from "@llm4ts/flow/EpicBrief"
import { EpicBriefInvalid } from "@llm4ts/flow/FlowError"

export const sampleBrief = EpicBrief.make({
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
