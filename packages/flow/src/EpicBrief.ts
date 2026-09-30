import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { makeOpenPointsCollector, OpenPoint } from "./Decisions.ts"
import { EpicBriefInvalid } from "./FlowError.ts"

/**
 * The epic brief: what `epic-design` writes and `epic-stories` plans from.
 * The file is the state. It says what an epic delivers and, for every
 * scenario of every legacy program it considered, whether that behaviour is
 * carried over, dropped, already provided by the target, or deferred, each
 * with its evidence in the extract pack (`PROGRAM › scenario title`). A human
 * edits it, answers its open points, writes feedback, and approves it by
 * setting `Status: approved`.
 */

export const BriefStatus = Schema.Literals(["draft", "approved"])
export type BriefStatus = typeof BriefStatus.Type

/** Legacy evidence: a scenario of a program, both named exactly as in the pack. */
export class Citation extends Schema.Class<Citation>("Citation")({
  program: Schema.String,
  scenario: Schema.String
}) {}

export class ScopeItem extends Schema.Class<ScopeItem>("ScopeItem")({
  title: Schema.String,
  citations: Schema.Array(Citation),
  /** Why an item with no citation exists: behaviour with no legacy counterpart. */
  newBehaviour: Schema.optionalKey(Schema.String)
}) {}

/** A scenario not carried over; `note` is the reason (dropped), the pointer (provided) or the note (deferred). */
export class Disposed extends Schema.Class<Disposed>("Disposed")({
  program: Schema.String,
  scenario: Schema.String,
  note: Schema.String
}) {}

export class ConsideredProgram extends Schema.Class<ConsideredProgram>("ConsideredProgram")({
  name: Schema.String,
  reason: Schema.String
}) {}

export class EpicBrief extends Schema.Class<EpicBrief>("EpicBrief")({
  epicId: Schema.String,
  status: BriefStatus,
  /** The epic as the user asked for it; becomes the story plan's `epic`. */
  request: Schema.String,
  legacy: Schema.String,
  goal: Schema.String,
  programs: Schema.Array(ConsideredProgram),
  scope: Schema.Array(ScopeItem),
  dropped: Schema.Array(Disposed),
  provided: Schema.Array(Disposed),
  deferred: Schema.Array(Disposed),
  constraints: Schema.String,
  openPoints: Schema.Array(OpenPoint),
  feedback: Schema.String
}) {}

/** Open points with no answer, or an empty one. */
export const unanswered = (brief: EpicBrief): ReadonlyArray<OpenPoint> =>
  brief.openPoints.filter((point) => (point.answer ?? "").trim().length === 0)

// ---- Rendering ----------------------------------------------------------------

const cite = " › "
const dash = " — "

const sectionTitles = {
  goal: "Goal",
  programs: "Legacy programs considered",
  scope: "In scope",
  dropped: "Dropped",
  provided: "Provided by the target",
  deferred: "Deferred",
  constraints: "Constraints",
  openPoints: "Open points",
  feedback: "Feedback"
} as const
type SectionKey = keyof typeof sectionTitles

const renderDisposed = (entry: Disposed): string =>
  `- ${entry.program}${cite}${entry.scenario}${entry.note.length === 0 ? "" : `${dash}${entry.note}`}`

const section = (key: SectionKey, body: ReadonlyArray<string>): ReadonlyArray<string> => [
  `## ${sectionTitles[key]}`,
  "",
  ...(body.length === 0 ? [] : [...body, ""])
]

const prose = (text: string): ReadonlyArray<string> =>
  text.trim().length === 0 ? [] : text.trim().split("\n")

export const renderEpicBrief = (brief: EpicBrief): string =>
  [
    `# Epic brief: ${brief.epicId}`,
    "",
    `Status: ${brief.status}`,
    `Request: ${brief.request}`,
    `Legacy: ${brief.legacy}`,
    "",
    ...section("goal", prose(brief.goal)),
    ...section(
      "programs",
      brief.programs.map(
        (program) =>
          `- ${program.name}${program.reason.length === 0 ? "" : `${dash}${program.reason}`}`
      )
    ),
    ...section(
      "scope",
      brief.scope.flatMap((item) => [
        `- ${item.title}`,
        ...item.citations.map((citation) => `  - ${citation.program}${cite}${citation.scenario}`),
        ...(item.newBehaviour === undefined ? [] : [`  - new: ${item.newBehaviour}`])
      ])
    ),
    ...section("dropped", brief.dropped.map(renderDisposed)),
    ...section("provided", brief.provided.map(renderDisposed)),
    ...section("deferred", brief.deferred.map(renderDisposed)),
    ...section("constraints", prose(brief.constraints)),
    ...section(
      "openPoints",
      brief.openPoints.flatMap((point) => {
        const answer = (point.answer ?? "").trim()
        return [
          `${point.number}. ${point.question}`,
          `   answer:${answer.length === 0 ? "" : ` ${answer}`}`
        ]
      })
    ),
    ...section("feedback", prose(brief.feedback))
  ]
    .join("\n")
    .replace(/\n+$/, "\n")

// ---- Parsing ------------------------------------------------------------------

const sectionOf = (title: string): SectionKey | undefined => {
  for (const key of Object.keys(sectionTitles)) {
    if (isSectionKey(key) && sectionTitles[key].toLowerCase() === title.toLowerCase()) return key
  }
  return undefined
}

const isSectionKey = (key: string): key is SectionKey => Object.hasOwn(sectionTitles, key)

const splitFirst = (text: string, separator: string): readonly [string, string | undefined] => {
  const at = text.indexOf(separator)
  return at < 0
    ? [text.trim(), undefined]
    : [text.slice(0, at).trim(), text.slice(at + separator.length).trim()]
}

/** `PROGRAM › scenario — note` (the note optional); undefined when there is no `›`. */
const parseDisposed = (text: string): Disposed | undefined => {
  const [program, rest] = splitFirst(text, cite.trim())
  if (rest === undefined || program.length === 0) return undefined
  const [scenario, note] = splitFirst(rest, dash)
  return scenario.length === 0 ? undefined : Disposed.make({ program, scenario, note: note ?? "" })
}

const headerLine = /^(Status|Request|Legacy):\s*(.*)$/i

export const parseEpicBrief = Effect.fn("@llm4ts/flow/EpicBrief.parse")(function* (
  markdown: string,
  path?: string
): Effect.fn.Return<EpicBrief, EpicBriefInvalid> {
  const violations: Array<string> = []
  const header: Record<string, string> = {}
  let epicId: string | undefined
  let status: BriefStatus | undefined
  const proseLines: Record<"goal" | "constraints" | "feedback", Array<string>> = {
    goal: [],
    constraints: [],
    feedback: []
  }
  const programs: Array<ConsideredProgram> = []
  const scope: Array<{ title: string; citations: Array<Citation>; newBehaviour?: string }> = []
  const disposed: Record<"dropped" | "provided" | "deferred", Array<Disposed>> = {
    dropped: [],
    provided: [],
    deferred: []
  }
  const points = makeOpenPointsCollector()
  let current: SectionKey | "header" | "unknown" = "header"
  let fenced = false

  const lines = markdown.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const number = index + 1
    const raw = lines[index] ?? ""
    const trimmed = raw.trim()
    const isProse = current === "goal" || current === "constraints" || current === "feedback"
    if (trimmed.startsWith("```")) {
      fenced = !fenced
      if (current === "goal" || current === "constraints" || current === "feedback") {
        proseLines[current].push(raw)
      }
      continue
    }
    if (!fenced && trimmed.startsWith("## ")) {
      const title = trimmed.slice(3).trim()
      const key = sectionOf(title)
      if (key === undefined) {
        violations.push(`line ${number}: unknown section "${title}"`)
        current = "unknown"
      } else {
        current = key
      }
      continue
    }
    if (current === "goal" || current === "constraints" || current === "feedback") {
      proseLines[current].push(raw)
      continue
    }
    if (isProse || fenced || trimmed.length === 0 || current === "unknown") {
      continue
    }
    if (current === "header") {
      const title = /^#\s+Epic brief:\s*(.+)$/i.exec(trimmed)
      if (title?.[1] !== undefined) {
        epicId = title[1].trim()
        continue
      }
      const field = headerLine.exec(trimmed)
      if (field?.[1] !== undefined) {
        const name = field[1].toLowerCase()
        const value = (field[2] ?? "").trim()
        if (name === "status") {
          if (value === "draft" || value === "approved") {
            status = value
          } else {
            violations.push(`line ${number}: Status is \`draft\` or \`approved\`, got: ${value}`)
            status = "draft"
          }
        } else {
          header[name] = value
        }
      }
      continue
    }
    if (current === "openPoints") {
      const problem = points.add(number, trimmed)
      if (problem !== undefined) violations.push(problem)
      continue
    }
    const nested = /^\s+-\s+(.*)$/.exec(raw)
    const top = /^-\s+(.*)$/.exec(raw)
    if (current === "scope") {
      if (top?.[1] !== undefined) {
        scope.push({ title: top[1].trim(), citations: [] })
        continue
      }
      const item = scope.at(-1)
      if (nested?.[1] === undefined || item === undefined) {
        violations.push(
          `line ${number}: an in-scope entry is \`- <title>\` with indented \`- PROGRAM › scenario\` lines below it, got: ${trimmed}`
        )
        continue
      }
      const text = nested[1].trim()
      const fresh = /^new:\s*(.*)$/i.exec(text)
      if (fresh !== null) {
        item.newBehaviour = (fresh[1] ?? "").trim()
        continue
      }
      const [program, scenario] = splitFirst(text, cite.trim())
      if (scenario === undefined || program.length === 0 || scenario.length === 0) {
        violations.push(`line ${number}: a citation is \`PROGRAM › scenario title\`, got: ${text}`)
        continue
      }
      item.citations.push(Citation.make({ program, scenario }))
      continue
    }
    const bullet = (top ?? nested)?.[1]?.trim()
    if (bullet === undefined) {
      violations.push(`line ${number}: expected a \`- \` entry, got: ${trimmed}`)
      continue
    }
    if (current === "programs") {
      const [name, reason] = splitFirst(bullet, dash)
      programs.push(ConsideredProgram.make({ name, reason: reason ?? "" }))
      continue
    }
    const entry = parseDisposed(bullet)
    if (entry === undefined) {
      violations.push(
        `line ${number}: an entry here is \`- PROGRAM › scenario title — note\`, got: ${bullet}`
      )
      continue
    }
    disposed[current].push(entry)
  }

  if (epicId === undefined) violations.push("missing the `# Epic brief: <id>` title")
  if (status === undefined) violations.push("missing the `Status:` line")
  if (header.request === undefined) violations.push("missing the `Request:` line")
  if (header.legacy === undefined) violations.push("missing the `Legacy:` line")
  if (violations.length > 0 || epicId === undefined || status === undefined) {
    return yield* EpicBriefInvalid.make({
      ...(path === undefined ? {} : { path }),
      violations
    })
  }
  const text = (key: "goal" | "constraints" | "feedback"): string =>
    proseLines[key].join("\n").trim()
  return EpicBrief.make({
    epicId,
    status,
    request: header.request ?? "",
    legacy: header.legacy ?? "",
    goal: text("goal"),
    programs,
    scope: scope.map((item) =>
      ScopeItem.make({
        title: item.title,
        citations: item.citations,
        ...(item.newBehaviour === undefined ? {} : { newBehaviour: item.newBehaviour })
      })
    ),
    dropped: disposed.dropped,
    provided: disposed.provided,
    deferred: disposed.deferred,
    constraints: text("constraints"),
    openPoints: points.points,
    feedback: text("feedback")
  })
})
