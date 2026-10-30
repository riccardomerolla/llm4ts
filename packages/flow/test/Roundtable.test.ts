import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { OpenPoint } from "@llm4ts/flow/Decisions"
import {
  AgendaItem,
  assembleAgenda,
  AgendaProposal,
  assembleTurn,
  briefingFor,
  chairSpeaker,
  decisions,
  decodeTurns,
  defaultCaps,
  encodeTurn,
  itemOf,
  itemState,
  Meeting,
  nextAction,
  openObjections,
  openQuestions,
  ownerSpeaker,
  parkedQuestions,
  parseMeeting,
  parsePersona,
  Persona,
  recordOwner,
  renderDecisions,
  renderDiscussion,
  renderMeeting,
  renderOpenQuestions,
  renderPersona,
  reviewItem,
  syncAnswers,
  Turn,
  TurnProposal,
  turnProposalJsonSchema,
  type ChairAction,
  type TurnKind
} from "@llm4ts/flow/Roundtable"

// ---- Personas -----------------------------------------------------------------

const sreCard = [
  "---",
  "name: SRE",
  "order: 60",
  "---",
  "",
  "## Mandate",
  "",
  "Keeps the solution operable: SLOs, failure modes, on-call reality.",
  "",
  "## Cares about",
  "",
  "Observability, blast radius, rollback.",
  "",
  "## Pushes back on",
  "",
  "Anything without a failure story.",
  "",
  "## Never decides alone",
  "",
  "Product scope.",
  "",
  "## Voice",
  "",
  "Short, concrete, asks for numbers.",
  ""
].join("\n")

describe("persona cards", () => {
  it.effect("parses the frontmatter and the sections", () =>
    Effect.gen(function* () {
      const persona = yield* parsePersona("sre", sreCard)
      assert.strictEqual(persona.name, "SRE")
      assert.strictEqual(persona.order, 60)
      assert.strictEqual(
        persona.mandate,
        "Keeps the solution operable: SLOs, failure modes, on-call reality."
      )
      assert.strictEqual(persona.caresAbout, "Observability, blast radius, rollback.")
      assert.strictEqual(persona.pushesBackOn, "Anything without a failure story.")
      assert.strictEqual(persona.neverDecidesAlone, "Product scope.")
      assert.strictEqual(persona.voice, "Short, concrete, asks for numbers.")
    })
  )

  it.effect("a card without frontmatter takes the file's name and a late order", () =>
    Effect.gen(function* () {
      const persona = yield* parsePersona("Cloud Architect", "## Mandate\n\nShapes the system.\n")
      assert.strictEqual(persona.name, "Cloud Architect")
      assert.strictEqual(persona.order, 100)
      assert.strictEqual(persona.mandate, "Shapes the system.")
      assert.strictEqual(persona.voice, "")
    })
  )

  it.effect("a card needs a mandate and knows its sections", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parsePersona("x", "## Likes\n\nCats.\n"))
      assert.strictEqual(error._tag, "PersonaInvalid")
      assert.strictEqual(error.name, "x")
      assert.deepStrictEqual(error.violations, [
        'line 1: unknown section "Likes"',
        "missing the `## Mandate` section"
      ])
    })
  )

  it.effect("renders back to a card that parses the same", () =>
    Effect.gen(function* () {
      const persona = yield* parsePersona("sre", sreCard)
      const again = yield* parsePersona("other", renderPersona(persona))
      assert.deepStrictEqual(again, persona)
      assert.strictEqual(renderPersona(persona), sreCard)
    })
  )

  it("the constructor is the type", () => {
    const persona = Persona.make({
      name: "PO",
      order: 10,
      mandate: "Owns the problem.",
      caresAbout: "",
      pushesBackOn: "",
      neverDecidesAlone: "",
      voice: ""
    })
    assert.strictEqual(persona.name, "PO")
  })
})

// ---- The meeting file ---------------------------------------------------------

const sampleMeeting = Meeting.make({
  id: "payments-outline",
  status: "discussing",
  topic: "Architecture outline for the payments hub",
  goal: "An outline and a plan the steering committee can approve, within the bank's standards.",
  attendees: ["PO", "Cloud Architect", "SRE"],
  agenda: [
    AgendaItem.make({
      number: 1,
      title: "Scope",
      question: "Which payment rails are in the first release?"
    }),
    AgendaItem.make({
      number: 2,
      title: "Integration style",
      question: "Events or synchronous calls between the hub and the ledger?"
    })
  ],
  answers: [
    OpenPoint.make({
      number: 7,
      question: "Is the 200ms latency budget a hard requirement? (SRE)",
      answer: "Yes, contractual."
    }),
    OpenPoint.make({ number: 9, question: "Who owns the ledger API? (Cloud Architect)" })
  ],
  feedback: "Mention the sandbox environment.",
  drafts: 1
})

const sampleMeetingMarkdown = [
  "# Roundtable: payments-outline",
  "",
  "Status: discussing",
  "Topic: Architecture outline for the payments hub",
  "Goal: An outline and a plan the steering committee can approve, within the bank's standards.",
  "Attendees: PO, Cloud Architect, SRE",
  "Drafts: 1",
  "",
  "## Agenda",
  "",
  "1. Scope — Which payment rails are in the first release?",
  "2. Integration style — Events or synchronous calls between the hub and the ledger?",
  "",
  "## Answers",
  "",
  "7. Is the 200ms latency budget a hard requirement? (SRE)",
  "   answer: Yes, contractual.",
  "9. Who owns the ledger API? (Cloud Architect)",
  "   answer:",
  "",
  "## Feedback",
  "",
  "Mention the sandbox environment.",
  ""
].join("\n")

describe("the meeting file", () => {
  it("renders the meeting as markdown a person edits", () => {
    assert.strictEqual(renderMeeting(sampleMeeting), sampleMeetingMarkdown)
  })

  it.effect("parses what it renders", () =>
    Effect.gen(function* () {
      const parsed = yield* parseMeeting(sampleMeetingMarkdown)
      assert.deepStrictEqual(parsed, sampleMeeting)
    })
  )

  it.effect("a fresh meeting has no agenda, no answers and no drafts", () =>
    Effect.gen(function* () {
      const parsed = yield* parseMeeting(
        [
          "# Roundtable: m1",
          "",
          "Status: agenda-proposed",
          "Topic: t",
          "Goal: g",
          "Attendees: PO, PM",
          "",
          "## Agenda",
          "",
          "## Answers",
          "",
          "## Feedback",
          ""
        ].join("\n")
      )
      assert.strictEqual(parsed.status, "agenda-proposed")
      assert.deepStrictEqual(parsed.agenda, [])
      assert.deepStrictEqual(parsed.answers, [])
      assert.strictEqual(parsed.feedback, "")
      assert.strictEqual(parsed.drafts, 0)
    })
  )

  it.effect("agenda lines may continue on the next line", () =>
    Effect.gen(function* () {
      const parsed = yield* parseMeeting(
        [
          "# Roundtable: m1",
          "Status: discussing",
          "Topic: t",
          "Goal: g",
          "Attendees: PO",
          "## Agenda",
          "1. Scope — Which rails",
          "   are first?",
          ""
        ].join("\n")
      )
      assert.deepStrictEqual(parsed.agenda, [
        AgendaItem.make({ number: 1, title: "Scope", question: "Which rails are first?" })
      ])
    })
  )

  it.effect("names every violation at once", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        parseMeeting(
          [
            "# Roundtable: m1",
            "Status: open",
            "Topic: t",
            "Attendees: PO, PO",
            "## Agenda",
            "- Scope",
            "## Minutes",
            ""
          ].join("\n"),
          ".llm4ts/meetings/m1/meeting.md"
        )
      )
      assert.strictEqual(error._tag, "MeetingInvalid")
      assert.strictEqual(error.path, ".llm4ts/meetings/m1/meeting.md")
      assert.deepStrictEqual(error.violations, [
        "line 2: Status is one of agenda-proposed, discussing, drafting, reviewing, done, got: open",
        "line 4: attendee listed twice: PO",
        "line 6: an agenda item is `1. <title> — <question>`, got: - Scope",
        'line 7: unknown section "Minutes"',
        "missing the `Goal:` line"
      ])
    })
  )
})

// ---- Turns --------------------------------------------------------------------

const turn = (
  id: number,
  item: number,
  round: number,
  speaker: string,
  kind: TurnKind,
  extra: {
    answers?: ReadonlyArray<number>
    blocking?: boolean
    needsHuman?: boolean
    assumption?: string
    body?: string
  } = {}
): Turn =>
  Turn.make({
    id,
    round,
    item,
    speaker,
    kind,
    answers: [...(extra.answers ?? [])],
    blocking: extra.blocking ?? false,
    needsHuman: extra.needsHuman ?? false,
    ...(extra.assumption === undefined ? {} : { assumption: extra.assumption }),
    body: extra.body ?? `${speaker} ${kind}`
  })

describe("the turn record", () => {
  it.effect("one JSON line per turn, decoded in order", () =>
    Effect.gen(function* () {
      const turns = [
        turn(1, 1, 1, "PO", "position"),
        turn(2, 1, 1, "SRE", "question", { needsHuman: true, assumption: "it is 200ms" })
      ]
      const text = turns.map(encodeTurn).join("\n") + "\n"
      assert.strictEqual(text.split("\n").length, 3)
      const decoded = yield* decodeTurns(text)
      assert.deepStrictEqual(decoded, turns)
      assert.deepStrictEqual(yield* decodeTurns(""), [])
    })
  )

  it.effect("names the line that is not a turn, and a gap in the ids", () =>
    Effect.gen(function* () {
      const text = [
        encodeTurn(turn(1, 1, 1, "PO", "position")),
        "{not json",
        encodeTurn(turn(4, 1, 1, "SRE", "pass"))
      ].join("\n")
      const error = yield* Effect.flip(decodeTurns(text, "turns.jsonl"))
      assert.strictEqual(error._tag, "TurnsInvalid")
      assert.strictEqual(error.path, "turns.jsonl")
      assert.strictEqual(error.violations.length, 2)
      assert.match(error.violations[0] ?? "", /^line 2: not a JSON turn/)
      assert.strictEqual(error.violations[1], "line 3: turn id 4 where 2 was expected")
    })
  )

  it("a proposal becomes a turn the record can hold", () => {
    const existing = [turn(1, 1, 1, "PO", "position"), turn(2, 2, 1, "PO", "proposal")]
    const objection = assembleTurn(
      TurnProposal.make({
        kind: "objection",
        answers: [1, 2, 7],
        blocking: true,
        needsHuman: true,
        assumption: "none",
        body: "  Too slow.\n"
      }),
      { id: 3, round: 1, item: 1, speaker: "SRE", existing }
    )
    // Only turns of the same item that already exist can be answered; an
    // objection blocks but never needs the owner.
    assert.deepStrictEqual(
      objection,
      turn(3, 1, 1, "SRE", "objection", { answers: [1], blocking: true, body: "Too slow." })
    )
    const question = assembleTurn(
      TurnProposal.make({
        kind: "question",
        answers: [],
        blocking: true,
        needsHuman: true,
        assumption: "we assume yes",
        body: "Is it contractual?"
      }),
      { id: 3, round: 1, item: 1, speaker: "SRE", existing }
    )
    assert.strictEqual(question.blocking, false)
    assert.strictEqual(question.needsHuman, true)
    assert.strictEqual(question.assumption, "we assume yes")
    const position = assembleTurn(
      TurnProposal.make({
        kind: "position",
        answers: [],
        blocking: false,
        needsHuman: false,
        assumption: "stray",
        body: "Fine."
      }),
      { id: 3, round: 1, item: 1, speaker: "SRE", existing }
    )
    assert.strictEqual(position.assumption, undefined)
  })

  it("the proposal's JSON schema asks for every field", () => {
    assert.deepStrictEqual(turnProposalJsonSchema.required, [
      "kind",
      "answers",
      "blocking",
      "needsHuman",
      "body"
    ])
  })
})

// ---- What the turns imply -----------------------------------------------------

const room = Meeting.make({
  id: "m",
  status: "discussing",
  topic: "Payments hub",
  goal: "An approved outline.",
  attendees: ["PO", "Cloud Architect", "SRE"],
  agenda: [
    AgendaItem.make({ number: 1, title: "Scope", question: "Which rails first?" }),
    AgendaItem.make({ number: 2, title: "Integration", question: "Events or calls?" })
  ],
  answers: [],
  feedback: "",
  drafts: 0
})

/** Round 1 of item 1: a proposal and a blocking objection to it. */
const contested = [
  turn(1, 1, 1, "PO", "position"),
  turn(2, 1, 1, "Cloud Architect", "proposal"),
  turn(3, 1, 1, "SRE", "objection", { answers: [2], blocking: true })
]

describe("what the turns imply", () => {
  it("a blocking objection stays open until its objector, or the chair, agrees it is answered", () => {
    assert.deepStrictEqual(
      openObjections(contested, 1).map((t) => t.id),
      [3]
    )
    const closedByObjector = [...contested, turn(4, 1, 2, "SRE", "agreement", { answers: [3] })]
    assert.deepStrictEqual(openObjections(closedByObjector, 1), [])
    const closedByChair = [...contested, turn(4, 1, 2, chairSpeaker, "agreement", { answers: [3] })]
    assert.deepStrictEqual(openObjections(closedByChair, 1), [])
    const notClosed = [
      ...contested,
      turn(4, 1, 2, "Cloud Architect", "agreement", { answers: [3] })
    ]
    assert.deepStrictEqual(
      openObjections(notClosed, 1).map((t) => t.id),
      [3]
    )
    const soft = [
      turn(1, 1, 1, "PO", "proposal"),
      turn(2, 1, 1, "SRE", "objection", { answers: [1] })
    ]
    assert.deepStrictEqual(openObjections(soft, 1), [])
  })

  it("a question is open until any later turn answers it; one for the owner is parked", () => {
    const turns = [
      turn(1, 1, 1, "PO", "question"),
      turn(2, 1, 1, "Cloud Architect", "question", { needsHuman: true, assumption: "200ms" }),
      turn(3, 1, 1, "SRE", "position", { answers: [1] })
    ]
    assert.deepStrictEqual(openQuestions(turns, 1), [])
    assert.deepStrictEqual(
      parkedQuestions(turns).map((t) => t.id),
      [2]
    )
    const answered = [
      ...turns,
      turn(4, 1, 2, ownerSpeaker, "position", { answers: [2], body: "Yes." })
    ]
    assert.deepStrictEqual(parkedQuestions(answered), [])
    assert.deepStrictEqual(
      openQuestions([turn(1, 1, 1, "PO", "question"), turn(2, 1, 1, "SRE", "pass")], 1).map(
        (t) => t.id
      ),
      [1]
    )
  })

  it("an item settles after a complete round with nothing open; the cap leaves it open", () => {
    const partial = itemState(room, contested.slice(0, 2), 1, defaultCaps)
    assert.deepStrictEqual(partial, { rounds: 0, round: 1, settled: false, capped: false })
    const contestedState = itemState(room, contested, 1, defaultCaps)
    assert.deepStrictEqual(contestedState, { rounds: 1, round: 2, settled: false, capped: false })
    const settled = itemState(
      room,
      [
        ...contested,
        turn(4, 1, 2, "PO", "pass"),
        turn(5, 1, 2, "Cloud Architect", "position", { answers: [3] }),
        turn(6, 1, 2, "SRE", "agreement", { answers: [3] })
      ],
      1,
      defaultCaps
    )
    assert.deepStrictEqual(settled, { rounds: 2, round: 3, settled: true, capped: false })
    const stuck = [
      ...contested,
      turn(4, 1, 2, "PO", "pass"),
      turn(5, 1, 2, "Cloud Architect", "pass"),
      turn(6, 1, 2, "SRE", "pass"),
      turn(7, 1, 3, "PO", "pass"),
      turn(8, 1, 3, "Cloud Architect", "pass"),
      turn(9, 1, 3, "SRE", "pass")
    ]
    assert.deepStrictEqual(itemState(room, stuck, 1, defaultCaps), {
      rounds: 3,
      round: 4,
      settled: false,
      capped: true
    })
    // The owner's word reopens a capped item for one more round.
    const reopened = [
      ...stuck,
      turn(10, 1, 4, ownerSpeaker, "position", {
        answers: [3],
        body: "Latency is not contractual."
      })
    ]
    assert.deepStrictEqual(itemState(room, reopened, 1, defaultCaps), {
      rounds: 3,
      round: 4,
      settled: false,
      capped: false
    })
  })

  it("a proposal on a settled item is a decision, with the soft objections as its dissent", () => {
    const turns = [
      turn(1, 1, 1, "PO", "position"),
      turn(2, 1, 1, "Cloud Architect", "proposal", { body: "Events." }),
      turn(3, 1, 1, "SRE", "objection", { answers: [2], body: "Harder to debug." }),
      turn(4, 2, 1, "PO", "proposal", { body: "Cards first." }),
      turn(5, 2, 1, "Cloud Architect", "objection", { answers: [4], blocking: true }),
      turn(6, 2, 1, "SRE", "pass")
    ]
    const found = decisions(room, turns, defaultCaps)
    assert.deepStrictEqual(
      found.map((d) => [d.item.number, d.proposal.id, d.dissent.map((t) => t.id)]),
      [[1, 2, [3]]]
    )
  })
})

// ---- The chair ----------------------------------------------------------------

const speak = (item: number, round: number, speaker: string): ChairAction => ({
  _tag: "Speak",
  item: itemOf(room, item) ?? reviewItem(room),
  round,
  speaker,
  addressed: []
})

describe("the chair", () => {
  it("a fresh meeting gets its agenda from the first attendee, then opens", () => {
    const fresh = Meeting.make({ ...room, status: "agenda-proposed", agenda: [] })
    assert.deepStrictEqual(nextAction(fresh, [], defaultCaps), {
      _tag: "ProposeAgenda",
      speaker: "PO"
    })
    assert.deepStrictEqual(
      nextAction(Meeting.make({ ...room, status: "agenda-proposed" }), [], defaultCaps),
      { _tag: "OpenDiscussion" }
    )
    assert.deepStrictEqual(nextAction(Meeting.make({ ...room, agenda: [] }), [], defaultCaps), {
      _tag: "Refused",
      reason:
        "the meeting is discussing but has no agenda: delete the folder or set Status: agenda-proposed"
    })
  })

  it("attendees speak in order, one round at a time, and the item moves on once settled", () => {
    assert.deepStrictEqual(nextAction(room, [], defaultCaps), speak(1, 1, "PO"))
    assert.deepStrictEqual(
      nextAction(room, contested.slice(0, 1), defaultCaps),
      speak(1, 1, "Cloud Architect")
    )
    const settled = [
      turn(1, 1, 1, "PO", "position"),
      turn(2, 1, 1, "Cloud Architect", "proposal"),
      turn(3, 1, 1, "SRE", "agreement", { answers: [2] })
    ]
    assert.deepStrictEqual(nextAction(room, settled, defaultCaps), speak(2, 1, "PO"))
  })

  it("an open objection opens another round, and names who it is aimed at", () => {
    const action = nextAction(room, contested, defaultCaps)
    assert.deepStrictEqual(action, speak(1, 2, "PO"))
    const after = nextAction(room, [...contested, turn(4, 1, 2, "PO", "pass")], defaultCaps)
    assert.strictEqual(after._tag, "Speak")
    if (after._tag === "Speak") {
      assert.strictEqual(after.speaker, "Cloud Architect")
      assert.deepStrictEqual(
        after.addressed.map((t) => t.id),
        [3]
      )
    }
  })

  it("when the objector has spoken again without closing, the chair judges the reply once", () => {
    const replied = [
      ...contested,
      turn(4, 1, 2, "PO", "pass"),
      turn(5, 1, 2, "Cloud Architect", "position", { answers: [3] })
    ]
    assert.deepStrictEqual(nextAction(room, replied, defaultCaps), speak(1, 2, "SRE"))
    const unclosed = [...replied, turn(6, 1, 2, "SRE", "pass")]
    assert.deepStrictEqual(nextAction(room, unclosed, defaultCaps), {
      _tag: "Judge",
      item: room.agenda[0],
      objection: contested[2],
      reply: replied[4]
    })
    const resolved = [...unclosed, turn(7, 1, 2, chairSpeaker, "agreement", { answers: [3] })]
    assert.deepStrictEqual(nextAction(room, resolved, defaultCaps), speak(2, 1, "PO"))
    const stillOpen = [...unclosed, turn(7, 1, 2, chairSpeaker, "position", { answers: [3] })]
    assert.deepStrictEqual(nextAction(room, stillOpen, defaultCaps), speak(1, 3, "PO"))
  })

  it("the closing item follows the agenda; drafting follows the last item or the turn cap", () => {
    const oneRound = (item: number, from: number) => [
      turn(from, item, 1, "PO", "position"),
      turn(from + 1, item, 1, "Cloud Architect", "proposal"),
      turn(from + 2, item, 1, "SRE", "agreement", { answers: [from + 1] })
    ]
    const twoItems = [...oneRound(1, 1), ...oneRound(2, 4)]
    assert.deepStrictEqual(nextAction(room, twoItems, defaultCaps), speak(3, 1, "PO"))
    const all = [...twoItems, ...oneRound(3, 7)]
    assert.deepStrictEqual(nextAction(room, all, defaultCaps), { _tag: "Draft" })
    assert.deepStrictEqual(nextAction(room, contested, { roundsPerItem: 3, maxTurns: 3 }), {
      _tag: "Draft"
    })
    assert.deepStrictEqual(
      nextAction(Meeting.make({ ...room, status: "drafting" }), all, defaultCaps),
      { _tag: "Draft" }
    )
  })

  it("every attendee reviews each draft once, then the scribe finalizes against the blocking objections", () => {
    const reviewing = Meeting.make({ ...room, status: "reviewing", drafts: 1 })
    assert.deepStrictEqual(nextAction(reviewing, [], defaultCaps), speak(4, 1, "PO"))
    const reviewed = [
      turn(1, 4, 1, "PO", "agreement"),
      turn(2, 4, 1, "Cloud Architect", "objection", { body: "Nit." }),
      turn(3, 4, 1, "SRE", "objection", { blocking: true, body: "No rollback section." })
    ]
    assert.deepStrictEqual(nextAction(reviewing, reviewed, defaultCaps), {
      _tag: "Finalize",
      objections: [reviewed[2]]
    })
    // A second draft opens a second review round.
    assert.deepStrictEqual(
      nextAction(Meeting.make({ ...reviewing, drafts: 2 }), reviewed, defaultCaps),
      speak(4, 2, "PO")
    )
  })

  it("the owner's answers and feedback are recorded as turns before anything else", () => {
    const parked = [
      turn(1, 1, 1, "PO", "position"),
      turn(2, 1, 1, "Cloud Architect", "question", {
        needsHuman: true,
        assumption: "200ms",
        body: "Is latency contractual?"
      }),
      turn(3, 1, 1, "SRE", "pass")
    ]
    const done = Meeting.make({
      ...room,
      status: "done",
      answers: [
        OpenPoint.make({
          number: 2,
          question: "Is latency contractual? (Cloud Architect)",
          answer: "Yes."
        })
      ],
      feedback: "Add the sandbox."
    })
    assert.deepStrictEqual(
      nextAction(Meeting.make({ ...room, status: "done" }), parked, defaultCaps),
      { _tag: "Done" }
    )
    const action = nextAction(done, parked, defaultCaps)
    assert.deepStrictEqual(action, {
      _tag: "RecordOwner",
      answers: [{ question: parked[1], answer: "Yes." }],
      feedback: "Add the sandbox."
    })
    if (action._tag !== "RecordOwner") return
    const recorded = recordOwner(done, parked, action)
    assert.deepStrictEqual(recorded, [
      turn(4, 1, 2, ownerSpeaker, "position", { answers: [2], body: "Yes." }),
      turn(5, 4, 1, ownerSpeaker, "position", { body: "Add the sandbox." })
    ])
    // Once recorded, the answer is not recorded twice; the flow reopens the
    // discussion and the item gets its extra round.
    const withOwner = [...parked, ...recorded]
    const reopened = Meeting.make({ ...done, status: "discussing", feedback: "" })
    assert.deepStrictEqual(nextAction(reopened, withOwner, defaultCaps), speak(1, 2, "PO"))
  })
})

// ---- Views ----------------------------------------------------------------------

const minutes = [
  turn(1, 1, 1, "PO", "position", { body: "Cards first." }),
  turn(2, 1, 1, "Cloud Architect", "proposal", { body: "Events between the hub and the ledger." }),
  turn(3, 1, 1, "SRE", "objection", { answers: [2], blocking: true, body: "Harder to debug." }),
  turn(4, 1, 2, "PO", "pass"),
  turn(5, 1, 2, "Cloud Architect", "question", {
    needsHuman: true,
    assumption: "200ms is hard",
    body: "Is the latency budget contractual?"
  }),
  turn(6, 1, 2, "SRE", "agreement", { answers: [3], body: "Fine with tracing." }),
  turn(7, 2, 1, "PO", "proposal", { body: "Cards only in release one." }),
  turn(8, 2, 1, "Cloud Architect", "objection", {
    answers: [7],
    body: "Transfers are cheap to add."
  })
]

describe("the views", () => {
  it("the discussion reads as meeting notes, item by item, round by round", () => {
    assert.strictEqual(
      renderDiscussion(room, minutes, defaultCaps),
      [
        "# Discussion: Payments hub",
        "",
        "Goal: An approved outline.",
        "Attendees: PO, Cloud Architect, SRE",
        "",
        "## 1. Scope — Which rails first?",
        "",
        "### Round 1",
        "",
        "**PO** #1 position: Cards first.",
        "",
        "**Cloud Architect** #2 proposal: Events between the hub and the ledger.",
        "",
        "**SRE** #3 objection to #2, blocking: Harder to debug.",
        "",
        "### Round 2",
        "",
        "**PO** #4 passes.",
        "",
        "**Cloud Architect** #5 question for the owner (assuming: 200ms is hard): Is the latency budget contractual?",
        "",
        "**SRE** #6 agreement with #3: Fine with tracing.",
        "",
        "Settled.",
        "",
        "## 2. Integration — Events or calls?",
        "",
        "### Round 1",
        "",
        "**PO** #7 proposal: Cards only in release one.",
        "",
        "**Cloud Architect** #8 objection to #7: Transfers are cheap to add.",
        "",
        "In progress.",
        "",
        "## 3. Goal check — Does the solution, as settled above, reach the goal?",
        "",
        "Not discussed yet.",
        ""
      ].join("\n")
    )
  })

  it("decisions are ADR-shaped, one per proposal that stood, with the dissent", () => {
    const settledTwo = [...minutes, turn(9, 2, 1, "SRE", "pass")]
    assert.strictEqual(
      renderDecisions(room, settledTwo, defaultCaps),
      [
        "# Decisions: Payments hub",
        "",
        "## 1. Events between the hub and the ledger.",
        "",
        "Item: 1. Scope — Which rails first?",
        "Proposed by: Cloud Architect (#2), round 1",
        "",
        "Events between the hub and the ledger.",
        "",
        "No dissent.",
        "",
        "## 2. Cards only in release one.",
        "",
        "Item: 2. Integration — Events or calls?",
        "Proposed by: PO (#7), round 1",
        "",
        "Cards only in release one.",
        "",
        "Dissent:",
        "- Cloud Architect (#8): Transfers are cheap to add.",
        ""
      ].join("\n")
    )
    assert.strictEqual(
      renderDecisions(room, [], defaultCaps),
      ["# Decisions: Payments hub", "", "No decision was reached.", ""].join("\n")
    )
  })

  it("open questions list what the owner owes and what the room left open", () => {
    const stuck = [
      ...minutes,
      turn(9, 2, 1, "SRE", "objection", { answers: [7], blocking: true, body: "No fraud story." }),
      ...[2, 3].flatMap((round) => [
        turn(4 + round * 3, 2, round, "PO", "pass"),
        turn(5 + round * 3, 2, round, "Cloud Architect", "pass"),
        turn(6 + round * 3, 2, round, "SRE", "pass")
      ])
    ]
    assert.deepStrictEqual(itemState(room, stuck, 2, defaultCaps).capped, true)
    assert.strictEqual(
      renderOpenQuestions(room, stuck, defaultCaps),
      [
        "# Open questions: Payments hub",
        "",
        "## For the owner",
        "",
        "- #5 Cloud Architect, item 1: Is the latency budget contractual? (assuming: 200ms is hard)",
        "",
        "## Left open by the room",
        "",
        "- 2. Integration — Events or calls?: left open after 3 rounds",
        "  - #9 SRE objects to #7, blocking: No fraud story.",
        "- 3. Goal check — Does the solution, as settled above, reach the goal?: not discussed",
        ""
      ].join("\n")
    )
    assert.strictEqual(
      renderOpenQuestions(room, [], defaultCaps),
      [
        "# Open questions: Payments hub",
        "",
        "## For the owner",
        "",
        "None.",
        "",
        "## Left open by the room",
        "",
        "- 1. Scope — Which rails first?: not discussed",
        "- 2. Integration — Events or calls?: not discussed",
        "- 3. Goal check — Does the solution, as settled above, reach the goal?: not discussed",
        ""
      ].join("\n")
    )
  })

  it("parked questions appear in the meeting file for the owner, answers kept", () => {
    const withAnswer = Meeting.make({
      ...room,
      answers: [
        OpenPoint.make({
          number: 5,
          question: "Is the latency budget contractual? (Cloud Architect)",
          answer: "Yes."
        })
      ]
    })
    assert.deepStrictEqual(syncAnswers(room, minutes).answers, [
      OpenPoint.make({
        number: 5,
        question: "Is the latency budget contractual? (Cloud Architect)"
      })
    ])
    assert.deepStrictEqual(syncAnswers(withAnswer, minutes).answers, withAnswer.answers)
  })

  it("an attendee is briefed with earlier decisions, parked questions and the current item's turns", () => {
    const briefing = briefingFor(room, minutes, 2, defaultCaps)
    assert.deepStrictEqual(
      briefing.decisions.map((d) => d.proposal.id),
      [2]
    )
    assert.deepStrictEqual(
      briefing.parked.map((t) => t.id),
      [5]
    )
    assert.deepStrictEqual(
      briefing.current.map((t) => t.id),
      [7, 8]
    )
  })

  it("a proposed agenda is numbered, one line each, capped at seven", () => {
    const items = assembleAgenda(
      AgendaProposal.make({
        items: [
          { title: "Scope — and more", question: "Which\nrails?" },
          ...Array.from({ length: 8 }, (_, index) => ({
            title: `t${index}`,
            question: `q${index}`
          }))
        ]
      })
    )
    assert.strictEqual(items.length, 7)
    assert.deepStrictEqual(
      items[0],
      AgendaItem.make({ number: 1, title: "Scope - and more", question: "Which rails?" })
    )
  })
})
