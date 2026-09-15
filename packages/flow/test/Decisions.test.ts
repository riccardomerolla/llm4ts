import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  Decisions,
  DecisionsInvalid,
  decisionsGuide,
  filterFeature,
  parseDecisions,
  renderDecisions,
  scenarioTitles,
  validateDecisions,
  waivedUnits,
  DecisionsProposal,
  applyProposal,
  proposePrompt
} from "@llm4ts/flow/Decisions"

const sample = `# Decisions

## How to mark

Prose the parser ignores, with a fenced example it also ignores:

\`\`\`markdown
- somePage: drop — an example inside a fence is never a decision
\`\`\`

## Programs

- promoQ3: drop — expired 2011 campaign (riccardo, 2026-09-15)
- login: provided — src/auth/AuthProvider.tsx; target owns login and session (riccardo, 2026-09-15)
- oldTransfer: ? — looks dead, confirm nothing links here
- help: defer — static FAQ, content team rewrites it; milestone: wave-3 (riccardo, 2026-09-15)
- esbGateway: wrap — stays on the legacy platform behind an API (riccardo, 2026-09-15)

## Scenarios

- accountOverview / Export movements as CSV: drop — reporting moves to the data platform (riccardo, 2026-09-15)
- beneficiaryList / Delete a beneficiary: defer — not in this delivery (riccardo, 2026-09-15)
- accountOverview / Refresh balances: ? — the target polls already, is this the same?

## Deepen

- accountOverview: the movements filter has a date-range rule I cannot find in the spec; check AccountServlet
- transferStep2: the review screen shows a fee line nobody specified [done 0f3a9c1]

## Open points

1. Does the target's polling cover the ajax refresh of accountOverview?
   answer: yes, the dashboard hook polls every 30s
2. Should transferConfirm keep the ESB reference number on screen?

- [ ] Approved
`

describe("decisions overlay", () => {
  it.effect("parses programs, scenarios, marks, deepen, open points, and the marker", () =>
    Effect.gen(function* () {
      const decisions = yield* parseDecisions(sample)
      assert.deepStrictEqual(
        decisions.programs.map((entry) => [entry.program, entry.disposition, entry.reason]),
        [
          ["promoQ3", "drop", "expired 2011 campaign"],
          ["login", "provided", "target owns login and session"],
          ["help", "defer", "static FAQ, content team rewrites it"],
          ["esbGateway", "wrap", "stays on the legacy platform behind an API"]
        ]
      )
      const login = decisions.programs[1]
      assert.strictEqual(login?.pointer, "src/auth/AuthProvider.tsx")
      assert.strictEqual(login?.decidedBy, "riccardo")
      assert.strictEqual(login?.decidedAt, "2026-09-15")
      assert.strictEqual(decisions.programs[2]?.milestone, "wave-3")
      assert.deepStrictEqual(
        decisions.scenarios.map((entry) => [entry.program, entry.scenario, entry.disposition]),
        [
          ["accountOverview", "Export movements as CSV", "drop"],
          ["beneficiaryList", "Delete a beneficiary", "defer"]
        ]
      )
      assert.deepStrictEqual(
        decisions.marks.map((mark) => [mark.program, mark.scenario, mark.note]),
        [
          ["oldTransfer", undefined, "looks dead, confirm nothing links here"],
          ["accountOverview", "Refresh balances", "the target polls already, is this the same?"]
        ]
      )
      assert.deepStrictEqual(
        decisions.deepen.map((mark) => [mark.program, mark.focus, mark.done]),
        [
          [
            "accountOverview",
            "the movements filter has a date-range rule I cannot find in the spec; check AccountServlet",
            undefined
          ],
          ["transferStep2", "the review screen shows a fee line nobody specified", "0f3a9c1"]
        ]
      )
      assert.deepStrictEqual(
        decisions.openPoints.map((point) => [point.number, point.question, point.answer]),
        [
          [
            1,
            "Does the target's polling cover the ajax refresh of accountOverview?",
            "yes, the dashboard hook polls every 30s"
          ],
          [2, "Should transferConfirm keep the ESB reference number on screen?", undefined]
        ]
      )
      assert.strictEqual(decisions.approved, false)
      assert.deepStrictEqual(
        decisions.pendingDeepen.map((mark) => mark.program),
        ["accountOverview"]
      )
      assert.deepStrictEqual(
        decisions.unansweredOpenPoints.map((point) => point.number),
        [2]
      )
    })
  )

  it.effect("rendering then parsing is the identity on the decided content", () =>
    Effect.gen(function* () {
      const decisions = yield* parseDecisions(sample)
      const again = yield* parseDecisions(renderDecisions(decisions))
      assert.deepStrictEqual(again.programs, decisions.programs)
      assert.deepStrictEqual(again.scenarios, decisions.scenarios)
      assert.deepStrictEqual(again.marks, decisions.marks)
      assert.deepStrictEqual(again.deepen, decisions.deepen)
      assert.deepStrictEqual(again.openPoints, decisions.openPoints)
      assert.strictEqual(again.approved, false)
      // The guide travels with every render so a hand-editor sees the vocabulary.
      assert.include(renderDecisions(decisions), decisionsGuide.split("\n")[0] ?? "")
    })
  )

  it.effect("an approved file parses as approved and an empty file as empty", () =>
    Effect.gen(function* () {
      const approved = yield* parseDecisions(`# Decisions\n\n## Programs\n\n- [x] Approved\n`)
      assert.strictEqual(approved.approved, true)
      const empty = yield* parseDecisions("")
      assert.strictEqual(empty.isEmpty, true)
    })
  )

  it.effect("rejects malformed lines with the line and the reason", () =>
    Effect.gen(function* () {
      const failure = yield* parseDecisions(
        `# Decisions\n\n## Programs\n\n- login: provided — no pointer here\n- x: retire — not a disposition\n\n## Deepen\n\n- accountOverview\n`
      ).pipe(Effect.flip)
      assert.instanceOf(failure, DecisionsInvalid)
      assert.deepStrictEqual(failure.violations, [
        "line 5: 'provided' needs a target pointer before ';' — `- login: provided — <path>; <note>`",
        "line 6: unknown disposition 'retire' (drop | provided | defer | wrap | ?)",
        "line 10: deepen marks need a focus — `- accountOverview: <what to look for>`"
      ])
    })
  )

  it.effect("validates every key against the pack's programs and scenario titles", () =>
    Effect.gen(function* () {
      const decisions = yield* parseDecisions(sample)
      const violations = validateDecisions(decisions, {
        programs: new Set(["promoQ3", "login", "help", "accountOverview", "beneficiaryList"]),
        scenarios: new Map([
          ["accountOverview", new Set(["Export movements as CSV", "Refresh balances"])],
          ["beneficiaryList", new Set(["List beneficiaries"])]
        ])
      })
      // Programs, scenarios, marks, deepen: the order the sections are written in.
      assert.deepStrictEqual(violations, [
        "program 'esbGateway' is not in the spec pack",
        "scenario 'Delete a beneficiary' does not exist in beneficiaryList (known: List beneficiaries)",
        "program 'oldTransfer' is not in the spec pack",
        "program 'transferStep2' is not in the spec pack"
      ])
    })
  )

  it("derives waived coverage units from program and scenario dispositions", () => {
    const decisions = Decisions.make({
      programs: [
        {
          program: "promoQ3",
          disposition: "drop",
          reason: "expired"
        }
      ],
      scenarios: [
        {
          program: "accountOverview",
          scenario: "Export movements as CSV",
          disposition: "drop",
          reason: "reporting moves"
        }
      ],
      marks: [],
      deepen: [],
      openPoints: [],
      approved: false
    })
    const waived = waivedUnits(decisions, {
      fragments: new Map([
        ["promoQ3", '/promo — Scenario: Show the campaign\naction="/promo" — Scenario: Enrol\n'],
        [
          "accountOverview",
          [
            "/accountOverview — Scenario: List accounts, Scenario: Export movements as CSV",
            "/servlet/ExportCsv — Scenario: Export movements as CSV",
            "url: '/accountOverview?fmt=json' — Rule 4"
          ].join("\n")
        ]
      ]),
      scenarios: new Map([
        ["accountOverview", new Set(["List accounts", "Export movements as CSV"])]
      ])
    })
    assert.deepStrictEqual(
      waived.map((entry) => [entry.unit, entry.program, entry.by]),
      [
        ["/promo", "promoQ3", "promoQ3: drop"],
        ['action="/promo"', "promoQ3", "promoQ3: drop"],
        ["/servlet/ExportCsv", "accountOverview", "accountOverview / Export movements as CSV: drop"]
      ]
    )
  })

  it("lists scenario titles and filters disposed scenarios out of a feature file", () => {
    const feature = [
      "Feature: Account overview",
      "",
      "  Background:",
      "    Given a logged-in customer",
      "",
      "  Scenario: List accounts",
      "    When the overview loads",
      "    Then every account is listed",
      "",
      "  Scenario: Export movements as CSV",
      "    When the customer clicks Export",
      "    Then a CSV downloads",
      "",
      "  Scenario Outline: Refresh balances",
      "    When <seconds> pass",
      "    Then balances refresh",
      "",
      "    Examples:",
      "      | seconds |",
      "      | 30      |",
      ""
    ].join("\n")
    assert.deepStrictEqual(scenarioTitles(feature), [
      "List accounts",
      "Export movements as CSV",
      "Refresh balances"
    ])
    const filtered = filterFeature(feature, new Set(["Export movements as CSV"]))
    assert.deepStrictEqual(scenarioTitles(filtered), ["List accounts", "Refresh balances"])
    assert.include(filtered, "Background:")
    assert.include(filtered, "| 30      |")
    assert.notInclude(filtered, "CSV")
  })

  it("folds a proposal into the decisions: marks resolve, refusals become open points", () => {
    const decisions = Decisions.make({
      programs: [{ program: "promoQ3", disposition: "drop", reason: "expired" }],
      scenarios: [],
      marks: [
        { program: "login", note: "the target has an AuthProvider" },
        { program: "oldTransfer", note: "looks dead" },
        { program: "accountOverview", scenario: "Refresh balances", note: "polling?" }
      ],
      deepen: [{ program: "help", focus: "the FAQ anchors", done: "abc1234" }],
      openPoints: [
        { number: 1, question: "Keep the ESB reference on screen?", answer: "yes" },
        { number: 2, question: "Is the print view used?" }
      ],
      approved: false
    })
    const known = {
      programs: new Set(["promoQ3", "login", "oldTransfer", "accountOverview", "help"]),
      scenarios: new Map([["accountOverview", new Set(["Refresh balances", "List accounts"])]])
    }
    const applied = applyProposal(
      decisions,
      DecisionsProposal.make({
        decisions: [
          {
            key: "login",
            disposition: "provided",
            reason: "AuthProvider owns login",
            pointer: "src/auth/AuthProvider.tsx"
          },
          { key: "oldTransfer", disposition: "defer", reason: "maybe later" },
          {
            key: "accountOverview / Refresh balances",
            disposition: "provided",
            reason: "polling hook",
            pointer: "src/hooks/nope.ts"
          },
          {
            key: "accountOverview / List accounts",
            disposition: "drop",
            reason: "consequential? no, a guess"
          },
          {
            key: "promoQ3",
            disposition: "wrap",
            reason: "already decided by a human, must be ignored"
          },
          { key: "ghost", disposition: "drop", reason: "not a program" }
        ],
        openPoints: ["Does the dashboard poll every 30s?"]
      }),
      {
        pointerExists: (pointer) => pointer === "src/auth/AuthProvider.tsx",
        known,
        decidedBy: "proposal",
        decidedAt: "2026-09-15"
      }
    )
    assert.deepStrictEqual(
      applied.programs.map((entry) => [
        entry.program,
        entry.disposition,
        entry.pointer,
        entry.decidedBy
      ]),
      [
        ["promoQ3", "drop", undefined, undefined],
        ["login", "provided", "src/auth/AuthProvider.tsx", "proposal"]
      ]
    )
    assert.deepStrictEqual(
      applied.scenarios.map((entry) => [entry.scenario, entry.disposition]),
      [["List accounts", "drop"]]
    )
    assert.deepStrictEqual(applied.marks, [])
    assert.deepStrictEqual(applied.deepen, decisions.deepen)
    assert.deepStrictEqual(
      applied.openPoints.map((point) => [point.number, point.question, point.answer]),
      [
        [1, "Is the print view used?", undefined],
        [2, "Does the dashboard poll every 30s?", undefined],
        // Refusals in proposal order, then the marks nothing resolved.
        [
          3,
          "The model would defer 'oldTransfer' (maybe later) — deferral is yours: mark it defer, drop, or leave it migrating",
          undefined
        ],
        [
          4,
          "'accountOverview / Refresh balances' was proposed as provided by 'src/hooks/nope.ts', which does not exist in the target — fix the pointer or choose drop",
          undefined
        ],
        [
          5,
          "The proposal named 'ghost', which is not a program of the pack — ignore or fix the key?",
          undefined
        ],
        [
          6,
          "No disposition could be proposed for 'oldTransfer' (looks dead) — decide it by hand or answer here",
          undefined
        ],
        [
          7,
          "No disposition could be proposed for 'accountOverview / Refresh balances' (polling?) — decide it by hand or answer here",
          undefined
        ]
      ]
    )
    assert.strictEqual(applied.approved, false)
  })

  it("the proposal prompt names every mark, prior decisions, answers, and the target rule", () => {
    const decisions = Decisions.make({
      programs: [{ program: "promoQ3", disposition: "drop", reason: "expired" }],
      scenarios: [],
      marks: [{ program: "login", note: "AuthProvider?" }],
      deepen: [],
      openPoints: [{ number: 1, question: "Poll?", answer: "yes, 30s" }],
      approved: false
    })
    const withTarget = proposePrompt(
      decisions,
      [{ name: "login", spec: "# login", feature: "Feature: login" }],
      {
        targetMounted: true,
        packParagraph: "Next.js targets own login."
      }
    )
    assert.include(withTarget, "- login — AuthProvider?")
    assert.include(withTarget, "- promoQ3: drop — expired")
    assert.include(withTarget, "A: yes, 30s")
    assert.include(withTarget, "Next.js targets own login.")
    assert.include(withTarget, "reading the\n  target workspace")
    assert.include(withTarget, "===== login =====")
    const withoutTarget = proposePrompt(decisions, [], { targetMounted: false })
    assert.include(withoutTarget, "never propose it")
  })
})
