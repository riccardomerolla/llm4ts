/**
 * taskforce (ADR 0047): the flow half of the delegation loop. What is ready,
 * blocked, checked and done is `@llm4ts/flow/Taskforce`; this module reads
 * and writes the run's files, builds the prompts, drives the seats, the
 * worktrees, the process executor and the judgment service, writes the
 * trail, and reports to the person.
 */
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type { JudgmentShape } from "@llm4ts/core/judgment/Judgment"
import { truthOf } from "@llm4ts/core/judgment/Judgment"
import { truth } from "@llm4ts/core/judgment/Schemas"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { JsonSchema } from "@llm4ts/core/Models"
import type { ProcessExecutorShape } from "@llm4ts/core/ProcessExecutor"
import { cap } from "@llm4ts/flow/Context"
import { completeAndPublish } from "@llm4ts/flow/Flow"
import {
  BriefReported,
  Info,
  StageCompleted,
  StageStarted,
  type FlowEventsShape
} from "@llm4ts/flow/FlowEvents"
import { FlowAborted, PlanInvalid, PlanPending, type FlowError } from "@llm4ts/flow/FlowError"
import { decide, judgeOrEscalate } from "@llm4ts/flow/Judgment"
import {
  recall,
  renderRunNote,
  RunNote,
  runNoteJsonSchema,
  type MemoryNote
} from "@llm4ts/flow/Memory"
import type { PlainFileStoreShape } from "@llm4ts/flow/Persistence"
import type { Reviewer } from "@llm4ts/flow/Reviewer"
import type { Role } from "@llm4ts/flow/Roster"
import { parsePersona, type Persona } from "@llm4ts/flow/Roundtable"
import {
  acceptanceLines,
  assembleBriefs,
  type Brief,
  CheckProposal,
  checkProposalJsonSchema,
  currentWave,
  Finding,
  fixBriefs,
  GoalCheck,
  isFinal,
  LeadProposal,
  leadProposalJsonSchema,
  LensFindings,
  lensFindingsJsonSchema,
  nextAction,
  parsePlan,
  parseReport,
  Plan,
  PlanProposal,
  planProposalJsonSchema,
  planViolations,
  recordOwner,
  renderOpenQuestions,
  renderPlan,
  renderReport,
  renderReview,
  renderTrailRow,
  Report,
  ReportProposal,
  reportProposalJsonSchema,
  reportOf,
  syncAnswers,
  trailHeader,
  verifyCommands,
  type Action,
  type Caps
} from "@llm4ts/flow/Taskforce"
import { structuredAndPublish } from "@llm4ts/flow/Usage"
import { ScriptUsage } from "@llm4ts/runner/FlowArgs"
import { terminalSafe } from "@llm4ts/runner/Terminal"
import { meetingSlug, personasDir, type ContextDoc } from "./roundtable.ts"
import {
  bundledSpecialistCards,
  chiefName,
  memoryName,
  selectableSpecialists,
  writerName
} from "./taskforce-personas.ts"

export { personasDir }
export type { ContextDoc }

// ---- Flags ----------------------------------------------------------------------

export const taskforceUsage = [
  'usage: llm4ts run taskforce --repo <dir> "<goal>" -- [--agents "Researcher,Engineer,..."] [--run <id>]',
  "                            [--context <dir>] [--waves <n>] [--briefs <n>] [--parallel <n>] [--turns <n>]",
  "                            [--no-pause] [--keep-work] [--no-memory]",
  "       llm4ts run taskforce --repo <dir> -- --run <id>             # continue or finish a run",
  "       llm4ts run taskforce --repo <dir> -- --eject-personas       # write the bundled cards to .llm4ts/personas/",
  "       llm4ts run taskforce --repo <dir> -- --list                 # the repository's runs",
  "  --agents <names>   specialists by card name; default: Researcher,Engineer,Operator,Reviewer,Memory Manager",
  "                     (the Chief of Staff and the Doc Writer are always present)",
  "  --run <id>         the run folder under .llm4ts/taskforce/; default: a slug of the goal",
  "  --context <dir>    documents every brief reads (standards, architecture notes)",
  "  --waves <n>        waves in all, the fix wave included (default 3)",
  "  --briefs <n>       briefs in all (default 12)",
  "  --parallel <n>     briefs run at once (default: the roster's slots, else 1)",
  "  --turns <n>        the coder's turn cap on every Engineer brief (default 30)",
  "  --no-pause         do not stop after the plan is proposed; only declared commands then run",
  "  --keep-work        keep the Engineer's worktrees when the run is done",
  "  --no-memory        neither recall nor write memory notes",
  "The plan file is the state: .llm4ts/taskforce/<id>/plan.md. Edit the briefs, answer the",
  "questions under '## Answers', write under '## Feedback', and rerun."
].join("\n")

export interface TaskforceArgs {
  readonly agents: ReadonlyArray<string> | undefined
  readonly run: string | undefined
  readonly context: string | undefined
  readonly waves: number | undefined
  readonly briefs: number | undefined
  readonly parallel: number | undefined
  readonly turns: number | undefined
  readonly noPause: boolean
  readonly keepWork: boolean
  readonly noMemory: boolean
  readonly ejectPersonas: boolean
  readonly list: boolean
  readonly rest: ReadonlyArray<string>
}

export const parseTaskforceArgs = (
  argv: ReadonlyArray<string>
): Effect.Effect<TaskforceArgs, ScriptUsage> =>
  Effect.gen(function* () {
    let agents: ReadonlyArray<string> | undefined
    let run: string | undefined
    let context: string | undefined
    let waves: number | undefined
    let briefs: number | undefined
    let parallel: number | undefined
    let turns: number | undefined
    let noPause = false
    let keepWork = false
    let noMemory = false
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
          ? ScriptUsage.make({ message: `${name} needs a value\n${taskforceUsage}` })
          : Effect.succeed(value.trim())
      }
      const counted = (name: string): Effect.Effect<number, ScriptUsage> =>
        Effect.flatMap(valued(name), (value) =>
          /^\d+$/.test(value) && Number.parseInt(value, 10) > 0
            ? Effect.succeed(Number.parseInt(value, 10))
            : ScriptUsage.make({ message: `${name} needs a positive number, got: ${value}` })
        )
      if (is("--agents"))
        agents = (yield* valued("--agents"))
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0)
      else if (is("--run")) run = yield* valued("--run")
      else if (is("--context")) context = yield* valued("--context")
      else if (is("--waves")) waves = yield* counted("--waves")
      else if (is("--briefs")) briefs = yield* counted("--briefs")
      else if (is("--parallel")) parallel = yield* counted("--parallel")
      else if (is("--turns")) turns = yield* counted("--turns")
      else if (argument === "--no-pause") noPause = true
      else if (argument === "--keep-work") keepWork = true
      else if (argument === "--no-memory") noMemory = true
      else if (argument === "--eject-personas") ejectPersonas = true
      else if (argument === "--list") list = true
      else rest.push(argument)
    }
    return {
      agents,
      run,
      context,
      waves,
      briefs,
      parallel,
      turns,
      noPause,
      keepWork,
      noMemory,
      ejectPersonas,
      list,
      rest
    }
  })

// ---- Places -------------------------------------------------------------------

export const runsDir = (workDir: string): string => join(workDir, ".llm4ts", "taskforce")
export const runDir = (workDir: string, id: string): string => join(runsDir(workDir), id)
/** The repository's command allowlist for `--no-pause`, one command per line. */
export const commandsPath = (workDir: string): string => join(runsDir(workDir), "commands.md")
export const lensesDir = (workDir: string): string => join(workDir, ".llm4ts", "lenses")
export const runSlug = meetingSlug

const runFiles = (dir: string) => ({
  plan: join(dir, "plan.md"),
  report: (id: string) => join(dir, "reports", `${id}.md`),
  commandLog: (id: string) => join(dir, "reports", `${id}-commands.log`),
  diff: (id: string) => join(dir, "work", `${id}.diff`),
  review: join(dir, "review.md"),
  trail: join(dir, "decisions.tsv"),
  openQuestions: join(dir, "open-questions.md"),
  deliverable: (name: string) => join(dir, name)
})

// ---- The cast -----------------------------------------------------------------

export interface Cast {
  readonly chief: Persona
  readonly writer: Persona
  /** Everyone, the Chief of Staff and the Doc Writer included, in card order. */
  readonly all: ReadonlyArray<Persona>
}

/**
 * The cards the run uses: bundled ones, each replaced by a custom card of
 * the same name (`.llm4ts/personas/<name>.md`, read by the caller). The
 * Chief of Staff and the Doc Writer are always present; the Memory Manager
 * is present while memory is on; `agents` picks the rest.
 */
export const resolveCast = Effect.fn("taskforce.resolveCast")(function* (
  custom: Readonly<Record<string, string>>,
  agents: ReadonlyArray<string>,
  memory: boolean
): Effect.fn.Return<Cast, FlowError | ScriptUsage> {
  const cards: Record<string, string> = { ...bundledSpecialistCards, ...custom }
  const personas = new Map<string, Persona>()
  for (const [name, text] of Object.entries(cards)) {
    personas.set(name, yield* parsePersona(name, text))
  }
  const fixed = [chiefName, writerName]
  const known = [...personas.keys()].filter((name) => !fixed.includes(name))
  const missing = agents.filter((name) => !personas.has(name) || fixed.includes(name))
  if (missing.length > 0) {
    return yield* ScriptUsage.make({
      message: `unknown specialist(s): ${missing.join(", ")}; known: ${known.join(", ")} — add a card under .llm4ts/personas/<name>.md`
    })
  }
  const chief = personas.get(chiefName)
  const writer = personas.get(writerName)
  if (chief === undefined || writer === undefined) {
    return yield* ScriptUsage.make({ message: `no ${chiefName} or ${writerName} card` })
  }
  const names = new Set([chiefName, writerName, ...agents, ...(memory ? [memoryName] : [])])
  if (!memory) names.delete(memoryName)
  const all = [...names]
    .flatMap((name) => {
      const persona = personas.get(name)
      return persona === undefined ? [] : [persona]
    })
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
  return { chief, writer, all }
})

/** Writes every bundled card the folder lacks; returns the paths written. */
export const ejectPersonas = Effect.fn("taskforce.ejectPersonas")(function* (
  files: PlainFileStoreShape,
  workDir: string
): Effect.fn.Return<ReadonlyArray<string>, FlowError> {
  const written: Array<string> = []
  for (const [name, text] of Object.entries(bundledSpecialistCards)) {
    const path = join(personasDir(workDir), `${name}.md`)
    if ((yield* files.read(path)) !== undefined) continue
    yield* files.writeAtomic(path, text)
    written.push(path)
  }
  return written
})

export const describeCast = (cast: ReadonlyArray<Persona>): string =>
  cast
    .map(
      (persona) =>
        `  ${persona.name} (${persona.tools ?? "none"}, ${persona.seat ?? "planner"}): ${persona.mandate.split(/[.!?]/)[0] ?? ""}.`
    )
    .join("\n")

export const defaultAgents: ReadonlyArray<string> = selectableSpecialists

// ---- Commands (decision 5) ------------------------------------------------------

/** A command line as argv: whitespace-separated, single and double quotes grouping. */
export const shellWords = (command: string): ReadonlyArray<string> => {
  const words: Array<string> = []
  let current = ""
  let quoted = false
  let quote: '"' | "'" | undefined
  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      quoted = true
      continue
    }
    if (/\s/.test(char)) {
      if (current.length > 0 || quoted) words.push(current)
      current = ""
      quoted = false
      continue
    }
    current += char
  }
  if (current.length > 0 || quoted) words.push(current)
  return words
}

/**
 * What runs under `--no-pause`: the package's scripts through npm, pnpm or
 * yarn, and every line of `.llm4ts/taskforce/commands.md` that is not blank
 * or a comment.
 */
export const declaredCommands = (
  packageJson: string | undefined,
  commandsMarkdown: string | undefined
): ((argv: ReadonlyArray<string>) => boolean) => {
  const scripts = new Set<string>()
  if (packageJson !== undefined) {
    const parsed = Schema.decodeUnknownOption(
      Schema.fromJsonString(
        Schema.Struct({ scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) })
      )
    )(packageJson)
    if (parsed._tag === "Some")
      for (const name of Object.keys(parsed.value.scripts ?? {})) scripts.add(name)
  }
  const lines = new Set(
    (commandsMarkdown ?? "")
      .split(/\r?\n/)
      .map((line) =>
        line
          .trim()
          .replace(/^-\s*/, "")
          .replace(/^`(.*)`$/, "$1")
      )
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => shellWords(line).join("\u0000"))
  )
  return (argv) => {
    if (argv.length === 0) return false
    if (lines.has(argv.join("\u0000"))) return true
    const [runner, second, third] = argv
    if (runner === "npm") {
      return second === "test"
        ? scripts.has("test")
        : second === "run" && third !== undefined && scripts.has(third)
    }
    if (runner === "pnpm" || runner === "yarn") {
      return second === "run"
        ? third !== undefined && scripts.has(third)
        : second !== undefined && scripts.has(second)
    }
    return false
  }
}

// ---- Prompts ------------------------------------------------------------------

const personaBrief = (persona: Persona): string =>
  [
    `You are the ${persona.name} of a taskforce.`,
    "",
    `Mandate: ${persona.mandate}`,
    ...(persona.caresAbout.length === 0 ? [] : [`You care about: ${persona.caresAbout}`]),
    ...(persona.pushesBackOn.length === 0 ? [] : [`You push back on: ${persona.pushesBackOn}`]),
    ...(persona.neverDecidesAlone.length === 0
      ? []
      : [`You never decide alone: ${persona.neverDecidesAlone}`]),
    ...(persona.voice.length === 0 ? [] : [`Voice: ${persona.voice}`])
  ].join("\n")

const castBrief = (cast: ReadonlyArray<Persona>): string =>
  [
    "The cast (name, hands, mandate):",
    ...cast.map(
      (persona) =>
        `- ${persona.name} — ${persona.tools ?? "none"}: ${persona.mandate.split(/(?<=[.!?])\s/)[0] ?? persona.mandate}`
    )
  ].join("\n")

const contextBrief = (docs: ReadonlyArray<ContextDoc>, budget: number): ReadonlyArray<string> => {
  if (docs.length === 0) return []
  const each = Math.max(1_000, Math.floor(budget / 3 / docs.length))
  return [
    "",
    "Context documents (standards and notes the work stays within):",
    ...docs.flatMap((doc) => ["", `--- ${doc.path} ---`, cap(doc.text, each).text])
  ]
}

const memoryBrief = (notes: ReadonlyArray<MemoryNote>, budget: number): ReadonlyArray<string> => {
  if (notes.length === 0) return []
  const each = Math.max(500, Math.floor(budget / 6 / notes.length))
  return [
    "",
    "What we learned before (memory notes recalled for this goal):",
    ...notes.flatMap((note) => ["", `--- ${note.name} ---`, cap(note.body, each).text])
  ]
}

const briefTemplate = [
  "A brief has eight fields: GOAL (one sentence, the outcome, executable by a stranger), SCOPE (paths it may touch; paths it may not), CONTEXT (pointers to files and reports; what it depends on, pasted in), ACCEPTANCE (checkable criteria, one per entry), VERIFY (exact commands, one per entry; only the Operator may run commands — name them anyway and they will be routed), TIMEBOX (a rough cap), FORBIDDEN (what it must not do), REPORT (what the report must hold and which deliverable it feeds)."
].join("\n")

const planPrompt = (options: {
  chief: Persona
  goal: string
  cast: ReadonlyArray<Persona>
  docs: ReadonlyArray<ContextDoc>
  notes: ReadonlyArray<MemoryNote>
  caps: Caps
  budget: number
  violations: ReadonlyArray<string>
}): string =>
  [
    personaBrief(options.chief),
    "",
    `Goal: ${options.goal}`,
    "",
    castBrief(options.cast),
    ...contextBrief(options.docs, options.budget),
    ...memoryBrief(options.notes, options.budget),
    "",
    `Propose the plan: the deliverables (file names; result.md is always one and holds the answer, its sources and the next steps) and between 2 and ${options.caps.briefs} briefs, numbered B1 upward in the order you list them. Name each brief's owner from the cast by name and the brief ids it depends on. Riskiest unknown first; independent briefs run together. Every deliverable must be named in some brief's REPORT.`,
    "",
    briefTemplate,
    ...(options.violations.length === 0
      ? []
      : [
          "",
          "Your previous proposal was refused:",
          ...options.violations.map((violation) => `- ${violation}`),
          "Propose again without these faults."
        ]),
    "",
    'Reply with JSON: {"deliverables": ["result.md", ...], "briefs": [{"title": "...", "owner": "...", "dependsOn": ["B1"], "goal": "...", "scope": "...", "context": "...", "acceptance": ["..."], "verify": ["..."], "timebox": "...", "forbidden": "...", "report": "..."}]}'
  ].join("\n")

const reportsBrief = (
  plan: Plan,
  reports: ReadonlyArray<Report>,
  budget: number,
  only?: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const chosen = plan.briefs.filter((brief) => only === undefined || only.includes(brief.id))
  if (chosen.length === 0) return ["(no reports yet)"]
  const each = Math.max(800, Math.floor(budget / 2 / chosen.length))
  return chosen.flatMap((brief) => {
    const report = reportOf(reports, brief.id)
    return report === undefined
      ? [`--- ${brief.id} ${brief.title} (${brief.owner}): no report ---`]
      : [
          `--- ${brief.id} ${brief.title} (${brief.owner}): ${report.status}, ${report.summary} ---`,
          ...(report.evidence.length === 0 ? [] : [`evidence: ${report.evidence.join(", ")}`]),
          cap(report.body, each).text
        ]
  })
}

const checkPrompt = (options: {
  chief: Persona
  plan: Plan
  reports: ReadonlyArray<Report>
  wave: number
  mayReplan: boolean
  from: number
  caps: Caps
  cast: ReadonlyArray<Persona>
  budget: number
}): string =>
  [
    personaBrief(options.chief),
    "",
    `Goal: ${options.plan.goal}`,
    `Deliverables: ${options.plan.deliverables.join(", ")}`,
    "",
    `Goal check after wave ${options.wave}. The reports:`,
    "",
    ...reportsBrief(options.plan, options.reports, options.budget),
    "",
    options.mayReplan
      ? `Is the goal reached well enough for the Doc Writer to write the deliverables? If not, propose the second and last wave: up to ${Math.max(0, options.caps.briefs - options.plan.briefs.length)} more briefs, numbered from B${options.from}, that close the gap; they may depend on existing briefs by id. If yes, propose no briefs.`
      : "Is the goal reached well enough for the Doc Writer to write the deliverables? No further wave is possible: say what is reached and what is not, and propose no briefs.",
    "",
    castBrief(options.cast),
    "",
    briefTemplate,
    "",
    'Reply with JSON: {"reached": true, "note": "...", "briefs": []}'
  ].join("\n")

const reportGuide = [
  "Status: PASS when every acceptance criterion holds; ISSUES when the work is done but something named holds it back; BLOCKED when you could not do it (say what stopped you).",
  "Evidence: paths of what proves the report (files, diffs, logs). Questions: what only the owner can answer, each with the assumption you proceeded on."
].join("\n")

const briefPrompt = (options: {
  persona: Persona
  plan: Plan
  brief: Brief
  attempt: number
  reports: ReadonlyArray<Report>
  previous: Report | undefined
  docs: ReadonlyArray<ContextDoc>
  notes: ReadonlyArray<MemoryNote>
  commandOutput: string | undefined
  budget: number
}): string => {
  const { persona, plan, brief } = options
  return [
    personaBrief(persona),
    "",
    `Goal of the taskforce: ${plan.goal}`,
    "",
    `Brief ${brief.id}: ${brief.title}${options.attempt > 1 ? ` (attempt ${options.attempt})` : ""}`,
    `GOAL: ${brief.goal}`,
    `SCOPE: ${brief.scope}`,
    `CONTEXT: ${brief.context}`,
    "ACCEPTANCE:",
    ...acceptanceLines(brief).map((line) => `- ${line}`),
    ...(verifyCommands(brief).length === 0
      ? []
      : ["VERIFY:", ...verifyCommands(brief).map((line) => `- ${line}`)]),
    `TIMEBOX: ${brief.timebox}`,
    `FORBIDDEN: ${brief.forbidden}`,
    `REPORT: ${brief.report}`,
    ...(brief.dependsOn.length === 0
      ? []
      : [
          "",
          "Reports this brief depends on:",
          "",
          ...reportsBrief(plan, options.reports, options.budget, brief.dependsOn)
        ]),
    ...(options.previous === undefined
      ? []
      : [
          "",
          `Your previous attempt was BLOCKED: ${options.previous.summary}`,
          cap(options.previous.body, Math.floor(options.budget / 8)).text,
          "Try once more; if it is still blocked, say exactly what is needed."
        ]),
    ...(options.commandOutput === undefined
      ? []
      : [
          "",
          "The commands were run for you; their output:",
          "",
          cap(options.commandOutput, Math.floor(options.budget / 2)).text
        ]),
    ...contextBrief(options.docs, options.budget),
    ...memoryBrief(options.notes, options.budget),
    "",
    reportGuide,
    "",
    'Reply with JSON: {"status": "PASS|ISSUES|BLOCKED", "evidence": ["..."], "summary": "one line", "questions": [{"question": "...", "assumption": "..."}], "body": "<the report, markdown>"}'
  ].join("\n")
}

/** The Engineer's prompt: a coder with a worktree, asked to end with a REPORT line. */
const engineerPrompt = (options: {
  persona: Persona
  plan: Plan
  brief: Brief
  attempt: number
  reports: ReadonlyArray<Report>
  previous: Report | undefined
  docs: ReadonlyArray<ContextDoc>
  notes: ReadonlyArray<MemoryNote>
  budget: number
}): string =>
  [
    briefPrompt({ ...options, commandOutput: undefined }).split("\nReply with JSON:")[0] ?? "",
    "",
    "You are in a throwaway worktree of the repository: build, run and change what the brief needs. When you are done, write the report as your final message: what you built, what you ran, what it said, what is uncertain. End the message with one line exactly of the form",
    "REPORT: PASS|ISSUES|BLOCKED — <one-line summary>"
  ].join("\n")

export class DraftProposal extends Schema.Class<DraftProposal>("DraftProposal")({
  documents: Schema.Array(Schema.Struct({ name: Schema.String, content: Schema.String }))
}) {}

const draftProposalJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    documents: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, content: { type: "string" } },
        required: ["name", "content"]
      }
    }
  },
  required: ["documents"]
}

const draftPrompt = (options: {
  writer: Persona
  plan: Plan
  reports: ReadonlyArray<Report>
  docs: ReadonlyArray<ContextDoc>
  budget: number
  previous: ReadonlyArray<{ name: string; content: string }>
  fixes: ReadonlyArray<Brief>
}): string =>
  [
    personaBrief(options.writer),
    "",
    `Goal: ${options.plan.goal}`,
    `Deliverables to write: ${options.plan.deliverables.join(", ")}`,
    ...contextBrief(options.docs, options.budget),
    "",
    options.previous.length === 0
      ? "Write every deliverable from the reports below. Say what the taskforce established; cite the report or path behind each claim; where a question was parked for the owner, state the assumption the document rests on. Do not invent what no report supports."
      : "Revise the deliverables below from the fix reports. Change nothing the fixes do not touch.",
    ...(options.previous.length === 0
      ? []
      : [
          "",
          "Fix briefs that ran:",
          ...options.fixes.map((brief) => `- ${brief.id} ${brief.title} (${brief.owner})`),
          "",
          "Current deliverables:",
          ...options.previous.flatMap((doc) => [
            "",
            `--- ${doc.name} ---`,
            cap(doc.content, Math.floor(options.budget / 6)).text
          ])
        ]),
    "",
    "Reports:",
    "",
    ...reportsBrief(options.plan, options.reports, options.budget),
    "",
    "Sections of result.md:",
    options.writer.resultTemplate ??
      "## Answer\n## Sources\n## Explanation\n## Assumptions and open questions\n## Next steps",
    "",
    'Reply with JSON: {"documents": [{"name": "result.md", "content": "<complete markdown document>"}, ...]}'
  ].join("\n")

const lensPrompt = (options: {
  lens: Reviewer
  plan: Plan
  deliverables: ReadonlyArray<{ name: string; content: string }>
  diffs: ReadonlyArray<{ brief: Brief; diff: string }>
  budget: number
}): string =>
  [
    `Review lens: ${options.lens.name}`,
    "",
    options.lens.systemPrompt,
    "",
    `Goal: ${options.plan.goal}`,
    "Briefs:",
    ...options.plan.briefs.map((brief) => `- ${brief.id} ${brief.title} (${brief.owner})`),
    "",
    "Deliverables:",
    ...options.deliverables.flatMap((doc) => [
      "",
      `--- ${doc.name} ---`,
      cap(doc.content, Math.floor(options.budget / 3 / Math.max(1, options.deliverables.length)))
        .text
    ]),
    ...(options.diffs.length === 0
      ? []
      : [
          "",
          "Engineer diffs:",
          ...options.diffs.flatMap(({ brief, diff }) => [
            "",
            `--- ${brief.id} ${brief.title} ---`,
            cap(diff, Math.floor(options.budget / 3 / options.diffs.length)).text
          ])
        ]),
    "",
    "Report every concrete finding from this lens: what, where (a path, a section, a line), which brief's work it is about (its id, or empty when it is about a deliverable), and why it matters. No praise, no nitpicks. An empty list is a valid answer.",
    "",
    'Reply with JSON: {"findings": [{"title": "...", "where": "...", "brief": "B2", "detail": "..."}]}'
  ].join("\n")

const leadPrompt = (options: {
  reviewer: Persona
  plan: Plan
  findings: ReadonlyArray<Finding>
}): string =>
  [
    personaBrief(options.reviewer),
    "",
    `You are the lead reviewer. Goal: ${options.plan.goal}`,
    "",
    "The Judgment service has already marked which findings block the goal (act-on). Sort the rest: consider (legitimate, worth the owner's attention), noted (valid but not actionable now), dismissed (wrong, nitpicky, or missing context — say why).",
    "",
    ...options.findings.map(
      (finding) =>
        `- ${finding.id}. [${finding.bucket}] ${finding.title} (${finding.lens}; ${finding.where}): ${finding.detail}`
    ),
    "",
    'Reply with JSON: {"verdicts": [{"id": 2, "bucket": "consider|noted|dismissed", "reason": "..."}]} — one verdict per finding not already act-on.'
  ].join("\n")

const distillPrompt = (options: {
  memory: Persona
  plan: Plan
  reports: ReadonlyArray<Report>
  trail: string
  budget: number
}): string =>
  [
    personaBrief(options.memory),
    "",
    `Goal: ${options.plan.goal}`,
    `Deliverables: ${options.plan.deliverables.join(", ")}`,
    "",
    "Write the run note for the next run on this repository. The owner's edits and answers are in the trail (phase owner) and under Answers.",
    "",
    "Answers and feedback the owner gave:",
    ...(options.plan.answers.length === 0
      ? ["- none"]
      : options.plan.answers.map(
          (point) => `- ${point.question}${point.answer === undefined ? "" : ` → ${point.answer}`}`
        )),
    "",
    "The trail:",
    cap(options.trail, Math.floor(options.budget / 4)).text,
    "",
    "Reports:",
    "",
    ...reportsBrief(options.plan, options.reports, Math.floor(options.budget / 2)),
    "",
    'Reply with JSON: {"decisions": ["..."], "preferences": ["..."], "failed": ["..."], "pointers": ["..."]}'
  ].join("\n")

// ---- The run ------------------------------------------------------------------

export interface Seats {
  /** The toolless reasoning seat: the Chief of Staff, the Doc Writer, the Operator's write-up, the Memory Manager. */
  readonly toolless: LlmServiceShape
  /** A read-only seat over the repository: the Researcher, the Reviewer. */
  readonly readOnly: LlmServiceShape
  /** A roster's seat for a role, when the run has a roster. */
  readonly forSeat?: (role: Role) => LlmServiceShape
}

/** A throwaway worktree with a coder in it (decision 4). */
export interface Workspace {
  readonly dir: string
  readonly coder: LlmServiceShape
  readonly diff: Effect.Effect<string, FlowError>
}

export interface TaskforceDeps {
  readonly files: PlainFileStoreShape
  readonly events: FlowEventsShape
  readonly workDir: string
  readonly runId: string
  /** The goal, used only when the plan file does not exist yet. */
  readonly goal: string | undefined
  readonly cast: Cast
  readonly context: ReadonlyArray<ContextDoc>
  /** Every memory note of the repository; recall picks from them. */
  readonly notes: ReadonlyArray<MemoryNote>
  readonly caps: Caps
  readonly parallel: number
  readonly noPause: boolean
  readonly keepWork: boolean
  readonly memory: boolean
  readonly budget: number
  readonly seats: Seats
  readonly judgment: JudgmentShape
  readonly lenses: ReadonlyArray<Reviewer>
  readonly processes: ProcessExecutorShape
  /** Whether a command may run under `--no-pause`. */
  readonly allowedCommand: (argv: ReadonlyArray<string>) => boolean
  /** A worktree for a workspace brief; the scope ends the coder, the directory stays until `removeWorkspace`. */
  readonly workspaceFor: (brief: Brief) => Effect.Effect<Workspace, FlowError, Scope.Scope>
  readonly removeWorkspace: (dir: string) => Effect.Effect<void, FlowError>
  /** The trail's clock. */
  readonly now: () => string
}

export type TaskforceOutcome =
  | { readonly _tag: "NothingToDo"; readonly message: string }
  | { readonly _tag: "Finished"; readonly summary: ReadonlyArray<string> }

const firstLine = (text: string): string => {
  const line = terminalSafe(text.split(/\r?\n/)[0] ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return line.length > 80 ? `${line.slice(0, 77)}...` : line
}

const reportLine = /^REPORT:\s*(PASS|ISSUES|BLOCKED)\s*(?:[—:-]+\s*(.*))?$/m

/** The Engineer's status and summary from the last REPORT line of its reply; none means the timebox or the model cut it. */
export const engineerReport = (
  reply: string
): { status: "PASS" | "ISSUES" | "BLOCKED"; summary: string } | undefined => {
  const matches = [...reply.matchAll(new RegExp(reportLine.source, "gm"))]
  const last = matches.at(-1)
  if (last === undefined) return undefined
  const status = last[1]
  return status === "PASS" || status === "ISSUES" || status === "BLOCKED"
    ? { status, summary: (last[2] ?? "").trim() }
    : undefined
}

/** The run, driven from its files until it halts for the person or is done. */
export const runTaskforce = Effect.fn("taskforce.run")(function* (
  deps: TaskforceDeps
): Effect.fn.Return<TaskforceOutcome, FlowError | ScriptUsage> {
  const { files, events, caps, cast } = deps
  const dir = runDir(deps.workDir, deps.runId)
  const paths = runFiles(dir)
  const say = (message: string) => events.publish(Info.make({ message }))
  const save = (plan: Plan) => files.writeAtomic(paths.plan, renderPlan(plan))
  const trail = (phase: string, decision: string, why: string, evidence: string, result: string) =>
    Effect.gen(function* () {
      const existing = yield* files.read(paths.trail)
      const row = renderTrailRow({ ts: deps.now(), phase, decision, why, evidence, result })
      yield* files.append(
        paths.trail,
        `${existing === undefined ? `${trailHeader}\n` : ""}${row}\n`
      )
    })
  const personaOf = (name: string): Persona | undefined =>
    cast.all.find((persona) => persona.name === name)
  const seatOf = (persona: Persona): LlmServiceShape => {
    const role: Role = persona.seat ?? (persona.tools === "read-only" ? "reviewer" : "planner")
    const fromRoster = deps.seats.forSeat?.(role)
    if (fromRoster !== undefined) return fromRoster
    return persona.tools === "read-only" ? deps.seats.readOnly : deps.seats.toolless
  }
  const notesFor = (goal: string): ReadonlyArray<MemoryNote> =>
    deps.memory ? recall(goal, deps.notes, 5) : []

  // ---- The plan ----
  const loaded = yield* files.read(paths.plan)
  let plan: Plan
  if (loaded === undefined) {
    const goal = (deps.goal ?? "").trim()
    if (goal.length === 0) {
      return yield* ScriptUsage.make({
        message: `no plan at ${paths.plan}: give the goal to start a run\n${taskforceUsage}`
      })
    }
    plan = Plan.make({
      id: deps.runId,
      status: "planned",
      goal,
      deliverables: ["result.md"],
      cast: cast.all.map((persona) => persona.name),
      briefs: [],
      checks: [],
      answers: [],
      feedback: "",
      drafts: 0,
      folded: []
    })
    yield* save(plan)
    yield* say(`taskforce: ${paths.plan} opened — ${plan.cast.join(", ")}`)
  } else {
    plan = yield* parsePlan(loaded, paths.plan)
  }
  for (const name of plan.cast) {
    if (personaOf(name) === undefined) {
      return yield* ScriptUsage.make({
        message: `the plan lists ${name} but no such card is known; pass --agents with the plan's cast, or add .llm4ts/personas/${name}.md`
      })
    }
  }
  // Every specialist is a lane in the dashboard, from the first event of the run.
  for (const name of plan.cast) {
    yield* events.publish(StageStarted.make({ stage: `specialist ${name}`, lane: name }))
  }
  const notes = notesFor(plan.goal)
  if (notes.length > 0) yield* say(`memory: recalled ${notes.map((note) => note.name).join(", ")}`)

  // ---- Reports ----
  let reports: Array<Report> = []
  for (const brief of plan.briefs) {
    const text = yield* files.read(paths.report(brief.id))
    if (text !== undefined) reports.push(yield* parseReport(text, paths.report(brief.id)))
  }
  const workspaces = new Map<string, string>()
  const record = (report: Report, brief: Brief) =>
    Effect.gen(function* () {
      reports = [...reports.filter((existing) => existing.brief !== report.brief), report]
      yield* files.writeAtomic(paths.report(brief.id), renderReport(report, brief.title))
      plan = syncAnswers(plan, [report])
      yield* save(plan)
      yield* events.publish(
        BriefReported.make({
          lane: brief.owner,
          run: plan.id,
          brief: brief.id,
          title: brief.title,
          wave: brief.wave,
          attempt: report.attempt,
          status: report.status,
          summary: firstLine(report.summary)
        })
      )
      yield* trail(
        `wave ${brief.wave}`,
        `${brief.id} reported ${report.status} by ${brief.owner}`,
        report.summary,
        `reports/${brief.id}.md`,
        report.status === "BLOCKED" && !isFinal(report) ? "retry" : report.status.toLowerCase()
      )
      yield* say(`[${brief.id} ${brief.owner}] ${report.status}: ${firstLine(report.summary)}`)
    })
  const blocked = (brief: Brief, attempt: number, summary: string, body: string): Report =>
    Report.make({
      brief: brief.id,
      status: "BLOCKED",
      attempt,
      evidence: [],
      summary,
      questions: [],
      body
    })
  const fromProposal = (brief: Brief, attempt: number, proposal: ReportProposal): Report =>
    Report.make({
      brief: brief.id,
      status: proposal.status,
      attempt,
      evidence: proposal.evidence,
      summary: proposal.summary,
      questions: proposal.questions,
      body: proposal.body
    })

  /** Runs the commands a brief names; the log, and a reason it could not. */
  const runCommands = (brief: Brief, cwd: string) =>
    Effect.gen(function* () {
      const lines: Array<string> = []
      for (const command of verifyCommands(brief)) {
        const argv = shellWords(command)
        if (deps.noPause && !deps.allowedCommand(argv)) {
          return { log: lines.join("\n"), refused: command }
        }
        const result = yield* deps.processes.run(argv, cwd, {}).pipe(
          Effect.map((done) => ({
            exitCode: done.exitCode,
            stdout: done.stdout,
            stderr: done.stderr
          })),
          Effect.catch((error) =>
            Effect.succeed({ exitCode: 127, stdout: [], stderr: [error.message] })
          )
        )
        lines.push(
          `$ ${command}`,
          `exit ${result.exitCode}`,
          ...result.stdout,
          ...result.stderr,
          ""
        )
      }
      return { log: lines.join("\n"), refused: undefined }
    })

  /** One brief, start to report: the seat by grade, the commands, the worktree. */
  const runBrief = (
    brief: Brief,
    attempt: number
  ): Effect.Effect<Report, FlowError | ScriptUsage> =>
    Effect.gen(function* () {
      const persona = personaOf(brief.owner)
      if (persona === undefined) {
        return yield* ScriptUsage.make({ message: `no card for ${brief.owner}` })
      }
      const previous = reportOf(reports, brief.id)
      yield* events.publish(
        StageStarted.make({ stage: `${brief.id}: ${brief.title}`, lane: brief.owner })
      )
      const prompts = {
        persona,
        plan,
        brief,
        attempt,
        reports,
        previous,
        docs: deps.context,
        notes,
        budget: deps.budget
      }
      let report: Report
      if (persona.tools === "workspace") {
        report = yield* Effect.scoped(
          Effect.gen(function* () {
            const workspace = yield* deps.workspaceFor(brief)
            workspaces.set(brief.id, workspace.dir)
            const reply = yield* completeAndPublish(
              workspace.coder,
              events,
              engineerPrompt(prompts)
            ).pipe(
              Effect.map((text): string | undefined => text),
              Effect.catch((error) =>
                say(`[${brief.id}] the coder failed: ${error.message}`).pipe(Effect.as(undefined))
              )
            )
            const diff = yield* workspace.diff.pipe(Effect.catch(() => Effect.succeed("")))
            const evidence: Array<string> = []
            if (diff.trim().length > 0) {
              yield* files.writeAtomic(paths.diff(brief.id), diff)
              evidence.push(`work/${brief.id}.diff`)
            }
            const parsed = reply === undefined ? undefined : engineerReport(reply)
            return parsed === undefined
              ? blocked(
                  brief,
                  attempt,
                  reply === undefined
                    ? "the coder failed before reporting"
                    : "no REPORT line: the turn cap or the model cut the work short",
                  reply ?? ""
                )
              : Report.make({
                  brief: brief.id,
                  status: parsed.status,
                  attempt,
                  evidence,
                  summary: parsed.summary,
                  questions: [],
                  body: reply ?? ""
                })
          })
        )
      } else {
        let commandOutput: string | undefined
        if (persona.tools === "commands") {
          const inWorkspace = brief.dependsOn
            .map((id) => workspaces.get(id))
            .find((dir) => dir !== undefined)
          const ran = yield* runCommands(brief, inWorkspace ?? deps.workDir)
          if (ran.log.length > 0) yield* files.writeAtomic(paths.commandLog(brief.id), ran.log)
          if (ran.refused !== undefined) {
            return blocked(
              brief,
              attempt,
              `command not declared, not run under --no-pause: ${ran.refused}`,
              `Declare it in package.json scripts or ${commandsPath(deps.workDir)}, or run without --no-pause.\n\n${ran.log}`
            )
          }
          commandOutput = ran.log
        }
        const proposal = yield* structuredAndPublish(
          seatOf(persona),
          events,
          briefPrompt({ ...prompts, commandOutput }),
          ReportProposal,
          reportProposalJsonSchema,
          persona.name
        ).pipe(
          Effect.map((value): ReportProposal | undefined => value),
          Effect.catch((error) =>
            say(`[${brief.id}] the seat failed: ${error.message}`).pipe(Effect.as(undefined))
          )
        )
        report =
          proposal === undefined
            ? blocked(brief, attempt, "the seat failed before reporting", "")
            : fromProposal(
                brief,
                attempt,
                commandOutput === undefined
                  ? proposal
                  : ReportProposal.make({
                      ...proposal,
                      evidence: [...proposal.evidence, `reports/${brief.id}-commands.log`]
                    })
              )
      }
      yield* events.publish(
        StageCompleted.make({ stage: `${brief.id}: ${brief.title}`, lane: brief.owner })
      )
      return report
    })

  /** Worktrees whose dependents all ended are removed, unless kept. */
  const sweepWorkspaces = (final: boolean) =>
    Effect.gen(function* () {
      if (deps.keepWork) return
      for (const [id, workspaceDir] of [...workspaces]) {
        const dependents = plan.briefs.filter((brief) => brief.dependsOn.includes(id))
        const done = dependents.every((brief) => {
          const report = reportOf(reports, brief.id)
          return report !== undefined && isFinal(report)
        })
        if (final || done) {
          yield* deps
            .removeWorkspace(workspaceDir)
            .pipe(
              Effect.catch((error) => say(`could not remove ${workspaceDir}: ${error.message}`))
            )
          workspaces.delete(id)
        }
      }
    })

  const proposePlan = (violations: ReadonlyArray<string>) =>
    structuredAndPublish(
      deps.seats.forSeat?.("planner") ?? deps.seats.toolless,
      events,
      planPrompt({
        chief: cast.chief,
        goal: plan.goal,
        cast: cast.all,
        docs: deps.context,
        notes,
        caps,
        budget: deps.budget,
        violations
      }),
      PlanProposal,
      planProposalJsonSchema,
      cast.chief.name
    )

  const readDeliverables = () =>
    Effect.forEach(plan.deliverables, (name) =>
      Effect.map(files.read(paths.deliverable(name)), (content) => ({
        name,
        content: content ?? ""
      }))
    )

  let guard = 0
  for (;;) {
    guard += 1
    if (guard > caps.briefs * 6 + 64) {
      return yield* FlowAborted.make({
        message: `taskforce ${deps.runId}: no end after ${guard} steps; the files under ${dir} are intact`
      })
    }
    const action: Action = nextAction(plan, reports, caps)
    switch (action._tag) {
      case "Refused":
        return yield* ScriptUsage.make({ message: `taskforce ${deps.runId}: ${action.reason}` })
      case "Done":
        yield* sweepWorkspaces(true)
        return {
          _tag: "NothingToDo",
          message: `taskforce ${deps.runId} is done; answer a question under '## Answers' or write '## Feedback' in ${paths.plan} to reopen it`
        }
      case "ProposePlan": {
        let violations: ReadonlyArray<string> = []
        for (let round = 1; round <= 2; round += 1) {
          const proposal = yield* proposePlan(violations)
          const deliverables = [
            ...new Set([
              "result.md",
              ...proposal.deliverables.map((name) => name.trim()).filter((name) => name.length > 0)
            ])
          ]
          const assembled = assembleBriefs(proposal.briefs, { from: 1, wave: 1, cast: cast.all })
          const candidate = Plan.make({ ...plan, deliverables, briefs: assembled.briefs })
          violations = planViolations(candidate, caps)
          for (const note of assembled.notes) yield* say(`plan: ${note}`)
          if (violations.length === 0) {
            plan = candidate
            break
          }
          yield* say(
            `plan: proposal ${round} refused:\n${violations.map((v) => `  - ${v}`).join("\n")}`
          )
        }
        if (violations.length > 0) {
          yield* trail("plan", "plan refused twice", violations.join("; "), "plan.md", "stopped")
          return yield* PlanInvalid.make({ path: paths.plan, violations })
        }
        yield* save(plan)
        yield* trail(
          "plan",
          `${cast.chief.name} proposed ${plan.briefs.length} briefs`,
          `deliverables ${plan.deliverables.join(", ")}`,
          "plan.md",
          deps.noPause ? "accepted" : "awaiting the owner"
        )
        yield* say(
          `taskforce: ${cast.chief.name} proposed ${plan.briefs.length} brief(s) for ${plan.deliverables.join(", ")}:\n${plan.briefs.map((brief) => `  ${brief.id}. ${brief.title} — ${brief.owner}${brief.dependsOn.length === 0 ? "" : ` (after ${brief.dependsOn.join(", ")})`}`).join("\n")}`
        )
        if (!deps.noPause) {
          return yield* PlanPending.make({ path: paths.plan, briefs: plan.briefs.length })
        }
        continue
      }
      case "Open": {
        const violations = planViolations(plan, caps)
        if (violations.length > 0) {
          return yield* PlanInvalid.make({ path: paths.plan, violations })
        }
        plan = Plan.make({ ...plan, status: "working" })
        yield* save(plan)
        yield* trail(
          "plan",
          "plan opened",
          `${plan.briefs.length} briefs, ${plan.cast.length} in the cast`,
          "plan.md",
          "working"
        )
        yield* say(
          `taskforce: working ${plan.briefs.length} brief(s), up to ${deps.parallel} at once, ${caps.waves} wave(s) at most`
        )
        continue
      }
      case "RecordOwner": {
        const recorded = recordOwner(plan, action, caps, cast.writer.name)
        plan = Plan.make({
          ...recorded.plan,
          briefs: [...recorded.plan.briefs, ...recorded.briefs]
        })
        yield* save(plan)
        for (const note of recorded.notes) yield* say(`owner: ${note}`)
        for (const answer of action.answers) {
          yield* trail(
            "owner",
            `answer ${answer.number} folded`,
            answer.answer,
            "plan.md",
            recorded.briefs.length === 0 ? "no rework" : "rework"
          )
        }
        if (action.feedback.length > 0)
          yield* trail("owner", "feedback folded", action.feedback, "plan.md", recorded.plan.status)
        for (const brief of recorded.briefs) {
          yield* say(`owner: ${brief.id} ${brief.title} — ${brief.owner} (wave ${brief.wave})`)
        }
        continue
      }
      case "Skip": {
        const report = blocked(
          action.brief,
          2,
          `not run: ${action.reason}`,
          "A dependency ended blocked twice; the run went on without this brief."
        )
        yield* record(report, action.brief)
        continue
      }
      case "Dispatch": {
        const wave = action.briefs[0]?.wave ?? currentWave(plan)
        yield* events.publish(StageStarted.make({ stage: `wave ${wave}` }))
        for (const brief of action.briefs) {
          yield* trail(
            `wave ${wave}`,
            `dispatched ${brief.id} to ${brief.owner}${action.attempt > 1 ? " again" : ""}`,
            brief.dependsOn.length === 0
              ? "no dependencies"
              : `after ${brief.dependsOn.join(", ")}`,
            "plan.md",
            "running"
          )
        }
        const results = yield* Effect.forEach(
          action.briefs,
          (brief) => Effect.map(runBrief(brief, action.attempt), (report) => ({ brief, report })),
          { concurrency: Math.max(1, deps.parallel) }
        )
        for (const { brief, report } of results) yield* record(report, brief)
        yield* sweepWorkspaces(false)
        yield* events.publish(StageCompleted.make({ stage: `wave ${wave}` }))
        continue
      }
      case "Check": {
        const from = plan.briefs.length + 1
        const proposal = yield* structuredAndPublish(
          deps.seats.forSeat?.("planner") ?? deps.seats.toolless,
          events,
          checkPrompt({
            chief: cast.chief,
            plan,
            reports,
            wave: action.wave,
            mayReplan: action.mayReplan,
            from,
            caps,
            cast: cast.all,
            budget: deps.budget
          }),
          CheckProposal,
          checkProposalJsonSchema,
          cast.chief.name
        )
        const check = GoalCheck.make({
          wave: action.wave,
          reached: proposal.reached || !action.mayReplan || proposal.briefs.length === 0,
          note: proposal.note
        })
        let added: ReadonlyArray<Brief> = []
        if (!proposal.reached && action.mayReplan && proposal.briefs.length > 0) {
          const room = Math.max(0, caps.briefs - plan.briefs.length)
          const assembled = assembleBriefs(
            proposal.briefs.slice(0, room),
            { from, wave: action.wave + 1, cast: cast.all },
            plan.briefs.map((brief) => brief.id)
          )
          added = assembled.briefs.slice(0, room)
          for (const note of assembled.notes) yield* say(`check: ${note}`)
          if (proposal.briefs.length > room)
            yield* say(
              `check: ${proposal.briefs.length - room} proposed brief(s) dropped at the cap of ${caps.briefs}`
            )
        }
        const candidate = Plan.make({
          ...plan,
          checks: [...plan.checks, check],
          briefs: [...plan.briefs, ...added],
          status: added.length === 0 ? "drafting" : "working"
        })
        const violations = added.length === 0 ? [] : planViolations(candidate, caps)
        if (violations.length > 0) {
          yield* say(
            `check: the second wave was refused and dropped:\n${violations.map((v) => `  - ${v}`).join("\n")}`
          )
          plan = Plan.make({
            ...plan,
            checks: [...plan.checks, GoalCheck.make({ ...check, reached: true })],
            status: "drafting"
          })
        } else {
          plan = candidate
        }
        yield* save(plan)
        yield* trail(
          "check",
          `wave ${action.wave}: ${check.reached ? "reached" : "not reached"}`,
          proposal.note,
          "plan.md",
          added.length === 0 ? "drafting" : `wave ${action.wave + 1}: ${added.length} briefs`
        )
        yield* say(
          `${cast.chief.name}: wave ${action.wave} ${check.reached ? "reached the goal" : "did not reach the goal"} — ${firstLine(proposal.note)}${added.length === 0 ? "" : `; ${added.length} more brief(s)`}`
        )
        continue
      }
      case "Draft": {
        if (plan.status !== "drafting") {
          plan = Plan.make({ ...plan, status: "drafting" })
          yield* save(plan)
        }
        const previous = action.redraft ? yield* readDeliverables() : []
        const fixes = plan.briefs.filter(
          (brief) => brief.wave === currentWave(plan) && action.redraft
        )
        const proposal = yield* structuredAndPublish(
          seatOf(cast.writer),
          events,
          draftPrompt({
            writer: cast.writer,
            plan,
            reports,
            docs: deps.context,
            budget: deps.budget,
            previous,
            fixes
          }),
          DraftProposal,
          draftProposalJsonSchema,
          cast.writer.name
        )
        const written: Array<string> = []
        for (const document of proposal.documents) {
          const name = document.name.trim()
          if (!plan.deliverables.includes(name)) continue
          yield* files.writeAtomic(paths.deliverable(name), `${document.content.trim()}\n`)
          written.push(name)
        }
        const missing = plan.deliverables.filter((name) => !written.includes(name))
        if (missing.length > 0)
          yield* say(`${cast.writer.name}: did not write ${missing.join(", ")}`)
        yield* files.writeAtomic(paths.openQuestions, renderOpenQuestions(plan, reports))
        plan = Plan.make({
          ...plan,
          drafts: plan.drafts + 1,
          status: plan.drafts === 0 ? "reviewing" : "distilling"
        })
        yield* save(plan)
        yield* trail(
          "draft",
          `${cast.writer.name} wrote draft ${plan.drafts}`,
          written.join(", "),
          written.map((name) => name).join(", "),
          plan.status
        )
        yield* say(
          `${cast.writer.name}: draft ${plan.drafts} — ${written.map((name) => paths.deliverable(name)).join(", ")}`
        )
        continue
      }
      case "Review": {
        const deliverables = yield* readDeliverables()
        const diffs: Array<{ brief: Brief; diff: string }> = []
        for (const brief of plan.briefs) {
          if (personaOf(brief.owner)?.tools !== "workspace") continue
          const diff = yield* files.read(paths.diff(brief.id))
          if (diff !== undefined && diff.trim().length > 0) diffs.push({ brief, diff })
        }
        const reviewer = cast.all.find((persona) => persona.name === "Reviewer")
        const reviewSeat = reviewer === undefined ? deps.seats.readOnly : seatOf(reviewer)
        const findings: Array<Finding> = []
        for (const lens of deps.lenses) {
          const found = yield* structuredAndPublish(
            reviewSeat,
            events,
            lensPrompt({ lens, plan, deliverables, diffs, budget: deps.budget }),
            LensFindings,
            lensFindingsJsonSchema,
            `lens ${lens.name}`
          )
          for (const finding of found.findings) {
            const id = findings.length + 1
            const result = yield* judgeOrEscalate({
              judgment: deps.judgment,
              reasoning: deps.seats.toolless,
              events,
              request: {
                state: {
                  goal: plan.goal,
                  finding: `${finding.title} (${finding.where}): ${finding.detail}`
                },
                questions: {
                  blocks: truth(
                    "This finding, left unaddressed, stops the deliverables from reaching the goal."
                  )
                }
              }
            })
            const answer = yield* truthOf(result, "blocks").pipe(Effect.option)
            const blocks =
              answer._tag === "Some" && decide(answer.value) !== "hold" && answer.value.truth >= 0.5
            const probability = answer._tag === "Some" ? answer.value.truth.toFixed(2) : "n/a"
            findings.push(
              Finding.make({
                id,
                lens: lens.name,
                title: finding.title,
                where: finding.where,
                brief: plan.briefs.some((brief) => brief.id === finding.brief.trim())
                  ? finding.brief.trim()
                  : "",
                detail: finding.detail,
                bucket: blocks ? "act-on" : "consider",
                reason: blocks
                  ? `judged blocking (p=${probability})`
                  : `judged not blocking (p=${probability})`
              })
            )
            yield* trail(
              "review",
              `finding ${id} ${blocks ? "act-on" : "consider"}: ${finding.title}`,
              `${lens.name}; p=${probability}`,
              finding.where,
              blocks ? "fix" : "lead"
            )
          }
        }
        const pending = findings.filter((finding) => finding.bucket === "consider")
        if (reviewer !== undefined && pending.length > 0) {
          const lead = yield* structuredAndPublish(
            seatOf(reviewer),
            events,
            leadPrompt({ reviewer, plan, findings }),
            LeadProposal,
            leadProposalJsonSchema,
            `${reviewer.name} lead`
          )
          for (const verdict of lead.verdicts) {
            const index = findings.findIndex(
              (finding) => finding.id === verdict.id && finding.bucket === "consider"
            )
            if (index < 0) continue
            findings[index] = Finding.make({
              ...findings[index],
              bucket: verdict.bucket,
              reason: verdict.reason
            })
          }
        }
        yield* files.writeAtomic(paths.review, renderReview(findings))
        const fix = fixBriefs(plan, findings, caps, cast.writer.name)
        for (const dropped of fix.dropped)
          yield* say(`review: finding ${dropped.id} dropped at the brief cap: ${dropped.title}`)
        plan = Plan.make({
          ...plan,
          briefs: [...plan.briefs, ...fix.briefs],
          status: fix.briefs.length === 0 ? "distilling" : "fixing"
        })
        yield* save(plan)
        yield* trail(
          "review",
          `${findings.length} finding(s): ${findings.filter((f) => f.bucket === "act-on").length} act-on`,
          deps.lenses.map((lens) => lens.name).join(", "),
          "review.md",
          fix.briefs.length === 0
            ? "no fix wave"
            : `fix wave: ${fix.briefs.map((brief) => brief.id).join(", ")}`
        )
        yield* say(
          `review: ${findings.length} finding(s) — ${paths.review}${fix.briefs.length === 0 ? "" : `; fix wave of ${fix.briefs.length}`}`
        )
        continue
      }
      case "Distill": {
        yield* files.writeAtomic(paths.openQuestions, renderOpenQuestions(plan, reports))
        const memory = cast.all.find((persona) => persona.name === memoryName)
        if (deps.memory && memory !== undefined) {
          const trailText = (yield* files.read(paths.trail)) ?? ""
          const note = yield* structuredAndPublish(
            seatOf(memory),
            events,
            distillPrompt({ memory, plan, reports, trail: trailText, budget: deps.budget }),
            RunNote,
            runNoteJsonSchema,
            memory.name
          )
          const path = join(deps.workDir, ".llm4ts", "memory", "runs", `${plan.id}.md`)
          yield* files.writeAtomic(path, renderRunNote(plan.id, plan.goal, note))
          yield* trail(
            "distill",
            `${memory.name} wrote the run note`,
            `${note.decisions.length} decisions, ${note.failed.length} failures`,
            `.llm4ts/memory/runs/${plan.id}.md`,
            "done"
          )
          yield* say(`${memory.name}: ${path}`)
        }
        plan = Plan.make({ ...plan, status: "done" })
        yield* save(plan)
        yield* sweepWorkspaces(true)
        const unanswered = plan.answers.filter((point) => (point.answer ?? "").trim().length === 0)
        const blockedTwice = plan.briefs.filter((brief) => {
          const report = reportOf(reports, brief.id)
          return report?.status === "BLOCKED" && isFinal(report)
        })
        const summary = [
          `taskforce ${deps.runId} done after ${plan.briefs.length} brief(s), ${currentWave(plan)} wave(s) and ${plan.drafts} draft(s)`,
          ...plan.deliverables.map((name) => `${name}: ${paths.deliverable(name)}`),
          `review: ${paths.review}`,
          `trail: ${paths.trail}`,
          `open questions: ${paths.openQuestions}${blockedTwice.length === 0 ? "" : ` (${blockedTwice.length} brief(s) blocked)`}`,
          ...(unanswered.length === 0
            ? []
            : [
                `${unanswered.length} question(s) for you under '## Answers' in ${paths.plan}; answer and rerun to fold them in`
              ])
        ]
        for (const line of summary) yield* say(line)
        for (const name of plan.cast) {
          yield* events.publish(StageCompleted.make({ stage: `specialist ${name}`, lane: name }))
        }
        return { _tag: "Finished", summary }
      }
    }
  }
})

/** The two lenses a repository without `.llm4ts/lenses/` reviews with. */
export const bundledLenses: ReadonlyArray<{ name: string; systemPrompt: string }> = [
  {
    name: "evidence",
    systemPrompt:
      "Check every claim in the deliverables against the reports and the diffs. A claim no report supports, a number no log shows, a source that does not exist, an assumption presented as a fact: each is a finding."
  },
  {
    name: "risk",
    systemPrompt:
      "Ask what breaks if the deliverables are wrong and acted on. A recommendation with an unexamined failure mode, a next step that is irreversible, a change in a diff that touches more than its brief, a security or data concern nobody raised: each is a finding."
  }
]
