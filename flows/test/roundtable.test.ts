import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeFakeJudgment } from "@llm4ts/core/judgment/FakeJudgment"
import {
  Info,
  RoundtableTurn,
  StageCompleted,
  StageStarted,
  makeCollectingFlowEvents
} from "@llm4ts/flow/FlowEvents"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { OpenPoint } from "@llm4ts/flow/Decisions"
import {
  chairSpeaker,
  decodeTurns,
  defaultCaps,
  Meeting,
  nextAction,
  ownerSpeaker,
  parseMeeting,
  renderMeeting
} from "@llm4ts/flow/Roundtable"
import {
  ejectPersonas,
  meetingDir,
  meetingSlug,
  parseRoundtableArgs,
  resolvePersonas,
  runRoundtable,
  type RoundtableDeps
} from "../lib/roundtable.ts"
import { bundledPersonaCards } from "../lib/roundtable-personas.ts"
import { scripted } from "./support.ts"

const workDir = "/repo"
const dir = meetingDir(workDir, "payments")

const agenda = { items: [{ title: "Scope", question: "Which rails first?" }] }
const say = (
  kind: string,
  body: string,
  extra: {
    answers?: ReadonlyArray<number>
    blocking?: boolean
    needsHuman?: boolean
    assumption?: string
  } = {}
) => ({
  kind,
  answers: extra.answers ?? [],
  blocking: extra.blocking ?? false,
  needsHuman: extra.needsHuman ?? false,
  ...(extra.assumption === undefined ? {} : { assumption: extra.assumption }),
  body
})
const draft = (outline: string, plan: string) => ({ outline, plan })

const setup = (options: { noPause?: boolean; truth?: number } = {}) =>
  Effect.gen(function* () {
    const memory = yield* makeMemoryPlainFileStore()
    const files = memory.store
    const events = yield* makeCollectingFlowEvents
    const fake = yield* makeFakeJudgment({ defaultTruth: options.truth ?? 0.9 })
    const personas = yield* resolvePersonas({}, ["PO", "SRE"])
    const run = (replies: ReadonlyArray<unknown>, overrides: Partial<RoundtableDeps> = {}) =>
      Effect.gen(function* () {
        const seat = yield* scripted(replies)
        const outcome = yield* runRoundtable({
          files,
          events,
          seat: seat.service,
          judgment: fake.judgment,
          workDir,
          meetingId: "payments",
          topic: "Payments hub",
          goal: "An approved outline.",
          attendees: personas.attendees,
          scribe: personas.scribe,
          context: [{ path: "standards/api.md", text: "Every API is versioned." }],
          caps: defaultCaps,
          noPause: options.noPause ?? true,
          budget: 50_000,
          ...overrides
        })
        return { outcome, calls: yield* seat.calls, prompts: yield* seat.prompts }
      })
    const read = (name: string) => Effect.map(files.read(`${dir}/${name}`), (text) => text ?? "")
    const meeting = Effect.flatMap(read("meeting.md"), (text) => parseMeeting(text))
    const turns = Effect.flatMap(read("turns.jsonl"), (text) => decodeTurns(text))
    const infos = Effect.map(events.recorded, (all) =>
      all.flatMap((event) => (event instanceof Info ? [event.message] : []))
    )
    return {
      files,
      run,
      read,
      meeting,
      turns,
      infos,
      events: events.recorded,
      judged: fake.recorded
    }
  })

describe("a roundtable from agenda to done", () => {
  it.effect(
    "the whole meeting: agenda, rounds, a judged stalemate, the drafts, the review, the fix",
    () =>
      Effect.gen(function* () {
        const room = yield* setup()
        const first = yield* room.run([
          agenda,
          say("proposal", "Cards first."), // #1 PO, item 1 round 1
          say("objection", "No fraud story.", { answers: [1], blocking: true }), // #2 SRE
          say("position", "Fraud checks run in the issuer; we only forward.", { answers: [2] }), // #3 PO, round 2
          say("pass", ""), // #4 SRE: does not close → judged → #5 Chair
          say("position", "Cards first reaches the goal."), // #6 PO, goal check
          say("agreement", "Agreed.", { answers: [6] }), // #7 SRE → settled → draft
          draft("# Outline\n\nCards first.", "# Plan\n\nPhase 1: cards."),
          say("agreement", "Reads right."), // #8 PO review
          say("objection", "No rollback section.", { blocking: true }), // #9 SRE review → fix pass
          draft(
            "# Outline\n\nCards first.\n\n## Rollback\n\nFeature flag.",
            "# Plan\n\nPhase 1: cards."
          )
        ])
        assert.strictEqual(first.calls, 11)
        assert.strictEqual(first.outcome._tag, "Finished")
        const meeting = yield* room.meeting
        assert.strictEqual(meeting.status, "done")
        assert.strictEqual(meeting.drafts, 1)
        assert.deepStrictEqual(
          meeting.agenda.map((item) => item.title),
          ["Scope"]
        )
        const turns = yield* room.turns
        assert.strictEqual(turns.length, 9)
        assert.deepStrictEqual(
          turns.map((turn) => [turn.id, turn.item, turn.round, turn.speaker, turn.kind]),
          [
            [1, 1, 1, "PO", "proposal"],
            [2, 1, 1, "SRE", "objection"],
            [3, 1, 2, "PO", "position"],
            [4, 1, 2, "SRE", "pass"],
            [5, 1, 2, chairSpeaker, "agreement"],
            [6, 2, 1, "PO", "position"],
            [7, 2, 1, "SRE", "agreement"],
            [8, 3, 1, "PO", "agreement"],
            [9, 3, 1, "SRE", "objection"]
          ]
        )
        assert.deepStrictEqual(turns[4]?.answers, [2])
        assert.strictEqual((yield* room.judged).length, 1)
        assert.match(yield* room.read("outline.md"), /## Rollback/)
        assert.match(yield* room.read("plan.md"), /Phase 1/)
        assert.match(yield* room.read("decisions.md"), /## 1\. Cards first\./)
        assert.match(yield* room.read("discussion.md"), /Settled\./)
        assert.match(yield* room.read("open-questions.md"), /Every item settled\./)
        // The SRE's second-round prompt names the objection aimed at nobody but the reply it got.
        assert.match(first.prompts[3] ?? "", /Every API is versioned/)
        assert.match(first.prompts[4] ?? "", /#3/)
        assert.match(first.prompts[10] ?? "", /No rollback section/)
        // The room is visible: one typed event per turn, a lane per attendee, an item per stage.
        const recorded = yield* room.events
        const spoken = recorded.flatMap((event) => (event instanceof RoundtableTurn ? [event] : []))
        assert.strictEqual(spoken.length, 9)
        assert.deepStrictEqual(
          spoken[0],
          RoundtableTurn.make({
            lane: "PO",
            meeting: "payments",
            item: 1,
            itemTitle: "Scope",
            round: 1,
            turn: 1,
            kind: "proposal",
            blocking: false,
            answers: [],
            summary: "Cards first."
          })
        )
        assert.deepStrictEqual(
          [spoken[4]?.lane, spoken[4]?.kind, spoken[4]?.answers],
          [chairSpeaker, "agreement", [2]]
        )
        assert.strictEqual(spoken[8]?.itemTitle, "Review of the drafts")
        const started = recorded.flatMap((event) =>
          event instanceof StageStarted ? [event.stage] : []
        )
        assert.deepStrictEqual(started, [
          "attendee PO",
          "attendee SRE",
          "item 1: Scope",
          "item 2: Goal check",
          "item 3: Review of the drafts"
        ])
        const completed = recorded.flatMap((event) =>
          event instanceof StageCompleted ? [event.stage] : []
        )
        assert.deepStrictEqual(completed, [
          "item 1: Scope",
          "item 2: Goal check",
          "item 3: Review of the drafts",
          "attendee PO",
          "attendee SRE"
        ])
        // A rerun with nothing new asks nobody anything.
        const again = yield* room.run([])
        assert.strictEqual(again.calls, 0)
        assert.strictEqual(again.outcome._tag, "NothingToDo")
      })
  )

  it.effect("feedback after done becomes an Owner turn, a redraft and a fresh review round", () =>
    Effect.gen(function* () {
      const room = yield* setup()
      yield* room.run([
        agenda,
        say("proposal", "Cards first."),
        say("agreement", "Yes.", { answers: [1] }),
        say("position", "Reaches the goal."),
        say("agreement", "Yes.", { answers: [3] }),
        draft("# Outline", "# Plan"),
        say("agreement", "Fine."),
        say("agreement", "Fine.")
      ])
      const done = yield* room.meeting
      yield* room.files.writeAtomic(
        `${dir}/meeting.md`,
        renderMeeting(Meeting.make({ ...done, feedback: "Mention the sandbox." }))
      )
      const second = yield* room.run([
        draft("# Outline\n\nSandbox: yes.", "# Plan"),
        say("agreement", "Better."),
        say("agreement", "Better.")
      ])
      assert.strictEqual(second.calls, 3)
      assert.strictEqual(second.outcome._tag, "Finished")
      const meeting = yield* room.meeting
      assert.strictEqual(meeting.status, "done")
      assert.strictEqual(meeting.drafts, 2)
      assert.strictEqual(meeting.feedback, "")
      const turns = yield* room.turns
      assert.strictEqual(turns.length, 9)
      assert.deepStrictEqual(
        [turns[6]?.speaker, turns[6]?.item, turns[6]?.round],
        [ownerSpeaker, 3, 2]
      )
      assert.match(yield* room.read("outline.md"), /Sandbox/)
      assert.match(second.prompts[0] ?? "", /Mention the sandbox/)
    })
  )

  it.effect("a question for the owner is parked in the meeting file and the run goes on", () =>
    Effect.gen(function* () {
      const room = yield* setup()
      const result = yield* room.run([
        agenda,
        say("question", "Is the latency budget contractual?", {
          needsHuman: true,
          assumption: "it is"
        }),
        say("pass", ""),
        say("position", "Reaches the goal."),
        say("pass", ""),
        draft("# Outline", "# Plan"),
        say("pass", ""),
        say("pass", "")
      ])
      assert.strictEqual(result.outcome._tag, "Finished")
      const meeting = yield* room.meeting
      assert.deepStrictEqual(
        meeting.answers.map((point) => [point.number, point.answer]),
        [[1, undefined]]
      )
      assert.match(meeting.answers[0]?.question ?? "", /latency budget contractual\? \(PO\)/)
      assert.match(yield* room.read("open-questions.md"), /#1 PO, item 1/)
      // Answering it reopens the item for one more round, then redrafts.
      yield* room.files.writeAtomic(
        `${dir}/meeting.md`,
        renderMeeting(
          Meeting.make({
            ...meeting,
            answers: [
              OpenPoint.make({
                number: 1,
                question: meeting.answers[0]?.question ?? "",
                answer: "Yes, contractual."
              })
            ]
          })
        )
      )
      const third = yield* room.run([
        say("position", "Then 200ms it is."),
        say("pass", ""),
        draft("# Outline\n\n200ms.", "# Plan"),
        say("pass", ""),
        say("pass", "")
      ])
      assert.strictEqual(third.outcome._tag, "Finished")
      const turns = yield* room.turns
      assert.strictEqual(turns[6]?.speaker, ownerSpeaker)
      assert.deepStrictEqual(turns[6]?.answers, [1])
      assert.match(third.prompts[0] ?? "", /Yes, contractual/)
      assert.strictEqual((yield* room.meeting).drafts, 2)
    })
  )

  it.effect("without --no-pause the run stops after proposing the agenda", () =>
    Effect.gen(function* () {
      const room = yield* setup({ noPause: false })
      const error = yield* Effect.flip(room.run([agenda]))
      assert.strictEqual(error._tag, "AgendaPending")
      const meeting = yield* room.meeting
      assert.strictEqual(meeting.status, "agenda-proposed")
      assert.deepStrictEqual(nextAction(meeting, [], defaultCaps), { _tag: "OpenDiscussion" })
      assert.ok((yield* room.infos).some((line) => /agenda/.test(line)))
    })
  )

  it.effect("a meeting needs a goal the first time", () =>
    Effect.gen(function* () {
      const room = yield* setup()
      const error = yield* Effect.flip(room.run([], { goal: undefined }))
      assert.strictEqual(error._tag, "ScriptUsage")
    })
  )
})

describe("flags, personas and ejecting", () => {
  it.effect("parses its own flags and leaves the rest to the runner", () =>
    Effect.gen(function* () {
      const flags = yield* parseRoundtableArgs([
        "--repo",
        ".",
        "Payments hub",
        "--goal",
        "An outline",
        "--agents",
        "PO, SRE",
        "--meeting=payments",
        "--context",
        "docs/standards",
        "--rounds",
        "2",
        "--max-turns=10",
        "--no-pause",
        "--eject-personas",
        "--list"
      ])
      assert.deepStrictEqual(flags, {
        goal: "An outline",
        agents: ["PO", "SRE"],
        meeting: "payments",
        context: "docs/standards",
        rounds: 2,
        maxTurns: 10,
        noPause: true,
        ejectPersonas: true,
        list: true,
        rest: ["--repo", ".", "Payments hub"]
      })
      const bad = yield* Effect.flip(parseRoundtableArgs(["--rounds", "many"]))
      assert.strictEqual(bad._tag, "ScriptUsage")
    })
  )

  it("a meeting id is the topic as a slug", () => {
    assert.strictEqual(
      meetingSlug("Architecture outline: the Payments Hub (v2)!"),
      "architecture-outline-the-payments-hub-v2"
    )
    assert.strictEqual(meetingSlug("   "), "meeting")
  })

  it.effect(
    "custom cards override bundled ones by name; an unknown attendee is a usage error",
    () =>
      Effect.gen(function* () {
        const custom = {
          SRE: bundledPersonaCards.SRE?.replace("asks for numbers", "asks for SLOs") ?? "",
          Scribe: bundledPersonaCards.Scribe?.replace("No meeting narration.", "Terse.") ?? ""
        }
        const resolved = yield* resolvePersonas(custom, ["SRE", "PO"])
        assert.deepStrictEqual(
          resolved.attendees.map((persona) => persona.name),
          ["PO", "SRE"]
        )
        assert.match(resolved.attendees[1]?.voice ?? "", /asks for SLOs/)
        assert.match(resolved.scribe.voice, /Terse\./)
        const error = yield* Effect.flip(resolvePersonas({}, ["PO", "CFO"]))
        assert.strictEqual(error._tag, "ScriptUsage")
        assert.match(error.message, /CFO/)
      })
  )

  it.effect("ejecting writes every bundled card once and never overwrites", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore({ "/repo/.llm4ts/personas/SRE.md": "mine" })
      const written = yield* ejectPersonas(memory.store, "/repo")
      assert.strictEqual(written.length, Object.keys(bundledPersonaCards).length - 1)
      assert.strictEqual(yield* memory.store.read("/repo/.llm4ts/personas/SRE.md"), "mine")
      assert.strictEqual(
        yield* memory.store.read("/repo/.llm4ts/personas/PO.md"),
        bundledPersonaCards.PO
      )
      assert.deepStrictEqual(yield* ejectPersonas(memory.store, "/repo"), [])
    })
  )
})
