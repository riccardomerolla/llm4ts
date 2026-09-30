import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { parseEpicBrief, renderEpicBrief, EpicBrief } from "@llm4ts/flow/EpicBrief"
import { OpenPoint } from "@llm4ts/flow/Decisions"
import { EpicBriefInvalid, ExtractPackMissing, OpenPointsPending } from "@llm4ts/flow/FlowError"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import { makeMemoryPlainFileStore, type PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import {
  briefPath,
  designEpic,
  parseEpicDesignArgs,
  readPackIndex,
  renderOutcome
} from "../lib/epic-design.ts"
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

const setup = (replies: ReadonlyArray<unknown>, names: ReadonlyArray<string> = specNames) =>
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
        pathExists: (absolute) => Effect.map(files.read(absolute), (text) => text !== undefined)
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
        const { run, files, brief, edit } = yield* setup([selection, good, good, good])
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
              OpenPoint.make({ ...point, answer: "kept: the business asked for it again" })
            )
          })
        )
        const second = yield* run()
        assert.deepStrictEqual(second.problems, [])
        const kept = (yield* brief).openPoints.find((point) => point.question.startsWith("[check]"))
        assert.strictEqual(kept?.answer, "kept: the business asked for it again")
      })
  )
})

describe("epic-design arguments", () => {
  it.effect("parses --list and --epic, leaving the request as the rest", () =>
    Effect.gen(function* () {
      const plain = yield* parseEpicDesignArgs(["Current account"])
      assert.deepStrictEqual(plain, { list: false, epic: undefined, rest: ["Current account"] })
      const resumed = yield* parseEpicDesignArgs(["--epic", "conto-corrente"])
      assert.strictEqual(resumed.epic, "conto-corrente")
      assert.isTrue((yield* parseEpicDesignArgs(["--list"])).list)
      const error = yield* Effect.flip(parseEpicDesignArgs(["--epic"]))
      assert.include(error.message, "--epic needs an epic id")
    })
  )
})
