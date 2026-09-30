import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type { LedgerBrief } from "@llm4ts/flow/CoverageLedger"
import {
  Citation,
  ConsideredProgram,
  Disposed,
  EpicBrief,
  parseEpicBrief,
  renderEpicBrief,
  ScopeItem
} from "@llm4ts/flow/EpicBrief"
import { OpenPoint } from "@llm4ts/flow/Decisions"
import {
  EpicBriefInvalid,
  EpicBriefNotApproved,
  ExtractPackMissing,
  OpenPointsPending
} from "@llm4ts/flow/FlowError"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import { makeMemoryPlainFileStore, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import {
  briefPath,
  coverageReport,
  designEpic,
  epicProgressOf,
  parseEpicDesignArgs,
  proposePrompt,
  readPackIndex,
  renderBriefList,
  renderOutcome,
  resolveDesignTarget
} from "../lib/epic-design.ts"
import { chooseEpic, generateStoryPlan, listBriefs, plannerInput } from "../lib/epic-stories.ts"
import { scripted } from "./support.ts"

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "epic-design")
const packFiles = [
  "legacy/docs/modernization/specs/CONTO_SALDO.md",
  "legacy/docs/modernization/specs/CONTO_MOVIMENTI.md",
  "legacy/docs/modernization/features/conto_saldo.feature",
  "legacy/docs/modernization/features/conto_movimenti.feature",
  "target/CONTRIBUTING.md",
  "target/src/kit/session/SessionGuard.tsx"
]
const specNames = ["CONTO_MOVIMENTI", "CONTO_SALDO"]
const epicId = "conto-corrente"
const path = briefPath("/target", epicId)

const selection = {
  programs: [
    { name: "CONTO_SALDO", reason: "balance inquiry" },
    { name: "CONTO_MOVIMENTI", reason: "movements and filters" }
  ]
}
const good = {
  goal: "Customers see their balance and filter their movements.",
  scope: [
    {
      title: "Balance card",
      citations: [{ program: "CONTO_SALDO", scenario: "Show the available balance" }]
    },
    {
      title: "Movement filters",
      citations: [
        { program: "CONTO_MOVIMENTI", scenario: "Filter movements by date range" },
        { program: "CONTO_MOVIMENTI", scenario: "Filter movements by amount" }
      ]
    }
  ],
  dropped: [
    {
      program: "CONTO_MOVIMENTI",
      scenario: "Export movements to fax",
      note: "dead: fax gateway retired"
    }
  ],
  provided: [
    {
      program: "CONTO_SALDO",
      scenario: "Session timeout warning",
      note: "src/kit/session/SessionGuard.tsx"
    }
  ],
  deferred: [],
  constraints: "Amounts are integer cents.",
  openPoints: ["Are pending movements shown with the booked ones?"]
}
/** Cites a scenario the pack does not have, and so leaves the amount filter unaccounted. */
const wrongCitation = {
  ...good,
  scope: [
    good.scope[0],
    {
      title: "Movement filters",
      citations: [
        { program: "CONTO_MOVIMENTI", scenario: "Filter movements by date range" },
        { program: "CONTO_MOVIMENTI", scenario: "Filter movements by payee" }
      ]
    }
  ]
}

const setup = (
  replies: ReadonlyArray<unknown>,
  names: ReadonlyArray<string> = specNames,
  others: ReadonlyArray<LedgerBrief> = []
) =>
  Effect.gen(function* () {
    const memory = yield* makeMemoryPlainFileStore()
    for (const file of packFiles) {
      yield* memory.store.writeAtomic(`/${file}`, readFileSync(join(fixtures, file), "utf8"))
    }
    const events = yield* makeCollectingFlowEvents
    const seat = yield* scripted(replies)
    const files: PlainFileStoreShape = memory.store
    const run = (request = "Current account: balance and movements") =>
      designEpic({
        files,
        reasoning: seat.service,
        events,
        targetDir: "/target",
        legacyRepo: "/legacy",
        specNames: names,
        epicId,
        request,
        budget: 50_000,
        guidance: readFileSync(join(fixtures, "target/CONTRIBUTING.md"), "utf8"),
        packNote: undefined,
        pathExists: (absolute) => Effect.map(files.read(absolute), (text) => text !== undefined),
        others
      })
    const brief = Effect.gen(function* () {
      const text = yield* files.read(path)
      return yield* parseEpicBrief(text ?? "", path)
    })
    const edit = (change: (current: EpicBrief) => EpicBrief) =>
      Effect.gen(function* () {
        yield* files.writeAtomic(path, renderEpicBrief(change(yield* brief)))
      })
    return { files, seat, run, brief, edit }
  })

describe("epic-design: one run of the brief loop", () => {
  it.effect("refuses a legacy repository without an extract pack", () =>
    Effect.gen(function* () {
      const { run, seat } = yield* setup([], [])
      const error = yield* Effect.flip(run())
      assert.instanceOf(error, ExtractPackMissing)
      assert.strictEqual(yield* seat.calls, 0)
    })
  )

  it.effect("the pack index carries each program's summary and scenario titles", () =>
    Effect.gen(function* () {
      const { files } = yield* setup([])
      const pack = yield* readPackIndex({ files, legacyRepo: "/legacy", specNames })
      const movements = pack.index.programs.find((program) => program.name === "CONTO_MOVIMENTI")
      assert.include(movements?.summary ?? "", "Movements of one current account")
      assert.deepStrictEqual(movements?.scenarios, [
        "Filter movements by date range",
        "Filter movements by amount",
        "Export movements to fax"
      ])
      assert.deepStrictEqual(pack.index.refine, [])
    })
  )

  it.effect("a first run selects programs, proposes, checks and writes a draft", () =>
    Effect.gen(function* () {
      const { run, seat, brief } = yield* setup([selection, good])
      const outcome = yield* run()
      assert.strictEqual(outcome.action, "propose")
      assert.deepStrictEqual(outcome.problems, [])
      assert.strictEqual(yield* seat.calls, 2)
      const written = yield* brief
      assert.strictEqual(written.status, "draft")
      assert.strictEqual(written.request, "Current account: balance and movements")
      assert.deepStrictEqual(
        written.programs.map((program) => program.name),
        ["CONTO_SALDO", "CONTO_MOVIMENTI"]
      )
      assert.deepStrictEqual(
        written.openPoints.map((point) => point.question),
        ["Are pending movements shown with the booked ones?"]
      )
      const [select, propose] = yield* seat.prompts
      assert.include(select ?? "", "Current account: balance and movements")
      assert.include(select ?? "", "Export movements to fax")
      assert.include(propose ?? "", "fax gateway")
      assert.include(propose ?? "", "Amounts are integer cents")
      assert.include(renderOutcome(outcome, epicId).join("\n"), "Status: approved")
    })
  )

  it.effect("a proposal that fails a check gets one fix round", () =>
    Effect.gen(function* () {
      const { run, seat, brief } = yield* setup([selection, wrongCitation, good])
      const outcome = yield* run()
      assert.strictEqual(yield* seat.calls, 3)
      assert.deepStrictEqual(outcome.problems, [])
      const fix = (yield* seat.prompts)[2] ?? ""
      assert.include(fix, 'CONTO_MOVIMENTI has no scenario "Filter movements by payee"')
      assert.isTrue(
        (yield* brief).openPoints.every((point) => !point.question.startsWith("[check]"))
      )
    })
  )

  it.effect("what the fix round cannot clear is written as a check-raised open point", () =>
    Effect.gen(function* () {
      const { run, seat, brief } = yield* setup([selection, wrongCitation, wrongCitation])
      const outcome = yield* run()
      assert.strictEqual(yield* seat.calls, 3)
      assert.deepStrictEqual(outcome.problems.map((problem) => problem.kind).sort(), [
        "Unaccounted",
        "UnknownScenario"
      ])
      const raised = (yield* brief).openPoints.filter((point) =>
        point.question.startsWith("[check]")
      )
      assert.strictEqual(raised.length, 2)
      // Completeness: the scenario the proposal left out is named.
      assert.isTrue(raised.some((point) => point.question.includes("Filter movements by amount")))
    })
  )

  it.effect("a provided pointer that is not in the target is a problem", () =>
    Effect.gen(function* () {
      const missing = {
        ...good,
        provided: [
          { program: "CONTO_SALDO", scenario: "Session timeout warning", note: "src/kit/Nope.tsx" }
        ]
      }
      const { run, brief } = yield* setup([selection, missing, missing])
      const outcome = yield* run()
      assert.deepStrictEqual(
        outcome.problems.map((problem) => problem.kind),
        ["MissingPointer"]
      )
      assert.include((yield* brief).openPoints.at(-1)?.question ?? "", "src/kit/Nope.tsx")
    })
  )

  it.effect("halts on unanswered open points, without calling the model or touching the file", () =>
    Effect.gen(function* () {
      const { run, seat, files } = yield* setup([selection, good])
      yield* run()
      const before = yield* files.read(path)
      const error = yield* Effect.flip(run())
      assert.instanceOf(error, OpenPointsPending)
      if (error._tag === "OpenPointsPending") {
        assert.strictEqual(error.path, path)
        assert.strictEqual(error.points.length, 1)
      }
      assert.strictEqual(yield* seat.calls, 2)
      assert.strictEqual(yield* files.read(path), before)
    })
  )

  it.effect(
    "revises from the file: answers and feedback in, the current brief kept as the base",
    () =>
      Effect.gen(function* () {
        const revised = {
          ...good,
          goal: "Customers see their balance and filter movements by date. (edited by hand)",
          scope: [
            good.scope[0],
            { title: "Date filter", citations: [good.scope[1]?.citations[0]] }
          ],
          deferred: [
            {
              program: "CONTO_MOVIMENTI",
              scenario: "Filter movements by amount",
              note: "next epic, with the payee filter"
            }
          ],
          openPoints: []
        }
        const { run, seat, brief, edit } = yield* setup([selection, good, revised])
        yield* run()
        yield* edit((current) =>
          EpicBrief.make({
            ...current,
            goal: "Customers see their balance and filter movements by date. (edited by hand)",
            openPoints: [
              OpenPoint.make({
                number: 1,
                question: current.openPoints[0]?.question ?? "",
                answer: "together, pending ones in grey"
              })
            ],
            feedback: "Defer the amount filter to the next epic."
          })
        )
        const outcome = yield* run()
        assert.strictEqual(outcome.action, "revise")
        // No second selection: the brief's own list is the selection.
        assert.strictEqual(yield* seat.calls, 3)
        const prompt = (yield* seat.prompts)[2] ?? ""
        assert.include(prompt, "(edited by hand)")
        assert.include(prompt, "Defer the amount filter to the next epic.")
        assert.include(prompt, "together, pending ones in grey")
        assert.include(prompt, "Keep everything")
        const written = yield* brief
        assert.strictEqual(written.feedback, "")
        assert.deepStrictEqual(written.openPoints, [])
        assert.include(written.goal, "(edited by hand)")
        assert.include(
          outcome.changes.join("\n"),
          "CONTO_MOVIMENTI › Filter movements by amount: in scope → deferred"
        )
      })
  )

  it.effect(
    "a draft with nothing pending waits for approval; an approved one validates untouched",
    () =>
      Effect.gen(function* () {
        const { run, seat, files, edit } = yield* setup([selection, { ...good, openPoints: [] }])
        yield* run()
        const waiting = yield* run()
        assert.strictEqual(waiting.action, "await-approval")
        yield* edit((current) => EpicBrief.make({ ...current, status: "approved" }))
        const approved = yield* files.read(path)
        const outcome = yield* run()
        assert.strictEqual(outcome.action, "validate")
        assert.strictEqual(yield* files.read(path), approved)
        assert.strictEqual(yield* seat.calls, 2)
        assert.include(renderOutcome(outcome, epicId).join("\n"), `epic-stories --repo`)
        assert.include(renderOutcome(outcome, epicId).join("\n"), `--epic ${epicId}`)
      })
  )

  it.effect("an approved brief with an unanswered open point is refused and left alone", () =>
    Effect.gen(function* () {
      const { run, files, edit } = yield* setup([selection, good])
      yield* run()
      yield* edit((current) => EpicBrief.make({ ...current, status: "approved" }))
      const approved = yield* files.read(path)
      const error = yield* Effect.flip(run())
      assert.instanceOf(error, EpicBriefInvalid)
      assert.include(error.message, "unanswered open points")
      assert.strictEqual(yield* files.read(path), approved)
    })
  )

  it.effect(
    "a scenario refine dropped comes back only through an answered check point, which stays",
    () =>
      Effect.gen(function* () {
        const { run, files, brief, edit, seat } = yield* setup([
          selection,
          good,
          good,
          { ...good, openPoints: [] }
        ])
        yield* files.writeAtomic(
          "/legacy/docs/modernization/decisions.md",
          [
            "# Decisions",
            "",
            "## Scenarios",
            "",
            "- CONTO_MOVIMENTI / Filter movements by amount: drop — rarely used (anna, 2026-09-20)",
            "",
            "- [ ] Approved",
            ""
          ].join("\n")
        )
        const first = yield* run()
        assert.deepStrictEqual(
          first.problems.map((problem) => problem.kind),
          ["RefineConflict"]
        )
        const raised = (yield* brief).openPoints.find((point) =>
          point.question.startsWith("[check]")
        )
        assert.include(raised?.question ?? "", "modernize-refine marked it drop")
        yield* edit((current) =>
          EpicBrief.make({
            ...current,
            openPoints: current.openPoints.map((point) =>
              OpenPoint.make({ ...point, answer: "keep: the business asked for it again" })
            )
          })
        )
        const second = yield* run()
        assert.deepStrictEqual(second.problems, [])
        const kept = (yield* brief).openPoints.find((point) => point.question.startsWith("[check]"))
        assert.strictEqual(kept?.answer, "keep: the business asked for it again")
        // The override is on file: the next run waits for approval and calls no model.
        const calls = yield* seat.calls
        const third = yield* run()
        assert.strictEqual(third.action, "await-approval")
        assert.strictEqual(yield* seat.calls, calls)
      })
  )
})

describe("epic-design arguments", () => {
  it.effect("parses --list and --epic, leaving the request as the rest", () =>
    Effect.gen(function* () {
      const plain = yield* parseEpicDesignArgs(["Current account"])
      assert.deepStrictEqual(plain, {
        list: false,
        coverage: false,
        epic: undefined,
        rest: ["Current account"]
      })
      const resumed = yield* parseEpicDesignArgs(["--epic", "conto-corrente"])
      assert.strictEqual(resumed.epic, "conto-corrente")
      assert.isTrue((yield* parseEpicDesignArgs(["--list"])).list)
      const error = yield* Effect.flip(parseEpicDesignArgs(["--epic"]))
      assert.include(error.message, "--epic needs an epic id")
    })
  )
})

describe("epic-stories plans from an approved brief", () => {
  const stateDir = "/target/.llm4ts/epics/conto-corrente"
  const planPath = `${stateDir}/plan.md`
  const written = (status: "draft" | "approved", answered: boolean) =>
    renderEpicBrief(
      EpicBrief.make({
        epicId: "conto-corrente",
        status,
        request: "Current account: balance and movements",
        legacy: "/legacy",
        goal: "Balance and movements in the portal.",
        programs: [],
        scope: [],
        dropped: [],
        provided: [],
        deferred: [],
        constraints: "",
        openPoints: answered ? [] : [OpenPoint.make({ number: 1, question: "Pending movements?" })],
        feedback: ""
      })
    )

  it.effect("no brief, or a plan already written: nothing changes", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      assert.isUndefined(yield* plannerInput(memory.store, stateDir, planPath))
      yield* memory.store.writeAtomic(`${stateDir}/brief.md`, written("draft", true))
      yield* memory.store.writeAtomic(planPath, "# Epic: already planned")
      assert.isUndefined(yield* plannerInput(memory.store, stateDir, planPath))
    })
  )

  it.effect(
    "an approved brief is the planner's input; a draft or an open point refuses the run",
    () =>
      Effect.gen(function* () {
        const memory = yield* makeMemoryPlainFileStore()
        yield* memory.store.writeAtomic(`${stateDir}/brief.md`, written("approved", true))
        const input = yield* plannerInput(memory.store, stateDir, planPath)
        assert.include(input ?? "", "# Epic brief: conto-corrente")
        assert.include(input ?? "", "Balance and movements in the portal.")

        yield* memory.store.writeAtomic(`${stateDir}/brief.md`, written("draft", true))
        const draft = yield* Effect.flip(plannerInput(memory.store, stateDir, planPath))
        assert.instanceOf(draft, EpicBriefNotApproved)
        assert.include(draft.message, "epic-design")

        yield* memory.store.writeAtomic(`${stateDir}/brief.md`, written("approved", false))
        const pending = yield* Effect.flip(plannerInput(memory.store, stateDir, planPath))
        assert.instanceOf(pending, EpicBriefInvalid)

        yield* memory.store.writeAtomic(`${stateDir}/brief.md`, "not a brief")
        const broken = yield* Effect.flip(plannerInput(memory.store, stateDir, planPath))
        assert.instanceOf(broken, EpicBriefInvalid)
      })
  )

  it.effect("--epic finds a folder that holds a brief and no plan yet", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* memory.store.writeAtomic(`${stateDir}/brief.md`, written("approved", true))
      yield* memory.store.writeAtomic("/target/.llm4ts/epics/broken/brief.md", "not a brief")
      const briefs = yield* listBriefs(memory.store, "/target", [
        "broken",
        "conto-corrente",
        "empty"
      ])
      assert.deepStrictEqual(briefs, [
        {
          dir: "conto-corrente",
          request: "Current account: balance and movements",
          status: "approved"
        }
      ])
      const choice = yield* chooseEpic({
        text: "",
        epic: "conto-corrente",
        epics: [],
        briefs,
        defaultEpic: "default"
      })
      assert.deepStrictEqual(choice, {
        _tag: "Brief",
        dir: "conto-corrente",
        request: "Current account: balance and movements"
      })
      const unknown = yield* Effect.flip(
        chooseEpic({ text: "", epic: "nope", epics: [], briefs, defaultEpic: "default" })
      )
      assert.include(unknown.message, "no epic 'nope'")
    })
  )

  it.effect("the planner reads the brief; the plan keeps the request as its epic", () =>
    Effect.gen(function* () {
      const seat = yield* scripted([
        {
          epicId: "x",
          epic: "whatever the model echoed",
          stories: [
            {
              id: "conto-saldo",
              title: "Balance card",
              description: "Show the balance",
              owned: ["src/features/conto/"]
            }
          ]
        }
      ])
      const events = yield* makeCollectingFlowEvents
      const plan = yield* generateStoryPlan(
        seat.service,
        events,
        "Current account: balance and movements",
        "conto-corrente",
        "house rules",
        written("approved", true)
      )
      assert.strictEqual(plan.epic, "Current account: balance and movements")
      assert.strictEqual(plan.epicId, "conto-corrente")
      const prompt = (yield* seat.prompts)[0] ?? ""
      assert.include(prompt, "# Epic brief: conto-corrente")
      assert.include(prompt, "Balance and movements in the portal.")
    })
  )
})

describe("epic-design: which brief a run works on", () => {
  const briefs = [
    { dir: "conto-corrente", request: "Current account", status: "draft" as const },
    { dir: "bonifici", request: "Wire transfers", status: "approved" as const }
  ]

  it.effect("text starts (or resumes) the brief its id derives from", () =>
    Effect.gen(function* () {
      const target = yield* resolveDesignTarget({
        text: "Statements archive",
        epic: undefined,
        briefs
      })
      assert.strictEqual(target.request, "Statements archive")
      assert.match(target.epicId, /^statements-archive-[0-9a-f]{6}$/)
    })
  )

  it.effect("--epic resumes a brief by folder, or names a new one when text is given", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* resolveDesignTarget({ text: "", epic: "conto-corrente", briefs }),
        { epicId: "conto-corrente", request: "Current account" }
      )
      assert.deepStrictEqual(
        yield* resolveDesignTarget({ text: "Card limits", epic: "carte", briefs }),
        { epicId: "carte", request: "Card limits" }
      )
      const error = yield* Effect.flip(resolveDesignTarget({ text: "", epic: "carte", briefs }))
      assert.include(error.message, "no brief 'carte'")
    })
  )

  it.effect("with neither, the one draft is resumed; none or several stop with the list", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* resolveDesignTarget({ text: "", epic: undefined, briefs }), {
        epicId: "conto-corrente",
        request: "Current account"
      })
      const none = yield* Effect.flip(
        resolveDesignTarget({ text: "", epic: undefined, briefs: [] })
      )
      assert.include(none.message, "Usage: epic-design")
      const two = yield* Effect.flip(
        resolveDesignTarget({
          text: "",
          epic: undefined,
          briefs: [...briefs, { dir: "carte", request: "Cards", status: "draft" as const }]
        })
      )
      assert.include(two.message, "conto-corrente")
      assert.include(two.message, "carte")
      assert.include(renderBriefList(briefs), "bonifici  approved  Wire transfers")
    })
  )

  it("the flow entry describes itself on its first line and runs designEpic", () => {
    const entry = readFileSync(join(fixtures, "..", "..", "epic-design.ts"), "utf8")
    assert.match(entry.split("\n")[0] ?? "", /^\/\/ .*epic brief/)
    assert.include(entry, "designEpic(")
    assert.include(entry, "LLM4TS_LEGACY_REPO")
    assert.include(entry, "runFlowMain(")
  })
})

describe("review findings: epic-design", () => {
  it.effect("odd text from the model is normalized, and what is written parses back the same", () =>
    Effect.gen(function* () {
      const odd = {
        ...good,
        goal: "Intro.\n## A heading the model invented\nMore.",
        dropped: [
          {
            program: "CONTO_MOVIMENTI",
            scenario: "Export movements to fax",
            note: "dead:\nfax gateway retired — 2019"
          }
        ]
      }
      const { run, files, brief } = yield* setup([selection, odd])
      const outcome = yield* run()
      assert.deepStrictEqual(outcome.problems, [])
      const parsed = yield* brief
      assert.strictEqual(parsed.dropped[0]?.note, "dead: fax gateway retired — 2019")
      assert.include(parsed.goal, "### A heading the model invented")
      assert.strictEqual(renderEpicBrief(parsed), yield* files.read(path))
    })
  )

  it.effect("every scenario title reaches the model, however small the evidence budget", () =>
    Effect.gen(function* () {
      const { files } = yield* setup([])
      const pack = yield* readPackIndex({ files, legacyRepo: "/legacy", specNames })
      const prompt = proposePrompt({
        request: "r",
        programs: selection.programs,
        pack,
        budget: 10,
        guidance: "",
        packNote: undefined
      })
      for (const program of pack.index.programs) {
        for (const scenario of program.scenarios) {
          assert.include(prompt, `${program.name} › ${scenario}`)
        }
      }
    })
  )

  it.effect("a selection with no program of the pack says so as an open point", () =>
    Effect.gen(function* () {
      const nothing = {
        ...good,
        scope: [],
        dropped: [],
        provided: [],
        deferred: [],
        openPoints: []
      }
      const { run, brief } = yield* setup([{ programs: [{ name: "GHOST", reason: "?" }] }, nothing])
      yield* run()
      const written = yield* brief
      assert.deepStrictEqual(written.programs, [])
      assert.include(written.openPoints[0]?.question ?? "", "No legacy program")
    })
  )

  it.effect("an epic id cannot leave the epics folder", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parseEpicDesignArgs(["--epic", "../outside", "text"]))
      assert.include(error.message, "epic id")
      assert.strictEqual(
        (yield* parseEpicDesignArgs(["--epic=conto-corrente_2.1"])).epic,
        "conto-corrente_2.1"
      )
    })
  )

  it.effect(
    "epic-stories with no text picks up the one approved brief, and never guesses among several",
    () =>
      Effect.gen(function* () {
        const briefs = [
          { dir: "conto-corrente", request: "Current account", status: "approved" as const }
        ]
        assert.deepStrictEqual(
          yield* chooseEpic({ text: "", epic: undefined, epics: [], briefs, defaultEpic: "demo" }),
          { _tag: "Brief", dir: "conto-corrente", request: "Current account" }
        )
        // No briefs: exactly as before.
        assert.deepStrictEqual(
          yield* chooseEpic({
            text: "",
            epic: undefined,
            epics: [],
            briefs: [],
            defaultEpic: "demo"
          }),
          { _tag: "Text", prompt: "demo" }
        )
        const two = yield* Effect.flip(
          chooseEpic({
            text: "",
            epic: undefined,
            epics: [],
            briefs: [...briefs, { dir: "carte", request: "Cards", status: "draft" as const }],
            defaultEpic: "demo"
          })
        )
        assert.include(two.message, "conto-corrente")
        assert.include(two.message, "carte")
      })
  )
})

describe("epic-design inherits from the approved briefs of other epics", () => {
  /** Another epic's brief: it owns the amount filter, dropped the fax, deferred the timeout. */
  const saldo = (status: "draft" | "approved", epicId = "saldo"): LedgerBrief => ({
    epicId,
    brief: EpicBrief.make({
      epicId,
      status,
      request: "Balance",
      legacy: "/legacy",
      goal: "",
      programs: [ConsideredProgram.make({ name: "CONTO_MOVIMENTI", reason: "" })],
      scope: [
        ScopeItem.make({
          title: "Amount filter",
          citations: [
            Citation.make({ program: "CONTO_MOVIMENTI", scenario: "Filter movements by amount" })
          ]
        })
      ],
      dropped: [
        Disposed.make({
          program: "CONTO_MOVIMENTI",
          scenario: "Export movements to fax",
          note: "fax gateway retired"
        })
      ],
      provided: [],
      deferred: [
        Disposed.make({
          program: "CONTO_SALDO",
          scenario: "Session timeout warning",
          note: "with the session epic"
        })
      ],
      constraints: "",
      openPoints: [],
      feedback: ""
    })
  })
  /** Disposes only of what is still open: nothing the other epic decided is restated. */
  const onlyOpen = {
    ...good,
    scope: [good.scope[0], { title: "Date filter", citations: [good.scope[1]?.citations[0]] }],
    dropped: [],
    openPoints: []
  }

  it.effect("the proposal is told what is decided, and need not restate it", () =>
    Effect.gen(function* () {
      const { run, seat, brief } = yield* setup([selection, onlyOpen], specNames, [
        saldo("approved")
      ])
      const outcome = yield* run()
      assert.deepStrictEqual(outcome.problems, [])
      assert.deepStrictEqual(outcome.inherited, [{ epic: "saldo", scenarios: 2 }])
      assert.include(renderOutcome(outcome, epicId).join("\n"), "inherited from saldo")
      const prompt = (yield* seat.prompts)[1] ?? ""
      assert.include(prompt, "Already decided by other epics")
      assert.include(
        prompt,
        "- CONTO_MOVIMENTI › Export movements to fax — dropped by epic saldo (fax gateway retired)"
      )
      assert.include(
        prompt,
        "- CONTO_MOVIMENTI › Filter movements by amount — in scope in epic saldo"
      )
      assert.include(
        prompt,
        "- CONTO_SALDO › Session timeout warning — deferred by epic saldo: with the session epic"
      )
      const open = prompt.slice(
        prompt.indexOf("Every scenario to give a disposition to"),
        prompt.indexOf("Legacy evidence:")
      )
      assert.include(open, "Filter movements by date range")
      assert.include(open, "Session timeout warning")
      assert.notInclude(open, "Export movements to fax")
      assert.notInclude(open, "Filter movements by amount")
      // The brief does not repeat the inherited decisions.
      assert.deepStrictEqual((yield* brief).dropped, [])
    })
  )

  it.effect("claiming what another epic owns is raised as a check point naming it", () =>
    Effect.gen(function* () {
      const { run, brief } = yield* setup([selection, good, good], specNames, [saldo("approved")])
      const outcome = yield* run()
      assert.deepStrictEqual(
        outcome.problems.map((problem) => problem.kind),
        ["AlreadyOwned"]
      )
      assert.include((yield* brief).openPoints.at(-1)?.question ?? "", "epic saldo")
    })
  )

  it.effect("a draft of another epic feeds nothing and eases nothing", () =>
    Effect.gen(function* () {
      const { run, seat } = yield* setup([selection, onlyOpen, onlyOpen], specNames, [
        saldo("draft")
      ])
      const outcome = yield* run()
      assert.deepStrictEqual(outcome.inherited, [])
      assert.deepStrictEqual(outcome.problems.map((problem) => problem.kind).sort(), [
        "Unaccounted",
        "Unaccounted"
      ])
      assert.notInclude((yield* seat.prompts)[1] ?? "", "Already decided by other epics")
    })
  )

  it.effect("a brief never inherits from, or conflicts with, itself", () =>
    Effect.gen(function* () {
      const { run } = yield* setup([selection, good], specNames, [saldo("approved", epicId)])
      const outcome = yield* run()
      assert.deepStrictEqual(outcome.problems, [])
      assert.deepStrictEqual(outcome.inherited, [])
    })
  )
})

describe("epic-design --coverage", () => {
  const owned = (epicId: string, parts: Partial<ConstructorParameters<typeof EpicBrief>[0]>) =>
    renderEpicBrief(
      EpicBrief.make({
        epicId,
        status: "approved",
        request: epicId,
        legacy: "/legacy",
        goal: "",
        programs: [ConsideredProgram.make({ name: "CONTO_MOVIMENTI", reason: "" })],
        scope: [],
        dropped: [],
        provided: [],
        deferred: [],
        constraints: "",
        openPoints: [],
        feedback: "",
        ...parts
      })
    )
  const amount = { program: "CONTO_MOVIMENTI", scenario: "Filter movements by amount" }

  it.effect("writes the report from every brief, with no model call and no brief touched", () =>
    Effect.gen(function* () {
      const { files, seat } = yield* setup([])
      const a = owned("a", {
        scope: [ScopeItem.make({ title: "Amount filter", citations: [Citation.make(amount)] })]
      })
      const b = owned("b", { dropped: [Disposed.make({ ...amount, note: "rarely used" })] })
      yield* files.writeAtomic("/target/.llm4ts/epics/a/brief.md", a)
      yield* files.writeAtomic("/target/.llm4ts/epics/b/brief.md", b)
      yield* files.writeAtomic("/target/.llm4ts/epics/broken/brief.md", "not a brief")
      const report = yield* coverageReport({
        files,
        targetDir: "/target",
        legacyRepo: "/legacy",
        specNames,
        dirs: ["a", "b", "broken", "no-brief-here"],
        epics: []
      })
      assert.strictEqual(report.path, "/target/.llm4ts/epics/coverage.md")
      assert.strictEqual(
        report.headline,
        "5 scenarios · 0 accounted for (0%) · 0 delivered · 5 remaining · 1 conflict"
      )
      const text = (yield* files.read(report.path)) ?? ""
      assert.include(text, report.headline)
      assert.include(text, "## Conflicts")
      assert.include(text, "a: in scope (Amount filter); b: dropped (rarely used)")
      assert.include(text, "- broken: ")
      assert.strictEqual(yield* files.read("/target/.llm4ts/epics/a/brief.md"), a)
      assert.strictEqual(yield* files.read("/target/.llm4ts/epics/b/brief.md"), b)
      assert.strictEqual(yield* seat.calls, 0)
    })
  )

  it.effect("with no brief at all, every program is there and unclaimed", () =>
    Effect.gen(function* () {
      const { files } = yield* setup([])
      const report = yield* coverageReport({
        files,
        targetDir: "/target",
        legacyRepo: "/legacy",
        specNames,
        dirs: [],
        epics: []
      })
      const text = (yield* files.read(report.path)) ?? ""
      assert.include(text, "no epic brief yet")
      assert.include(text, "| CONTO_MOVIMENTI | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0% |")
      assert.include(text, "| CONTO_SALDO | 2 | 0 | 0 | 0 | 0 | 0 | 2 | 0 | 0% |")
    })
  )

  it.effect("an epic's recorded progress becomes the delivery state of what it owns", () =>
    Effect.gen(function* () {
      const { files } = yield* setup([])
      yield* files.writeAtomic(
        "/target/.llm4ts/epics/a/brief.md",
        owned("a", {
          scope: [ScopeItem.make({ title: "Amount filter", citations: [Citation.make(amount)] })]
        })
      )
      const epics = [
        {
          dir: "a",
          stateDir: "/target/.llm4ts/epics/a",
          epicId: "a",
          epic: "a",
          stories: 3,
          merged: 3,
          landed: "main",
          rounds: []
        }
      ]
      assert.deepStrictEqual(epicProgressOf(epics), [
        { epicId: "a", planned: true, stories: 3, merged: 3, landed: true }
      ])
      const report = yield* coverageReport({
        files,
        targetDir: "/target",
        legacyRepo: "/legacy",
        specNames,
        dirs: ["a"],
        epics
      })
      assert.include(report.headline, "1 accounted for (20%) · 1 delivered")
      assert.include((yield* files.read(report.path)) ?? "", "- a — approved, landed")
    })
  )

  it.effect("--coverage is a flag of the flow, and the entry runs the report", () =>
    Effect.gen(function* () {
      assert.isTrue((yield* parseEpicDesignArgs(["--coverage"])).coverage)
      const entry = readFileSync(join(fixtures, "..", "..", "epic-design.ts"), "utf8")
      assert.include(entry, "--coverage")
      assert.include(entry, "coverageReport(")
      // The entry loads the other briefs and hands them to designEpic.
      assert.include(entry, "loadBriefs(")
      assert.include(entry, "others: loaded.briefs")
    })
  )
})

describe("review findings: the ledger during design", () => {
  it.effect("briefs that could not be used are named in the outcome, not dropped quietly", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      for (const file of packFiles) {
        yield* memory.store.writeAtomic(`/${file}`, readFileSync(join(fixtures, file), "utf8"))
      }
      const events = yield* makeCollectingFlowEvents
      const seat = yield* scripted([selection, { ...good, openPoints: [] }])
      const elsewhere: LedgerBrief = {
        epicId: "carte",
        brief: EpicBrief.make({
          epicId: "carte",
          status: "approved",
          request: "Cards",
          legacy: "/another/cards-core",
          goal: "",
          programs: [],
          scope: [],
          dropped: [],
          provided: [],
          deferred: [],
          constraints: "",
          openPoints: [],
          feedback: ""
        })
      }
      const outcome = yield* designEpic({
        files: memory.store,
        reasoning: seat.service,
        events,
        targetDir: "/target",
        legacyRepo: "/legacy",
        specNames,
        epicId,
        request: "Current account",
        budget: 50_000,
        guidance: "",
        packNote: undefined,
        pathExists: (absolute) =>
          Effect.map(memory.store.read(absolute), (text) => text !== undefined),
        others: [elsewhere],
        unreadable: [{ dir: "bonifici", reason: "line 2: Status is `draft` or `approved`" }]
      })
      assert.deepStrictEqual(outcome.warnings, [
        "brief 'bonifici' could not be read (line 2: Status is `draft` or `approved`): nothing is inherited from it",
        "brief 'carte' was designed against another legacy repository: nothing is inherited from it"
      ])
      assert.include(
        renderOutcome(outcome, epicId).join("\n"),
        "brief 'bonifici' could not be read"
      )
    })
  )

  it.effect("a prompt with nothing left open says so", () =>
    Effect.gen(function* () {
      const { files } = yield* setup([])
      const pack = yield* readPackIndex({ files, legacyRepo: "/legacy", specNames })
      const prompt = proposePrompt({
        request: "r",
        programs: [{ name: "CONTO_SALDO", reason: "" }],
        pack,
        budget: 10_000,
        guidance: "",
        packNote: undefined,
        inherited: [
          {
            program: "CONTO_SALDO",
            scenario: "Show the available balance",
            epic: "saldo",
            disposition: "in-scope",
            note: ""
          },
          {
            program: "CONTO_SALDO",
            scenario: "Session timeout warning",
            epic: "saldo",
            disposition: "provided",
            note: "src/kit/session/SessionGuard.tsx"
          }
        ]
      })
      assert.include(prompt, "(none: every scenario of these programs is already decided")
    })
  )

  it("the entry resolves the legacy path and passes on the briefs it could not read", () => {
    const entry = readFileSync(join(fixtures, "..", "..", "epic-design.ts"), "utf8")
    assert.include(entry, "resolve(")
    assert.match(entry, /\n\s+unreadable: /)
  })
})
