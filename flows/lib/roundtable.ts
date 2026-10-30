/**
 * roundtable (ADR 0046): the flow half of the meeting. The protocol — what
 * settles an item, who speaks next, when to judge, draft and finish — is
 * `@llm4ts/flow/Roundtable`; this module reads and writes the meeting's
 * files, builds the prompts, drives one read-only seat and the judgment
 * service, and reports to the person.
 */
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { JudgmentShape } from "@llm4ts/core/judgment/Judgment"
import { truthOf } from "@llm4ts/core/judgment/Judgment"
import { truth } from "@llm4ts/core/judgment/Schemas"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { JsonSchema } from "@llm4ts/core/Models"
import { cap } from "@llm4ts/flow/Context"
import { Info, type FlowEventsShape } from "@llm4ts/flow/FlowEvents"
import { AgendaPending, FlowAborted, type FlowError } from "@llm4ts/flow/FlowError"
import { decide, judgeOrEscalate } from "@llm4ts/flow/Judgment"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import {
  AgendaProposal,
  agendaProposalJsonSchema,
  assembleAgenda,
  assembleTurn,
  briefingFor,
  chairSpeaker,
  closingItem,
  decodeTurns,
  encodeTurn,
  itemState,
  maxAgendaItems,
  Meeting,
  minAgendaItems,
  nextAction,
  parseMeeting,
  parsePersona,
  recordOwner,
  renderAgendaItem,
  renderDecisions,
  renderDiscussion,
  renderMeeting,
  renderOpenQuestions,
  renderTurn,
  reviewItem,
  syncAnswers,
  Turn,
  TurnProposal,
  turnProposalJsonSchema,
  type AgendaItem,
  type Caps,
  type ChairAction,
  type Persona
} from "@llm4ts/flow/Roundtable"
import { structuredAndPublish } from "@llm4ts/flow/Usage"
import { ScriptUsage } from "@llm4ts/runner/FlowArgs"
import { bundledPersonaCards, scribeName } from "./roundtable-personas.ts"

// ---- Flags ----------------------------------------------------------------------

export const roundtableUsage = [
  'usage: llm4ts run roundtable --repo <dir> "<topic>" -- --goal "<goal>" [--agents "PO,PM,..."] [--meeting <id>]',
  "                             [--context <dir>] [--rounds <n>] [--max-turns <n>] [--no-pause]",
  "       llm4ts run roundtable --repo <dir> -- --meeting <id>        # continue or finish a meeting",
  "       llm4ts run roundtable --repo <dir> -- --eject-personas      # write the bundled cards to .llm4ts/personas/",
  "       llm4ts run roundtable --repo <dir> -- --list                # the repository's meetings",
  "  --goal <text>      what the meeting must reach (required the first time)",
  "  --agents <names>   attendees by persona name, in any order; default: PO,PM,Sr SW Eng,Cloud Architect,DevOps,SRE",
  "  --meeting <id>     the meeting folder under .llm4ts/meetings/; default: a slug of the topic",
  "  --context <dir>    documents every attendee reads (standards, architecture notes)",
  "  --rounds <n>       complete rounds an item gets before it is left open (default 3)",
  "  --max-turns <n>    turns in the whole discussion before drafting starts (default 40)",
  "  --no-pause         do not stop after the agenda is proposed",
  "The meeting file is the state: .llm4ts/meetings/<id>/meeting.md. Answer the questions under",
  "'## Answers', write under '## Feedback', and rerun."
].join("\n")

export interface RoundtableArgs {
  readonly goal: string | undefined
  readonly agents: ReadonlyArray<string> | undefined
  readonly meeting: string | undefined
  readonly context: string | undefined
  readonly rounds: number | undefined
  readonly maxTurns: number | undefined
  readonly noPause: boolean
  readonly ejectPersonas: boolean
  readonly list: boolean
  readonly rest: ReadonlyArray<string>
}

export const parseRoundtableArgs = (
  argv: ReadonlyArray<string>
): Effect.Effect<RoundtableArgs, ScriptUsage> =>
  Effect.gen(function* () {
    let goal: string | undefined
    let agents: ReadonlyArray<string> | undefined
    let meeting: string | undefined
    let context: string | undefined
    let rounds: number | undefined
    let maxTurns: number | undefined
    let noPause = false
    let ejectPersonas = false
    let list = false
    const rest: Array<string> = []
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index] ?? ""
      const is = (name: string): boolean => argument === name || argument.startsWith(`${name}=`)
      const valued = (name: string): Effect.Effect<string, ScriptUsage> => {
        const value = argument.includes("=") ? argument.slice(name.length + 1) : argv[index + 1]
        if (!argument.includes("=")) index += 1
        return value === undefined || value.trim().length === 0 || value.startsWith("--")
          ? ScriptUsage.make({ message: `${name} needs a value\n${roundtableUsage}` })
          : Effect.succeed(value.trim())
      }
      const counted = (name: string): Effect.Effect<number, ScriptUsage> =>
        Effect.flatMap(valued(name), (value) =>
          /^\d+$/.test(value) && Number.parseInt(value, 10) > 0
            ? Effect.succeed(Number.parseInt(value, 10))
            : ScriptUsage.make({ message: `${name} needs a positive number, got: ${value}` })
        )
      if (is("--goal")) goal = yield* valued("--goal")
      else if (is("--agents"))
        agents = (yield* valued("--agents"))
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
      else if (is("--meeting")) meeting = yield* valued("--meeting")
      else if (is("--context")) context = yield* valued("--context")
      else if (is("--rounds")) rounds = yield* counted("--rounds")
      else if (is("--max-turns")) maxTurns = yield* counted("--max-turns")
      else if (argument === "--no-pause") noPause = true
      else if (argument === "--eject-personas") ejectPersonas = true
      else if (argument === "--list") list = true
      else rest.push(argument)
    }
    return { goal, agents, meeting, context, rounds, maxTurns, noPause, ejectPersonas, list, rest }
  })

// ---- Places -------------------------------------------------------------------

export const meetingsDir = (workDir: string): string => join(workDir, ".llm4ts", "meetings")
export const meetingDir = (workDir: string, id: string): string => join(meetingsDir(workDir), id)
export const personasDir = (workDir: string): string => join(workDir, ".llm4ts", "personas")

/** The folder name a topic gets: lower case, words joined by dashes, at most 60 characters. */
export const meetingSlug = (topic: string): string => {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "")
  return slug.length === 0 ? "meeting" : slug
}

const meetingFiles = (dir: string) => ({
  meeting: join(dir, "meeting.md"),
  turns: join(dir, "turns.jsonl"),
  discussion: join(dir, "discussion.md"),
  outline: join(dir, "outline.md"),
  plan: join(dir, "plan.md"),
  decisions: join(dir, "decisions.md"),
  openQuestions: join(dir, "open-questions.md")
})

// ---- Personas -----------------------------------------------------------------

export interface ResolvedPersonas {
  /** In speaking order. */
  readonly attendees: ReadonlyArray<Persona>
  readonly scribe: Persona
}

/**
 * The cards the meeting uses: bundled ones, each replaced by a custom card
 * of the same name (`.llm4ts/personas/<name>.md`, read by the caller).
 * Attendees are named; the Scribe is always present.
 */
export const resolvePersonas = Effect.fn("roundtable.resolvePersonas")(function* (
  custom: Readonly<Record<string, string>>,
  attendees: ReadonlyArray<string>
): Effect.fn.Return<ResolvedPersonas, FlowError | ScriptUsage> {
  const cards: Record<string, string> = { ...bundledPersonaCards, ...custom }
  const personas = new Map<string, Persona>()
  for (const [name, text] of Object.entries(cards)) {
    const persona = yield* parsePersona(name, text)
    personas.set(name, persona)
  }
  const known = [...personas.keys()].filter((name) => name !== scribeName)
  const missing = attendees.filter((name) => !personas.has(name) || name === scribeName)
  if (missing.length > 0) {
    return yield* ScriptUsage.make({
      message: `unknown persona(s): ${missing.join(", ")}; known: ${known.join(", ")} — add a card under .llm4ts/personas/<name>.md`
    })
  }
  if (attendees.length === 0) {
    return yield* ScriptUsage.make({ message: `--agents names at least one persona` })
  }
  const scribe = personas.get(scribeName)
  if (scribe === undefined) {
    return yield* ScriptUsage.make({ message: `no ${scribeName} card` })
  }
  const chosen = [...new Set(attendees)]
    .flatMap((name) => {
      const persona = personas.get(name)
      return persona === undefined ? [] : [persona]
    })
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
  return { attendees: chosen, scribe }
})

/** Writes every bundled card the folder lacks; returns the paths written. */
export const ejectPersonas = Effect.fn("roundtable.ejectPersonas")(function* (
  files: PlainFileStoreShape,
  workDir: string
): Effect.fn.Return<ReadonlyArray<string>, FlowError> {
  const written: Array<string> = []
  for (const [name, text] of Object.entries(bundledPersonaCards)) {
    const path = join(personasDir(workDir), `${name}.md`)
    const existing = yield* files.read(path)
    if (existing !== undefined) continue
    yield* files.writeAtomic(path, text)
    written.push(path)
  }
  return written
})

// ---- The Scribe's output ------------------------------------------------------

export class DraftProposal extends Schema.Class<DraftProposal>("DraftProposal")({
  outline: Schema.String,
  plan: Schema.String
}) {}

export const draftProposalJsonSchema: JsonSchema = {
  type: "object",
  properties: { outline: { type: "string" }, plan: { type: "string" } },
  required: ["outline", "plan"]
}

// ---- Prompts ------------------------------------------------------------------

export interface ContextDoc {
  readonly path: string
  readonly text: string
}

const personaBrief = (persona: Persona): string =>
  [
    `You are the ${persona.name} in a roundtable of specialists.`,
    "",
    `Mandate: ${persona.mandate}`,
    ...(persona.caresAbout.length === 0 ? [] : [`You care about: ${persona.caresAbout}`]),
    ...(persona.pushesBackOn.length === 0 ? [] : [`You push back on: ${persona.pushesBackOn}`]),
    ...(persona.neverDecidesAlone.length === 0
      ? []
      : [`You never decide alone: ${persona.neverDecidesAlone}`]),
    ...(persona.voice.length === 0 ? [] : [`Voice: ${persona.voice}`])
  ].join("\n")

const meetingBrief = (meeting: Meeting): string =>
  [
    `Topic: ${meeting.topic}`,
    `Goal: ${meeting.goal}`,
    `Attendees: ${meeting.attendees.join(", ")}`
  ].join("\n")

const contextBrief = (docs: ReadonlyArray<ContextDoc>, budget: number): string => {
  if (docs.length === 0) return ""
  const each = Math.max(1_000, Math.floor(budget / 2 / docs.length))
  return [
    "",
    "Context documents (standards and notes the room works within):",
    ...docs.flatMap((doc) => ["", `--- ${doc.path} ---`, cap(doc.text, each).text])
  ].join("\n")
}

const agendaPrompt = (
  persona: Persona,
  meeting: Meeting,
  docs: ReadonlyArray<ContextDoc>,
  budget: number
): string =>
  [
    personaBrief(persona),
    "",
    meetingBrief(meeting),
    contextBrief(docs, budget),
    "",
    `Propose the agenda: between ${minAgendaItems} and ${maxAgendaItems} items, each a short title and the one question the room must settle under it. Order them problem first, then solution, then how it is delivered and run. Do not add a goal check: the chair closes the meeting with one.`,
    "",
    'Reply with JSON: {"items": [{"title": "...", "question": "..."}]}'
  ].join("\n")

const kindsGuide = [
  "Kinds of turn:",
  "- position: your view on the question, with reasons.",
  "- proposal: a concrete decision you want the room to take; write it so it can be recorded as is.",
  "- objection: against an earlier turn (name it in answers). blocking=true only when the goal cannot be reached unless it is addressed; otherwise it is recorded as dissent.",
  "- question: for the room, or for the owner (needsHuman=true) when only the person who called the meeting can answer; then state the assumption you proceed on.",
  "- agreement: you accept an earlier turn (name it in answers). Close your own blocking objection this way when it has been answered.",
  "- pass: nothing to add this round."
].join("\n")

const turnPrompt = (options: {
  persona: Persona
  meeting: Meeting
  item: AgendaItem
  round: number
  caps: Caps
  turns: ReadonlyArray<Turn>
  addressed: ReadonlyArray<Turn>
  docs: ReadonlyArray<ContextDoc>
  budget: number
}): string => {
  const { persona, meeting, item, round, caps, turns, addressed, docs, budget } = options
  const briefing = briefingFor(meeting, turns, item.number, caps)
  const isReview = item.number === reviewItem(meeting).number
  return [
    personaBrief(persona),
    "",
    meetingBrief(meeting),
    contextBrief(docs, budget),
    "",
    "Decisions so far:",
    ...(briefing.decisions.length === 0
      ? ["- none yet"]
      : briefing.decisions.map(
          (decision) =>
            `- item ${decision.item.number} (${decision.item.title}): ${decision.proposal.body} — proposed by ${decision.proposal.speaker}${decision.dissent.length === 0 ? "" : `; dissent from ${decision.dissent.map((turn) => turn.speaker).join(", ")}`}`
        )),
    "",
    "Questions parked for the owner (proceed on the stated assumption):",
    ...(briefing.parked.length === 0
      ? ["- none"]
      : briefing.parked.map(
          (turn) =>
            `- #${turn.id} ${turn.speaker}: ${turn.body}${turn.assumption === undefined ? "" : ` (assuming: ${turn.assumption})`}`
        )),
    "",
    `Agenda item ${renderAgendaItem(item)}`,
    `Round ${round} of at most ${caps.roundsPerItem}.`,
    ...(isReview
      ? [
          "",
          "The Scribe has written outline.md and plan.md from the discussion. Review them from your mandate: object (blocking only for what makes them wrong or unusable), agree, or pass."
        ]
      : []),
    "",
    "The discussion on this item so far:",
    ...(briefing.current.length === 0
      ? ["(nobody has spoken yet)"]
      : briefing.current.map(renderTurn)),
    "",
    ...(addressed.length === 0
      ? []
      : ["Aimed at your earlier turns, still open:", ...addressed.map(renderTurn), ""]),
    kindsGuide,
    "",
    `Speak as the ${persona.name}, in your voice, once. Answer turns by their #id on this item only. Keep the body to a short paragraph.`,
    "",
    'Reply with JSON: {"kind": "position|proposal|objection|question|agreement|pass", "answers": [ids], "blocking": false, "needsHuman": false, "assumption": "optional", "body": "..."}'
  ].join("\n")
}

const draftPrompt = (options: {
  scribe: Persona
  meeting: Meeting
  discussion: string
  decisions: string
  openQuestions: string
  docs: ReadonlyArray<ContextDoc>
  budget: number
  previous?: { outline: string; plan: string; objections: ReadonlyArray<Turn> }
}): string => {
  const { scribe, meeting, docs, budget, previous } = options
  return [
    personaBrief(scribe),
    "",
    meetingBrief(meeting),
    contextBrief(docs, budget),
    "",
    previous === undefined
      ? "Write the two deliverables from the transcript below. Say what the room settled; keep every decision's dissent visible; where a question is parked for the owner, state the assumption the document rests on. Do not invent decisions the room did not take."
      : "Revise the two deliverables below so that every blocking objection from the review is addressed. Change nothing the objections do not touch.",
    "",
    ...(previous === undefined
      ? []
      : [
          "Blocking objections from the review:",
          ...previous.objections.map(renderTurn),
          "",
          "Current outline.md:",
          cap(previous.outline, Math.floor(budget / 6)).text,
          "",
          "Current plan.md:",
          cap(previous.plan, Math.floor(budget / 6)).text,
          ""
        ]),
    "Decisions (as recorded):",
    cap(options.decisions, Math.floor(budget / 6)).text,
    "",
    "Open questions (as recorded):",
    cap(options.openQuestions, Math.floor(budget / 8)).text,
    "",
    "Transcript:",
    cap(options.discussion, Math.floor(budget / 2)).text,
    "",
    "Outline sections:",
    scribe.outlineTemplate ??
      "## Context\n## Proposed solution\n## Risks\n## Open questions and assumptions",
    "",
    "Plan sections:",
    scribe.planTemplate ?? "## Phases\n## Workstreams and owners\n## Risks and mitigations",
    "",
    'Reply with JSON: {"outline": "<complete markdown document>", "plan": "<complete markdown document>"}'
  ].join("\n")
}

// ---- The run ------------------------------------------------------------------

export interface RoundtableDeps {
  readonly files: PlainFileStoreShape
  readonly events: FlowEventsShape
  /** The read-only reasoning seat every persona borrows. */
  readonly seat: LlmServiceShape
  readonly judgment: JudgmentShape
  readonly workDir: string
  readonly meetingId: string
  /** The topic and goal, used only when the meeting file does not exist yet. */
  readonly topic: string | undefined
  readonly goal: string | undefined
  readonly attendees: ReadonlyArray<Persona>
  readonly scribe: Persona
  readonly context: ReadonlyArray<ContextDoc>
  readonly caps: Caps
  readonly noPause: boolean
  readonly budget: number
}

export type RoundtableOutcome =
  | { readonly _tag: "NothingToDo"; readonly message: string }
  | { readonly _tag: "Finished"; readonly summary: ReadonlyArray<string> }

/** The meeting, driven from its files until it halts for the person or is done. */
export const runRoundtable = Effect.fn("roundtable.run")(function* (
  deps: RoundtableDeps
): Effect.fn.Return<RoundtableOutcome, FlowError | ScriptUsage> {
  const { files, events, caps } = deps
  const dir = meetingDir(deps.workDir, deps.meetingId)
  const paths = meetingFiles(dir)
  const say = (message: string) => events.publish(Info.make({ message }))
  const save = (meeting: Meeting) => files.writeAtomic(paths.meeting, renderMeeting(meeting))

  const loaded = yield* loadMeeting(files, paths.meeting)
  let meeting: Meeting
  if (loaded === undefined) {
    const topic = (deps.topic ?? "").trim()
    const goal = (deps.goal ?? "").trim()
    if (topic.length === 0 || goal.length === 0) {
      return yield* ScriptUsage.make({
        message: `no meeting at ${paths.meeting}: give the topic and --goal to start one\n${roundtableUsage}`
      })
    }
    meeting = Meeting.make({
      id: deps.meetingId,
      status: "agenda-proposed",
      topic,
      goal,
      attendees: deps.attendees.map((persona) => persona.name),
      agenda: [],
      answers: [],
      feedback: "",
      drafts: 0
    })
    yield* save(meeting)
    yield* say(`roundtable: ${paths.meeting} opened — ${meeting.attendees.join(", ")}`)
  } else {
    meeting = loaded
  }
  const personaOf = (name: string): Persona | undefined =>
    deps.attendees.find((persona) => persona.name === name)
  for (const name of meeting.attendees) {
    if (personaOf(name) === undefined) {
      return yield* ScriptUsage.make({
        message: `the meeting lists attendee ${name} but no such persona is known; pass --agents with the meeting's attendees, or add .llm4ts/personas/${name}.md`
      })
    }
  }
  let turns: ReadonlyArray<Turn> = yield* decodeTurns(
    (yield* files.read(paths.turns)) ?? "",
    paths.turns
  )

  const appendTurn = (turn: Turn) =>
    Effect.gen(function* () {
      yield* files.append(paths.turns, `${encodeTurn(turn)}\n`)
      turns = [...turns, turn]
      yield* files.writeAtomic(paths.discussion, renderDiscussion(meeting, turns, caps))
      const synced = syncAnswers(meeting, turns)
      if (synced.answers.length !== meeting.answers.length) {
        meeting = synced
        yield* save(meeting)
      }
    })
  const writeRecords = () =>
    Effect.gen(function* () {
      yield* files.writeAtomic(paths.decisions, renderDecisions(meeting, turns, caps))
      yield* files.writeAtomic(paths.openQuestions, renderOpenQuestions(meeting, turns, caps))
    })
  const askScribe = (previous?: {
    outline: string
    plan: string
    objections: ReadonlyArray<Turn>
  }) =>
    Effect.gen(function* () {
      const proposal = yield* structuredAndPublish(
        deps.seat,
        events,
        draftPrompt({
          scribe: deps.scribe,
          meeting,
          discussion: renderDiscussion(meeting, turns, caps),
          decisions: renderDecisions(meeting, turns, caps),
          openQuestions: renderOpenQuestions(meeting, turns, caps),
          docs: deps.context,
          budget: deps.budget,
          ...(previous === undefined ? {} : { previous })
        }),
        DraftProposal,
        draftProposalJsonSchema,
        "scribe"
      )
      yield* files.writeAtomic(paths.outline, `${proposal.outline.trim()}\n`)
      yield* files.writeAtomic(paths.plan, `${proposal.plan.trim()}\n`)
    })

  let guard = 0
  for (;;) {
    guard += 1
    if (guard > caps.maxTurns * 4 + 64) {
      return yield* FlowAborted.make({
        message: `roundtable ${deps.meetingId}: the chair did not reach an end after ${guard} steps; the files under ${dir} are intact`
      })
    }
    const action: ChairAction = nextAction(meeting, turns, caps)
    switch (action._tag) {
      case "Refused":
        return yield* ScriptUsage.make({
          message: `roundtable ${deps.meetingId}: ${action.reason}`
        })
      case "Done":
        return {
          _tag: "NothingToDo",
          message: `meeting ${deps.meetingId} is done; answer a question under '## Answers' or write '## Feedback' in ${paths.meeting} to reopen it`
        }
      case "ProposeAgenda": {
        const persona = personaOf(action.speaker) ?? deps.attendees[0]
        if (persona === undefined) {
          return yield* ScriptUsage.make({ message: "the meeting has no attendees" })
        }
        const proposal = yield* structuredAndPublish(
          deps.seat,
          events,
          agendaPrompt(persona, meeting, deps.context, deps.budget),
          AgendaProposal,
          agendaProposalJsonSchema,
          persona.name
        )
        const items = assembleAgenda(proposal)
        if (items.length === 0) {
          return yield* FlowAborted.make({
            message: `${persona.name} proposed no agenda item; rerun`
          })
        }
        meeting = Meeting.make({ ...meeting, agenda: items })
        yield* save(meeting)
        yield* say(
          `roundtable: ${persona.name} proposed ${items.length} agenda item(s):\n${items.map((item) => `  ${renderAgendaItem(item)}`).join("\n")}`
        )
        if (!deps.noPause) {
          return yield* AgendaPending.make({ path: paths.meeting, items: items.length })
        }
        continue
      }
      case "OpenDiscussion":
        meeting = Meeting.make({ ...meeting, status: "discussing" })
        yield* save(meeting)
        yield* say(
          `roundtable: discussing ${meeting.agenda.length} item(s) plus the goal check, ${meeting.attendees.length} attendees, up to ${caps.roundsPerItem} rounds each`
        )
        continue
      case "RecordOwner": {
        const recorded = recordOwner(meeting, turns, action)
        for (const turn of recorded) {
          yield* appendTurn(turn)
          yield* say(renderTurn(turn))
        }
        meeting = Meeting.make({ ...meeting, status: "discussing", feedback: "" })
        yield* save(meeting)
        continue
      }
      case "Judge": {
        const result = yield* judgeOrEscalate({
          judgment: deps.judgment,
          reasoning: deps.seat,
          events,
          request: {
            state: {
              question: action.item.question,
              objection: `${action.objection.speaker}: ${action.objection.body}`,
              reply: `${action.reply.speaker}: ${action.reply.body}`
            },
            questions: {
              resolved: truth(
                "The reply answers the objection well enough that a reasonable objector would withdraw it."
              )
            }
          }
        })
        const answer = yield* truthOf(result, "resolved").pipe(Effect.option)
        const resolved =
          answer._tag === "Some" && decide(answer.value) !== "hold" && answer.value.truth >= 0.5
        const probability = answer._tag === "Some" ? answer.value.truth.toFixed(2) : "n/a"
        const chair = Turn.make({
          id: turns.length + 1,
          round: action.reply.round,
          item: action.item.number,
          speaker: chairSpeaker,
          kind: resolved ? "agreement" : "position",
          answers: [action.objection.id],
          blocking: false,
          needsHuman: false,
          body: resolved
            ? `Judged resolved by #${action.reply.id} (p=${probability}).`
            : `Judged still open after #${action.reply.id} (p=${probability}); ${action.objection.speaker} may close it or the item is left open at the cap.`
        })
        yield* appendTurn(chair)
        yield* say(renderTurn(chair))
        continue
      }
      case "Speak": {
        const persona = personaOf(action.speaker)
        if (persona === undefined) {
          return yield* ScriptUsage.make({ message: `no persona for ${action.speaker}` })
        }
        const proposal = yield* structuredAndPublish(
          deps.seat,
          events,
          turnPrompt({
            persona,
            meeting,
            item: action.item,
            round: action.round,
            caps,
            turns,
            addressed: action.addressed,
            docs: deps.context,
            budget: deps.budget
          }),
          TurnProposal,
          turnProposalJsonSchema,
          persona.name
        )
        const turn = assembleTurn(proposal, {
          id: turns.length + 1,
          round: action.round,
          item: action.item.number,
          speaker: persona.name,
          existing: turns
        })
        yield* appendTurn(turn)
        yield* say(`[item ${action.item.number}, round ${action.round}] ${renderTurn(turn)}`)
        const state = itemState(meeting, turns, action.item.number, caps)
        if (state.settled) yield* say(`item ${action.item.number} settled.`)
        else if (state.capped) yield* say(`item ${action.item.number} left open at the cap.`)
        continue
      }
      case "Draft": {
        if (meeting.status !== "drafting") {
          meeting = Meeting.make({ ...meeting, status: "drafting" })
          yield* save(meeting)
        }
        yield* writeRecords()
        yield* askScribe()
        meeting = Meeting.make({ ...meeting, status: "reviewing", drafts: meeting.drafts + 1 })
        yield* save(meeting)
        yield* say(
          `scribe: draft ${meeting.drafts} written — ${paths.outline}, ${paths.plan}, ${paths.decisions}, ${paths.openQuestions}`
        )
        continue
      }
      case "Finalize": {
        if (action.objections.length > 0) {
          const outline = (yield* files.read(paths.outline)) ?? ""
          const plan = (yield* files.read(paths.plan)) ?? ""
          yield* askScribe({ outline, plan, objections: action.objections })
          yield* say(`scribe: fix pass for ${action.objections.length} blocking objection(s)`)
        }
        yield* writeRecords()
        meeting = Meeting.make({ ...meeting, status: "done" })
        yield* save(meeting)
        const parked = meeting.answers.filter((point) => (point.answer ?? "").trim().length === 0)
        const closing = closingItem(meeting)
        const open = [...meeting.agenda, closing].filter(
          (item) => !itemState(meeting, turns, item.number, caps).settled
        )
        const summary = [
          `roundtable ${deps.meetingId} done after ${turns.length} turns and ${meeting.drafts} draft(s)`,
          `outline: ${paths.outline}`,
          `plan: ${paths.plan}`,
          `decisions: ${paths.decisions}`,
          `open questions: ${paths.openQuestions}${open.length === 0 ? "" : ` (${open.length} item(s) left open)`}`,
          ...(parked.length === 0
            ? []
            : [
                `${parked.length} question(s) for you under '## Answers' in ${paths.meeting}; answer and rerun to fold them in`
              ])
        ]
        for (const line of summary) yield* say(line)
        return { _tag: "Finished", summary }
      }
    }
  }
})

const loadMeeting = Effect.fn("roundtable.loadMeeting")(function* (
  files: PlainFileStoreShape,
  path: string
): Effect.fn.Return<Meeting | undefined, FlowError> {
  const text = yield* files.read(path)
  if (text === undefined) return undefined
  return yield* parseMeeting(text, path)
})

/** Markdown of the bundled and custom cards, for `--list` and for the docs. */
export const describePersonas = (personas: ReadonlyArray<Persona>): string =>
  personas.map((persona) => `- ${persona.name}: ${persona.mandate}`).join("\n")
