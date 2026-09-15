import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { JsonSchema } from "@llm4ts/core/Models"
import { DecisionsInvalid } from "./FlowError.ts"

export { DecisionsInvalid, OpenPointsPending } from "./FlowError.ts"

/**
 * The scope overlay of a modernization spec pack (ADR 0015): what the
 * extracted pack should BECOME, kept apart from the judged, source-grounded
 * record of what the legacy does. Keyed at program and Gherkin-scenario
 * level only; `migrate` is the implicit default and is never written.
 *
 * The file is the state. Marks (`?`) ask the model to propose, deepen marks
 * send the analyst back to the source with a focus, open points are the
 * questions a proposal could not settle and the answers a human appended,
 * and the approval marker is the gate seed checks.
 */
export const Disposition = Schema.Literals(["drop", "provided", "defer", "wrap"])
export type Disposition = typeof Disposition.Type

const dispositionWords: ReadonlyArray<string> = ["drop", "provided", "defer", "wrap", "?"]

const decidedFields = {
  reason: Schema.String,
  /** `provided` only: the target path or capability that already covers it. */
  pointer: Schema.optionalKey(Schema.String),
  /** `defer` only: the wave or milestone the behaviour moves to. */
  milestone: Schema.optionalKey(Schema.String),
  decidedBy: Schema.optionalKey(Schema.String),
  decidedAt: Schema.optionalKey(Schema.String)
}

export class ProgramDecision extends Schema.Class<ProgramDecision>("ProgramDecision")({
  program: Schema.String,
  disposition: Disposition,
  ...decidedFields
}) {}

export class ScenarioDecision extends Schema.Class<ScenarioDecision>("ScenarioDecision")({
  program: Schema.String,
  scenario: Schema.String,
  disposition: Disposition,
  ...decidedFields
}) {}

/** A `?` line: "propose a disposition for me, here is my note". */
export class ProposalMark extends Schema.Class<ProposalMark>("ProposalMark")({
  program: Schema.String,
  scenario: Schema.optionalKey(Schema.String),
  note: Schema.String
}) {}

/** A program to re-extract with a mandatory focus; `done` carries the commit once executed. */
export class DeepenMark extends Schema.Class<DeepenMark>("DeepenMark")({
  program: Schema.String,
  focus: Schema.String,
  done: Schema.optionalKey(Schema.String)
}) {}

export class OpenPoint extends Schema.Class<OpenPoint>("OpenPoint")({
  number: Schema.Int,
  question: Schema.String,
  answer: Schema.optionalKey(Schema.String)
}) {}

export class Decisions extends Schema.Class<Decisions>("Decisions")({
  programs: Schema.Array(ProgramDecision),
  scenarios: Schema.Array(ScenarioDecision),
  marks: Schema.Array(ProposalMark),
  deepen: Schema.Array(DeepenMark),
  openPoints: Schema.Array(OpenPoint),
  approved: Schema.Boolean
}) {
  static readonly empty = (): Decisions =>
    Decisions.make({
      programs: [],
      scenarios: [],
      marks: [],
      deepen: [],
      openPoints: [],
      approved: false
    })

  get isEmpty(): boolean {
    return (
      this.programs.length === 0 &&
      this.scenarios.length === 0 &&
      this.marks.length === 0 &&
      this.deepen.length === 0 &&
      this.openPoints.length === 0
    )
  }

  get pendingDeepen(): ReadonlyArray<DeepenMark> {
    return this.deepen.filter((mark) => mark.done === undefined)
  }

  get unansweredOpenPoints(): ReadonlyArray<OpenPoint> {
    return this.openPoints.filter((point) => point.answer === undefined)
  }

  /** The program-level decision, if the whole program is disposed. */
  programDecision(program: string): ProgramDecision | undefined {
    return this.programs.find((entry) => entry.program === program)
  }

  /** The disposed scenario titles of one program (program-level decisions do not expand here). */
  disposedScenarios(program: string): ReadonlySet<string> {
    return new Set(
      this.scenarios.filter((entry) => entry.program === program).map((entry) => entry.scenario)
    )
  }
}

// ---- Guide ------------------------------------------------------------------

export const decisionsGuide = [
  "## How to mark",
  "",
  "Every program and scenario of the spec pack migrates unless it is listed",
  "here. List only the exceptions, one per line, as `- <key>: <disposition> — <why>`.",
  "A key is a program name (`accountOverview`) or `<program> / <scenario title>`",
  "exactly as the title reads in the .feature file. Dispositions:",
  "",
  "- `drop` — deprecated, will not exist in the target. Needs a reason.",
  "- `provided` — the target already has it or solves it differently. Needs the",
  "  target path or capability that provides it, then `;` and a note.",
  "- `defer` — still to migrate, not in this delivery. Needs a reason; add",
  "  `; milestone: <wave or name>` to say when.",
  "- `wrap` — programs only: stays on the legacy platform behind an API.",
  "- `?` — ask the model to propose one; write your note after the dash.",
  "",
  "Append `(who, YYYY-MM-DD)` to sign a decision. Under `## Deepen`, list a",
  "program with what the analyst must look for; the flow re-extracts it and",
  "stamps `[done <commit>]`. Under `## Open points`, answer a question by adding",
  "an indented `answer: …` line below it, then rerun. Flip the marker at the",
  "end when everything above is what you want seeded.",
  "",
  "```markdown",
  "- promoQ3: drop — expired 2011 campaign (riccardo, 2026-09-15)",
  "- login: provided — src/auth/AuthProvider.tsx; the target owns login and session",
  "- help: defer — content team rewrites the FAQ; milestone: wave-3",
  "- accountOverview / Export movements as CSV: drop — reporting moves to the data platform",
  "- oldTransfer: ? — looks dead, confirm nothing links here",
  "```"
].join("\n")

// ---- Parse ------------------------------------------------------------------

const approvedMarker = /^- \[([ xX])\] Approved\s*$/

/** `- [x] Approved` → true, `- [ ] Approved` → false, anything else → undefined. */
export const parseApprovalMarker = (trimmed: string): boolean | undefined => {
  const marker = approvedMarker.exec(trimmed)
  return marker === null ? undefined : marker[1] !== " "
}

/**
 * Collects a `## Open points` section line by line: `1. <question>`, an
 * indented `answer: …` below it, and continuation lines of either. Shared by
 * every overlay that carries open points.
 */
export const makeOpenPointsCollector = (): {
  readonly points: Array<OpenPoint>
  readonly add: (line: number, trimmed: string) => string | undefined
} => {
  const points: Array<OpenPoint> = []
  return {
    points,
    add: (line, trimmed) => {
      const question = /^(\d+)\.\s+(.*)$/.exec(trimmed)
      if (question !== null) {
        points.push(
          OpenPoint.make({
            number: Number.parseInt(question[1] ?? "0", 10),
            question: (question[2] ?? "").trim()
          })
        )
        return undefined
      }
      const answer = /^answer:\s*(.*)$/.exec(trimmed)
      const last = points.at(-1)
      if (last === undefined) {
        return `line ${line}: open points are numbered \`1. <question>\`, got: ${trimmed}`
      }
      const text = answer === null ? trimmed : (answer[1] ?? "").trim()
      points[points.length - 1] =
        answer !== null || last.answer !== undefined
          ? OpenPoint.make({
              number: last.number,
              question: last.question,
              answer: last.answer === undefined ? text : `${last.answer} ${text}`
            })
          : // A continuation line of the question itself.
            OpenPoint.make({ number: last.number, question: `${last.question} ${text}` })
      return undefined
    }
  }
}

export const renderOpenPoints = (points: ReadonlyArray<OpenPoint>): ReadonlyArray<string> =>
  points.flatMap((point) => [
    `${point.number}. ${point.question}`,
    ...(point.answer === undefined ? [] : [`   answer: ${point.answer}`])
  ])
const sectionNames = ["Programs", "Scenarios", "Deepen", "Open points"] as const
type Section = (typeof sectionNames)[number] | "other"

const signature = /\s*\(([^()]+?),\s*(\d{4}-\d{2}-\d{2})\)\s*$/
const milestoneTail = /;\s*milestone:\s*([^;]+?)\s*$/

interface Decided {
  readonly reason: string
  readonly pointer?: string
  readonly milestone?: string
  readonly decidedBy?: string
  readonly decidedAt?: string
}

const parseDecided = (
  disposition: Disposition,
  rest: string,
  line: number,
  key: string
): Decided | string => {
  let body = rest.trim()
  const signed = signature.exec(body)
  const decidedBy = signed?.[1]?.trim()
  const decidedAt = signed?.[2]
  if (signed !== null) {
    body = body.slice(0, signed.index).trim()
  }
  const milestoned = milestoneTail.exec(body)
  const milestone = milestoned?.[1]?.trim()
  if (milestoned !== null) {
    body = body.slice(0, milestoned.index).trim()
  }
  let pointer: string | undefined
  if (disposition === "provided") {
    const semicolon = body.indexOf(";")
    const candidate = (semicolon < 0 ? body : body.slice(0, semicolon)).trim()
    if (candidate.length === 0 || /\s/.test(candidate)) {
      return `line ${line}: 'provided' needs a target pointer before ';' — \`- ${key}: provided — <path>; <note>\``
    }
    pointer = candidate
    body = semicolon < 0 ? "" : body.slice(semicolon + 1).trim()
  } else if (body.length === 0) {
    return `line ${line}: '${disposition}' needs a reason after '—' — \`- ${key}: ${disposition} — <why>\``
  }
  return {
    reason: body,
    ...(pointer === undefined ? {} : { pointer }),
    ...(milestone === undefined ? {} : { milestone }),
    ...(decidedBy === undefined ? {} : { decidedBy }),
    ...(decidedAt === undefined ? {} : { decidedAt })
  }
}

const entryLine = /^- (.+?): (\S+)(?:\s+—\s*(.*))?$/

const isDisposition = (word: string): word is Disposition =>
  word === "drop" || word === "provided" || word === "defer" || word === "wrap"

export const parseDecisions = Effect.fn("@llm4ts/flow/Decisions.parse")(function* (
  markdown: string,
  path?: string
): Effect.fn.Return<Decisions, DecisionsInvalid> {
  const programs: Array<ProgramDecision> = []
  const scenarios: Array<ScenarioDecision> = []
  const marks: Array<ProposalMark> = []
  const deepen: Array<DeepenMark> = []
  const points = makeOpenPointsCollector()
  const violations: Array<string> = []
  let approved = false
  let section: Section = "other"
  let fenced = false
  const lines = markdown.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const number = index + 1
    const raw = lines[index] ?? ""
    const trimmed = raw.trim()
    if (trimmed.startsWith("```")) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      continue
    }
    const marker = parseApprovalMarker(trimmed)
    if (marker !== undefined) {
      approved = marker
      continue
    }
    if (trimmed.startsWith("## ")) {
      const title = trimmed.slice(3).trim()
      section = sectionNames.find((name) => name === title) ?? "other"
      continue
    }
    if (trimmed.startsWith("# ") || trimmed.length === 0) {
      continue
    }
    if (section === "Programs" || section === "Scenarios") {
      const match = entryLine.exec(trimmed)
      if (match === null) {
        violations.push(
          `line ${number}: expected \`- <key>: <disposition> — <why>\`, got: ${trimmed}`
        )
        continue
      }
      const key = match[1]?.trim() ?? ""
      const word = match[2] ?? ""
      const rest = match[3] ?? ""
      const slash = key.indexOf(" / ")
      const program = (section === "Scenarios" && slash > 0 ? key.slice(0, slash) : key).trim()
      const scenario =
        section === "Scenarios" && slash > 0 ? key.slice(slash + 3).trim() : undefined
      if (section === "Scenarios" && scenario === undefined) {
        violations.push(
          `line ${number}: scenario keys read \`<program> / <scenario title>\`, got: ${key}`
        )
        continue
      }
      if (word === "?") {
        marks.push(
          ProposalMark.make({
            program,
            ...(scenario === undefined ? {} : { scenario }),
            note: rest.trim()
          })
        )
        continue
      }
      if (!isDisposition(word)) {
        violations.push(
          `line ${number}: unknown disposition '${word}' (${dispositionWords.join(" | ")})`
        )
        continue
      }
      const decided = parseDecided(word, rest, number, key)
      if (typeof decided === "string") {
        violations.push(decided)
        continue
      }
      if (scenario === undefined) {
        programs.push(ProgramDecision.make({ program, disposition: word, ...decided }))
      } else if (word === "wrap") {
        violations.push(`line ${number}: 'wrap' applies to programs, not scenarios`)
      } else {
        scenarios.push(ScenarioDecision.make({ program, scenario, disposition: word, ...decided }))
      }
      continue
    }
    if (section === "Deepen") {
      const match = /^- ([^:]+?)(?::\s*(.*))?$/.exec(trimmed)
      const program = match?.[1]?.trim() ?? trimmed.replace(/^- /, "").trim()
      const body = match?.[2]?.trim() ?? ""
      const done = /\s*\[done ([^\]]+)\]\s*$/.exec(body)
      const focus = done === null ? body : body.slice(0, done.index).trim()
      if (focus.length === 0) {
        violations.push(
          `line ${number}: deepen marks need a focus — \`- ${program}: <what to look for>\``
        )
        continue
      }
      deepen.push(
        DeepenMark.make({
          program,
          focus,
          ...(done?.[1] === undefined ? {} : { done: done[1].trim() })
        })
      )
      continue
    }
    if (section === "Open points") {
      const violation = points.add(number, trimmed)
      if (violation !== undefined) {
        violations.push(violation)
      }
    }
  }
  if (violations.length > 0) {
    return yield* DecisionsInvalid.make({ ...(path === undefined ? {} : { path }), violations })
  }
  return Decisions.make({
    programs,
    scenarios,
    marks,
    deepen,
    openPoints: points.points,
    approved
  })
})

// ---- Render -----------------------------------------------------------------

const renderDecided = (disposition: Disposition, entry: Decided): string => {
  const body =
    disposition === "provided" ? `${entry.pointer ?? ""}; ${entry.reason}`.trimEnd() : entry.reason
  const milestone = entry.milestone === undefined ? "" : `; milestone: ${entry.milestone}`
  const signed =
    entry.decidedBy === undefined || entry.decidedAt === undefined
      ? ""
      : ` (${entry.decidedBy}, ${entry.decidedAt})`
  return `${disposition} — ${body}${milestone}${signed}`
}

export const renderDecisions = (decisions: Decisions): string => {
  const programLines = [
    ...decisions.programs.map(
      (entry) => `- ${entry.program}: ${renderDecided(entry.disposition, entry)}`
    ),
    ...decisions.marks
      .filter((mark) => mark.scenario === undefined)
      .map((mark) => `- ${mark.program}: ? — ${mark.note}`.trimEnd())
  ]
  const scenarioLines = [
    ...decisions.scenarios.map(
      (entry) =>
        `- ${entry.program} / ${entry.scenario}: ${renderDecided(entry.disposition, entry)}`
    ),
    ...decisions.marks
      .filter((mark) => mark.scenario !== undefined)
      .map((mark) => `- ${mark.program} / ${mark.scenario}: ? — ${mark.note}`.trimEnd())
  ]
  const deepenLines = decisions.deepen.map(
    (mark) =>
      `- ${mark.program}: ${mark.focus}${mark.done === undefined ? "" : ` [done ${mark.done}]`}`
  )
  const pointLines = renderOpenPoints(decisions.openPoints)
  const sectionOf = (title: string, lines: ReadonlyArray<string>): string =>
    [`## ${title}`, "", ...(lines.length === 0 ? [] : [...lines, ""])].join("\n")
  return [
    "# Decisions",
    "",
    decisionsGuide,
    "",
    sectionOf("Programs", programLines),
    sectionOf("Scenarios", scenarioLines),
    sectionOf("Deepen", deepenLines),
    sectionOf("Open points", pointLines),
    decisions.approved ? "- [x] Approved" : "- [ ] Approved",
    ""
  ].join("\n")
}

// ---- Validate ---------------------------------------------------------------

export interface KnownPack {
  readonly programs: ReadonlySet<string>
  /** Scenario titles per program, from the pack's .feature files. */
  readonly scenarios: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * Every key must name a program of the pack and, for scenario keys, a title
 * of that program's feature file. Order: programs, scenarios, marks, deepen —
 * the order the sections are written in, so a violation list reads top-down.
 */
export const validateDecisions = (
  decisions: Decisions,
  known: KnownPack
): ReadonlyArray<string> => {
  const violations: Array<string> = []
  const checkProgram = (program: string): boolean => {
    if (known.programs.has(program)) {
      return true
    }
    violations.push(`program '${program}' is not in the spec pack`)
    return false
  }
  const checkScenario = (program: string, title: string): void => {
    if (!checkProgram(program)) {
      return
    }
    const titles = known.scenarios.get(program) ?? new Set<string>()
    if (!titles.has(title)) {
      violations.push(
        `scenario '${title}' does not exist in ${program} (known: ${[...titles].join(", ") || "none"})`
      )
    }
  }
  for (const entry of decisions.programs) {
    checkProgram(entry.program)
  }
  for (const entry of decisions.scenarios) {
    checkScenario(entry.program, entry.scenario)
  }
  for (const mark of decisions.marks) {
    if (mark.scenario === undefined) {
      checkProgram(mark.program)
    } else {
      checkScenario(mark.program, mark.scenario)
    }
  }
  for (const mark of decisions.deepen) {
    checkProgram(mark.program)
  }
  return violations
}

// ---- Waived coverage units --------------------------------------------------

export interface WaivedUnit {
  readonly unit: string
  readonly program: string
  /** The decision that waives it, as `<key>: <disposition>`. */
  readonly by: string
}

export interface WaiverInputs {
  /** Traceability fragments per program: `<UNIT> — <refs>` lines. */
  readonly fragments: ReadonlyMap<string, string>
  /** Scenario titles per program, so a ref to a surviving scenario keeps the unit live. */
  readonly scenarios: ReadonlyMap<string, ReadonlySet<string>>
}

const fragmentUnits = (fragment: string): ReadonlyArray<readonly [unit: string, refs: string]> =>
  fragment.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf(" — ")
    if (separator <= 0) {
      return []
    }
    const unit = line.slice(0, separator).trim()
    return unit.length === 0 || unit.startsWith("Patterns:")
      ? []
      : [[unit, line.slice(separator + 3)] as const]
  })

/**
 * Coverage units the decisions waive, derived — never addressed directly.
 * A program-level decision waives every unit of that program's traceability
 * fragment. A scenario-level decision waives a unit only when its refs name
 * at least one disposed scenario and no surviving scenario of that program:
 * a unit still reached by a migrating scenario stays live.
 */
export const waivedUnits = (
  decisions: Decisions,
  inputs: WaiverInputs
): ReadonlyArray<WaivedUnit> => {
  const waived: Array<WaivedUnit> = []
  for (const entry of decisions.programs) {
    const fragment = inputs.fragments.get(entry.program)
    if (fragment === undefined) {
      continue
    }
    for (const [unit] of fragmentUnits(fragment)) {
      waived.push({ unit, program: entry.program, by: `${entry.program}: ${entry.disposition}` })
    }
  }
  const byProgram = new Map<string, Array<ScenarioDecision>>()
  for (const entry of decisions.scenarios) {
    if (decisions.programDecision(entry.program) !== undefined) {
      continue
    }
    byProgram.set(entry.program, [...(byProgram.get(entry.program) ?? []), entry])
  }
  for (const [program, entries] of byProgram) {
    const fragment = inputs.fragments.get(program)
    if (fragment === undefined) {
      continue
    }
    const disposed = new Set(entries.map((entry) => entry.scenario))
    const surviving = [...(inputs.scenarios.get(program) ?? [])].filter(
      (title) => !disposed.has(title)
    )
    for (const [unit, refs] of fragmentUnits(fragment)) {
      const hit = entries.find((entry) => refs.includes(entry.scenario))
      if (hit === undefined || surviving.some((title) => refs.includes(title))) {
        continue
      }
      waived.push({
        unit,
        program,
        by: `${program} / ${hit.scenario}: ${hit.disposition}`
      })
    }
  }
  return waived
}

// ---- Feature files ----------------------------------------------------------

const scenarioHeading = /^\s*Scenario(?: Outline)?:\s*(.+?)\s*$/
const blockHeading = /^\s*(?:Scenario(?: Outline)?|Rule|Background):/

/** The scenario titles of a feature file, in order. */
export const scenarioTitles = (feature: string): ReadonlyArray<string> =>
  feature.split(/\r?\n/).flatMap((line) => {
    const match = scenarioHeading.exec(line)
    return match?.[1] === undefined ? [] : [match[1]]
  })

/**
 * The feature file without the scenarios in `disposed` — the projection seed
 * hands the target, so a coder never sees a scenario it must not encode.
 * Background, Rule headers, and every surviving block are kept verbatim.
 */
export const filterFeature = (feature: string, disposed: ReadonlySet<string>): string => {
  const kept: Array<string> = []
  let skipping = false
  for (const line of feature.split(/\r?\n/)) {
    if (blockHeading.test(line)) {
      const title = scenarioHeading.exec(line)?.[1]
      skipping = title !== undefined && disposed.has(title)
    }
    if (!skipping) {
      kept.push(line)
    }
  }
  return kept.join("\n")
}

// ---- Proposal (model) ----------------------------------------------------------

/** One disposition the model proposes; `key` is a program or `<program> / <title>`. */
export class ProposedDecision extends Schema.Class<ProposedDecision>("ProposedDecision")({
  key: Schema.String,
  disposition: Disposition,
  reason: Schema.String,
  pointer: Schema.optionalKey(Schema.String)
}) {}

export class DecisionsProposal extends Schema.Class<DecisionsProposal>("DecisionsProposal")({
  decisions: Schema.Array(ProposedDecision),
  openPoints: Schema.Array(Schema.String)
}) {}

export const decisionsProposalJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          disposition: { type: "string", enum: ["drop", "provided", "defer", "wrap"] },
          reason: { type: "string" },
          pointer: { type: "string" }
        },
        required: ["key", "disposition", "reason"]
      }
    },
    openPoints: { type: "array", items: { type: "string" } }
  },
  required: ["decisions", "openPoints"]
}

export interface ProposeOptions {
  /** Whether a read-only target workspace is mounted for `provided` evidence. */
  readonly targetMounted: boolean
  /** The pack's `prompts/refine-propose.md` paragraph. */
  readonly packParagraph?: string
}

const markKey = (mark: ProposalMark): string =>
  mark.scenario === undefined ? mark.program : `${mark.program} / ${mark.scenario}`

/**
 * The prune proposal ask: every `?` mark with its note, the decisions a
 * human already took (context, never to be overridden), the answered open
 * points as guidance, and the marked programs' specs and features.
 */
export const proposePrompt = (
  decisions: Decisions,
  specs: ReadonlyArray<{ readonly name: string; readonly spec: string; readonly feature: string }>,
  options: ProposeOptions
): string =>
  [
    "Propose dispositions for the marked programs and scenarios of this legacy spec pack.",
    "",
    "A disposition says what the extracted behaviour should become in the target:",
    "- drop: deprecated, will not exist in the target — only with evidence from the specs",
    "  (dead route, expired campaign, developer harness, a technology with no target equivalent);",
    options.targetMounted
      ? "- provided: the target already has it or solves it differently — ONLY after reading the\n" +
        "  target workspace you are running in and naming, as `pointer`, the existing file that\n" +
        "  proves it (a path relative to the target root);"
      : "- provided: NOT available in this run (no target workspace is mounted) — never propose it;",
    "- wrap: a whole program that stays on the legacy platform behind an API.",
    "Never propose defer: deferral is a delivery decision, not something the source evidences.",
    "Also add consequential entries: a scenario or program that only makes sense with one you",
    "drop (an orphaned route, a page nothing links to any more) gets its own entry.",
    "Anything you cannot decide from the evidence goes in `openPoints` as a question, never a guess.",
    ...(options.packParagraph === undefined || options.packParagraph.trim().length === 0
      ? []
      : ["", options.packParagraph.trim()]),
    "",
    "Marks to resolve:",
    ...decisions.marks.map(
      (mark) => `- ${markKey(mark)}${mark.note.length === 0 ? "" : ` — ${mark.note}`}`
    ),
    ...(decisions.programs.length + decisions.scenarios.length === 0
      ? []
      : [
          "",
          "Decisions already taken by a human (context only — do not repeat or contradict them):",
          ...decisions.programs.map(
            (entry) => `- ${entry.program}: ${entry.disposition} — ${entry.reason}`
          ),
          ...decisions.scenarios.map(
            (entry) =>
              `- ${entry.program} / ${entry.scenario}: ${entry.disposition} — ${entry.reason}`
          )
        ]),
    ...(decisions.openPoints.some((point) => point.answer !== undefined)
      ? [
          "",
          "Answers the human gave to earlier questions — treat them as instructions:",
          ...decisions.openPoints
            .filter((point) => point.answer !== undefined)
            .map((point) => `- Q: ${point.question}\n  A: ${point.answer ?? ""}`)
        ]
      : []),
    "",
    "Specs and features of the marked programs:",
    ...specs.flatMap((entry) => ["", `===== ${entry.name} =====`, entry.spec, "", entry.feature]),
    "",
    'Respond only with JSON: {"decisions":[{"key":"<program> or <program> / <scenario title>",',
    '"disposition":"drop|provided|wrap","reason":"…","pointer":"<target path, provided only>"}],',
    '"openPoints":["…"]}'
  ].join("\n")

export interface ApplyProposalOptions {
  /** Whether a `provided` pointer names something that exists in the target. */
  readonly pointerExists: (pointer: string) => boolean
  readonly known: KnownPack
  /** The signature written on proposed entries; the human's approval covers them. */
  readonly decidedBy?: string
  readonly decidedAt: string
}

const splitKey = (key: string): { program: string; scenario?: string } => {
  const slash = key.indexOf(" / ")
  return slash > 0
    ? { program: key.slice(0, slash).trim(), scenario: key.slice(slash + 3).trim() }
    : { program: key.trim() }
}

/**
 * Folds a proposal into the decisions. A proposed entry resolves the mark
 * with the same key (the mark is removed) or lands as a consequential entry;
 * it never overrides a decision a human already took. Anything the rules
 * refuse — a `defer`, a `provided` without a real pointer, a `wrap` on a
 * scenario, a key the pack does not have, a mark left unresolved — becomes
 * an open point instead of a silent choice. Answered open points are
 * consumed; the rest are renumbered after the survivors.
 */
export const applyProposal = (
  decisions: Decisions,
  proposal: DecisionsProposal,
  options: ApplyProposalOptions
): Decisions => {
  const programs = [...decisions.programs]
  const scenarios = [...decisions.scenarios]
  const questions: Array<string> = []
  const resolved = new Set<string>()
  const signature = {
    ...(options.decidedBy === undefined ? {} : { decidedBy: options.decidedBy }),
    decidedAt: options.decidedAt
  }
  const decided = (program: string, scenario?: string): boolean =>
    scenario === undefined
      ? programs.some((entry) => entry.program === program)
      : scenarios.some((entry) => entry.program === program && entry.scenario === scenario)
  for (const proposed of proposal.decisions) {
    const { program, scenario } = splitKey(proposed.key)
    const key = scenario === undefined ? program : `${program} / ${scenario}`
    if (!options.known.programs.has(program)) {
      questions.push(
        `The proposal named '${key}', which is not a program of the pack — ignore or fix the key?`
      )
      continue
    }
    if (scenario !== undefined && !(options.known.scenarios.get(program)?.has(scenario) ?? false)) {
      questions.push(
        `The proposal named scenario '${key}', which ${program} does not have — ignore or fix the title?`
      )
      continue
    }
    if (decided(program, scenario)) {
      continue
    }
    if (proposed.disposition === "defer") {
      questions.push(
        `The model would defer '${key}' (${proposed.reason}) — deferral is yours: mark it defer, drop, or leave it migrating`
      )
      continue
    }
    if (proposed.disposition === "wrap" && scenario !== undefined) {
      questions.push(
        `The model proposed wrap for scenario '${key}' — wrap applies to programs; drop it or leave it?`
      )
      continue
    }
    if (proposed.disposition === "provided") {
      const pointer = proposed.pointer?.trim() ?? ""
      if (pointer.length === 0 || !options.pointerExists(pointer)) {
        questions.push(
          `'${key}' was proposed as provided by '${pointer || "(no pointer)"}', which does not exist in the target — fix the pointer or choose drop`
        )
        continue
      }
      const entry = {
        disposition: proposed.disposition,
        reason: proposed.reason,
        pointer,
        ...signature
      }
      if (scenario === undefined) {
        programs.push(ProgramDecision.make({ program, ...entry }))
      } else {
        scenarios.push(ScenarioDecision.make({ program, scenario, ...entry }))
      }
    } else {
      const entry = { disposition: proposed.disposition, reason: proposed.reason, ...signature }
      if (scenario === undefined) {
        programs.push(ProgramDecision.make({ program, ...entry }))
      } else {
        scenarios.push(ScenarioDecision.make({ program, scenario, ...entry }))
      }
    }
    resolved.add(key)
  }
  const marks = decisions.marks.filter((mark) => !resolved.has(markKey(mark)))
  for (const mark of marks) {
    questions.push(
      `No disposition could be proposed for '${markKey(mark)}'${mark.note.length === 0 ? "" : ` (${mark.note})`} — decide it by hand or answer here`
    )
  }
  const kept = decisions.openPoints.filter((point) => point.answer === undefined)
  const openPoints = [...kept.map((point) => point.question), ...proposal.openPoints, ...questions]
    .filter((question, index, all) => all.indexOf(question) === index)
    .map((question, index) => OpenPoint.make({ number: index + 1, question }))
  return Decisions.make({
    programs,
    scenarios,
    marks: [],
    deepen: decisions.deepen,
    openPoints,
    approved: false
  })
}
