import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Option from "effect/Option"
import type { JsonSchema } from "@llm4ts/core/Models"
import { makeOpenPointsCollector, OpenPoint } from "./Decisions.ts"
import { MeetingInvalid, PersonaInvalid, TurnsInvalid } from "./FlowError.ts"
import { RoundtableTurnKind } from "./FlowEvents.ts"

/**
 * The roundtable (ADR 0046): a meeting run by code. Chosen personas speak in
 * turns about a topic toward a goal, agenda item by agenda item, until each
 * item is settled or capped; then the Scribe writes the outline and the plan.
 *
 * This module is the pure half: the persona card, the meeting file, the turn
 * record, what the turns imply (open objections, open questions, decisions,
 * settled items) and the chair's `nextAction`. The flow wires seats, files
 * and events around it.
 */

// ---- Shared helpers -----------------------------------------------------------

const dash = " — "
const headerLine = /^([A-Za-z][A-Za-z ]*):\s*(.*)$/

const splitFirst = (text: string, separator: string): readonly [string, string | undefined] => {
  const index = text.indexOf(separator)
  return index < 0
    ? [text.trim(), undefined]
    : [text.slice(0, index).trim(), text.slice(index + separator.length).trim()]
}

const prose = (text: string): ReadonlyArray<string> =>
  text.trim().length === 0 ? [] : text.trim().split("\n")

const sectionLines = (title: string, body: ReadonlyArray<string>): ReadonlyArray<string> => [
  `## ${title}`,
  "",
  ...(body.length === 0 ? [] : [...body, ""])
]

// ---- Personas -----------------------------------------------------------------

/**
 * A persona card: what a speaker is. A role is a seat an executor takes; a
 * persona is a voice. The order sorts attendees into speaking order.
 */
export class Persona extends Schema.Class<Persona>("Persona")({
  name: Schema.String,
  order: Schema.Int,
  mandate: Schema.String,
  caresAbout: Schema.String,
  pushesBackOn: Schema.String,
  neverDecidesAlone: Schema.String,
  voice: Schema.String,
  /** The Scribe's section skeleton for `outline.md`; other cards have none. */
  outlineTemplate: Schema.optionalKey(Schema.String),
  /** The Scribe's section skeleton for `plan.md`. */
  planTemplate: Schema.optionalKey(Schema.String)
}) {}

/** The order a card without one gets: after every bundled persona. */
export const defaultPersonaOrder = 100

const personaSections = {
  mandate: "Mandate",
  caresAbout: "Cares about",
  pushesBackOn: "Pushes back on",
  neverDecidesAlone: "Never decides alone",
  voice: "Voice",
  outlineTemplate: "Outline template",
  planTemplate: "Plan template"
} as const
type PersonaSection = keyof typeof personaSections
const personaSectionKeys: ReadonlyArray<PersonaSection> = [
  "mandate",
  "caresAbout",
  "pushesBackOn",
  "neverDecidesAlone",
  "voice",
  "outlineTemplate",
  "planTemplate"
]
/** Sections whose body is a markdown skeleton: a `## ` line inside them is content, not a section. */
const templateSections: ReadonlyArray<PersonaSection> = ["outlineTemplate", "planTemplate"]

const personaSectionOf = (title: string): PersonaSection | undefined =>
  personaSectionKeys.find((key) => personaSections[key].toLowerCase() === title.toLowerCase())

/**
 * Reads a card: optional `---` frontmatter with `name:` and `order:`, then
 * one `## ` section per field. `fallbackName` is the file's name, used when
 * the frontmatter has none.
 */
export const parsePersona = Effect.fn("@llm4ts/flow/Roundtable.parsePersona")(function* (
  fallbackName: string,
  markdown: string
): Effect.fn.Return<Persona, PersonaInvalid> {
  const violations: Array<string> = []
  const lines = markdown.split(/\r?\n/)
  let name = fallbackName
  let order = defaultPersonaOrder
  let index = 0
  if ((lines[0] ?? "").trim() === "---") {
    index = 1
    while (index < lines.length && (lines[index] ?? "").trim() !== "---") {
      const field = headerLine.exec((lines[index] ?? "").trim())
      if (field?.[1] !== undefined) {
        const key = field[1].toLowerCase()
        const value = (field[2] ?? "").trim()
        if (key === "name" && value.length > 0) name = value
        if (key === "order") {
          const parsed = /^\d+$/.test(value) ? Number.parseInt(value, 10) : undefined
          if (parsed === undefined) {
            violations.push(`line ${index + 1}: order is a whole number, got: ${value}`)
          } else {
            order = parsed
          }
        }
      }
      index += 1
    }
    if (index >= lines.length) {
      violations.push("line 1: the frontmatter opened here is never closed")
    }
    index += 1
  }
  const bodies: Record<PersonaSection, Array<string>> = {
    mandate: [],
    caresAbout: [],
    pushesBackOn: [],
    neverDecidesAlone: [],
    voice: [],
    outlineTemplate: [],
    planTemplate: []
  }
  let current: PersonaSection | "unknown" | "none" = "none"
  let fenced = false
  for (; index < lines.length; index += 1) {
    const raw = lines[index] ?? ""
    const trimmed = raw.trim()
    if (trimmed.startsWith("```")) fenced = !fenced
    if (!fenced && trimmed.startsWith("## ")) {
      const title = trimmed.slice(3).trim()
      const key = personaSectionOf(title)
      if (key !== undefined) {
        current = key
        continue
      }
      // A template is a skeleton of headings: its `## ` lines are its body.
      if (current !== "unknown" && current !== "none" && templateSections.includes(current)) {
        bodies[current].push(raw)
        continue
      }
      violations.push(`line ${index + 1}: unknown section "${title}"`)
      current = "unknown"
      continue
    }
    if (current !== "unknown" && current !== "none") bodies[current].push(raw)
  }
  const text = (key: PersonaSection): string => bodies[key].join("\n").trim()
  if (text("mandate").length === 0) violations.push("missing the `## Mandate` section")
  if (violations.length > 0) {
    return yield* PersonaInvalid.make({ name: fallbackName, violations })
  }
  return Persona.make({
    name,
    order,
    mandate: text("mandate"),
    caresAbout: text("caresAbout"),
    pushesBackOn: text("pushesBackOn"),
    neverDecidesAlone: text("neverDecidesAlone"),
    voice: text("voice"),
    ...(bodies.outlineTemplate.length === 0 ? {} : { outlineTemplate: text("outlineTemplate") }),
    ...(bodies.planTemplate.length === 0 ? {} : { planTemplate: text("planTemplate") })
  })
})

export const renderPersona = (persona: Persona): string =>
  [
    "---",
    `name: ${persona.name}`,
    `order: ${persona.order}`,
    "---",
    "",
    ...personaSectionKeys.flatMap((key) => {
      const body = persona[key]
      return body === undefined ? [] : sectionLines(personaSections[key], prose(body))
    })
  ].join("\n")

// ---- The meeting file ---------------------------------------------------------

export const MeetingStatus = Schema.Literals([
  "agenda-proposed",
  "discussing",
  "drafting",
  "reviewing",
  "done"
])
export type MeetingStatus = typeof MeetingStatus.Type

/** One question the meeting settles, with a title. Numbered as the agenda lists it. */
export class AgendaItem extends Schema.Class<AgendaItem>("AgendaItem")({
  number: Schema.Int,
  title: Schema.String,
  question: Schema.String
}) {}

/**
 * The meeting file, `meeting.md`: the state of a roundtable, and the owner's
 * only seat at the table. Answers are keyed by the id of the question turn
 * they answer; feedback is free text that becomes an Owner turn on the next
 * run. `drafts` counts how many times the Scribe has written the documents:
 * each draft opens a new review round.
 */
export class Meeting extends Schema.Class<Meeting>("Meeting")({
  id: Schema.String,
  status: MeetingStatus,
  topic: Schema.String,
  goal: Schema.String,
  attendees: Schema.Array(Schema.String),
  agenda: Schema.Array(AgendaItem),
  answers: Schema.Array(OpenPoint),
  feedback: Schema.String,
  drafts: Schema.Int
}) {}

const meetingSections = { agenda: "Agenda", answers: "Answers", feedback: "Feedback" } as const
type MeetingSection = keyof typeof meetingSections
const meetingSectionKeys: ReadonlyArray<MeetingSection> = ["agenda", "answers", "feedback"]

const meetingSectionOf = (title: string): MeetingSection | undefined =>
  meetingSectionKeys.find((key) => meetingSections[key].toLowerCase() === title.toLowerCase())

const isMeetingStatus = (value: string): value is MeetingStatus =>
  MeetingStatus.literals.some((literal) => literal === value)

export const renderAgendaItem = (item: AgendaItem): string =>
  `${item.number}. ${item.title}${dash}${item.question}`

export const renderMeeting = (meeting: Meeting): string =>
  [
    `# Roundtable: ${meeting.id}`,
    "",
    `Status: ${meeting.status}`,
    `Topic: ${meeting.topic}`,
    `Goal: ${meeting.goal}`,
    `Attendees: ${meeting.attendees.join(", ")}`,
    `Drafts: ${meeting.drafts}`,
    "",
    ...sectionLines(meetingSections.agenda, meeting.agenda.map(renderAgendaItem)),
    ...sectionLines(
      meetingSections.answers,
      meeting.answers.flatMap((point) => [
        `${point.number}. ${point.question}`,
        `   answer:${(point.answer ?? "").trim().length === 0 ? "" : ` ${(point.answer ?? "").trim()}`}`
      ])
    ),
    ...sectionLines(meetingSections.feedback, prose(meeting.feedback))
  ].join("\n")

/** An open point as the file holds it: an empty answer is no answer. */
const settledPoint = (point: OpenPoint): OpenPoint =>
  (point.answer ?? "").trim().length === 0
    ? OpenPoint.make({ number: point.number, question: point.question })
    : OpenPoint.make({
        number: point.number,
        question: point.question,
        answer: (point.answer ?? "").trim()
      })

export const parseMeeting = Effect.fn("@llm4ts/flow/Roundtable.parseMeeting")(function* (
  markdown: string,
  path?: string
): Effect.fn.Return<Meeting, MeetingInvalid> {
  const violations: Array<string> = []
  let id: string | undefined
  let status: MeetingStatus | undefined
  let drafts = 0
  const header: Record<string, string> = {}
  let attendees: Array<string> | undefined
  const agenda: Array<{ title: string; question: string }> = []
  const points = makeOpenPointsCollector()
  const feedback: Array<string> = []
  let current: MeetingSection | "header" | "unknown" = "header"
  let fenced = false
  const lines = markdown.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const number = index + 1
    const raw = lines[index] ?? ""
    const trimmed = raw.trim()
    if (trimmed.startsWith("```")) {
      fenced = !fenced
      if (current === "feedback") feedback.push(raw)
      continue
    }
    if (!fenced && trimmed.startsWith("## ")) {
      const title = trimmed.slice(3).trim()
      const key = meetingSectionOf(title)
      if (key === undefined) {
        violations.push(`line ${number}: unknown section "${title}"`)
        current = "unknown"
      } else {
        current = key
      }
      continue
    }
    if (current === "feedback") {
      feedback.push(raw)
      continue
    }
    if (fenced || trimmed.length === 0 || current === "unknown") continue
    if (current === "header") {
      const title = /^#\s+Roundtable:\s*(.+)$/i.exec(trimmed)
      if (title?.[1] !== undefined) {
        id = title[1].trim()
        continue
      }
      const field = headerLine.exec(trimmed)
      if (field?.[1] === undefined) continue
      const name = field[1].toLowerCase()
      const value = (field[2] ?? "").trim()
      if (name === "status") {
        if (isMeetingStatus(value)) {
          status = value
        } else {
          violations.push(
            `line ${number}: Status is one of ${MeetingStatus.literals.join(", ")}, got: ${value}`
          )
          status = "discussing"
        }
      } else if (name === "attendees") {
        attendees = []
        for (const entry of value.split(",")) {
          const persona = entry.trim()
          if (persona.length === 0) continue
          if (attendees.includes(persona)) {
            violations.push(`line ${number}: attendee listed twice: ${persona}`)
          } else {
            attendees.push(persona)
          }
        }
      } else if (name === "drafts") {
        if (/^\d+$/.test(value)) {
          drafts = Number.parseInt(value, 10)
        } else {
          violations.push(`line ${number}: Drafts is a whole number, got: ${value}`)
        }
      } else {
        header[name] = value
      }
      continue
    }
    if (current === "answers") {
      const problem = points.add(number, trimmed)
      if (problem !== undefined) violations.push(problem)
      continue
    }
    const item = /^(\d+)\.\s+(.*)$/.exec(trimmed)
    if (item !== null) {
      const [title, question] = splitFirst(item[2] ?? "", dash.trim())
      if (question === undefined || title.length === 0) {
        violations.push(
          `line ${number}: an agenda item is \`1. <title>${dash}<question>\`, got: ${trimmed}`
        )
      } else {
        agenda.push({ title, question })
      }
      continue
    }
    const last = agenda.at(-1)
    if (/^\s/.test(raw) && last !== undefined) {
      last.question = `${last.question} ${trimmed}`.trim()
      continue
    }
    violations.push(
      `line ${number}: an agenda item is \`1. <title>${dash}<question>\`, got: ${trimmed}`
    )
  }
  if (id === undefined) violations.push("missing the `# Roundtable: <id>` title")
  if (status === undefined) violations.push("missing the `Status:` line")
  if (header.topic === undefined) violations.push("missing the `Topic:` line")
  if (header.goal === undefined) violations.push("missing the `Goal:` line")
  if (attendees === undefined) violations.push("missing the `Attendees:` line")
  else if (attendees.length === 0) violations.push("the `Attendees:` line names no persona")
  if (fenced) violations.push("a code fence in the feedback is never closed")
  if (
    violations.length > 0 ||
    id === undefined ||
    status === undefined ||
    attendees === undefined
  ) {
    return yield* MeetingInvalid.make({ ...(path === undefined ? {} : { path }), violations })
  }
  return Meeting.make({
    id,
    status,
    topic: header.topic ?? "",
    goal: header.goal ?? "",
    attendees,
    agenda: agenda.map((entry, index) =>
      AgendaItem.make({ number: index + 1, title: entry.title, question: entry.question })
    ),
    answers: points.points.map(settledPoint),
    feedback: feedback.join("\n").trim(),
    drafts
  })
})

// ---- Turns --------------------------------------------------------------------

/** The person who called the meeting, present through the meeting file only. */
export const ownerSpeaker = "Owner"
/** The code that runs the meeting; it speaks only to record a judgment. */
export const chairSpeaker = "Chair"

/** The kinds of turn, shared with the `RoundtableTurn` event the dashboard reads. */
export const TurnKind = RoundtableTurnKind
export type TurnKind = RoundtableTurnKind

/**
 * One contribution on one agenda item in one round. `answers` names the
 * turns it responds to: what an objection objects to, what an agreement
 * closes, what a reply replies to. `blocking` is read on objections only,
 * `needsHuman` and `assumption` on questions only.
 */
export class Turn extends Schema.Class<Turn>("Turn")({
  id: Schema.Int,
  round: Schema.Int,
  item: Schema.Int,
  speaker: Schema.String,
  kind: TurnKind,
  answers: Schema.Array(Schema.Int),
  blocking: Schema.Boolean,
  needsHuman: Schema.Boolean,
  assumption: Schema.optionalKey(Schema.String),
  body: Schema.String
}) {}

const turnLine = Schema.fromJsonString(Turn)
const encodeTurnLine = Schema.encodeSync(turnLine)
const decodeTurnLine = Schema.decodeUnknownOption(turnLine)

/** One line of `turns.jsonl`. */
export const encodeTurn = (turn: Turn): string => encodeTurnLine(turn)

/** `turns.jsonl` back into turns, ids checked to run 1, 2, 3 … in file order. */
export const decodeTurns = Effect.fn("@llm4ts/flow/Roundtable.decodeTurns")(function* (
  text: string,
  path?: string
): Effect.fn.Return<ReadonlyArray<Turn>, TurnsInvalid> {
  const violations: Array<string> = []
  const turns: Array<Turn> = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim()
    if (line.length === 0) continue
    const decoded = decodeTurnLine(line)
    if (Option.isNone(decoded)) {
      violations.push(`line ${index + 1}: not a JSON turn: ${line.slice(0, 80)}`)
      continue
    }
    const expected = turns.length + 1
    if (decoded.value.id !== expected) {
      violations.push(
        `line ${index + 1}: turn id ${decoded.value.id} where ${expected} was expected`
      )
    }
    turns.push(decoded.value)
  }
  if (violations.length > 0) {
    return yield* TurnsInvalid.make({ ...(path === undefined ? {} : { path }), violations })
  }
  return turns
})

/** What an attendee returns for a turn; the chair stamps id, round, item and speaker. */
export class TurnProposal extends Schema.Class<TurnProposal>("TurnProposal")({
  kind: TurnKind,
  answers: Schema.Array(Schema.Int),
  blocking: Schema.Boolean,
  needsHuman: Schema.Boolean,
  assumption: Schema.optionalKey(Schema.String),
  body: Schema.String
}) {}

export const turnProposalJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: [...TurnKind.literals] },
    answers: { type: "array", items: { type: "integer" } },
    blocking: { type: "boolean" },
    needsHuman: { type: "boolean" },
    assumption: { type: "string" },
    body: { type: "string" }
  },
  required: ["kind", "answers", "blocking", "needsHuman", "body"]
}

export interface TurnAt {
  readonly id: number
  readonly round: number
  readonly item: number
  readonly speaker: string
  readonly existing: ReadonlyArray<Turn>
}

/**
 * A proposal as the record can hold it: only earlier turns of the same item
 * can be answered, only an objection blocks, only a question needs the owner
 * and carries an assumption.
 */
export const assembleTurn = (proposal: TurnProposal, at: TurnAt): Turn => {
  const known = new Set(
    at.existing.filter((turn) => turn.item === at.item && turn.id < at.id).map((turn) => turn.id)
  )
  const answers = [...new Set(proposal.answers)].filter((id) => known.has(id)).sort((a, b) => a - b)
  const needsHuman = proposal.kind === "question" && proposal.needsHuman
  const assumption = needsHuman ? (proposal.assumption ?? "").trim() : ""
  return Turn.make({
    id: at.id,
    round: at.round,
    item: at.item,
    speaker: at.speaker,
    kind: proposal.kind,
    answers,
    blocking: proposal.kind === "objection" && proposal.blocking,
    needsHuman,
    ...(assumption.length === 0 ? {} : { assumption }),
    body: proposal.body.trim()
  })
}

// ---- The agenda ---------------------------------------------------------------

export class AgendaProposal extends Schema.Class<AgendaProposal>("AgendaProposal")({
  items: Schema.Array(Schema.Struct({ title: Schema.String, question: Schema.String }))
}) {}

export const agendaProposalJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, question: { type: "string" } },
        required: ["title", "question"]
      }
    }
  },
  required: ["items"]
}

export const minAgendaItems = 3
export const maxAgendaItems = 7

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()

/** The proposed items as the file can hold them: one line each, the title free of the separator, at most the cap. */
export const assembleAgenda = (proposal: AgendaProposal): ReadonlyArray<AgendaItem> =>
  proposal.items.slice(0, maxAgendaItems).map((item, index) =>
    AgendaItem.make({
      number: index + 1,
      title: oneLine(item.title).replaceAll(dash.trim(), "-"),
      question: oneLine(item.question)
    })
  )

/** The fixed item after the proposed ones: does what was settled reach the goal? */
export const closingItem = (meeting: Meeting): AgendaItem =>
  AgendaItem.make({
    number: meeting.agenda.length + 1,
    title: "Goal check",
    question: "Does the solution, as settled above, reach the goal?"
  })

/** The synthetic item the drafts are reviewed under, once per draft. */
export const reviewItem = (meeting: Meeting): AgendaItem =>
  AgendaItem.make({
    number: meeting.agenda.length + 2,
    title: "Review of the drafts",
    question: "Do the outline and the plan say what the room settled, and reach the goal?"
  })

/** The items the discussion goes through, in order: the agenda, then the goal check. */
export const discussionItems = (meeting: Meeting): ReadonlyArray<AgendaItem> => [
  ...meeting.agenda,
  closingItem(meeting)
]

export const itemOf = (meeting: Meeting, number: number): AgendaItem | undefined =>
  [...discussionItems(meeting), reviewItem(meeting)].find((item) => item.number === number)

// ---- What the turns imply -----------------------------------------------------

const onItem = (turns: ReadonlyArray<Turn>, item: number): ReadonlyArray<Turn> =>
  turns.filter((turn) => turn.item === item)

/** The objector, or the chair, agreed later that the objection is answered. */
const isResolved = (turns: ReadonlyArray<Turn>, objection: Turn): boolean =>
  turns.some(
    (turn) =>
      turn.id > objection.id &&
      turn.kind === "agreement" &&
      turn.answers.includes(objection.id) &&
      (turn.speaker === objection.speaker || turn.speaker === chairSpeaker)
  )

/** Blocking objections on the item nobody entitled to has closed. */
export const openObjections = (turns: ReadonlyArray<Turn>, item: number): ReadonlyArray<Turn> =>
  onItem(turns, item).filter(
    (turn) => turn.kind === "objection" && turn.blocking && !isResolved(turns, turn)
  )

/** Objections to a proposal that do not block it: recorded with the decision, never resolved. */
export const dissent = (turns: ReadonlyArray<Turn>, proposal: Turn): ReadonlyArray<Turn> =>
  turns.filter(
    (turn) => turn.kind === "objection" && !turn.blocking && turn.answers.includes(proposal.id)
  )

/** Questions for the room with no later turn answering them. */
export const openQuestions = (turns: ReadonlyArray<Turn>, item: number): ReadonlyArray<Turn> =>
  onItem(turns, item).filter(
    (turn) =>
      turn.kind === "question" &&
      !turn.needsHuman &&
      !turns.some(
        (reply) => reply.id > turn.id && reply.kind !== "pass" && reply.answers.includes(turn.id)
      )
  )

/** Questions for the owner the owner has not answered yet. */
export const parkedQuestions = (turns: ReadonlyArray<Turn>): ReadonlyArray<Turn> =>
  turns.filter(
    (turn) =>
      turn.kind === "question" &&
      turn.needsHuman &&
      !turns.some((reply) => reply.speaker === ownerSpeaker && reply.answers.includes(turn.id))
  )

const roundComplete = (
  meeting: Meeting,
  turns: ReadonlyArray<Turn>,
  item: number,
  round: number
): boolean =>
  meeting.attendees.every((attendee) =>
    turns.some((turn) => turn.item === item && turn.round === round && turn.speaker === attendee)
  )

const maxRound = (turns: ReadonlyArray<Turn>, item: number): number =>
  onItem(turns, item).reduce((most, turn) => Math.max(most, turn.round), 0)

/** The round the next turn on the item belongs to: the open one, or a new one after a complete one. */
export const currentRound = (
  meeting: Meeting,
  turns: ReadonlyArray<Turn>,
  item: number
): number => {
  const most = maxRound(turns, item)
  return most > 0 && roundComplete(meeting, turns, item, most) ? most + 1 : Math.max(most, 1)
}

export interface Caps {
  /** Complete rounds an item gets before it is left open; an owner turn grants one more. */
  readonly roundsPerItem: number
  /** Turns in the whole discussion before drafting starts whatever is open. */
  readonly maxTurns: number
}

export const defaultCaps: Caps = { roundsPerItem: 3, maxTurns: 40 }

export interface ItemState {
  /** Complete rounds so far. */
  readonly rounds: number
  /** The round the next turn belongs to. */
  readonly round: number
  /** A complete round ended with no open blocking objection and no open question. */
  readonly settled: boolean
  /** Not settled, and out of rounds. */
  readonly capped: boolean
}

export const itemState = (
  meeting: Meeting,
  turns: ReadonlyArray<Turn>,
  item: number,
  caps: Caps
): ItemState => {
  const most = maxRound(turns, item)
  let rounds = 0
  for (let round = 1; round <= most; round += 1) {
    if (roundComplete(meeting, turns, item, round)) rounds += 1
  }
  const latestComplete = most > 0 && roundComplete(meeting, turns, item, most)
  const open = openObjections(turns, item).length > 0 || openQuestions(turns, item).length > 0
  const settled = latestComplete && !open
  const ownerTurns = onItem(turns, item).filter((turn) => turn.speaker === ownerSpeaker).length
  return {
    rounds,
    round: currentRound(meeting, turns, item),
    settled,
    capped: !settled && latestComplete && rounds >= caps.roundsPerItem + ownerTurns
  }
}

export interface Decision {
  readonly item: AgendaItem
  readonly proposal: Turn
  readonly dissent: ReadonlyArray<Turn>
}

/**
 * Silence is consent: on an item that is settled or capped, every proposal
 * with no open blocking objection against it is a decision, and the soft
 * objections to it are its dissent.
 */
export const decisions = (
  meeting: Meeting,
  turns: ReadonlyArray<Turn>,
  caps: Caps
): ReadonlyArray<Decision> =>
  discussionItems(meeting).flatMap((item) => {
    const state = itemState(meeting, turns, item.number, caps)
    if (!state.settled && !state.capped) return []
    const blocking = openObjections(turns, item.number)
    return onItem(turns, item.number)
      .filter(
        (turn) =>
          turn.kind === "proposal" &&
          !blocking.some((objection) => objection.answers.includes(turn.id))
      )
      .map((proposal) => ({ item, proposal, dissent: dissent(turns, proposal) }))
  })

// ---- The chair ----------------------------------------------------------------

export interface OwnerAnswer {
  readonly question: Turn
  readonly answer: string
}

export type ChairAction =
  | { readonly _tag: "ProposeAgenda"; readonly speaker: string }
  | { readonly _tag: "OpenDiscussion" }
  | {
      readonly _tag: "RecordOwner"
      readonly answers: ReadonlyArray<OwnerAnswer>
      readonly feedback: string
    }
  | {
      readonly _tag: "Judge"
      readonly item: AgendaItem
      readonly objection: Turn
      readonly reply: Turn
    }
  | {
      readonly _tag: "Speak"
      readonly item: AgendaItem
      readonly round: number
      readonly speaker: string
      /** Open objections and questions aimed at this speaker's earlier turns. */
      readonly addressed: ReadonlyArray<Turn>
    }
  | { readonly _tag: "Draft" }
  | { readonly _tag: "Finalize"; readonly objections: ReadonlyArray<Turn> }
  | { readonly _tag: "Done" }
  | { readonly _tag: "Refused"; readonly reason: string }

/** Answers written in the file for parked questions, and feedback, not yet recorded as Owner turns. */
const pendingOwner = (
  meeting: Meeting,
  turns: ReadonlyArray<Turn>
): { answers: ReadonlyArray<OwnerAnswer>; feedback: string } => {
  const parked = parkedQuestions(turns)
  const answers = meeting.answers.flatMap((point) => {
    const answer = (point.answer ?? "").trim()
    const question = parked.find((turn) => turn.id === point.number)
    return answer.length === 0 || question === undefined ? [] : [{ question, answer }]
  })
  return { answers, feedback: meeting.feedback.trim() }
}

/** An open objection the objector has spoken past without closing, since the last reply to it. */
const judgeNeeded = (
  turns: ReadonlyArray<Turn>,
  item: number
): { objection: Turn; reply: Turn } | undefined => {
  for (const objection of openObjections(turns, item)) {
    const reply = turns
      .filter(
        (turn) =>
          turn.id > objection.id &&
          turn.kind !== "pass" &&
          turn.answers.includes(objection.id) &&
          turn.speaker !== objection.speaker &&
          turn.speaker !== chairSpeaker
      )
      .at(-1)
    if (reply === undefined) continue
    const objectorSpoke = turns.some(
      (turn) => turn.id > reply.id && turn.item === item && turn.speaker === objection.speaker
    )
    const chairRuled = turns.some(
      (turn) =>
        turn.id > reply.id && turn.speaker === chairSpeaker && turn.answers.includes(objection.id)
    )
    if (objectorSpoke && !chairRuled) return { objection, reply }
  }
  return undefined
}

const speakOn = (
  meeting: Meeting,
  turns: ReadonlyArray<Turn>,
  item: AgendaItem,
  round: number
): ChairAction => {
  const speaker =
    meeting.attendees.find(
      (attendee) =>
        !turns.some(
          (turn) => turn.item === item.number && turn.round === round && turn.speaker === attendee
        )
    ) ??
    meeting.attendees[0] ??
    ""
  const mine = new Set(
    onItem(turns, item.number)
      .filter((turn) => turn.speaker === speaker)
      .map((turn) => turn.id)
  )
  const addressed = [...openObjections(turns, item.number), ...openQuestions(turns, item.number)]
    .filter((turn) => turn.answers.some((id) => mine.has(id)))
    .sort((left, right) => left.id - right.id)
  return { _tag: "Speak", item, round, speaker, addressed }
}

/**
 * What the run does next, from the files alone. The owner's words come
 * first; then the agenda, the discussion item by item (a judgment before a
 * turn when a stalemate needs breaking), the drafting, one review round per
 * draft, and the end.
 */
export const nextAction = (
  meeting: Meeting,
  turns: ReadonlyArray<Turn>,
  caps: Caps
): ChairAction => {
  if (meeting.attendees.length === 0) {
    return { _tag: "Refused", reason: "the meeting has no attendees" }
  }
  if (meeting.status === "agenda-proposed") {
    return meeting.agenda.length === 0
      ? { _tag: "ProposeAgenda", speaker: meeting.attendees[0] ?? "" }
      : { _tag: "OpenDiscussion" }
  }
  if (meeting.agenda.length === 0) {
    return {
      _tag: "Refused",
      reason:
        "the meeting is discussing but has no agenda: delete the folder or set Status: agenda-proposed"
    }
  }
  const owner = pendingOwner(meeting, turns)
  if (owner.answers.length > 0 || owner.feedback.length > 0) {
    return { _tag: "RecordOwner", answers: owner.answers, feedback: owner.feedback }
  }
  if (meeting.status === "done") return { _tag: "Done" }
  if (meeting.status === "drafting") return { _tag: "Draft" }
  if (meeting.status === "reviewing") {
    const review = reviewItem(meeting)
    const state = itemState(meeting, turns, review.number, caps)
    return state.rounds >= meeting.drafts
      ? { _tag: "Finalize", objections: openObjections(turns, review.number) }
      : speakOn(meeting, turns, review, state.round)
  }
  if (turns.length >= caps.maxTurns) return { _tag: "Draft" }
  for (const item of discussionItems(meeting)) {
    const state = itemState(meeting, turns, item.number, caps)
    if (state.settled || state.capped) continue
    const stalemate = judgeNeeded(turns, item.number)
    if (stalemate !== undefined) return { _tag: "Judge", item, ...stalemate }
    return speakOn(meeting, turns, item, state.round)
  }
  return { _tag: "Draft" }
}

/** The owner's answers and feedback as turns: an answer on its question's item, feedback on the review item. */
export const recordOwner = (
  meeting: Meeting,
  turns: ReadonlyArray<Turn>,
  action: Extract<ChairAction, { _tag: "RecordOwner" }>
): ReadonlyArray<Turn> => {
  const recorded: Array<Turn> = []
  const ownerTurn = (item: number, answers: ReadonlyArray<number>, body: string): Turn => {
    const all = [...turns, ...recorded]
    return Turn.make({
      id: all.length + 1,
      round: currentRound(meeting, all, item),
      item,
      speaker: ownerSpeaker,
      kind: "position",
      answers: [...answers],
      blocking: false,
      needsHuman: false,
      body
    })
  }
  for (const { question, answer } of action.answers) {
    recorded.push(ownerTurn(question.item, [question.id], answer))
  }
  if (action.feedback.length > 0) {
    recorded.push(ownerTurn(reviewItem(meeting).number, [], action.feedback))
  }
  return recorded
}

// ---- Views ----------------------------------------------------------------------

const refs = (ids: ReadonlyArray<number>): string => ids.map((id) => `#${id}`).join(", ")

const firstLine = (text: string): string => {
  const line = oneLine(text.split(/\r?\n/)[0] ?? "")
  return line.length > 80 ? `${line.slice(0, 77)}...` : line
}

/** One turn as the notes show it: `**PO** #4 objection to #2, blocking: …`. */
export const renderTurn = (turn: Turn): string => {
  if (turn.kind === "pass") return `**${turn.speaker}** #${turn.id} passes.`
  const owner = turn.needsHuman ? " for the owner" : ""
  const assuming = turn.assumption === undefined ? "" : ` (assuming: ${turn.assumption})`
  const linked =
    turn.answers.length === 0
      ? ""
      : turn.kind === "objection"
        ? ` to ${refs(turn.answers)}`
        : turn.kind === "agreement"
          ? ` with ${refs(turn.answers)}`
          : ` answering ${refs(turn.answers)}`
  const blocking = turn.kind === "objection" && turn.blocking ? ", blocking" : ""
  return `**${turn.speaker}** #${turn.id} ${turn.kind}${owner}${assuming}${linked}${blocking}: ${turn.body}`
}

const itemFooter = (state: ItemState, turns: number): string =>
  state.settled
    ? "Settled."
    : state.capped
      ? `Left open after ${state.rounds} rounds.`
      : turns === 0
        ? "Not discussed yet."
        : "In progress."

/** `discussion.md`: the record as meeting notes, item by item, round by round. */
export const renderDiscussion = (
  meeting: Meeting,
  turns: ReadonlyArray<Turn>,
  caps: Caps
): string => {
  const review = reviewItem(meeting)
  const items = [
    ...discussionItems(meeting),
    ...(onItem(turns, review.number).length === 0 ? [] : [review])
  ]
  return [
    `# Discussion: ${meeting.topic}`,
    "",
    `Goal: ${meeting.goal}`,
    `Attendees: ${meeting.attendees.join(", ")}`,
    "",
    ...items.flatMap((item) => {
      const own = onItem(turns, item.number)
      const rounds = [...new Set(own.map((turn) => turn.round))].sort((a, b) => a - b)
      const state = itemState(meeting, turns, item.number, caps)
      return [
        `## ${renderAgendaItem(item)}`,
        "",
        ...rounds.flatMap((round) => [
          `### Round ${round}`,
          "",
          ...own.filter((turn) => turn.round === round).flatMap((turn) => [renderTurn(turn), ""])
        ]),
        item.number === review.number
          ? state.round > state.rounds
            ? "In progress."
            : "Reviewed."
          : itemFooter(state, own.length),
        ""
      ]
    })
  ].join("\n")
}

/** `decisions.md`: one ADR-shaped entry per proposal that stood, with its dissent. */
export const renderDecisions = (
  meeting: Meeting,
  turns: ReadonlyArray<Turn>,
  caps: Caps
): string => {
  const decided = decisions(meeting, turns, caps)
  return [
    `# Decisions: ${meeting.topic}`,
    "",
    ...(decided.length === 0
      ? ["No decision was reached.", ""]
      : decided.flatMap((decision, index) => [
          `## ${index + 1}. ${firstLine(decision.proposal.body)}`,
          "",
          `Item: ${renderAgendaItem(decision.item)}`,
          `Proposed by: ${decision.proposal.speaker} (#${decision.proposal.id}), round ${decision.proposal.round}`,
          "",
          ...prose(decision.proposal.body),
          "",
          ...(decision.dissent.length === 0
            ? ["No dissent."]
            : [
                "Dissent:",
                ...decision.dissent.map(
                  (turn) => `- ${turn.speaker} (#${turn.id}): ${oneLine(turn.body)}`
                )
              ]),
          ""
        ]))
  ].join("\n")
}

/** `open-questions.md`: what the owner owes the room, and what the room left open. */
export const renderOpenQuestions = (
  meeting: Meeting,
  turns: ReadonlyArray<Turn>,
  caps: Caps
): string => {
  const parked = parkedQuestions(turns)
  const open = discussionItems(meeting).flatMap((item) => {
    const state = itemState(meeting, turns, item.number, caps)
    if (state.settled) return []
    const own = onItem(turns, item.number)
    const why = state.capped
      ? `left open after ${state.rounds} rounds`
      : own.length === 0
        ? "not discussed"
        : "in progress"
    return [
      `- ${renderAgendaItem(item)}: ${why}`,
      ...openObjections(turns, item.number).map(
        (turn) =>
          `  - #${turn.id} ${turn.speaker} objects${turn.answers.length === 0 ? "" : ` to ${refs(turn.answers)}`}, blocking: ${oneLine(turn.body)}`
      ),
      ...openQuestions(turns, item.number).map(
        (turn) => `  - #${turn.id} ${turn.speaker} asks: ${oneLine(turn.body)}`
      )
    ]
  })
  return [
    `# Open questions: ${meeting.topic}`,
    "",
    "## For the owner",
    "",
    ...(parked.length === 0
      ? ["None."]
      : parked.map(
          (turn) =>
            `- #${turn.id} ${turn.speaker}, item ${turn.item}: ${oneLine(turn.body)}${turn.assumption === undefined ? "" : ` (assuming: ${turn.assumption})`}`
        )),
    "",
    "## Left open by the room",
    "",
    ...(open.length === 0 ? ["Every item settled."] : open),
    ""
  ].join("\n")
}

/** The meeting file with every parked question listed for the owner; answers already there are kept. */
export const syncAnswers = (meeting: Meeting, turns: ReadonlyArray<Turn>): Meeting => {
  const listed = new Set(meeting.answers.map((point) => point.number))
  const missing = parkedQuestions(turns)
    .filter((turn) => !listed.has(turn.id))
    .map((turn) =>
      OpenPoint.make({ number: turn.id, question: `${oneLine(turn.body)} (${turn.speaker})` })
    )
  return Meeting.make({
    ...meeting,
    answers: [...meeting.answers, ...missing].sort((left, right) => left.number - right.number)
  })
}

export interface Briefing {
  /** Decisions of the items before this one. */
  readonly decisions: ReadonlyArray<Decision>
  /** Questions parked for the owner so far, with their assumptions. */
  readonly parked: ReadonlyArray<Turn>
  /** Every turn on the item under discussion. */
  readonly current: ReadonlyArray<Turn>
}

/** What an attendee reads before speaking on an item (ADR 0046, decision 8). */
export const briefingFor = (
  meeting: Meeting,
  turns: ReadonlyArray<Turn>,
  item: number,
  caps: Caps
): Briefing => ({
  decisions: decisions(meeting, turns, caps).filter((decision) => decision.item.number < item),
  parked: parkedQuestions(turns),
  current: onItem(turns, item)
})
