/**
 * taskforce (ADR 0047): the pure half of the delegation loop. The plan file
 * and the reports are the state; this module parses and renders them,
 * derives what is ready, blocked, checked and done, and tells the flow what
 * to do next (`nextAction`). Nothing here talks to a model, a file or a
 * process; the flow does.
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { JsonSchema } from "@llm4ts/core/Models"
import { makeOpenPointsCollector, OpenPoint } from "./Decisions.ts"
import { PlanInvalid, ReportInvalid } from "./FlowError.ts"
import type { Persona } from "./Roundtable.ts"

export { ToolGrade } from "./Roundtable.ts"

const dash = " — "
const headerLine = /^([A-Za-z][A-Za-z ]*):\s*(.*)$/
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()
const prose = (text: string): ReadonlyArray<string> =>
  text.trim().length === 0 ? [] : text.trim().split(/\r?\n/)
const bulletLines = (text: string): ReadonlyArray<string> =>
  prose(text)
    .map((line) => line.trim().replace(/^-\s*/, "").trim())
    .filter((line) => line.length > 0)

// ---- The plan file --------------------------------------------------------------

export const PlanStatus = Schema.Literals([
  "planned",
  "working",
  "drafting",
  "reviewing",
  "fixing",
  "distilling",
  "done"
])
export type PlanStatus = typeof PlanStatus.Type

const isPlanStatus = (value: string): value is PlanStatus =>
  PlanStatus.literals.some((status) => status === value)

/** The eight fields of a brief, in the order the file shows them (pstack's template). */
export const briefFields = [
  "GOAL",
  "SCOPE",
  "CONTEXT",
  "ACCEPTANCE",
  "VERIFY",
  "TIMEBOX",
  "FORBIDDEN",
  "REPORT"
] as const
type BriefField = (typeof briefFields)[number]
const fieldKeys = {
  GOAL: "goal",
  SCOPE: "scope",
  CONTEXT: "context",
  ACCEPTANCE: "acceptance",
  VERIFY: "verify",
  TIMEBOX: "timebox",
  FORBIDDEN: "forbidden",
  REPORT: "report"
} as const
const isBriefField = (value: string): value is BriefField =>
  briefFields.some((field) => field === value)

/** One unit of delegated work: an owner, dependencies, a wave, the eight fields. */
export class Brief extends Schema.Class<Brief>("Brief")({
  /** `B1`, `B2`, … in the order they were added to the plan. */
  id: Schema.String,
  title: Schema.String,
  /** A specialist's name from the cast. */
  owner: Schema.String,
  dependsOn: Schema.Array(Schema.String),
  /** The wave it was planned in: 1 the plan, 2 a re-plan or rework, the fix wave after a review. */
  wave: Schema.Int,
  goal: Schema.String,
  scope: Schema.String,
  context: Schema.String,
  /** One line per criterion, as written (bullets kept). */
  acceptance: Schema.String,
  /** One command per line; only a `commands` card ever runs them. */
  verify: Schema.String,
  timebox: Schema.String,
  forbidden: Schema.String,
  /** What the report must hold, and which deliverable it feeds. */
  report: Schema.String
}) {}

/** The Chief of Staff's verdict after a wave. */
export class GoalCheck extends Schema.Class<GoalCheck>("GoalCheck")({
  wave: Schema.Int,
  reached: Schema.Boolean,
  note: Schema.String
}) {}

export class Plan extends Schema.Class<Plan>("TaskforcePlan")({
  id: Schema.String,
  status: PlanStatus,
  goal: Schema.String,
  /** File names the Doc Writer writes; `result.md` is always among them. */
  deliverables: Schema.Array(Schema.String),
  /** Every specialist present, the Chief of Staff and the Doc Writer included. */
  cast: Schema.Array(Schema.String),
  briefs: Schema.Array(Brief),
  checks: Schema.Array(GoalCheck),
  /** Questions for the owner, with the assumption the run took; an answer here reopens work. */
  answers: Schema.Array(OpenPoint),
  feedback: Schema.String,
  /** Drafts the Doc Writer wrote: 0 none, 1 reviewed, 2 redrafted after the fix wave. */
  drafts: Schema.Int,
  /** Answer numbers already folded into a brief, so a rerun does not fold them twice. */
  folded: Schema.Array(Schema.Int),
  /**
   * Briefs the owner had in the file before the run opened it: their VERIFY
   * commands run as written. Any brief added later (a second wave, a fix, a
   * rework) runs only declared commands, as under `--no-pause`.
   */
  approved: Schema.Array(Schema.String)
}) {}

/** A deliverable is a plain markdown or text file name in the run's folder: no path, no `..`. */
export const isDeliverableName = (name: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.(md|txt)$/.test(name) && !name.includes("..")

/** The turn cap a TIMEBOX names (`20 turns`, `20`), when it names one. */
export const timeboxTurns = (brief: Brief): number | undefined => {
  const match = /(\d+)/.exec(brief.timebox)
  const turns = match === null ? undefined : Number.parseInt(match[1] ?? "", 10)
  return turns === undefined || Number.isNaN(turns) || turns <= 0 ? undefined : turns
}

/** The VERIFY lines as commands: bullets stripped, blanks dropped. */
export const verifyCommands = (brief: Brief): ReadonlyArray<string> => bulletLines(brief.verify)

/** The ACCEPTANCE lines as criteria. */
export const acceptanceLines = (brief: Brief): ReadonlyArray<string> =>
  bulletLines(brief.acceptance)

export const renderBrief = (brief: Brief): ReadonlyArray<string> => [
  `### ${brief.id}. ${brief.title}`,
  `Owner: ${brief.owner}`,
  `Depends on: ${brief.dependsOn.length === 0 ? "-" : brief.dependsOn.join(", ")}`,
  `Wave: ${brief.wave}`,
  "",
  ...briefFields.flatMap((field) => {
    const body = brief[fieldKeys[field]]
    const lines = prose(body)
    return lines.length <= 1 ? [`${field}: ${lines[0] ?? ""}`.trimEnd()] : [`${field}:`, ...lines]
  }),
  ""
]

const renderCheck = (check: GoalCheck): string =>
  `- wave ${check.wave}: ${check.reached ? "reached" : "not reached"}${dash}${oneLine(check.note)}`

export const renderPlan = (plan: Plan): string =>
  [
    `# Taskforce: ${plan.id}`,
    "",
    `Status: ${plan.status}`,
    `Goal: ${plan.goal}`,
    `Deliverables: ${plan.deliverables.join(", ")}`,
    `Cast: ${plan.cast.join(", ")}`,
    `Drafts: ${plan.drafts}`,
    `Folded: ${plan.folded.length === 0 ? "-" : plan.folded.join(", ")}`,
    `Approved: ${plan.approved.length === 0 ? "-" : plan.approved.join(", ")}`,
    "",
    "## Briefs",
    "",
    ...plan.briefs.flatMap(renderBrief),
    "## Goal checks",
    "",
    ...(plan.checks.length === 0 ? ["- none"] : plan.checks.map(renderCheck)),
    "",
    "## Answers",
    "",
    ...plan.answers.flatMap((point) => [
      `${point.number}. ${point.question}`,
      `   answer:${(point.answer ?? "").trim().length === 0 ? "" : ` ${(point.answer ?? "").trim()}`}`
    ]),
    "",
    "## Feedback",
    "",
    ...prose(plan.feedback),
    ""
  ].join("\n")

const settledPoint = (point: OpenPoint): OpenPoint =>
  (point.answer ?? "").trim().length === 0
    ? OpenPoint.make({ number: point.number, question: point.question })
    : OpenPoint.make({
        number: point.number,
        question: point.question,
        answer: (point.answer ?? "").trim()
      })

type PlanSection = "briefs" | "checks" | "answers" | "feedback"
const planSections: Record<string, PlanSection> = {
  briefs: "briefs",
  "goal checks": "checks",
  answers: "answers",
  feedback: "feedback"
}

const splitList = (value: string): ReadonlyArray<string> =>
  value === "-"
    ? []
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)

interface DraftBrief {
  id: string
  title: string
  owner: string | undefined
  dependsOn: ReadonlyArray<string>
  wave: number | undefined
  fields: Record<BriefField, Array<string>>
  field: BriefField | undefined
  line: number
}

const emptyFields = (): Record<BriefField, Array<string>> => ({
  GOAL: [],
  SCOPE: [],
  CONTEXT: [],
  ACCEPTANCE: [],
  VERIFY: [],
  TIMEBOX: [],
  FORBIDDEN: [],
  REPORT: []
})

export const parsePlan = Effect.fn("@llm4ts/flow/Taskforce.parsePlan")(function* (
  markdown: string,
  path?: string
): Effect.fn.Return<Plan, PlanInvalid> {
  const violations: Array<string> = []
  let id: string | undefined
  let status: PlanStatus | undefined
  let drafts = 0
  let folded: Array<number> = []
  let approved: ReadonlyArray<string> = []
  const header: Record<string, string> = {}
  const briefs: Array<DraftBrief> = []
  const checks: Array<GoalCheck> = []
  const points = makeOpenPointsCollector()
  const feedback: Array<string> = []
  let current: PlanSection | "header" | "unknown" = "header"
  let fenced = false
  const lines = markdown.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const number = index + 1
    const raw = lines[index] ?? ""
    const trimmed = raw.trim()
    if (trimmed.startsWith("```")) {
      fenced = !fenced
      if (current === "feedback") feedback.push(raw)
      else if (current === "briefs") {
        const brief = briefs.at(-1)
        if (brief?.field !== undefined) brief.fields[brief.field].push(raw)
      }
      continue
    }
    if (!fenced && trimmed.startsWith("## ")) {
      const title = trimmed.slice(3).trim()
      const key = planSections[title.toLowerCase()]
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
    if (current === "briefs") {
      const opened = /^###\s+(B\d+)\.\s+(.*)$/.exec(trimmed)
      if (!fenced && opened !== null) {
        briefs.push({
          id: opened[1] ?? "",
          title: (opened[2] ?? "").trim(),
          owner: undefined,
          dependsOn: [],
          wave: undefined,
          fields: emptyFields(),
          field: undefined,
          line: number
        })
        continue
      }
      const brief = briefs.at(-1)
      if (brief === undefined) {
        if (trimmed.length > 0) {
          violations.push(
            `line ${number}: a brief starts with \`### B1. <title>\`, got: ${trimmed}`
          )
        }
        continue
      }
      const field = /^([A-Z]+):\s?(.*)$/.exec(fenced ? "" : raw)
      if (field !== null && isBriefField(field[1] ?? "")) {
        const name = field[1] ?? "GOAL"
        if (isBriefField(name)) {
          brief.field = name
          const rest = (field[2] ?? "").trimEnd()
          if (rest.trim().length > 0) brief.fields[name].push(rest)
        }
        continue
      }
      if (brief.field === undefined) {
        const meta = headerLine.exec(trimmed)
        if (meta?.[1] === undefined) {
          if (trimmed.length > 0) {
            violations.push(
              `line ${number}: a brief's header is Owner:, Depends on:, Wave:, got: ${trimmed}`
            )
          }
          continue
        }
        const name = meta[1].toLowerCase()
        const value = (meta[2] ?? "").trim()
        if (name === "owner") brief.owner = value
        else if (name === "depends on") brief.dependsOn = splitList(value)
        else if (name === "wave") {
          if (/^\d+$/.test(value)) brief.wave = Number.parseInt(value, 10)
          else violations.push(`line ${number}: Wave is a whole number, got: ${value}`)
        } else {
          violations.push(`line ${number}: unknown brief header ${meta[1]}`)
        }
        continue
      }
      brief.fields[brief.field].push(raw)
      continue
    }
    if (fenced || trimmed.length === 0 || current === "unknown") continue
    if (current === "header") {
      const title = /^#\s+Taskforce:\s*(.+)$/i.exec(trimmed)
      if (title?.[1] !== undefined) {
        id = title[1].trim()
        continue
      }
      const field = headerLine.exec(trimmed)
      if (field?.[1] === undefined) continue
      const name = field[1].toLowerCase()
      const value = (field[2] ?? "").trim()
      if (name === "status") {
        if (isPlanStatus(value)) status = value
        else {
          violations.push(
            `line ${number}: Status is one of ${PlanStatus.literals.join(", ")}, got: ${value}`
          )
          status = "working"
        }
      } else if (name === "drafts") {
        if (/^\d+$/.test(value)) drafts = Number.parseInt(value, 10)
        else violations.push(`line ${number}: Drafts is a whole number, got: ${value}`)
      } else if (name === "folded") {
        folded = splitList(value).flatMap((entry) =>
          /^\d+$/.test(entry) ? [Number.parseInt(entry, 10)] : []
        )
      } else if (name === "approved") {
        approved = splitList(value)
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
    if (current === "checks") {
      if (trimmed === "- none") continue
      const check = /^-\s*wave\s+(\d+):\s*(reached|not reached)(?:\s*—\s*(.*))?$/.exec(trimmed)
      if (check === null) {
        violations.push(
          `line ${number}: a goal check is \`- wave <n>: reached|not reached${dash}<note>\`, got: ${trimmed}`
        )
      } else {
        checks.push(
          GoalCheck.make({
            wave: Number.parseInt(check[1] ?? "0", 10),
            reached: check[2] === "reached",
            note: (check[3] ?? "").trim()
          })
        )
      }
    }
  }
  if (id === undefined) violations.push("missing the `# Taskforce: <id>` title")
  if (status === undefined) violations.push("missing the `Status:` line")
  if (header.goal === undefined) violations.push("missing the `Goal:` line")
  if (header.cast === undefined) violations.push("missing the `Cast:` line")
  if (fenced) violations.push("a code fence is never closed")
  for (const brief of briefs) {
    if (brief.owner === undefined) violations.push(`line ${brief.line}: ${brief.id} has no Owner:`)
    if (brief.wave === undefined) violations.push(`line ${brief.line}: ${brief.id} has no Wave:`)
  }
  if (violations.length > 0 || id === undefined || status === undefined) {
    return yield* PlanInvalid.make({ ...(path === undefined ? {} : { path }), violations })
  }
  const text = (lines: ReadonlyArray<string>): string => lines.join("\n").trim()
  return Plan.make({
    id,
    status,
    goal: header.goal ?? "",
    deliverables: splitList(header.deliverables ?? ""),
    cast: splitList(header.cast ?? ""),
    briefs: briefs.map((brief) =>
      Brief.make({
        id: brief.id,
        title: brief.title,
        owner: brief.owner ?? "",
        dependsOn: brief.dependsOn,
        wave: brief.wave ?? 1,
        goal: text(brief.fields.GOAL),
        scope: text(brief.fields.SCOPE),
        context: text(brief.fields.CONTEXT),
        acceptance: text(brief.fields.ACCEPTANCE),
        verify: text(brief.fields.VERIFY),
        timebox: text(brief.fields.TIMEBOX),
        forbidden: text(brief.fields.FORBIDDEN),
        report: text(brief.fields.REPORT)
      })
    ),
    checks,
    answers: points.points.map(settledPoint),
    feedback: feedback.join("\n").trim(),
    drafts,
    folded,
    approved
  })
})

// ---- Validity (decision 3) --------------------------------------------------------

export interface Caps {
  /** Waves in all, the fix wave included. */
  readonly waves: number
  /** Briefs in all. */
  readonly briefs: number
}

export const defaultCaps: Caps = { waves: 3, briefs: 12 }
export const minBriefs = 2

const hasCycle = (briefs: ReadonlyArray<Brief>): boolean => {
  const edges = new Map(briefs.map((brief) => [brief.id, brief.dependsOn]))
  const state = new Map<string, "open" | "done">()
  const visit = (id: string): boolean => {
    const seen = state.get(id)
    if (seen === "open") return true
    if (seen === "done") return false
    state.set(id, "open")
    for (const next of edges.get(id) ?? []) if (edges.has(next) && visit(next)) return true
    state.set(id, "done")
    return false
  }
  return briefs.some((brief) => visit(brief.id))
}

/** Everything that stops a plan from running; empty when it may. */
export const planViolations = (plan: Plan, caps: Caps): ReadonlyArray<string> => {
  const violations: Array<string> = []
  if (plan.briefs.length < minBriefs || plan.briefs.length > caps.briefs) {
    violations.push(`${minBriefs} to ${caps.briefs} briefs, got ${plan.briefs.length}`)
  }
  const ids = new Set<string>()
  for (const brief of plan.briefs) {
    if (ids.has(brief.id)) violations.push(`${brief.id}: listed twice`)
    ids.add(brief.id)
  }
  for (const brief of plan.briefs) {
    if (brief.title.trim().length === 0) violations.push(`${brief.id}: has no title`)
    if (!plan.cast.includes(brief.owner)) {
      violations.push(`${brief.id}: owner ${brief.owner} is not in the cast`)
    }
    for (const dependency of brief.dependsOn) {
      if (!ids.has(dependency)) {
        violations.push(`${brief.id}: depends on ${dependency}, which is not a brief`)
      }
    }
    if (brief.goal.trim().length === 0) violations.push(`${brief.id}: GOAL is empty`)
    if (acceptanceLines(brief).length === 0) violations.push(`${brief.id}: ACCEPTANCE is empty`)
  }
  if (hasCycle(plan.briefs)) violations.push("briefs depend on each other in a cycle")
  for (const deliverable of plan.deliverables) {
    if (!isDeliverableName(deliverable)) {
      violations.push(
        `deliverable ${deliverable} is not a plain file name (letters, digits, dots, dashes; .md or .txt)`
      )
      continue
    }
    const named = plan.briefs.some(
      (brief) =>
        brief.report.toLowerCase().includes(deliverable.toLowerCase()) ||
        brief.goal.toLowerCase().includes(deliverable.toLowerCase())
    )
    if (!named) violations.push(`deliverable ${deliverable} is named by no brief`)
  }
  return violations
}

// ---- Proposals (what the models reply) ---------------------------------------------

export class BriefProposal extends Schema.Class<BriefProposal>("BriefProposal")({
  title: Schema.String,
  owner: Schema.String,
  /** Brief ids (`B3`), the proposal's own numbered from the `from` the prompt names. */
  dependsOn: Schema.Array(Schema.String),
  goal: Schema.String,
  scope: Schema.String,
  context: Schema.String,
  acceptance: Schema.Array(Schema.String),
  verify: Schema.Array(Schema.String),
  timebox: Schema.String,
  forbidden: Schema.String,
  report: Schema.String
}) {}

const briefProposalJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    owner: { type: "string" },
    dependsOn: { type: "array", items: { type: "string" } },
    goal: { type: "string" },
    scope: { type: "string" },
    context: { type: "string" },
    acceptance: { type: "array", items: { type: "string" } },
    verify: { type: "array", items: { type: "string" } },
    timebox: { type: "string" },
    forbidden: { type: "string" },
    report: { type: "string" }
  },
  required: [
    "title",
    "owner",
    "dependsOn",
    "goal",
    "scope",
    "context",
    "acceptance",
    "verify",
    "timebox",
    "forbidden",
    "report"
  ]
}

export class PlanProposal extends Schema.Class<PlanProposal>("PlanProposal")({
  deliverables: Schema.Array(Schema.String),
  briefs: Schema.Array(BriefProposal)
}) {}

export const planProposalJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    deliverables: { type: "array", items: { type: "string" } },
    briefs: { type: "array", items: briefProposalJsonSchema }
  },
  required: ["deliverables", "briefs"]
}

export class CheckProposal extends Schema.Class<CheckProposal>("CheckProposal")({
  reached: Schema.Boolean,
  note: Schema.String,
  /** The second wave, when the goal is not reached and a re-plan is allowed; else empty. */
  briefs: Schema.Array(BriefProposal)
}) {}

export const checkProposalJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    reached: { type: "boolean" },
    note: { type: "string" },
    briefs: { type: "array", items: briefProposalJsonSchema }
  },
  required: ["reached", "note", "briefs"]
}

export const ReportStatus = Schema.Literals(["PASS", "ISSUES", "BLOCKED"])
export type ReportStatus = typeof ReportStatus.Type
const isReportStatus = (value: string): value is ReportStatus =>
  ReportStatus.literals.some((status) => status === value)

export class OwnerQuestion extends Schema.Class<OwnerQuestion>("OwnerQuestion")({
  question: Schema.String,
  /** What the specialist proceeded on, since nobody answers inside the run. */
  assumption: Schema.String
}) {}

export class ReportProposal extends Schema.Class<ReportProposal>("ReportProposal")({
  status: ReportStatus,
  evidence: Schema.Array(Schema.String),
  summary: Schema.String,
  questions: Schema.Array(OwnerQuestion),
  body: Schema.String
}) {}

export const reportProposalJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["PASS", "ISSUES", "BLOCKED"] },
    evidence: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: { question: { type: "string" }, assumption: { type: "string" } },
        required: ["question", "assumption"]
      }
    },
    body: { type: "string" }
  },
  required: ["status", "evidence", "summary", "questions", "body"]
}

export interface AssembleOptions {
  /** The number the first proposed brief gets. */
  readonly from: number
  readonly wave: number
  readonly cast: ReadonlyArray<Persona>
}

export interface AssembledBriefs {
  readonly briefs: ReadonlyArray<Brief>
  /** What was changed on the way: VERIFY dropped for want of an Operator. */
  readonly notes: ReadonlyArray<string>
}

const joinLines = (lines: ReadonlyArray<string>): string =>
  lines
    .map((line) => oneLine(line))
    .filter((line) => line.length > 0)
    .map((line) => `- ${line}`)
    .join("\n")

/**
 * Proposed briefs as plan briefs: ids from `from`, titles one line,
 * dependencies kept only when they name a brief that exists or is proposed,
 * and VERIFY moved off every card that may not run commands onto a
 * verifying brief owned by the first `commands` card, after the brief it
 * checks (decision 5).
 */
export const assembleBriefs = (
  proposals: ReadonlyArray<BriefProposal>,
  options: AssembleOptions,
  existing: ReadonlyArray<string> = []
): AssembledBriefs => {
  const notes: Array<string> = []
  const operator = options.cast.find((persona) => persona.tools === "commands")
  const gradeOf = (owner: string) => options.cast.find((persona) => persona.name === owner)?.tools
  let next = options.from
  const proposed = proposals.map(() => `B${next++}`)
  const known = new Set([...existing, ...proposed])
  const briefs: Array<Brief> = []
  const verifiers: Array<Brief> = []
  proposals.forEach((proposal, index) => {
    const id = proposed[index] ?? `B${options.from + index}`
    const dependsOn = [...new Set(proposal.dependsOn.map((entry) => entry.trim()))]
      .filter((entry) => known.has(entry) && entry !== id)
      .sort(
        (left, right) => Number.parseInt(left.slice(1), 10) - Number.parseInt(right.slice(1), 10)
      )
    const verify = joinLines(proposal.verify)
    const runsCommands = gradeOf(proposal.owner) === "commands"
    briefs.push(
      Brief.make({
        id,
        title: oneLine(proposal.title),
        owner: proposal.owner.trim(),
        dependsOn,
        wave: options.wave,
        goal: proposal.goal.trim(),
        scope: proposal.scope.trim(),
        context: proposal.context.trim(),
        acceptance: joinLines(proposal.acceptance),
        verify: runsCommands ? verify : "",
        timebox: oneLine(proposal.timebox),
        forbidden: proposal.forbidden.trim(),
        report: proposal.report.trim()
      })
    )
    if (runsCommands || verify.length === 0) return
    if (operator === undefined) {
      notes.push(
        `${id}: VERIFY dropped — no card in the cast runs commands (add the Operator with --agents)`
      )
      return
    }
    const verifier = `B${next++}`
    verifiers.push(
      Brief.make({
        id: verifier,
        title: `Verify ${id}`,
        owner: operator.name,
        dependsOn: [id],
        wave: options.wave,
        goal: `Run the checks for ${id} and report what each said.`,
        scope: `The repository as ${id} left it; write nothing.`,
        context: `${id}'s report is in reports/${id}.md.`,
        acceptance: "- Every command's exit code and output are in the report, unparaphrased.",
        verify,
        timebox: "1 run of each command",
        forbidden: "Fixing anything; running a command the VERIFY list does not name.",
        report: `reports/${verifier}.md with the commands, exit codes and output.`
      })
    )
  })
  return { briefs: [...briefs, ...verifiers], notes }
}

// ---- Reports -------------------------------------------------------------------------

export class Report extends Schema.Class<Report>("BriefReport")({
  brief: Schema.String,
  status: ReportStatus,
  /** 1 the first dispatch, 2 the retry after BLOCKED. */
  attempt: Schema.Int,
  evidence: Schema.Array(Schema.String),
  summary: Schema.String,
  questions: Schema.Array(OwnerQuestion),
  body: Schema.String
}) {}

export const renderReport = (report: Report, title: string): string =>
  [
    `# ${report.brief}: ${oneLine(title)}`,
    `Status: ${report.status}`,
    `Attempt: ${report.attempt}`,
    `Evidence: ${report.evidence.length === 0 ? "-" : report.evidence.map(oneLine).join(", ")}`,
    `Summary: ${oneLine(report.summary)}`,
    ...report.questions.map(
      (question) =>
        `Question: ${oneLine(question.question)} (assuming: ${oneLine(question.assumption)})`
    ),
    "",
    report.body.trim(),
    ""
  ].join("\n")

export const parseReport = Effect.fn("@llm4ts/flow/Taskforce.parseReport")(function* (
  markdown: string,
  path?: string
): Effect.fn.Return<Report, ReportInvalid> {
  const violations: Array<string> = []
  const lines = markdown.split(/\r?\n/)
  let brief: string | undefined
  let status: ReportStatus | undefined
  let attempt = 1
  let evidence: ReadonlyArray<string> = []
  let summary = ""
  const questions: Array<OwnerQuestion> = []
  let index = 0
  for (; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim()
    if (trimmed.length === 0) break
    const title = /^#\s+(B\d+):\s*(.*)$/.exec(trimmed)
    if (title !== null) {
      brief = title[1]
      continue
    }
    const field = headerLine.exec(trimmed)
    if (field?.[1] === undefined) {
      violations.push(`line ${index + 1}: not a report header line: ${trimmed}`)
      continue
    }
    const name = field[1].toLowerCase()
    const value = (field[2] ?? "").trim()
    if (name === "status") {
      if (isReportStatus(value)) status = value
      else violations.push(`line ${index + 1}: Status is PASS, ISSUES or BLOCKED, got: ${value}`)
    } else if (name === "attempt") {
      if (/^\d+$/.test(value)) attempt = Number.parseInt(value, 10)
      else violations.push(`line ${index + 1}: Attempt is a whole number, got: ${value}`)
    } else if (name === "evidence") evidence = splitList(value)
    else if (name === "summary") summary = value
    else if (name === "question") {
      const parts = /^(.*?)\s*\(assuming:\s*(.*)\)$/.exec(value)
      questions.push(
        OwnerQuestion.make(
          parts === null
            ? { question: value, assumption: "" }
            : { question: (parts[1] ?? "").trim(), assumption: (parts[2] ?? "").trim() }
        )
      )
    } else violations.push(`line ${index + 1}: unknown report header ${field[1]}`)
  }
  if (brief === undefined) violations.push("missing the `# B<n>: <title>` title")
  if (status === undefined) violations.push("missing the `Status:` line")
  if (violations.length > 0 || brief === undefined || status === undefined) {
    return yield* ReportInvalid.make({ ...(path === undefined ? {} : { path }), violations })
  }
  return Report.make({
    brief,
    status,
    attempt,
    evidence,
    summary,
    questions,
    body: lines.slice(index).join("\n").trim()
  })
})

// ---- Derived state (decision 6) -----------------------------------------------------

export const reportOf = (reports: ReadonlyArray<Report>, id: string): Report | undefined =>
  reports.find((report) => report.brief === id)

/** PASS and ISSUES end a brief; BLOCKED ends it on the second attempt. */
export const isFinal = (report: Report): boolean =>
  report.status !== "BLOCKED" || report.attempt >= 2

const finallyBlocked = (report: Report | undefined): boolean =>
  report !== undefined && report.status === "BLOCKED" && isFinal(report)

export const currentWave = (plan: Plan): number =>
  plan.briefs.reduce((wave, brief) => Math.max(wave, brief.wave), 0)

const openBriefs = (plan: Plan, reports: ReadonlyArray<Report>): ReadonlyArray<Brief> =>
  plan.briefs.filter((brief) => {
    const report = reportOf(reports, brief.id)
    return report === undefined || !isFinal(report)
  })

/** The reason a brief cannot run: a dependency finally blocked. */
const deadReason = (brief: Brief, reports: ReadonlyArray<Report>): string | undefined => {
  const dead = brief.dependsOn.filter((id) => finallyBlocked(reportOf(reports, id)))
  return dead.length === 0 ? undefined : `depends on ${dead.join(", ")}, blocked twice`
}

/** Open briefs whose dependencies all ended well: what the next dispatch runs together. */
export const readyBriefs = (plan: Plan, reports: ReadonlyArray<Report>): ReadonlyArray<Brief> =>
  openBriefs(plan, reports).filter(
    (brief) =>
      deadReason(brief, reports) === undefined &&
      brief.dependsOn.every((id) => {
        const report = reportOf(reports, id)
        return report !== undefined && isFinal(report)
      })
  )

export interface OwnerAnswer {
  readonly number: number
  readonly question: string
  readonly answer: string
}

export type Action =
  | { readonly _tag: "ProposePlan" }
  | { readonly _tag: "Open" }
  | {
      readonly _tag: "RecordOwner"
      readonly answers: ReadonlyArray<OwnerAnswer>
      readonly feedback: string
    }
  | { readonly _tag: "Dispatch"; readonly briefs: ReadonlyArray<Brief>; readonly attempt: number }
  | { readonly _tag: "Skip"; readonly brief: Brief; readonly reason: string }
  | { readonly _tag: "Check"; readonly wave: number; readonly mayReplan: boolean }
  | { readonly _tag: "Draft"; readonly redraft: boolean }
  | { readonly _tag: "Review" }
  | { readonly _tag: "Distill" }
  | { readonly _tag: "Done" }
  | { readonly _tag: "Refused"; readonly reason: string }

const pendingOwner = (plan: Plan): { answers: ReadonlyArray<OwnerAnswer>; feedback: string } => ({
  answers: plan.answers.flatMap((point) => {
    const answer = (point.answer ?? "").trim()
    return answer.length === 0 || plan.folded.includes(point.number)
      ? []
      : [{ number: point.number, question: point.question, answer }]
  }),
  feedback: plan.feedback.trim()
})

/** What the loop does next, from the plan and the reports alone. */
export const nextAction = (plan: Plan, reports: ReadonlyArray<Report>, caps: Caps): Action => {
  if (plan.status === "planned") {
    return plan.briefs.length === 0 ? { _tag: "ProposePlan" } : { _tag: "Open" }
  }
  const owner = pendingOwner(plan)
  if (owner.answers.length > 0 || owner.feedback.length > 0) {
    return { _tag: "RecordOwner", answers: owner.answers, feedback: owner.feedback }
  }
  switch (plan.status) {
    case "working":
    case "fixing": {
      const open = openBriefs(plan, reports)
      if (open.length === 0) {
        if (plan.status === "fixing") return { _tag: "Draft", redraft: true }
        const wave = currentWave(plan)
        const checked = plan.checks.some((check) => check.wave === wave)
        if (!checked) {
          return {
            _tag: "Check",
            wave,
            mayReplan: plan.checks.length === 0 && wave < caps.waves
          }
        }
        return { _tag: "Draft", redraft: plan.drafts > 0 }
      }
      for (const brief of open) {
        const reason = deadReason(brief, reports)
        if (reason !== undefined) return { _tag: "Skip", brief, reason }
      }
      const ready = readyBriefs(plan, reports)
      if (ready.length === 0) {
        return { _tag: "Refused", reason: "the open briefs wait on each other" }
      }
      // A brief back from BLOCKED runs alone, on its second attempt.
      const retry = ready.find((brief) => reportOf(reports, brief.id) !== undefined)
      return retry === undefined
        ? { _tag: "Dispatch", briefs: ready, attempt: 1 }
        : { _tag: "Dispatch", briefs: [retry], attempt: 2 }
    }
    case "drafting":
      return { _tag: "Draft", redraft: plan.drafts > 0 }
    case "reviewing":
      return { _tag: "Review" }
    case "distilling":
      return { _tag: "Distill" }
    case "done":
      return { _tag: "Done" }
  }
}

// ---- The owner (decision 9) ----------------------------------------------------------

export interface Recorded {
  readonly plan: Plan
  /** Briefs to add to the plan: a rework per answer, a fix for feedback. */
  readonly briefs: ReadonlyArray<Brief>
  readonly notes: ReadonlyArray<string>
}

const nextId = (plan: Plan, added: number): string => `B${plan.briefs.length + added + 1}`

/** The brief an answer's question came from: `(B3, assuming: …)` in the question text. */
const askingBrief = (plan: Plan, question: string): Brief | undefined => {
  const match = /\((B\d+)(?:,|\))/.exec(question)
  return match === null ? undefined : plan.briefs.find((brief) => brief.id === match[1])
}

/**
 * Folds the owner's words in: an answer reopens the brief that asked, with
 * the answer in its CONTEXT, one wave on; feedback becomes a fix brief for
 * the Doc Writer. At the wave cap the answer is folded and nothing is added.
 */
export const recordOwner = (
  plan: Plan,
  action: Extract<Action, { _tag: "RecordOwner" }>,
  caps: Caps,
  docWriter = "Doc Writer"
): Recorded => {
  const notes: Array<string> = []
  const briefs: Array<Brief> = []
  const wave = currentWave(plan) + 1
  const capped = wave > caps.waves
  for (const answer of action.answers) {
    const asked = askingBrief(plan, answer.question)
    if (capped) {
      notes.push(
        `answer ${answer.number} folded without rework: wave ${wave} is past the cap of ${caps.waves}`
      )
      continue
    }
    const id = nextId(plan, briefs.length)
    briefs.push(
      Brief.make({
        id,
        title:
          asked === undefined
            ? `Rework after answer ${answer.number}`
            : `Rework ${asked.id}: ${asked.title}`,
        owner: asked?.owner ?? docWriter,
        dependsOn: [],
        wave,
        goal: asked?.goal ?? `Fold the owner's answer into the deliverables.`,
        scope: asked?.scope ?? "",
        context: [
          asked?.context ?? "",
          `The owner answered question ${answer.number} (${oneLine(answer.question)}): ${oneLine(answer.answer)}. Redo the work on that answer, not the assumption.`
        ]
          .filter((line) => line.length > 0)
          .join("\n"),
        acceptance: asked?.acceptance ?? "- The answer is reflected.",
        verify: "",
        timebox: asked?.timebox ?? "",
        forbidden: asked?.forbidden ?? "",
        report: `reports/${id}.md${asked === undefined ? "" : `, replacing reports/${asked.id}.md`}`
      })
    )
  }
  if (action.feedback.length > 0) {
    if (capped) {
      notes.push(
        `feedback recorded without a fix wave: wave ${wave} is past the cap of ${caps.waves}`
      )
    } else {
      const id = nextId(plan, briefs.length)
      briefs.push(
        Brief.make({
          id,
          title: "Fix: the owner's feedback",
          owner: docWriter,
          dependsOn: [],
          wave,
          goal: "Address the owner's feedback in the deliverables.",
          scope: plan.deliverables.join(", "),
          context: `The owner wrote: ${action.feedback}`,
          acceptance: "- The feedback is addressed and nothing else changed.",
          verify: "",
          timebox: "",
          forbidden: "Rewriting what the feedback does not touch.",
          report: `reports/${id}.md with what changed and why.`
        })
      )
    }
  }
  const status: PlanStatus =
    briefs.length === 0
      ? plan.status
      : action.feedback.length > 0 && action.answers.length === 0
        ? "fixing"
        : "working"
  return {
    plan: Plan.make({
      ...plan,
      status,
      feedback: "",
      folded: [...new Set([...plan.folded, ...action.answers.map((answer) => answer.number)])].sort(
        (left, right) => left - right
      )
    }),
    briefs,
    notes
  }
}

/** Questions the reports raised, added under `## Answers` once each, with the assumption. */
export const syncAnswers = (plan: Plan, reports: ReadonlyArray<Report>): Plan => {
  const known = new Set(plan.answers.map((point) => point.question))
  const added: Array<OpenPoint> = []
  let number = plan.answers.reduce((max, point) => Math.max(max, point.number), 0)
  for (const report of reports) {
    for (const question of report.questions) {
      const text = `${oneLine(question.question)} (${report.brief}, assuming: ${oneLine(question.assumption)})`
      if (known.has(text)) continue
      known.add(text)
      number += 1
      added.push(OpenPoint.make({ number, question: text }))
    }
  }
  return added.length === 0 ? plan : Plan.make({ ...plan, answers: [...plan.answers, ...added] })
}

// ---- The review (decision 7) ----------------------------------------------------------

export const Bucket = Schema.Literals(["act-on", "consider", "noted", "dismissed"])
export type Bucket = typeof Bucket.Type

export class Finding extends Schema.Class<Finding>("Finding")({
  id: Schema.Int,
  lens: Schema.String,
  title: Schema.String,
  /** A path, a section, a line. */
  where: Schema.String,
  /** The brief whose work it is about, or empty when it is about a deliverable. */
  brief: Schema.String,
  detail: Schema.String,
  bucket: Bucket,
  reason: Schema.String
}) {}

export class LensFindings extends Schema.Class<LensFindings>("LensFindings")({
  findings: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      where: Schema.String,
      brief: Schema.String,
      detail: Schema.String
    })
  )
}) {}

export const lensFindingsJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          where: { type: "string" },
          brief: { type: "string" },
          detail: { type: "string" }
        },
        required: ["title", "where", "brief", "detail"]
      }
    }
  },
  required: ["findings"]
}

export class LeadProposal extends Schema.Class<LeadProposal>("LeadProposal")({
  verdicts: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      bucket: Schema.Literals(["consider", "noted", "dismissed"]),
      reason: Schema.String
    })
  )
}) {}

export const leadProposalJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          bucket: { type: "string", enum: ["consider", "noted", "dismissed"] },
          reason: { type: "string" }
        },
        required: ["id", "bucket", "reason"]
      }
    }
  },
  required: ["verdicts"]
}

const bucketTitles: Record<Bucket, string> = {
  "act-on": "Act on",
  consider: "Consider",
  noted: "Noted",
  dismissed: "Dismissed"
}

export const renderReview = (findings: ReadonlyArray<Finding>): string =>
  [
    "# Review",
    "",
    ...Bucket.literals.flatMap((bucket) => {
      const these = findings.filter((finding) => finding.bucket === bucket)
      return [
        `## ${bucketTitles[bucket]}`,
        "",
        ...(these.length === 0
          ? ["- none"]
          : these.flatMap((finding) => [
              `- ${finding.id}. ${oneLine(finding.title)} (${finding.lens}${finding.brief.length === 0 ? "" : `, ${finding.brief}`}; ${oneLine(finding.where)})`,
              `  ${oneLine(finding.detail)}${finding.reason.length === 0 ? "" : ` — ${oneLine(finding.reason)}`}`
            ])),
        ""
      ]
    })
  ].join("\n")

export interface FixWave {
  readonly briefs: ReadonlyArray<Brief>
  /** Act-on findings beyond the brief cap. */
  readonly dropped: ReadonlyArray<Finding>
}

/** One fix brief per act-on finding, for the owner of the work it is about, the Doc Writer otherwise. */
export const fixBriefs = (
  plan: Plan,
  findings: ReadonlyArray<Finding>,
  caps: Caps,
  docWriter: string
): FixWave => {
  const wave = currentWave(plan) + 1
  const briefs: Array<Brief> = []
  const dropped: Array<Finding> = []
  for (const finding of findings) {
    if (finding.bucket !== "act-on") continue
    if (plan.briefs.length + briefs.length >= caps.briefs) {
      dropped.push(finding)
      continue
    }
    const about = plan.briefs.find((brief) => brief.id === finding.brief)
    const id = nextId(plan, briefs.length)
    briefs.push(
      Brief.make({
        id,
        title: `Fix: ${oneLine(finding.title)}`,
        owner: about?.owner ?? docWriter,
        dependsOn: [],
        wave,
        goal: `Address the review finding: ${oneLine(finding.title)}.`,
        scope: about?.scope ?? plan.deliverables.join(", "),
        context: `The ${finding.lens} lens found, at ${oneLine(finding.where)}: ${oneLine(finding.detail)}${about === undefined ? "" : ` (about ${about.id}: ${about.title})`}`,
        acceptance: "- The finding no longer holds.\n- Nothing the finding does not touch changed.",
        verify: "",
        timebox: about?.timebox ?? "",
        forbidden: about?.forbidden ?? "Changing what the finding does not touch.",
        report: `reports/${id}.md with what changed and the evidence.`
      })
    )
  }
  return { briefs, dropped }
}

// ---- Views ---------------------------------------------------------------------------------

/** What nobody in the run could settle: finally blocked briefs with the assumption taken, and unanswered questions. */
export const renderOpenQuestions = (plan: Plan, reports: ReadonlyArray<Report>): string => {
  const blocked = plan.briefs.flatMap((brief) => {
    const report = reportOf(reports, brief.id)
    return finallyBlocked(report) && report !== undefined ? [{ brief, report }] : []
  })
  const unanswered = plan.answers.filter((point) => (point.answer ?? "").trim().length === 0)
  return [
    `# Open questions: ${plan.id}`,
    "",
    "## Blocked briefs",
    "",
    ...(blocked.length === 0
      ? ["- none"]
      : blocked.map(
          ({ brief, report }) =>
            `- ${brief.id} ${oneLine(brief.title)} (${brief.owner}): ${oneLine(report.summary)}`
        )),
    "",
    "## For the owner",
    "",
    ...(unanswered.length === 0
      ? ["- none"]
      : unanswered.map((point) => `- ${point.number}. ${point.question}`)),
    "",
    `Answer under '## Answers' in plan.md and rerun.`,
    ""
  ].join("\n")
}

// ---- The trail (decision 8) -------------------------------------------------------------------

export interface TrailRow {
  readonly ts: string
  readonly phase: string
  readonly decision: string
  readonly why: string
  readonly evidence: string
  readonly result: string
}

export const trailHeader = "ts\tphase\tdecision\twhy\tevidence\tresult"

/** A cell on one line, with a leading `=`, `+`, `-` or `@` quoted so a spreadsheet reads it as text. */
const cell = (text: string): string => {
  const flat = oneLine(text)
  return /^[=+\-@]/.test(flat) ? `'${flat}` : flat
}

export const renderTrailRow = (row: TrailRow): string =>
  [row.ts, row.phase, row.decision, row.why, row.evidence, row.result].map(cell).join("\t")
