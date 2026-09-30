import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { OpenPoint } from "@llm4ts/flow/Decisions"
import {
  assembleBrief,
  checkEpicBrief,
  Citation,
  ConsideredProgram,
  diffBriefs,
  Disposed,
  EpicBrief,
  EpicBriefProposal,
  epicBriefProposalJsonSchema,
  loopAction,
  normalizeBrief,
  parseEpicBrief,
  ProgramSelection,
  programSelectionJsonSchema,
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
    const conflict = checkEpicBrief(sampleBrief, { pack: refined, pointers })[0]
    const question = `[check] ${conflict === undefined ? "" : renderBriefProblem(conflict)}`
    assert.include(question, "keep:")
    const answered = (answer: string, asked = question): EpicBrief =>
      withBrief({ openPoints: [OpenPoint.make({ number: 1, question: asked, answer })] })
    // Any other answer, or an answer to some other question, overrides nothing.
    assert.deepStrictEqual(
      kinds(checkEpicBrief(answered("No, remove it"), { pack: refined, pointers })),
      ["RefineConflict"]
    )
    assert.deepStrictEqual(
      kinds(
        checkEpicBrief(
          answered("keep: yes", "Is CONTO_MOVIMENTI › Filter movements by amount still wanted?"),
          { pack: refined, pointers }
        )
      ),
      ["RefineConflict"]
    )
    const justified = answered("Keep: the business asked for it again")
    assert.deepStrictEqual(checkEpicBrief(justified, { pack: refined, pointers }), [])
  })

  it("an approved brief with an unanswered open point is refused", () => {
    const problems = checkEpicBrief(withBrief({ status: "approved" }), { pack, pointers })
    assert.deepStrictEqual(kinds(problems), ["ApprovedWithOpenPoints"])
    assert.include(problems.map(renderBriefProblem).join("\n"), "1")
  })
})

const proposal = EpicBriefProposal.make({
  goal: "Balance and movements in the portal.",
  scope: sampleBrief.scope,
  dropped: sampleBrief.dropped,
  provided: sampleBrief.provided,
  deferred: [],
  constraints: "Amounts are integer cents.",
  openPoints: ["Which date range is the default?"]
})

describe("the loop over the brief", () => {
  it("decides what a run does from the file alone", () => {
    assert.strictEqual(loopAction(undefined), "propose")
    // Point 2 is answered: there is something to fold in.
    assert.strictEqual(loopAction(sampleBrief), "revise")
    const pending = withBrief({
      openPoints: [OpenPoint.make({ number: 1, question: "q?" })]
    })
    assert.strictEqual(loopAction(pending), "halt")
    assert.strictEqual(loopAction(withBrief({ ...pending, feedback: "add statements" })), "revise")
    assert.strictEqual(loopAction(withBrief({ openPoints: [] })), "await-approval")
    assert.strictEqual(loopAction(withBrief({ status: "approved", openPoints: [] })), "validate")
    // Approved wins: validation is what reports its unanswered points.
    assert.strictEqual(loopAction(withBrief({ status: "approved" })), "validate")
  })

  it("assembles a draft from a proposal: numbered points, check-raised points last", () => {
    const brief = assembleBrief({
      epicId: "conto-corrente",
      request: "Current account",
      legacy: "~/legacy",
      programs: sampleBrief.programs,
      proposal,
      problems: [
        { kind: "Unaccounted", program: "CONTO_SALDO", scenario: "Session timeout warning" }
      ]
    })
    assert.strictEqual(brief.status, "draft")
    assert.strictEqual(brief.feedback, "")
    assert.deepStrictEqual(
      brief.openPoints.map((point) => [point.number, point.question.slice(0, 7)]),
      [
        [1, "Which d"],
        [2, "[check]"]
      ]
    )
    assert.include(brief.openPoints[1]?.question ?? "", "Session timeout warning")
  })

  it("a revision drops answered points, keeps unanswered ones it did not restate, empties feedback", () => {
    const previous = withBrief({
      openPoints: [
        OpenPoint.make({ number: 1, question: "Are pending movements shown?" }),
        OpenPoint.make({ number: 2, question: "Default range?", answer: "30 days" })
      ],
      feedback: "move the fax export back in"
    })
    const brief = assembleBrief({
      epicId: previous.epicId,
      request: previous.request,
      legacy: previous.legacy,
      programs: previous.programs,
      proposal,
      previous
    })
    assert.deepStrictEqual(
      brief.openPoints.map((point) => point.question),
      ["Which date range is the default?", "Are pending movements shown?"]
    )
    assert.deepStrictEqual(
      brief.openPoints.map((point) => point.number),
      [1, 2]
    )
    assert.strictEqual(brief.feedback, "")
  })

  it("says what changed between two revisions", () => {
    const next = withBrief({
      programs: [
        ...sampleBrief.programs,
        ConsideredProgram.make({ name: "ESTRATTO", reason: "statements" })
      ],
      dropped: [],
      scope: [
        ...sampleBrief.scope,
        ScopeItem.make({
          title: "Fax export, kept after all",
          citations: [
            Citation.make({ program: "CONTO_MOVIMENTI", scenario: "Export movements to fax" })
          ]
        })
      ],
      openPoints: [OpenPoint.make({ number: 1, question: "A new question?" })]
    })
    const changes = diffBriefs(sampleBrief, next).join("\n")
    assert.include(changes, "CONTO_MOVIMENTI › Export movements to fax: dropped → in scope")
    assert.include(changes, "program added: ESTRATTO")
    assert.include(changes, "open point raised: A new question?")
    assert.include(changes, "open point closed: Which date is the default range?")
    assert.deepStrictEqual(diffBriefs(sampleBrief, sampleBrief), [])
    assert.include(diffBriefs(undefined, sampleBrief).join("\n"), "in scope: 3 item(s)")
  })

  it.effect("the structured-output schemas decode what the JSON schemas describe", () =>
    Effect.gen(function* () {
      const selection = yield* Schema.decodeUnknownEffect(ProgramSelection)({
        programs: [{ name: "CONTO_SALDO", reason: "balance" }]
      })
      assert.strictEqual(selection.programs[0]?.name, "CONTO_SALDO")
      const decoded = yield* Schema.decodeUnknownEffect(EpicBriefProposal)({
        goal: "g",
        scope: [{ title: "t", citations: [{ program: "P", scenario: "s" }] }],
        dropped: [],
        provided: [{ program: "P", scenario: "s2", note: "src/x.ts" }],
        deferred: [],
        constraints: "",
        openPoints: []
      })
      assert.strictEqual(decoded.provided[0]?.note, "src/x.ts")
      assert.strictEqual(programSelectionJsonSchema.type, "object")
      assert.strictEqual(epicBriefProposalJsonSchema.type, "object")
    })
  )
})

describe("review findings: the brief file", () => {
  it("an answered check point alone does not ask for another revision", () => {
    const overridden = withBrief({
      openPoints: [
        OpenPoint.make({ number: 1, question: "[check] something", answer: "keep: yes" })
      ]
    })
    assert.strictEqual(loopAction(overridden), "await-approval")
    assert.strictEqual(
      loopAction(
        withBrief({
          openPoints: [
            OpenPoint.make({ number: 1, question: "[check] something", answer: "keep: yes" }),
            OpenPoint.make({ number: 2, question: "still open?" })
          ]
        })
      ),
      "halt"
    )
  })

  it.effect("a code fence that never closes is a violation, not a swallowed brief", () =>
    Effect.gen(function* () {
      const text = renderEpicBrief(sampleBrief).replace(
        "Customers see their balance",
        "```\nCustomers see their balance"
      )
      const error = yield* Effect.flip(parseEpicBrief(text))
      assert.include(error.violations.join("\n"), "never closed")
    })
  )

  it.effect("a scenario title with a dash survives the file in every list", () =>
    Effect.gen(function* () {
      const dashed = withBrief({
        dropped: [
          Disposed.make({
            program: "CONTO_MOVIMENTI",
            scenario: "Export — to fax",
            note: "dead — since 2019"
          })
        ],
        scope: [
          ScopeItem.make({
            title: "Filters — date and amount",
            citations: [Citation.make({ program: "CONTO_MOVIMENTI", scenario: "Filter — by date" })]
          })
        ]
      })
      const parsed = yield* parseEpicBrief(renderEpicBrief(dashed))
      assert.strictEqual(parsed.dropped[0]?.scenario, "Export — to fax")
      assert.strictEqual(parsed.dropped[0]?.note, "dead — since 2019")
      assert.strictEqual(parsed.scope[0]?.citations[0]?.scenario, "Filter — by date")
      assert.strictEqual(renderEpicBrief(parsed), renderEpicBrief(dashed))
    })
  )

  it.effect("normalizing makes a model's odd text writable: newlines, headings, open fences", () =>
    Effect.gen(function* () {
      const odd = withBrief({
        request: "Current account\nwith statements",
        goal: "Intro.\n## Not a section\n```ts\nconst x = 1",
        dropped: [
          Disposed.make({
            program: "CONTO_MOVIMENTI",
            scenario: "Export movements to fax",
            note: "dead:\nno caller"
          })
        ],
        scope: [
          ScopeItem.make({
            title: "- Balance\ncard",
            citations: [
              Citation.make({ program: "CONTO_SALDO", scenario: "Show the available balance" })
            ]
          })
        ]
      })
      const safe = normalizeBrief(odd)
      const parsed = yield* parseEpicBrief(renderEpicBrief(safe))
      assert.strictEqual(renderEpicBrief(parsed), renderEpicBrief(safe))
      assert.strictEqual(parsed.request, "Current account with statements")
      assert.strictEqual(parsed.dropped[0]?.note, "dead: no caller")
      assert.strictEqual(parsed.scope[0]?.title, "Balance card")
      assert.include(parsed.goal, "### Not a section")
      assert.strictEqual(parsed.programs.length, 2)
    })
  )

  it("a program that is cited must be complete, even when it is not listed as considered", () => {
    const problems = checkEpicBrief(
      withBrief({
        programs: [ConsideredProgram.make({ name: "CONTO_SALDO", reason: "balance" })],
        dropped: []
      }),
      { pack, pointers }
    )
    assert.deepStrictEqual(kinds(problems), ["Unaccounted"])
    assert.include(problems.map(renderBriefProblem).join("\n"), "Export movements to fax")
  })

  it("the revision diff shows changed reasons, renamed items and the answers it folded in", () => {
    const next = withBrief({
      dropped: [
        Disposed.make({
          program: "CONTO_MOVIMENTI",
          scenario: "Export movements to fax",
          note: "replaced by the document service"
        })
      ],
      scope: [
        ScopeItem.make({ ...sampleBrief.scope[0], title: "Movement filters" }),
        ...sampleBrief.scope.slice(1, 2)
      ],
      openPoints: [sampleBrief.openPoints[0] ?? OpenPoint.make({ number: 1, question: "" })]
    })
    const changes = diffBriefs(sampleBrief, next).join("\n")
    assert.include(changes, "CONTO_MOVIMENTI › Export movements to fax: reason changed")
    assert.include(changes, "item removed: Movements list with date and amount filters")
    assert.include(changes, "item added: Movement filters")
    assert.include(changes, "item removed: Empty state for an account with no movements")
    assert.include(changes, "open point closed: Which date is the default range? (answer: 30 days)")
  })
})
