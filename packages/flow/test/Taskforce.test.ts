import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { OpenPoint } from "@llm4ts/flow/Decisions"
import { parsePersona, renderPersona } from "@llm4ts/flow/Roundtable"
import {
  assembleBriefs,
  Brief,
  BriefProposal,
  currentWave,
  defaultCaps,
  Finding,
  fixBriefs,
  GoalCheck,
  nextAction,
  parsePlan,
  parseReport,
  Plan,
  planViolations,
  readyBriefs,
  recordOwner,
  renderOpenQuestions,
  renderPlan,
  renderReport,
  renderReview,
  renderTrailRow,
  Report,
  syncAnswers,
  trailHeader,
  verifyCommands,
  type Action
} from "@llm4ts/flow/Taskforce"

// ---- Fixtures -----------------------------------------------------------------

const card = (name: string, extra: ReadonlyArray<string> = []): string =>
  [
    "---",
    `name: ${name}`,
    "order: 20",
    "---",
    "",
    "## Mandate",
    "",
    "Do the thing.",
    ...extra
  ].join("\n")

const personas = Effect.gen(function* () {
  const chief = yield* parsePersona("Chief of Staff", card("Chief of Staff"))
  const researcher = yield* parsePersona(
    "Researcher",
    card("Researcher", ["", "## Tools", "", "read-only", "", "## Seat", "", "planner"])
  )
  const engineer = yield* parsePersona(
    "Engineer",
    card("Engineer", ["", "## Tools", "", "workspace", "", "## Seat", "", "coder"])
  )
  const operator = yield* parsePersona(
    "Operator",
    card("Operator", ["", "## Tools", "", "commands", "", "## Seat", "", "verifier"])
  )
  const writer = yield* parsePersona("Doc Writer", card("Doc Writer"))
  return { chief, researcher, engineer, operator, writer }
})

const brief = (
  id: string,
  owner: string,
  overrides: Partial<ConstructorParameters<typeof Brief>[0]> = {}
): Brief =>
  Brief.make({
    id,
    title: `Work ${id}`,
    owner,
    dependsOn: [],
    wave: 1,
    goal: `Reach ${id}`,
    scope: "src/",
    context: "",
    acceptance: "- it is done",
    verify: "",
    timebox: "10 turns",
    forbidden: "nothing else",
    report: `reports/${id}.md with the answer`,
    ...overrides
  })

const plan = (
  status: Plan["status"],
  briefs: ReadonlyArray<Brief>,
  overrides: Partial<ConstructorParameters<typeof Plan>[0]> = {}
): Plan =>
  Plan.make({
    id: "auth-gateway",
    status,
    goal: "Move auth behind the gateway.",
    deliverables: ["result.md"],
    cast: ["Chief of Staff", "Researcher", "Engineer", "Operator", "Doc Writer"],
    briefs,
    checks: [],
    answers: [],
    feedback: "",
    drafts: 0,
    folded: [],
    ...overrides
  })

const report = (
  id: string,
  status: Report["status"],
  overrides: Partial<ConstructorParameters<typeof Report>[0]> = {}
): Report =>
  Report.make({
    brief: id,
    status,
    attempt: 1,
    evidence: [],
    summary: `${id} ${status.toLowerCase()}`,
    questions: [],
    body: "Details.",
    ...overrides
  })

const tagsOf = (action: Action): string => action._tag

// ---- Cards --------------------------------------------------------------------

describe("specialist cards (ADR 0047, decision 4)", () => {
  it.effect("a card carries a tool grade and a seat, both optional", () =>
    Effect.gen(function* () {
      const { researcher, chief } = yield* personas
      assert.strictEqual(researcher.tools, "read-only")
      assert.strictEqual(researcher.seat, "planner")
      assert.isUndefined(chief.tools)
      assert.isUndefined(chief.seat)
      const rendered = renderPersona(researcher)
      assert.include(rendered, "## Tools\n\nread-only")
      assert.include(rendered, "## Seat\n\nplanner")
      const again = yield* parsePersona("Researcher", rendered)
      assert.deepStrictEqual(again, researcher)
    })
  )

  it.effect("an unknown grade or seat is a violation", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        parsePersona("Odd", card("Odd", ["", "## Tools", "", "root", "", "## Seat", "", "boss"]))
      )
      assert.strictEqual(error._tag, "PersonaInvalid")
      assert.isTrue(error.violations.some((v) => v.includes("Tools is one of")))
      assert.isTrue(error.violations.some((v) => v.includes("Seat is one of")))
    })
  )
})

// ---- The plan file ------------------------------------------------------------

describe("the plan file (decision 2)", () => {
  it.effect("round-trips through markdown", () =>
    Effect.gen(function* () {
      const original = plan(
        "working",
        [
          brief("B1", "Researcher", { context: "Read src/auth first.\nThen the gateway docs." }),
          brief("B2", "Engineer", {
            dependsOn: ["B1"],
            verify: "- pnpm test\n- pnpm lint",
            acceptance: "- the prototype boots\n- the tests pass"
          })
        ],
        {
          checks: [GoalCheck.make({ wave: 1, reached: false, note: "The prototype is missing." })],
          answers: [
            OpenPoint.make({ number: 1, question: "Which gateway? (B1, assuming: Kong)" }),
            OpenPoint.make({ number: 2, question: "Keep sessions?", answer: "Yes" })
          ],
          feedback: "Shorter please.",
          drafts: 1,
          folded: [2]
        }
      )
      const text = renderPlan(original)
      assert.include(text, "# Taskforce: auth-gateway")
      assert.include(text, "### B2. Work B2\nOwner: Engineer\nDepends on: B1\nWave: 1")
      assert.include(text, "VERIFY:\n- pnpm test\n- pnpm lint")
      assert.include(text, "- wave 1: not reached — The prototype is missing.")
      const parsed = yield* parsePlan(text, "/repo/.llm4ts/taskforce/auth-gateway/plan.md")
      assert.deepStrictEqual(parsed, original)
    })
  )

  it.effect("names what is wrong, with the line", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        parsePlan(
          [
            "# Taskforce: x",
            "",
            "Status: dreaming",
            "Goal: g",
            "Deliverables: result.md",
            "Cast: Chief of Staff",
            "",
            "## Briefs",
            "",
            "### B1. Thing",
            "Owner: Researcher",
            "Wave: one",
            "",
            "GOAL: g",
            "## Nope"
          ].join("\n")
        )
      )
      assert.strictEqual(error._tag, "PlanInvalid")
      assert.isTrue(error.violations.some((v) => v.startsWith("line 3: Status is one of")))
      assert.isTrue(error.violations.some((v) => v.includes("Wave is a whole number")))
      assert.isTrue(error.violations.some((v) => v.includes('unknown section "Nope"')))
    })
  )

  it("verify commands are the VERIFY lines, bullets stripped", () => {
    assert.deepStrictEqual(
      verifyCommands(brief("B1", "Operator", { verify: "- pnpm test\n\n  pnpm lint\n- " })),
      ["pnpm test", "pnpm lint"]
    )
  })
})

describe("a valid plan (decision 3)", () => {
  it("accepts two to twelve briefs whose owners are in the cast and whose deliverables are covered", () => {
    const ok = plan("planned", [
      brief("B1", "Researcher"),
      brief("B2", "Doc Writer", { report: "result.md from B1" })
    ])
    assert.deepStrictEqual(planViolations(ok, defaultCaps), [])
  })

  it("names every violation", () => {
    const bad = plan(
      "planned",
      [
        brief("B1", "Nobody", { dependsOn: ["B2"], acceptance: "" }),
        brief("B2", "Researcher", { dependsOn: ["B1", "B9"], goal: "" })
      ],
      { deliverables: ["result.md", "design.md"] }
    )
    const violations = planViolations(bad, defaultCaps)
    assert.isTrue(violations.some((v) => v.includes("B1: owner Nobody is not in the cast")))
    assert.isTrue(violations.some((v) => v.includes("B2: depends on B9, which is not a brief")))
    assert.isTrue(violations.some((v) => v.includes("depend on each other in a cycle")))
    assert.isTrue(violations.some((v) => v.includes("B1: ACCEPTANCE is empty")))
    assert.isTrue(violations.some((v) => v.includes("B2: GOAL is empty")))
    assert.isTrue(violations.some((v) => v.includes("deliverable design.md is named by no brief")))
    const one = plan("planned", [brief("B1", "Researcher")])
    assert.isTrue(planViolations(one, defaultCaps).some((v) => v.includes("2 to 12 briefs, got 1")))
  })
})

// ---- Assembling briefs ----------------------------------------------------------

describe("assembling a proposal (decisions 3 and 5)", () => {
  const proposal = (owner: string, verify: ReadonlyArray<string> = []): BriefProposal =>
    BriefProposal.make({
      title: "  Survey   the module ",
      owner,
      dependsOn: [],
      goal: "g",
      scope: "s",
      context: "c",
      acceptance: ["a"],
      verify,
      timebox: "10 turns",
      forbidden: "f",
      report: "reports with the answer"
    })

  it.effect(
    "numbers briefs from `from`, maps dependencies, and routes VERIFY to the Operator",
    () =>
      Effect.gen(function* () {
        const cast = yield* personas
        const assembled = assembleBriefs(
          [
            proposal("Researcher"),
            BriefProposal.make({ ...proposal("Engineer", ["pnpm test"]), dependsOn: ["B3", "B9"] })
          ],
          {
            from: 3,
            wave: 2,
            cast: [cast.chief, cast.researcher, cast.engineer, cast.operator, cast.writer]
          }
        )
        assert.deepStrictEqual(
          assembled.briefs.map((b) => [b.id, b.owner, b.dependsOn, b.wave, b.verify]),
          [
            ["B3", "Researcher", [], 2, ""],
            ["B4", "Engineer", ["B3"], 2, ""],
            ["B5", "Operator", ["B4"], 2, "- pnpm test"]
          ]
        )
        assert.strictEqual(assembled.briefs[0]?.title, "Survey the module")
        assert.strictEqual(assembled.briefs[2]?.title, "Verify B4")
        assert.deepStrictEqual(assembled.notes, [])
      })
  )

  it.effect("drops VERIFY with a note when no card may run commands", () =>
    Effect.gen(function* () {
      const cast = yield* personas
      const assembled = assembleBriefs([proposal("Researcher", ["pnpm test"])], {
        from: 1,
        wave: 1,
        cast: [cast.chief, cast.researcher, cast.writer]
      })
      assert.strictEqual(assembled.briefs.length, 1)
      assert.strictEqual(assembled.briefs[0]?.verify, "")
      assert.strictEqual(assembled.notes.length, 1)
      assert.include(assembled.notes[0], "no card in the cast runs commands")
    })
  )
})

// ---- Reports --------------------------------------------------------------------

describe("reports (decision 2)", () => {
  it.effect("round-trip, questions and evidence included", () =>
    Effect.gen(function* () {
      const original = report("B2", "ISSUES", {
        attempt: 2,
        evidence: ["work/B2.diff", "reports/B2-tests.log"],
        questions: [{ question: "Keep sessions?", assumption: "Yes, for a release" }],
        body: "The prototype boots.\n\n## Notes\n\nOne test fails."
      })
      const text = renderReport(original, "Build the prototype")
      assert.include(text, "# B2: Build the prototype\nStatus: ISSUES\nAttempt: 2")
      assert.include(text, "Question: Keep sessions? (assuming: Yes, for a release)")
      const parsed = yield* parseReport(text, "reports/B2.md")
      assert.deepStrictEqual(parsed, original)
    })
  )

  it.effect("refuses a report without a status", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parseReport("# B1: x\nSummary: s\n\nbody"))
      assert.strictEqual(error._tag, "ReportInvalid")
      assert.isTrue(error.violations.some((v) => v.includes("Status")))
    })
  )
})

// ---- The loop -------------------------------------------------------------------

describe("nextAction (decisions 3, 6, 7, 9)", () => {
  const b1 = brief("B1", "Researcher")
  const b2 = brief("B2", "Engineer", { dependsOn: ["B1"] })
  const b3 = brief("B3", "Operator", { dependsOn: ["B2"], verify: "- pnpm test" })
  const b4 = brief("B4", "Researcher")

  it("proposes a plan when there is none, opens it when there is", () => {
    assert.strictEqual(tagsOf(nextAction(plan("planned", []), [], defaultCaps)), "ProposePlan")
    assert.strictEqual(tagsOf(nextAction(plan("planned", [b1, b4]), [], defaultCaps)), "Open")
  })

  it("dispatches every brief whose dependencies are final, together", () => {
    const action = nextAction(plan("working", [b1, b2, b3, b4]), [], defaultCaps)
    assert.strictEqual(action._tag, "Dispatch")
    if (action._tag === "Dispatch") {
      assert.deepStrictEqual(
        action.briefs.map((b) => b.id),
        ["B1", "B4"]
      )
    }
    const later = nextAction(
      plan("working", [b1, b2, b3, b4]),
      [report("B1", "PASS"), report("B4", "ISSUES")],
      defaultCaps
    )
    assert.strictEqual(later._tag, "Dispatch")
    if (later._tag === "Dispatch")
      assert.deepStrictEqual(
        later.briefs.map((b) => b.id),
        ["B2"]
      )
  })

  it("a BLOCKED brief is dispatched once more; twice is final", () => {
    const once = nextAction(
      plan("working", [b1, b4]),
      [report("B1", "BLOCKED"), report("B4", "PASS")],
      defaultCaps
    )
    assert.strictEqual(once._tag, "Dispatch")
    if (once._tag === "Dispatch") {
      assert.deepStrictEqual(
        once.briefs.map((b) => b.id),
        ["B1"]
      )
      assert.strictEqual(once.attempt, 2)
    }
    const twice = nextAction(
      plan("working", [b1, b4]),
      [report("B1", "BLOCKED", { attempt: 2 }), report("B4", "PASS")],
      defaultCaps
    )
    assert.strictEqual(twice._tag, "Check")
  })

  it("a brief behind a finally blocked one is skipped, not run", () => {
    const action = nextAction(
      plan("working", [b1, b2]),
      [report("B1", "BLOCKED", { attempt: 2 })],
      defaultCaps
    )
    assert.strictEqual(action._tag, "Skip")
    if (action._tag === "Skip") {
      assert.strictEqual(action.brief.id, "B2")
      assert.include(action.reason, "B1")
    }
  })

  it("after the first wave the Chief of Staff checks the goal, and may re-plan once", () => {
    const first = nextAction(
      plan("working", [b1, b4]),
      [report("B1", "PASS"), report("B4", "PASS")],
      defaultCaps
    )
    assert.strictEqual(first._tag, "Check")
    if (first._tag === "Check") {
      assert.strictEqual(first.wave, 1)
      assert.isTrue(first.mayReplan)
    }
    const second = nextAction(
      plan("working", [b1, b4, brief("B5", "Researcher", { wave: 2 })], {
        checks: [GoalCheck.make({ wave: 1, reached: false, note: "more" })]
      }),
      [report("B1", "PASS"), report("B4", "PASS"), report("B5", "PASS")],
      defaultCaps
    )
    assert.strictEqual(second._tag, "Check")
    if (second._tag === "Check") {
      assert.strictEqual(second.wave, 2)
      assert.isFalse(second.mayReplan)
    }
    const atCap = nextAction(
      plan("working", [b1, b4]),
      [report("B1", "PASS"), report("B4", "PASS")],
      {
        waves: 1,
        briefs: 12
      }
    )
    assert.strictEqual(atCap._tag, "Check")
    if (atCap._tag === "Check") assert.isFalse(atCap.mayReplan)
  })

  it("a checked wave drafts; a draft reviews once; a review's fix wave redrafts and distils", () => {
    const checked = plan("working", [b1, b4], {
      checks: [GoalCheck.make({ wave: 1, reached: true, note: "ok" })]
    })
    const reports = [report("B1", "PASS"), report("B4", "PASS")]
    const draft = nextAction(checked, reports, defaultCaps)
    assert.strictEqual(draft._tag, "Draft")
    if (draft._tag === "Draft") assert.isFalse(draft.redraft)
    assert.strictEqual(
      tagsOf(nextAction(plan("drafting", [b1, b4]), reports, defaultCaps)),
      "Draft"
    )
    assert.strictEqual(
      tagsOf(nextAction(plan("reviewing", [b1, b4]), reports, defaultCaps)),
      "Review"
    )
    const fixing = plan("fixing", [b1, b4, brief("B5", "Doc Writer", { wave: 2 })], { drafts: 1 })
    const dispatch = nextAction(fixing, reports, defaultCaps)
    assert.strictEqual(dispatch._tag, "Dispatch")
    const redraft = nextAction(fixing, [...reports, report("B5", "PASS")], defaultCaps)
    assert.strictEqual(redraft._tag, "Draft")
    if (redraft._tag === "Draft") assert.isTrue(redraft.redraft)
    assert.strictEqual(
      tagsOf(nextAction(plan("distilling", [b1]), reports, defaultCaps)),
      "Distill"
    )
    assert.strictEqual(tagsOf(nextAction(plan("done", [b1]), reports, defaultCaps)), "Done")
  })

  it("an answer or feedback in the file comes before anything else", () => {
    const answered = plan("done", [b1], {
      answers: [
        OpenPoint.make({
          number: 1,
          question: "Which gateway? (B1, assuming: Kong)",
          answer: "Envoy"
        })
      ]
    })
    const action = nextAction(answered, [report("B1", "PASS")], defaultCaps)
    assert.strictEqual(action._tag, "RecordOwner")
    if (action._tag === "RecordOwner") {
      assert.deepStrictEqual(
        action.answers.map((a) => [a.number, a.answer]),
        [[1, "Envoy"]]
      )
    }
    const folded = plan("done", [b1], { answers: answered.answers, folded: [1] })
    assert.strictEqual(tagsOf(nextAction(folded, [report("B1", "PASS")], defaultCaps)), "Done")
    const fed = plan("done", [b1], { feedback: "Shorter." })
    assert.strictEqual(tagsOf(nextAction(fed, [report("B1", "PASS")], defaultCaps)), "RecordOwner")
  })
})

describe("recording the owner (decision 9)", () => {
  const b1 = brief("B1", "Researcher")
  it("an answer reopens the brief that asked, with the answer in its context, one wave on", () => {
    const answered = plan("done", [b1], {
      answers: [
        OpenPoint.make({
          number: 1,
          question: "Which gateway? (B1, assuming: Kong)",
          answer: "Envoy"
        })
      ],
      drafts: 1
    })
    const recorded = recordOwner(
      answered,
      {
        _tag: "RecordOwner",
        answers: [{ number: 1, question: answered.answers[0]?.question ?? "", answer: "Envoy" }],
        feedback: ""
      },
      defaultCaps
    )
    assert.strictEqual(recorded.plan.status, "working")
    assert.deepStrictEqual(recorded.plan.folded, [1])
    assert.strictEqual(recorded.briefs.length, 1)
    const rework = recorded.briefs[0]
    assert.strictEqual(rework?.id, "B2")
    assert.strictEqual(rework?.owner, "Researcher")
    assert.strictEqual(rework?.wave, 2)
    assert.include(rework?.context ?? "", "Envoy")
    assert.include(rework?.title ?? "", "B1")
  })

  it("feedback after done becomes a fix brief for the Doc Writer", () => {
    const fed = plan("done", [b1], { feedback: "Shorter, and cite the standard.", drafts: 1 })
    const recorded = recordOwner(
      fed,
      { _tag: "RecordOwner", answers: [], feedback: fed.feedback },
      defaultCaps
    )
    assert.strictEqual(recorded.plan.status, "fixing")
    assert.strictEqual(recorded.plan.feedback, "")
    assert.strictEqual(recorded.briefs[0]?.owner, "Doc Writer")
    assert.include(recorded.briefs[0]?.context ?? "", "cite the standard")
  })

  it("at the wave cap the answer is folded but no brief is added", () => {
    const answered = plan("done", [b1, brief("B2", "Researcher", { wave: 3 })], {
      answers: [OpenPoint.make({ number: 1, question: "q (B1, assuming: a)", answer: "b" })]
    })
    const recorded = recordOwner(
      answered,
      {
        _tag: "RecordOwner",
        answers: [{ number: 1, question: "q", answer: "b" }],
        feedback: ""
      },
      defaultCaps
    )
    assert.deepStrictEqual(recorded.briefs, [])
    assert.deepStrictEqual(recorded.plan.folded, [1])
    assert.strictEqual(recorded.plan.status, "done")
    assert.strictEqual(recorded.notes.length, 1)
  })

  it("questions in reports land under Answers with their assumption, once", () => {
    const synced = syncAnswers(plan("working", [b1]), [
      report("B1", "PASS", { questions: [{ question: "Which gateway?", assumption: "Kong" }] })
    ])
    assert.deepStrictEqual(
      synced.answers.map((p) => [p.number, p.question]),
      [[1, "Which gateway? (B1, assuming: Kong)"]]
    )
    const again = syncAnswers(synced, [
      report("B1", "PASS", { questions: [{ question: "Which gateway?", assumption: "Kong" }] })
    ])
    assert.strictEqual(again.answers.length, 1)
  })
})

describe("the fix wave (decision 7)", () => {
  const finding = (id: number, bucket: Finding["bucket"], about: string): Finding =>
    Finding.make({
      id,
      lens: "evidence",
      title: `Finding ${id}`,
      where: "result.md",
      brief: about,
      detail: "Says X without a report behind it.",
      bucket,
      reason: ""
    })
  it("act-on findings become briefs for the owner of the work, the Doc Writer otherwise", () => {
    const current = plan("reviewing", [brief("B1", "Researcher"), brief("B2", "Engineer")], {
      drafts: 1
    })
    const fixes = fixBriefs(
      current,
      [finding(1, "act-on", "B2"), finding(2, "consider", "B1"), finding(3, "act-on", "")],
      defaultCaps,
      "Doc Writer"
    )
    assert.deepStrictEqual(
      fixes.briefs.map((b) => [b.id, b.owner, b.wave]),
      [
        ["B3", "Engineer", 2],
        ["B4", "Doc Writer", 2]
      ]
    )
    assert.include(fixes.briefs[0]?.context ?? "", "Says X")
    assert.deepStrictEqual(fixes.dropped, [])
  })

  it("beyond the brief cap, findings are dropped and named", () => {
    const current = plan("reviewing", [brief("B1", "Researcher")], { drafts: 1 })
    const fixes = fixBriefs(
      current,
      [finding(1, "act-on", ""), finding(2, "act-on", "")],
      { waves: 3, briefs: 2 },
      "Doc Writer"
    )
    assert.strictEqual(fixes.briefs.length, 1)
    assert.deepStrictEqual(
      fixes.dropped.map((f) => f.id),
      [2]
    )
  })

  it("the review renders every bucket", () => {
    const text = renderReview([finding(1, "act-on", "B2"), finding(2, "dismissed", "")])
    assert.include(text, "## Act on")
    assert.include(text, "## Dismissed")
    assert.include(text, "Finding 1")
  })
})

describe("derived state and views", () => {
  const b1 = brief("B1", "Researcher")
  const b2 = brief("B2", "Engineer", { wave: 2 })
  it("the current wave is the highest planned", () => {
    assert.strictEqual(currentWave(plan("working", [])), 0)
    assert.strictEqual(currentWave(plan("working", [b1, b2])), 2)
  })
  it("ready briefs exclude those with a final report", () => {
    assert.deepStrictEqual(
      readyBriefs(plan("working", [b1, b2]), [report("B1", "PASS")]).map((b) => b.id),
      ["B2"]
    )
  })
  it("open questions list the finally blocked briefs with their assumption and the unanswered questions", () => {
    const text = renderOpenQuestions(
      plan("done", [b1, b2], {
        answers: [OpenPoint.make({ number: 1, question: "Which gateway? (B1, assuming: Kong)" })]
      }),
      [report("B2", "BLOCKED", { attempt: 2, summary: "No network; assumed the gateway is Kong." })]
    )
    assert.include(text, "B2")
    assert.include(text, "No network")
    assert.include(text, "Which gateway?")
  })
})

describe("the trail (decision 8)", () => {
  it("renders one TSV row, cells single-line, spreadsheet-unsafe starts quoted", () => {
    assert.strictEqual(trailHeader, "ts\tphase\tdecision\twhy\tevidence\tresult")
    const row = renderTrailRow({
      ts: "2026-10-31T09:00:00.000Z",
      phase: "wave 1",
      decision: "dispatched B1\tto Researcher",
      why: "=its dependencies\nare final",
      evidence: "plan.md",
      result: "-open"
    })
    assert.strictEqual(
      row,
      "2026-10-31T09:00:00.000Z\twave 1\tdispatched B1 to Researcher\t'=its dependencies are final\tplan.md\t'-open"
    )
  })
})
