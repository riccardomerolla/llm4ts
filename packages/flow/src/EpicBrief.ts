import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { JsonSchema } from "@llm4ts/core/Models"
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

/** A scenario title holding the note separator is quoted, so the note still splits cleanly. */
const quoted = (scenario: string): string =>
  scenario.includes(dash.trim()) ? `\`${scenario}\`` : scenario

const unquoted = (scenario: string): string =>
  scenario.length > 1 && scenario.startsWith("`") && scenario.endsWith("`")
    ? scenario.slice(1, -1)
    : scenario

const renderDisposed = (entry: Disposed): string =>
  `- ${entry.program}${cite}${quoted(entry.scenario)}${entry.note.length === 0 ? "" : `${dash}${entry.note}`}`

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
  const close = rest.startsWith("`") ? rest.indexOf("`", 1) : -1
  if (close > 0) {
    const tail = rest.slice(close + 1).trim()
    const note = tail.startsWith(dash.trim()) ? tail.slice(dash.trim().length).trim() : tail
    return Disposed.make({ program, scenario: rest.slice(1, close), note })
  }
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
  let fenceLine = 0

  const lines = markdown.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const number = index + 1
    const raw = lines[index] ?? ""
    const trimmed = raw.trim()
    const isProse = current === "goal" || current === "constraints" || current === "feedback"
    if (trimmed.startsWith("```")) {
      fenced = !fenced
      if (fenced) fenceLine = number
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
      item.citations.push(Citation.make({ program, scenario: unquoted(scenario) }))
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
  if (fenced) {
    // Everything after it was read as code: nothing below that line can be trusted.
    violations.push(`line ${fenceLine}: the code fence opened here is never closed`)
  }
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

// ---- Normalizing --------------------------------------------------------------

const oneLine = (text: string): string => text.replace(/\s*\r?\n\s*/g, " ").trim()

/** Prose the file format can hold: no `## ` line of its own, no fence left open. */
const safeProse = (text: string): string => {
  let fenced = false
  const lines = text.split(/\r?\n/).map((line) => {
    if (line.trim().startsWith("```")) {
      fenced = !fenced
      return line
    }
    return !fenced && /^\s*##\s/.test(line) ? line.replace(/^(\s*)##\s/, "$1### ") : line
  })
  return (fenced ? [...lines, "```"] : lines).join("\n")
}

const safeDisposed = (entry: Disposed): Disposed =>
  Disposed.make({
    program: oneLine(entry.program),
    scenario: oneLine(entry.scenario),
    note: oneLine(entry.note)
  })

/**
 * The brief as the file can hold it. A model's proposal may carry a newline
 * in a title, a `## ` line in the goal, an unclosed fence; written as they
 * are, those would parse back as something else on the next run. Fields that
 * live on one line are folded onto one, prose is made safe for the section
 * grammar, and nothing else changes.
 */
export const normalizeBrief = (brief: EpicBrief): EpicBrief =>
  EpicBrief.make({
    epicId: oneLine(brief.epicId),
    status: brief.status,
    request: oneLine(brief.request),
    legacy: oneLine(brief.legacy),
    goal: safeProse(brief.goal),
    programs: brief.programs.map((program) =>
      ConsideredProgram.make({ name: oneLine(program.name), reason: oneLine(program.reason) })
    ),
    scope: brief.scope.map((item) =>
      ScopeItem.make({
        title: oneLine(item.title).replace(/^-+\s*/, ""),
        citations: item.citations.map((citation) =>
          Citation.make({
            program: oneLine(citation.program),
            scenario: oneLine(citation.scenario)
          })
        ),
        ...(item.newBehaviour === undefined ? {} : { newBehaviour: oneLine(item.newBehaviour) })
      })
    ),
    dropped: brief.dropped.map(safeDisposed),
    provided: brief.provided.map(safeDisposed),
    deferred: brief.deferred.map(safeDisposed),
    constraints: safeProse(brief.constraints),
    openPoints: brief.openPoints.map((point) =>
      OpenPoint.make({
        number: point.number,
        question: oneLine(point.question),
        ...(point.answer === undefined ? {} : { answer: oneLine(point.answer) })
      })
    ),
    feedback: safeProse(brief.feedback)
  })

// ---- Checks -------------------------------------------------------------------

export interface PackProgram {
  readonly name: string
  /** The first paragraph of the program's spec. */
  readonly summary: string
  readonly scenarios: ReadonlyArray<string>
}

/** A disposition `modernize-refine` recorded in the legacy pack's decisions.md. */
export interface RefineDisposition {
  readonly program: string
  /** Absent: the disposition covers every scenario of the program. */
  readonly scenario?: string
  readonly disposition: "drop" | "provided" | "defer" | "wrap"
}

/** What the checks need from the extract pack, built by the flow from its files. */
export interface PackIndex {
  readonly programs: ReadonlyArray<PackProgram>
  readonly refine: ReadonlyArray<RefineDisposition>
}

export const BriefProblem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("UnknownProgram"), program: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("UnknownScenario"),
    program: Schema.String,
    scenario: Schema.String,
    closest: Schema.optionalKey(Schema.String)
  }),
  Schema.Struct({
    kind: Schema.Literal("MissingPointer"),
    program: Schema.String,
    scenario: Schema.String,
    pointer: Schema.String
  }),
  Schema.Struct({ kind: Schema.Literal("MissingReason"), where: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("DuplicateDisposition"),
    program: Schema.String,
    scenario: Schema.String,
    lists: Schema.Array(Schema.String)
  }),
  Schema.Struct({
    kind: Schema.Literal("Unaccounted"),
    program: Schema.String,
    scenario: Schema.String
  }),
  Schema.Struct({
    kind: Schema.Literal("RefineConflict"),
    program: Schema.String,
    scenario: Schema.String,
    disposition: Schema.String
  }),
  Schema.Struct({
    kind: Schema.Literal("AlreadyOwned"),
    program: Schema.String,
    scenario: Schema.String,
    /** The approved epic that already has the scenario in scope. */
    epic: Schema.String
  }),
  Schema.Struct({
    kind: Schema.Literal("ContradictsBrief"),
    program: Schema.String,
    scenario: Schema.String,
    /** The approved epic that decided otherwise. */
    epic: Schema.String,
    /** This brief's disposition, in words. */
    here: Schema.String,
    /** The other epic's disposition, in words. */
    disposition: Schema.String
  }),
  Schema.Struct({
    kind: Schema.Literal("ApprovedWithOpenPoints"),
    numbers: Schema.Array(Schema.Int)
  })
])
export type BriefProblem = typeof BriefProblem.Type

export const renderBriefProblem = (problem: BriefProblem): string => {
  switch (problem.kind) {
    case "UnknownProgram":
      return `${problem.program} is not a program of the extract pack`
    case "UnknownScenario":
      return `${problem.program} has no scenario "${problem.scenario}"${
        problem.closest === undefined ? "" : ` (did you mean "${problem.closest}"?)`
      }`
    case "MissingPointer":
      return `${problem.program}${cite}${problem.scenario} is marked provided by "${problem.pointer}", which does not exist in the target`
    case "MissingReason":
      return `${problem.where} needs a reason`
    case "DuplicateDisposition":
      return `${problem.program}${cite}${problem.scenario} appears in several lists: ${problem.lists.join(", ")}`
    case "Unaccounted":
      return `${problem.program}${cite}${problem.scenario} has no disposition: put it in scope, or drop, mark provided or defer it`
    case "RefineConflict":
      return `${problem.program}${cite}${problem.scenario} is in scope, but modernize-refine marked it ${problem.disposition}; answer \`keep: <why>\` to keep it in scope, or move it out`
    case "AlreadyOwned":
      return `${problem.program}${cite}${problem.scenario} is in scope here and in epic ${problem.epic}; answer \`keep: <why>\` to share it, or move it out`
    case "ContradictsBrief":
      return `${problem.program}${cite}${problem.scenario} is ${problem.here} here, but epic ${problem.epic} has it ${problem.disposition}; answer \`keep: <why>\` to keep this brief's decision, or follow the other`
    case "ApprovedWithOpenPoints":
      return `the brief is approved with unanswered open points: ${problem.numbers.join(", ")}`
  }
}

/** How a brief disposes of a scenario. */
export type BriefDisposition = "in-scope" | "dropped" | "provided" | "deferred"

export const dispositionWords: Readonly<Record<BriefDisposition, string>> = {
  "in-scope": "in scope",
  dropped: "dropped",
  provided: "provided",
  deferred: "deferred"
}

/** What an approved brief of another epic decided about a scenario (the coverage ledger). */
export interface InheritedDecision {
  readonly program: string
  readonly scenario: string
  readonly epic: string
  readonly disposition: BriefDisposition
  readonly note: string
}

/**
 * Whether the brief overrides a check on purpose: the check's own `[check]`
 * question, answered `keep: <why>`. Any other answer, or an answer to
 * another question, overrides nothing.
 */
export const hasOverride = (brief: EpicBrief, problem: BriefProblem): boolean =>
  brief.openPoints.some(
    (point) =>
      point.question === `${checkMark} ${renderBriefProblem(problem)}` &&
      (point.answer ?? "").trim().toLowerCase().startsWith("keep")
  )

/** The pointers of the provided entries: what the caller verifies before checking. */
export const providedPointers = (brief: EpicBrief): ReadonlyArray<string> => [
  ...new Set(brief.provided.map((entry) => entry.note).filter((note) => note.length > 0))
]

const loose = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase()
const slot = (program: string, scenario: string): string => `${program}\u0000${scenario}`

export interface BriefCheckInputs {
  readonly pack: PackIndex
  /** The provided pointers that were found in the target (or its pack). */
  readonly pointers: ReadonlySet<string>
}

/** Every problem of a brief against the pack, all at once; empty means acceptable. */
export const checkEpicBrief = (
  brief: EpicBrief,
  inputs: BriefCheckInputs
): ReadonlyArray<BriefProblem> => {
  const problems: Array<BriefProblem> = []
  const programs = new Map(inputs.pack.programs.map((program) => [program.name, program]))
  const lists = new Map<string, Array<string>>()
  const place = (list: string, program: string, scenario: string): void => {
    const known = programs.get(program)
    if (known === undefined) {
      if (!problems.some((p) => p.kind === "UnknownProgram" && p.program === program)) {
        problems.push({ kind: "UnknownProgram", program })
      }
      return
    }
    if (!known.scenarios.includes(scenario)) {
      const closest = known.scenarios.find((title) => loose(title) === loose(scenario))
      problems.push({
        kind: "UnknownScenario",
        program,
        scenario,
        ...(closest === undefined ? {} : { closest })
      })
      return
    }
    const key = slot(program, scenario)
    const seen = lists.get(key) ?? []
    if (!seen.includes(list)) lists.set(key, [...seen, list])
  }

  for (const item of brief.scope) {
    if (item.citations.length === 0 && (item.newBehaviour ?? "").trim().length === 0) {
      problems.push({
        kind: "MissingReason",
        where: `in-scope item "${item.title}" cites nothing and`
      })
    }
    for (const citation of item.citations) place("in scope", citation.program, citation.scenario)
  }
  for (const entry of brief.dropped) {
    place("dropped", entry.program, entry.scenario)
    if (entry.note.trim().length === 0) {
      problems.push({
        kind: "MissingReason",
        where: `dropped ${entry.program}${cite}${entry.scenario}`
      })
    }
  }
  for (const entry of brief.provided) {
    place("provided", entry.program, entry.scenario)
    if (!inputs.pointers.has(entry.note)) {
      problems.push({
        kind: "MissingPointer",
        program: entry.program,
        scenario: entry.scenario,
        pointer: entry.note
      })
    }
  }
  for (const entry of brief.deferred) {
    place("deferred", entry.program, entry.scenario)
    if (entry.note.trim().length === 0) {
      problems.push({
        kind: "MissingReason",
        where: `deferred ${entry.program}${cite}${entry.scenario}`
      })
    }
  }

  for (const [key, where] of lists) {
    if (where.length > 1) {
      const [program = "", scenario = ""] = key.split("\u0000")
      problems.push({ kind: "DuplicateDisposition", program, scenario, lists: where })
    }
  }
  // Complete means every program the brief touches: the ones it lists as
  // considered, and any it cites or disposes of without listing.
  const touched = [
    ...new Set([
      ...brief.programs.map((program) => program.name),
      ...[...lists.keys()].map((key) => key.split("\u0000")[0] ?? "")
    ])
  ]
  for (const name of touched) {
    const known = programs.get(name)
    if (known === undefined) {
      if (!problems.some((p) => p.kind === "UnknownProgram" && p.program === name)) {
        problems.push({ kind: "UnknownProgram", program: name })
      }
      continue
    }
    for (const scenario of known.scenarios) {
      if (!lists.has(slot(known.name, scenario))) {
        problems.push({ kind: "Unaccounted", program: known.name, scenario })
      }
    }
  }

  // A scenario refine took out of the pack's scope can come back only on purpose.
  for (const item of brief.scope) {
    for (const citation of item.citations) {
      const refined = inputs.pack.refine.find(
        (entry) =>
          entry.program === citation.program &&
          (entry.scenario === undefined || entry.scenario === citation.scenario) &&
          (entry.disposition === "drop" || entry.disposition === "provided")
      )
      if (refined !== undefined) {
        const conflict: BriefProblem = {
          kind: "RefineConflict",
          program: citation.program,
          scenario: citation.scenario,
          disposition: refined.disposition
        }
        if (!hasOverride(brief, conflict)) problems.push(conflict)
      }
    }
  }

  const pending = unanswered(brief)
  if (brief.status === "approved" && pending.length > 0) {
    problems.push({ kind: "ApprovedWithOpenPoints", numbers: pending.map((point) => point.number) })
  }
  return problems
}

// ---- Proposals ----------------------------------------------------------------

/** The programs of the pack a request touches; the model's first typed reply. */
export class ProgramSelection extends Schema.Class<ProgramSelection>("ProgramSelection")({
  programs: Schema.Array(ConsideredProgram)
}) {}

/** The model's typed proposal for a brief; checked before anything is written. */
export class EpicBriefProposal extends Schema.Class<EpicBriefProposal>("EpicBriefProposal")({
  goal: Schema.String,
  scope: Schema.Array(ScopeItem),
  dropped: Schema.Array(Disposed),
  provided: Schema.Array(Disposed),
  deferred: Schema.Array(Disposed),
  constraints: Schema.String,
  /** Questions only a human can answer. */
  openPoints: Schema.Array(Schema.String)
}) {}

const text: JsonSchema = { type: "string" }
const disposedList = (note: string): JsonSchema => ({
  type: "array",
  items: {
    type: "object",
    properties: {
      program: text,
      scenario: text,
      note: { type: "string", description: note }
    },
    required: ["program", "scenario", "note"]
  }
})

export const programSelectionJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    programs: {
      type: "array",
      items: {
        type: "object",
        properties: { name: text, reason: text },
        required: ["name", "reason"]
      }
    }
  },
  required: ["programs"]
}

export const epicBriefProposalJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    goal: text,
    scope: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: text,
          citations: {
            type: "array",
            items: {
              type: "object",
              properties: { program: text, scenario: text },
              required: ["program", "scenario"]
            }
          },
          newBehaviour: {
            type: "string",
            description: "only for an item with no citation: why it has no legacy counterpart"
          }
        },
        required: ["title", "citations"]
      }
    },
    dropped: disposedList("why the behaviour is not carried over"),
    provided: disposedList("the target path that already does it"),
    deferred: disposedList("why it waits and for what"),
    constraints: text,
    openPoints: { type: "array", items: text }
  },
  required: ["goal", "scope", "dropped", "provided", "deferred", "constraints", "openPoints"]
}

export interface AssembleOptions {
  readonly epicId: string
  readonly request: string
  readonly legacy: string
  readonly programs: ReadonlyArray<ConsideredProgram>
  readonly proposal: EpicBriefProposal
  /** The brief this one revises: its unanswered points the proposal did not restate are kept. */
  readonly previous?: EpicBrief
  /** Problems the fix round could not clear: raised as `[check]` open points. */
  readonly problems?: ReadonlyArray<BriefProblem>
}

export const checkMark = "[check]"

/**
 * The next draft: never approved, feedback consumed, open points renumbered.
 * Answered points are folded in by the revision and go, except answered
 * `[check]` points: those are the human overriding a check (a scenario
 * refine dropped, kept on purpose) and stay as the record of it.
 */
export const assembleBrief = (options: AssembleOptions): EpicBrief => {
  const previous = options.previous
  const isAnswered = (point: OpenPoint): boolean => (point.answer ?? "").trim().length > 0
  const carried: ReadonlyArray<{ readonly question: string; readonly answer?: string }> =
    previous === undefined
      ? []
      : [
          ...unanswered(previous)
            .filter((point) => !point.question.startsWith(checkMark))
            .map((point) => ({ question: point.question })),
          ...previous.openPoints
            .filter((point) => point.question.startsWith(checkMark) && isAnswered(point))
            .map((point) => ({ question: point.question, answer: (point.answer ?? "").trim() }))
        ]
  const all: ReadonlyArray<{ readonly question: string; readonly answer?: string }> = [
    ...options.proposal.openPoints.map((question) => ({ question })),
    ...carried,
    ...(options.problems ?? []).map((problem) => ({
      question: `${checkMark} ${renderBriefProblem(problem)}`
    }))
  ]
  const unique = all.filter(
    (entry, index) => all.findIndex((other) => other.question === entry.question) === index
  )
  return EpicBrief.make({
    epicId: options.epicId,
    status: "draft",
    request: options.request,
    legacy: options.legacy,
    goal: options.proposal.goal,
    programs: options.programs,
    scope: options.proposal.scope,
    dropped: options.proposal.dropped,
    provided: options.proposal.provided,
    deferred: options.proposal.deferred,
    constraints: options.proposal.constraints,
    openPoints: unique.map((entry, index) =>
      OpenPoint.make({
        number: index + 1,
        question: entry.question,
        ...(entry.answer === undefined ? {} : { answer: entry.answer })
      })
    ),
    feedback: ""
  })
}

// ---- The loop -----------------------------------------------------------------

export type LoopAction = "propose" | "revise" | "halt" | "await-approval" | "validate"

/** What one run does, decided from the file alone. */
export const loopAction = (brief: EpicBrief | undefined): LoopAction => {
  if (brief === undefined) return "propose"
  if (brief.status === "approved") return "validate"
  // An answered `[check]` point is an override on file, not something to fold in.
  const answered = brief.openPoints.some(
    (point) => (point.answer ?? "").trim().length > 0 && !point.question.startsWith(checkMark)
  )
  if (answered || brief.feedback.trim().length > 0) return "revise"
  return unanswered(brief).length > 0 ? "halt" : "await-approval"
}

const notes = (brief: EpicBrief): ReadonlyMap<string, readonly [string, string]> => {
  const found = new Map<string, readonly [string, string]>()
  const add = (kind: string, entries: ReadonlyArray<Disposed>): void => {
    for (const entry of entries) {
      found.set(`${entry.program}${cite}${entry.scenario}`, [kind, entry.note])
    }
  }
  add("reason", brief.dropped)
  add("pointer", brief.provided)
  add("note", brief.deferred)
  return found
}

const dispositions = (brief: EpicBrief): ReadonlyMap<string, string> => {
  const found = new Map<string, string>()
  const add = (list: string, program: string, scenario: string): void => {
    found.set(`${program}${cite}${scenario}`, list)
  }
  for (const item of brief.scope) {
    for (const citation of item.citations) add("in scope", citation.program, citation.scenario)
  }
  for (const entry of brief.dropped) add("dropped", entry.program, entry.scenario)
  for (const entry of brief.provided) add("provided", entry.program, entry.scenario)
  for (const entry of brief.deferred) add("deferred", entry.program, entry.scenario)
  return found
}

/** What a revision changed, in lines a person reads; empty when nothing did. */
export const diffBriefs = (
  previous: EpicBrief | undefined,
  next: EpicBrief
): ReadonlyArray<string> => {
  if (previous === undefined) {
    return [
      `programs considered: ${next.programs.map((program) => program.name).join(", ") || "none"}`,
      `in scope: ${next.scope.length} item(s); dropped: ${next.dropped.length}; provided by the target: ${next.provided.length}; deferred: ${next.deferred.length}`,
      `open points: ${next.openPoints.length}`
    ]
  }
  const changes: Array<string> = []
  const before = new Set(previous.programs.map((program) => program.name))
  const after = new Set(next.programs.map((program) => program.name))
  for (const name of after) if (!before.has(name)) changes.push(`program added: ${name}`)
  for (const name of before) if (!after.has(name)) changes.push(`program removed: ${name}`)
  const was = dispositions(previous)
  const is = dispositions(next)
  for (const [scenario, list] of is) {
    const old = was.get(scenario)
    if (old === undefined) changes.push(`${scenario}: added to ${list}`)
    else if (old !== list) changes.push(`${scenario}: ${old} → ${list}`)
  }
  for (const [scenario, list] of was) {
    if (!is.has(scenario)) changes.push(`${scenario}: removed (was ${list})`)
  }
  // A rationale is what an audit reads: a changed one is never silent.
  const noted = notes(previous)
  for (const [scenario, [kind, note]] of notes(next)) {
    const old = noted.get(scenario)
    if (old !== undefined && old[0] === kind && old[1] !== note) {
      changes.push(`${scenario}: ${kind} changed`)
    }
  }
  const titled = new Set(previous.scope.map((item) => item.title))
  const titles = new Set(next.scope.map((item) => item.title))
  for (const title of titles) if (!titled.has(title)) changes.push(`item added: ${title}`)
  for (const title of titled) if (!titles.has(title)) changes.push(`item removed: ${title}`)
  const asking = new Set(next.openPoints.map((point) => point.question))
  const asked = new Set(previous.openPoints.map((point) => point.question))
  for (const question of asking)
    if (!asked.has(question)) changes.push(`open point raised: ${question}`)
  for (const point of previous.openPoints) {
    if (asking.has(point.question)) continue
    const answer = (point.answer ?? "").trim()
    changes.push(
      `open point closed: ${point.question}${answer.length === 0 ? "" : ` (answer: ${answer})`}`
    )
  }
  if (previous.goal !== next.goal) changes.push("goal rewritten")
  if (previous.constraints !== next.constraints) changes.push("constraints rewritten")
  return changes
}
