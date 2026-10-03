/**
 * Retro: a run's failures become proposed fixes behind an approval.
 *
 * After an epic-stories run with failed stories, the evidence the run left
 * behind (trace, transcripts when kept, board, report, story plans, findings
 * and verdicts) is digested by code into one document, a read-only seat
 * turns it into a typed proposal, and the proposal is written beside an
 * approval line. The next epic-stories run applies what a person ticked:
 * tasks appended to a story's plan, or a story entry edited in the epic
 * plan (which restarts that story). Nothing is applied unreviewed.
 */
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { JsonSchema } from "@llm4ts/core/Models"
import { ApprovedMarker, DraftApprovalMarker } from "./Approval.ts"
import { Board, BoardVersion } from "./BoardSync.ts"
import { cap } from "./Context.ts"
import { PersistenceError, type FlowError, type StoryPlanInvalid } from "./FlowError.ts"
import { FlowEvent, Info, type FlowEventsShape } from "./FlowEvents.ts"
import type { TraceLine } from "./FlowRecorder.ts"
import { Plan, Task, parsePlan } from "./Plan.ts"
import { loadVersioned, makePlanStore, type PlainFileStoreShape } from "./Persistence.ts"
import { ReviewResult } from "./Review.ts"
import {
  EpicReport,
  EpicReportVersion,
  StoryState,
  StoryStateVersion,
  StoryVerdict
} from "./Stories.ts"
import { Story, StoryPlan, makeStoryPlanStore, validateStoryPlan } from "./StoryPlan.ts"
import type { TranscriptEntry } from "./Transcript.ts"

// ---- Paths --------------------------------------------------------------------------

export interface RetroPaths {
  readonly dir: string
  readonly digest: string
  readonly report: string
  readonly proposal: string
  readonly library: string
  readonly index: string
}

/** Where a run's retro lives: `<state>/retro/<runId>.*`, indexed in `retro/retros.jsonl`. */
export const retroPaths = (stateDir: string, runId: string): RetroPaths => {
  const dir = join(stateDir, "retro")
  return {
    dir,
    digest: join(dir, `${runId}.digest.md`),
    report: join(dir, `${runId}.md`),
    proposal: join(dir, `${runId}.json`),
    library: join(dir, `${runId}-library.md`),
    index: join(dir, "retros.jsonl")
  }
}

const RetroIndexEntry = Schema.Struct({ runId: Schema.String, at: Schema.Number })
const encodeIndexEntry = Schema.encodeSync(Schema.fromJsonString(RetroIndexEntry))
const decodeIndexEntry = Schema.decodeUnknownOption(Schema.fromJsonString(RetroIndexEntry))

export const appendRetroIndex = (
  files: PlainFileStoreShape,
  stateDir: string,
  runId: string,
  at: number
): Effect.Effect<void, PersistenceError> =>
  files.append(retroPaths(stateDir, runId).index, `${encodeIndexEntry({ runId, at })}\n`)

/** The retros written for this state folder, oldest first. */
export const readRetroIndex = (
  files: PlainFileStoreShape,
  stateDir: string
): Effect.Effect<ReadonlyArray<{ readonly runId: string; readonly at: number }>> =>
  files.read(retroPaths(stateDir, "").index).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
    Effect.map((contents) =>
      (contents ?? "")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => Option.toArray(decodeIndexEntry(line)))
    )
  )

// ---- Evidence --------------------------------------------------------------------------

/** What the run left behind for one story, as files on disk. */
export interface StoryFiles {
  readonly story: Story
  readonly state: StoryState | undefined
  readonly plan: Plan | undefined
  readonly findings: string | undefined
  readonly verdict: ReviewResult | undefined
}

export interface RetroInputs {
  readonly runId: string
  readonly plan: StoryPlan
  readonly trace: ReadonlyArray<TraceLine>
  /** Per story lane; `undefined` when the run kept no transcript at all. */
  readonly transcripts: ReadonlyMap<string, ReadonlyArray<TranscriptEntry>> | undefined
  readonly report: EpicReport | undefined
  readonly board: Board | undefined
  readonly stories: ReadonlyArray<StoryFiles>
  /** Characters the whole digest may hold (`LLM4TS_RETRO_CHARS`, default 60 000). */
  readonly budget?: number
}

export const defaultRetroChars = 60_000
const perStoryShare = 12_000
const findingsTail = 3_000
const transcriptHead = 600
const runLineCap = 40

const Verdict = Schema.Union([StoryVerdict, ReviewResult])
const VerdictEntry = Schema.fromJsonString(
  Schema.Struct({ fingerprint: Schema.String, result: Verdict })
)

/** Reads the per-story files the executor keeps under `<state>/stories/`. */
export const loadStoryFiles = Effect.fn("@llm4ts/flow/Retro.loadStoryFiles")(function* (
  files: PlainFileStoreShape,
  stateDir: string,
  story: Story
): Effect.fn.Return<StoryFiles, FlowError> {
  const base = join(stateDir, "stories", story.id)
  const quiet = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A | undefined> =>
    effect.pipe(Effect.catch(() => Effect.succeed(undefined)))
  const state = yield* quiet(loadVersioned(files, `${base}.json`, StoryStateVersion, StoryState))
  const planText = yield* quiet(files.read(`${base}.plan.md`))
  const plan = planText === undefined ? undefined : yield* quiet(parsePlan(planText))
  const findings = yield* quiet(files.read(`${base}.findings.md`))
  const judgeText = yield* quiet(files.read(`${base}.judge.json`))
  const verdict =
    judgeText === undefined
      ? undefined
      : Option.getOrUndefined(Schema.decodeUnknownOption(VerdictEntry)(judgeText))?.result
  return { story, state, plan, findings, verdict }
})

/** The epic's report and board, when the run wrote them. */
export const loadEpicFiles = Effect.fn("@llm4ts/flow/Retro.loadEpicFiles")(function* (
  files: PlainFileStoreShape,
  stateDir: string
): Effect.fn.Return<{
  readonly report: EpicReport | undefined
  readonly board: Board | undefined
}> {
  const quiet = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A | undefined> =>
    effect.pipe(Effect.catch(() => Effect.succeed(undefined)))
  const report = yield* quiet(
    loadVersioned(files, join(stateDir, "report.json"), EpicReportVersion, EpicReport)
  )
  const board = yield* quiet(
    loadVersioned(files, join(stateDir, "board.json"), BoardVersion, Board)
  )
  return { report, board }
})

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(FlowEvent))

interface TraceView {
  readonly outcome: string | undefined
  readonly events: ReadonlyArray<FlowEvent>
}

const traceView = (lines: ReadonlyArray<TraceLine>): TraceView => {
  let outcome: string | undefined
  const events: Array<FlowEvent> = []
  for (const line of lines) {
    if (line.kind === "RunEnded") {
      const value = line.fields.outcome
      outcome = typeof value === "string" ? value : "completed"
      continue
    }
    const raw = line.fields.event
    if (typeof raw === "string") {
      const decoded = decodeEvent(raw)
      if (decoded._tag === "Some") {
        events.push(decoded.value)
      }
    }
  }
  return { outcome, events }
}

const laneOf = (event: FlowEvent): string | undefined =>
  "lane" in event && typeof event.lane === "string" ? event.lane : undefined

const retryLine = /^⟳ (.+?) — retry (\d+)\/(\d+): (.*)$/u

const retryKind = (what: string): string =>
  what.startsWith("serving engine down")
    ? "outage"
    : what.startsWith("flaky")
      ? "flaky stream"
      : what.startsWith("transient")
        ? "transient"
        : what.startsWith("structured output")
          ? "structured repair"
          : what

const countBy = (items: ReadonlyArray<string>): string =>
  [
    ...items.reduce(
      (map, item) => map.set(item, (map.get(item) ?? 0) + 1),
      new Map<string, number>()
    )
  ]
    .sort((left, right) => right[1] - left[1])
    .map(([key, count]) => `${key} ×${count}`)
    .join(", ")

const head = (text: string, limit = transcriptHead): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/** The stories worth a retro: failed, waiting, or still active when the run ended. */
export const retroCandidates = (inputs: RetroInputs): ReadonlyArray<StoryFiles> => {
  const fromReport = new Set(
    (inputs.report?.stories ?? [])
      .filter((outcome) => outcome.status !== "done")
      .map((outcome) => outcome.id)
  )
  const fromBoard = new Set(
    (inputs.board?.items ?? [])
      .filter(
        (item) => item.status === "active" || item.status === "failed" || item.status === "waiting"
      )
      .map((item) => item.id)
  )
  const noRecord = inputs.report === undefined && inputs.board === undefined
  return inputs.stories.filter(
    (entry) =>
      entry.state?.status !== "merged" &&
      (fromReport.has(entry.story.id) ||
        fromBoard.has(entry.story.id) ||
        (noRecord && entry.state !== undefined))
  )
}

const storySection = (
  inputs: RetroInputs,
  trace: TraceView,
  entry: StoryFiles,
  share: number
): string => {
  const { story } = entry
  const cuts: Array<string> = []
  const lines: Array<string> = [`## Story ${story.id} — ${story.title}`]
  const outcome = inputs.report?.stories.find((candidate) => candidate.id === story.id)
  const item = inputs.board?.items.find((candidate) => candidate.id === story.id)
  if (outcome !== undefined) {
    lines.push(
      `- outcome: ${outcome.status}${outcome.reason === undefined ? "" : ` — ${outcome.reason}`}`
    )
  }
  if (item !== undefined && (outcome === undefined || item.detail !== outcome.reason)) {
    lines.push(`- board: ${item.status}${item.detail === undefined ? "" : ` — ${item.detail}`}`)
  }
  if (entry.state !== undefined) {
    lines.push(
      `- state: ${entry.state.status} on ${entry.state.branch}${entry.state.executor === undefined ? "" : `, coder ${entry.state.executor}`}`
    )
  }
  if (outcome?.judge !== undefined) {
    lines.push(`- judge: ${outcome.judge}`)
  }
  lines.push(
    `- owned: ${story.owned.join(", ")}; provides: ${story.provides.join(", ") || "(none)"}`
  )

  if (entry.plan === undefined) {
    lines.push("", "### Task plan", "- none yet (the story never planned its tasks)")
  } else {
    lines.push(
      "",
      "### Task plan",
      ...entry.plan.tasks.map((task) => `- [${task.completed ? "x" : " "}] ${task.title}`)
    )
  }

  if (entry.findings !== undefined) {
    const tail = entry.findings.trimEnd()
    const shown = tail.length > findingsTail ? tail.slice(tail.length - findingsTail) : tail
    if (shown.length < tail.length) {
      cuts.push(`findings ${tail.length - shown.length} chars`)
    }
    lines.push("", "### Findings (tail)", shown)
  }
  if (entry.verdict !== undefined) {
    const dims =
      entry.verdict instanceof StoryVerdict
        ? ` (${entry.verdict.dimensions.map((d) => `${d.id} ${d.score}/${d.max}`).join(", ")})`
        : ""
    lines.push(
      "",
      `### Last judge verdict${dims}`,
      ...(entry.verdict.issues.length === 0
        ? ["- cleared"]
        : entry.verdict.issues.map(
            (issue) => `- [${issue.severity}] ${issue.title}: ${issue.description}`
          ))
    )
  }

  const laneEvents = trace.events.filter((event) => laneOf(event) === story.id)
  const traceLines: Array<string> = []
  const retries: Array<string> = []
  for (const event of laneEvents) {
    switch (event._tag) {
      case "StageFailed":
        traceLines.push(`- stage failed (${event.stage}): ${event.message}`)
        break
      case "StoryJudged":
        traceLines.push(
          `- judge round ${event.round}: ${event.cleared ? "cleared" : `not cleared, ${event.issues} issue(s)`}${
            event.dimensions.length === 0
              ? ""
              : ` (${event.dimensions.map((d) => `${d.id} ${d.score}/${d.max}`).join(", ")})`
          }`
        )
        break
      case "ReviewFindings":
        traceLines.push(
          `- review round ${event.round}${event.settled ? " (settled)" : ""}: ${event.issues.length} issue(s)${
            event.issues.length === 0
              ? ""
              : ` — ${event.issues.map((issue) => issue.title).join("; ")}`
          }`
        )
        break
      case "Timed":
        if (event.kind === "gate" && event.failed === true) {
          traceLines.push(`- gate failed: ${event.label} (exit ${event.exitCode ?? "?"})`)
        }
        break
      case "Info": {
        const match = retryLine.exec(event.message)
        if (match?.[1] !== undefined) {
          retries.push(retryKind(match[1]))
        }
        break
      }
      default:
        break
    }
  }
  if (retries.length > 0) {
    traceLines.push(`- retries: ${countBy(retries)}`)
  }
  if (traceLines.length > 0) {
    lines.push("", "### Trace", ...traceLines)
  }

  if (inputs.transcripts !== undefined) {
    const entries = inputs.transcripts.get(story.id) ?? []
    if (entries.length === 0) {
      lines.push("", "### Transcript", "- no entries for this story")
    } else {
      const calls = entries.filter((e) => e._tag === "Call")
      const tools = entries.flatMap((e) => (e._tag === "Tool" ? [e.tool] : []))
      const failures = entries.filter((e) => e._tag === "ToolResult" && e.failed === true)
      const lastCall = calls.at(-1)
      const lastReply = [...entries].reverse().find((e) => e._tag === "Reply")
      const lastEnd = [...entries].reverse().find((e) => e._tag === "End")
      const transcriptLines = [
        `- calls: ${calls.length} (${countBy(calls.map((c) => (c._tag === "Call" ? c.role : "")))})`,
        `- tool calls: ${tools.length}${tools.length === 0 ? "" : ` (${countBy(tools)})`}`,
        `- failed tool results: ${failures.length}`
      ]
      const firstFailure = failures[0]
      if (firstFailure !== undefined && firstFailure._tag === "ToolResult") {
        transcriptLines.push(`- first failed tool result: ${head(firstFailure.output)}`)
      }
      if (lastCall !== undefined && lastCall._tag === "Call") {
        transcriptLines.push(`- last call: ${lastCall.role} — ${head(lastCall.input)}`)
      }
      if (lastReply !== undefined && lastReply._tag === "Reply") {
        transcriptLines.push(`- last reply: ${head(lastReply.text)}`)
      }
      if (lastEnd !== undefined && lastEnd._tag === "End") {
        transcriptLines.push(
          `- last call ended ${lastEnd.failed === true ? "failed" : "ok"} after ${Math.round(lastEnd.ms / 1000)}s`
        )
      }
      lines.push("", "### Transcript", ...transcriptLines)
    }
  }

  const text = lines.join("\n")
  const capped = cap(text, share)
  if (capped.truncated) {
    cuts.push(`section ${text.length - capped.text.length} chars`)
  }
  return cuts.length === 0 ? capped.text : `${capped.text}\n\n(cut: ${cuts.join(", ")})`
}

const runLinePrefixes = [
  "gates:",
  "node:",
  "app dir:",
  "epic ",
  "roster",
  "seats",
  "coder:",
  "reasoning:",
  "judge",
  "executor",
  "story plan:",
  "refine round",
  "retro:"
]

/** The digest a retro seat is given: code-built, deterministic, capped. */
export const renderRetroDigest = (inputs: RetroInputs): string => {
  const trace = traceView(inputs.trace)
  const candidates = retroCandidates(inputs)
  const budget = Math.max(4_000, inputs.budget ?? defaultRetroChars)
  const runLines: Array<string> = []
  const retries: Array<string> = []
  for (const event of trace.events) {
    if (laneOf(event) !== undefined) {
      continue
    }
    switch (event._tag) {
      case "Info": {
        const match = retryLine.exec(event.message)
        if (match?.[1] !== undefined) {
          retries.push(retryKind(match[1]))
        } else if (runLinePrefixes.some((prefix) => event.message.startsWith(prefix))) {
          runLines.push(`- ${event.message}`)
        }
        break
      }
      case "Aborted":
        runLines.push(`- aborted: ${event.message}`)
        break
      case "CapabilityDenied":
        runLines.push(`- capability denied: ${event.capability} (${event.operation})`)
        break
      case "CapabilityUnenforceable":
        runLines.push(`- capability unenforceable: ${event.detail}`)
        break
      case "ExecutorExcluded":
        runLines.push(`- executor excluded: ${event.executor} — ${event.reason}`)
        break
      case "StageFailed":
        runLines.push(`- stage failed (${event.stage}): ${event.message}`)
        break
      default:
        break
    }
  }
  const header = [
    `# Retro digest — run ${inputs.runId}, epic ${inputs.plan.epicId}`,
    "",
    `- run outcome: ${trace.outcome ?? "unknown (the trace has no end line: the process died)"}`,
    `- stories: ${inputs.plan.stories.length} planned, ${candidates.length} to look at (${candidates.map((c) => c.story.id).join(", ") || "none"})`,
    `- transcripts: ${inputs.transcripts === undefined ? "none (the run was started without --transcript)" : "present"}`,
    ...(retries.length === 0 ? [] : [`- retries across the run: ${countBy(retries)}`]),
    ...(runLines.length === 0
      ? []
      : [
          "",
          "## Run",
          ...runLines.slice(0, runLineCap),
          ...(runLines.length > runLineCap
            ? [`- … ${runLines.length - runLineCap} more lines`]
            : [])
        ])
  ].join("\n")
  const remaining = budget - header.length
  const share = Math.min(
    perStoryShare,
    Math.max(1_500, Math.floor(remaining / Math.max(1, candidates.length)))
  )
  const sections = candidates.map((entry) => storySection(inputs, trace, entry, share))
  return [header, ...sections].join("\n\n")
}

// ---- Proposal ------------------------------------------------------------------------------

export const RetroFixKind = Schema.Literals(["tasks", "story", "refine", "none"])
export type RetroFixKind = typeof RetroFixKind.Type

export const RetroTask = Schema.Struct({
  title: Schema.String,
  description: Schema.String
})
export type RetroTask = typeof RetroTask.Type

export const RetroStoryChanges = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  owned: Schema.optionalKey(Schema.Array(Schema.String)),
  sharedReadOnly: Schema.optionalKey(Schema.Array(Schema.String)),
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String)),
  provides: Schema.optionalKey(Schema.Array(Schema.String))
})
export type RetroStoryChanges = typeof RetroStoryChanges.Type

/** One story's diagnosis and exactly one fix, discriminated by `kind`. */
export const RetroStory = Schema.Struct({
  id: Schema.String,
  diagnosis: Schema.String,
  kind: RetroFixKind,
  /** `tasks`: appended to the story's plan. */
  tasks: Schema.optionalKey(Schema.Array(RetroTask)),
  /** `story`: the fields to change on the plan entry. */
  changes: Schema.optionalKey(RetroStoryChanges),
  /** `story`: why the entry itself is wrong. `none`: why nothing changes. */
  why: Schema.optionalKey(Schema.String),
  /** `refine`: the feedback a new round should take. */
  feedback: Schema.optionalKey(Schema.String)
})
export type RetroStory = typeof RetroStory.Type

export class RetroProposal extends Schema.Class<RetroProposal>("RetroProposal")({
  summary: Schema.String,
  stories: Schema.Array(RetroStory),
  runAdvice: Schema.Array(Schema.Struct({ finding: Schema.String, evidence: Schema.String })),
  libraryAdvice: Schema.Array(
    Schema.Struct({ title: Schema.String, evidence: Schema.String, suggestion: Schema.String })
  )
}) {}

export const retroProposalJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    stories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          diagnosis: { type: "string" },
          kind: { type: "string", enum: ["tasks", "story", "refine", "none"] },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: { title: { type: "string" }, description: { type: "string" } },
              required: ["title", "description"]
            }
          },
          changes: {
            type: "object",
            properties: {
              description: { type: "string" },
              owned: { type: "array", items: { type: "string" } },
              sharedReadOnly: { type: "array", items: { type: "string" } },
              dependsOn: { type: "array", items: { type: "string" } },
              provides: { type: "array", items: { type: "string" } }
            }
          },
          why: { type: "string" },
          feedback: { type: "string" }
        },
        required: ["id", "diagnosis", "kind"]
      }
    },
    runAdvice: {
      type: "array",
      items: {
        type: "object",
        properties: { finding: { type: "string" }, evidence: { type: "string" } },
        required: ["finding", "evidence"]
      }
    },
    libraryAdvice: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          evidence: { type: "string" },
          suggestion: { type: "string" }
        },
        required: ["title", "evidence", "suggestion"]
      }
    }
  },
  required: ["summary", "stories", "runAdvice", "libraryAdvice"]
}

/** The seat's instructions: the digest is the whole subject. */
export const retroPrompt = (digest: string, storiesWithPlan: ReadonlyArray<string>): string =>
  [
    "You are the retrospective of a failed parallel implementation run. Below is a digest of",
    "what the run left behind: per story, its outcome, task plan, reviewer findings, judge",
    "verdict, trace events and transcript summary. The digest is the whole subject: do not",
    "explore the repository, read other files, or run anything; answer from the digest.",
    "",
    "For every story in the digest, write a diagnosis that cites digest lines, then choose",
    "exactly one fix by `kind`:",
    "- `tasks`: new tasks to append to the story's own plan, each with a title and a description",
    "  that carries what the coder needs to know from the diagnosis. Only for stories that already",
    `  have a task plan: ${storiesWithPlan.length === 0 ? "none here" : storiesWithPlan.join(", ")}.`,
    "- `story`: the story's entry in the epic plan is wrong (description, owned paths, shared",
    "  read-only paths, dependencies, provides). Give only the fields that change, and `why`.",
    "  This restarts the story from a fresh worktree, discarding its work: choose it only when",
    "  the entry itself caused the failure.",
    "- `refine`: the story needs a new planning round (a missing story, a split, a scope change",
    "  no edit covers). Give the `feedback` text a planner should take.",
    "- `none`: nothing to change (an outage, a dependency that will unblock it). Give `why`.",
    "",
    "`runAdvice`: findings about the environment or configuration (a seat on an old CLI, Node",
    "mismatch, gates missing, transcripts off), each with its evidence line.",
    "`libraryAdvice`: only where the digest shows llm4ts itself — the flow, a seat's harness",
    "mapping, a prompt — misbehaving rather than the epic: title, evidence, suggestion.",
    "Be concrete and short. Return ONLY JSON matching the schema.",
    "",
    digest
  ].join("\n")

// ---- Validation ----------------------------------------------------------------------------

export interface ValidatedRetro {
  readonly proposal: RetroProposal
  /** What was dropped and why, for the report. */
  readonly dropped: ReadonlyArray<string>
}

const badPath = (path: string): boolean =>
  path.trim().length === 0 ||
  path.startsWith("/") ||
  /^[A-Za-z]:[\\/]/.test(path) ||
  path.split(/[\\/]/).includes("..")

const sameList = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index])

/** Applies the story changes a proposal names; `undefined` when nothing would change. */
export const storyWithChanges = (story: Story, changes: RetroStoryChanges): Story | undefined => {
  const next = Story.make({
    ...story,
    ...(changes.description === undefined ? {} : { description: changes.description }),
    ...(changes.owned === undefined ? {} : { owned: changes.owned }),
    ...(changes.sharedReadOnly === undefined ? {} : { sharedReadOnly: changes.sharedReadOnly }),
    ...(changes.dependsOn === undefined ? {} : { dependsOn: changes.dependsOn }),
    ...(changes.provides === undefined ? {} : { provides: changes.provides })
  })
  const unchanged =
    next.description === story.description &&
    sameList(next.owned, story.owned) &&
    sameList(next.sharedReadOnly, story.sharedReadOnly) &&
    sameList(next.dependsOn, story.dependsOn) &&
    sameList(next.provides, story.provides)
  return unchanged ? undefined : next
}

/** Code checks the seat's answer before anything is written; bad items are dropped, not fatal. */
export const validateRetroProposal = (
  proposal: RetroProposal,
  plan: StoryPlan,
  storiesWithPlan: ReadonlySet<string>
): ValidatedRetro => {
  const dropped: Array<string> = []
  const seen = new Set<string>()
  const stories: Array<RetroStory> = []
  for (const entry of proposal.stories) {
    const story = plan.story(entry.id)
    if (story === undefined) {
      dropped.push(`${entry.id}: not a story of this plan`)
      continue
    }
    if (seen.has(entry.id)) {
      dropped.push(`${entry.id}: named twice; the first entry stands`)
      continue
    }
    seen.add(entry.id)
    switch (entry.kind) {
      case "tasks": {
        const tasks = (entry.tasks ?? []).filter(
          (task) => task.title.trim().length > 0 && task.description.trim().length > 0
        )
        if (tasks.length === 0) {
          dropped.push(`${entry.id}: a tasks fix with no task`)
          continue
        }
        if (!storiesWithPlan.has(entry.id)) {
          dropped.push(`${entry.id}: tasks need a task plan, and the story never planned one`)
          continue
        }
        stories.push({ ...entry, tasks })
        break
      }
      case "story": {
        const changes = entry.changes
        if (changes === undefined) {
          dropped.push(`${entry.id}: a story fix with no changes`)
          continue
        }
        const paths = [...(changes.owned ?? []), ...(changes.sharedReadOnly ?? [])]
        const outside = paths.filter(badPath)
        if (outside.length > 0) {
          dropped.push(`${entry.id}: paths outside the repository (${outside.join(", ")})`)
          continue
        }
        const unknown = (changes.dependsOn ?? []).filter(
          (id) => id === entry.id || plan.story(id) === undefined
        )
        if (unknown.length > 0) {
          dropped.push(`${entry.id}: dependencies that are not stories (${unknown.join(", ")})`)
          continue
        }
        if (storyWithChanges(story, changes) === undefined) {
          dropped.push(`${entry.id}: a story fix that changes nothing`)
          continue
        }
        stories.push(entry)
        break
      }
      case "refine":
        if ((entry.feedback ?? "").trim().length === 0) {
          dropped.push(`${entry.id}: a refine fix with no feedback`)
          continue
        }
        stories.push(entry)
        break
      case "none":
        stories.push(entry)
        break
    }
  }
  return { proposal: RetroProposal.make({ ...proposal, stories }), dropped }
}

// ---- Report ---------------------------------------------------------------------------------

export const AppliedMarkerPrefix = "- [x] Applied"

export interface RetroApproval {
  readonly approved: boolean
  readonly applied: boolean
}

export const retroApprovalOf = (markdown: string): RetroApproval => ({
  approved: markdown.includes(ApprovedMarker),
  applied: markdown.split("\n").some((line) => line.trim().startsWith(AppliedMarkerPrefix))
})

const fixLines = (entry: RetroStory, story: Story | undefined): ReadonlyArray<string> => {
  switch (entry.kind) {
    case "tasks":
      return [
        `**Proposed fix: ${entry.tasks?.length ?? 0} task(s) appended to the story's plan.**`,
        ...(entry.tasks ?? []).map((task) => `- ${task.title}: ${task.description}`)
      ]
    case "story": {
      const changes = entry.changes ?? {}
      const field = (
        name: keyof RetroStoryChanges,
        before: ReadonlyArray<string> | string | undefined
      ) => {
        const after = changes[name]
        if (after === undefined) {
          return []
        }
        const render = (value: ReadonlyArray<string> | string | undefined): string =>
          value === undefined
            ? "(none)"
            : typeof value === "string"
              ? value
              : value.join(", ") || "(none)"
        return [`- ${name}: ${render(before)} → ${render(after)}`]
      }
      return [
        `**Proposed fix: edit the story's entry (restarts it from a fresh worktree).** ${entry.why ?? ""}`.trimEnd(),
        ...field("description", story?.description),
        ...field("owned", story?.owned),
        ...field("sharedReadOnly", story?.sharedReadOnly),
        ...field("dependsOn", story?.dependsOn),
        ...field("provides", story?.provides)
      ]
    }
    case "refine":
      return [
        "**Proposed fix: a refine round, not applied here.** Feedback to give it:",
        `> ${(entry.feedback ?? "").trim().replace(/\n/g, "\n> ")}`
      ]
    case "none":
      return [`**No change proposed.** ${entry.why ?? ""}`.trimEnd()]
  }
}

export interface RetroReportInputs {
  readonly runId: string
  readonly plan: StoryPlan
  readonly validated: ValidatedRetro
  readonly workDir: string
  readonly epicDir: string
}

/** The report a person reads and ticks. */
export const renderRetroReport = (inputs: RetroReportInputs): string => {
  const { proposal, dropped } = inputs.validated
  const lines: Array<string> = [
    `# Retro — run ${inputs.runId}, epic ${inputs.plan.epicId}`,
    "",
    proposal.summary.trim(),
    ""
  ]
  if (proposal.stories.length > 0) {
    lines.push("## Stories", "")
    for (const entry of proposal.stories) {
      const story = inputs.plan.story(entry.id)
      lines.push(
        `### ${entry.id}${story === undefined ? "" : ` — ${story.title}`}`,
        "",
        `**Diagnosis.** ${entry.diagnosis.trim()}`,
        "",
        ...fixLines(entry, story),
        ""
      )
    }
  }
  if (proposal.runAdvice.length > 0) {
    lines.push(
      "## Run advice",
      "",
      ...proposal.runAdvice.map((item) => `- ${item.finding} — ${item.evidence}`),
      ""
    )
  }
  if (dropped.length > 0) {
    lines.push("## Dropped by validation", "", ...dropped.map((item) => `- ${item}`), "")
  }
  const applies = proposal.stories.filter(
    (entry) => entry.kind === "tasks" || entry.kind === "story"
  )
  const refines = proposal.stories.filter((entry) => entry.kind === "refine")
  lines.push("## Approval", "")
  if (applies.length === 0) {
    lines.push("Nothing here is applied by the next run; the report is for reading.", "")
  } else {
    lines.push(
      "Ticking the box lets the next `epic-stories` run of this epic apply:",
      "",
      ...applies.map((entry) =>
        entry.kind === "tasks"
          ? `- ${entry.id}: append ${entry.tasks?.length ?? 0} task(s) to its plan`
          : `- ${entry.id}: edit its entry and restart it from a fresh worktree`
      ),
      ""
    )
  }
  if (refines.length > 0) {
    lines.push(
      "A refine round is started by hand, with the feedback above:",
      "",
      ...refines.map(
        () =>
          `    llm4ts run epic-stories --repo ${inputs.workDir} -- --refine --epic ${inputs.epicDir} "<feedback>"`
      ),
      ""
    )
  }
  lines.push(DraftApprovalMarker, "")
  return lines.join("\n")
}

/** The note for llm4ts itself; `undefined` when the seat had nothing to say. */
export const renderLibraryAdvice = (
  runId: string,
  epicId: string,
  proposal: RetroProposal
): string | undefined =>
  proposal.libraryAdvice.length === 0
    ? undefined
    : [
        `# Advice for llm4ts — from run ${runId} of epic ${epicId}`,
        "",
        "What the retro saw the library, not the epic, do. Read before changing anything.",
        "",
        ...proposal.libraryAdvice.flatMap((item) => [
          `## ${item.title}`,
          "",
          `Evidence: ${item.evidence}`,
          "",
          `Suggestion: ${item.suggestion}`,
          ""
        ])
      ].join("\n")

const encodeProposal = Schema.encodeEffect(Schema.fromJsonString(RetroProposal))
const decodeProposal = Schema.decodeUnknownOption(Schema.fromJsonString(RetroProposal))

/** Writes the four files of a retro and indexes it. */
export const writeRetro = Effect.fn("@llm4ts/flow/Retro.write")(function* (
  files: PlainFileStoreShape,
  stateDir: string,
  inputs: RetroReportInputs & { readonly digest: string; readonly at: number }
): Effect.fn.Return<RetroPaths, FlowError> {
  const paths = retroPaths(stateDir, inputs.runId)
  yield* files.writeAtomic(paths.digest, inputs.digest)
  const encoded = yield* encodeProposal(inputs.validated.proposal).pipe(
    Effect.mapError((error) =>
      PersistenceError.make({
        message: `failed to encode the retro proposal: ${String(error)}`,
        cause: error
      })
    )
  )
  yield* files.writeAtomic(paths.proposal, `${encoded}\n`)
  yield* files.writeAtomic(paths.report, renderRetroReport(inputs))
  const library = renderLibraryAdvice(inputs.runId, inputs.plan.epicId, inputs.validated.proposal)
  if (library !== undefined) {
    yield* files.writeAtomic(paths.library, library)
  }
  yield* appendRetroIndex(files, stateDir, inputs.runId, inputs.at)
  return paths
})

// ---- Applying ---------------------------------------------------------------------------------

export interface AppliedRetros {
  /** The plan after story edits, to run with. */
  readonly plan: StoryPlan
  /** One line per thing done or skipped, already published. */
  readonly notes: ReadonlyArray<string>
}

const retroTaskTitle = (runId: string, title: string): string => `Retro ${runId}: ${title}`

/**
 * Applies every approved, not yet applied retro of this state folder, oldest
 * first: tasks go onto story plans, story edits onto the epic plan (saved,
 * so the executor's hash check restarts them). Says what it did on the
 * events. Nothing here fails the run: a retro that no longer fits is skipped.
 */
export const applyApprovedRetros = Effect.fn("@llm4ts/flow/Retro.apply")(function* (
  files: PlainFileStoreShape,
  stateDir: string,
  plan: StoryPlan,
  events: FlowEventsShape,
  now: number
): Effect.fn.Return<AppliedRetros, FlowError> {
  const notes: Array<string> = []
  const say = (message: string): Effect.Effect<void> =>
    Effect.sync(() => {
      notes.push(message)
    }).pipe(Effect.andThen(events.publish(Info.make({ message: `retro: ${message}` }))))
  let current = plan
  const planStore = makePlanStore(files)
  for (const { runId } of yield* readRetroIndex(files, stateDir)) {
    const paths = retroPaths(stateDir, runId)
    const report = yield* files
      .read(paths.report)
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (report === undefined) {
      continue
    }
    const approval = retroApprovalOf(report)
    if (!approval.approved || approval.applied) {
      continue
    }
    const proposalText = yield* files
      .read(paths.proposal)
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    const proposal =
      proposalText === undefined ? undefined : Option.getOrUndefined(decodeProposal(proposalText))
    if (proposal === undefined) {
      yield* say(`${runId}: approved, but ${paths.proposal} is missing or unreadable; skipped`)
      continue
    }
    let edited = current
    const editedIds: Array<string> = []
    for (const entry of proposal.stories) {
      const story = edited.story(entry.id)
      if (story === undefined) {
        yield* say(`${runId}: ${entry.id} is no longer in the plan; skipped`)
        continue
      }
      switch (entry.kind) {
        case "tasks": {
          const path = join(stateDir, "stories", `${entry.id}.plan.md`)
          const existing = yield* planStore
            .load(path)
            .pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (existing === undefined) {
            yield* say(`${runId}: ${entry.id} has no task plan to append to; skipped`)
            continue
          }
          const tasks = entry.tasks ?? []
          const titles = new Set(existing.tasks.map((task) => task.title))
          const fresh = tasks.filter((task) => !titles.has(retroTaskTitle(runId, task.title)))
          if (fresh.length === 0) {
            continue
          }
          yield* planStore.save(
            path,
            Plan.make({
              ...existing,
              tasks: [
                ...existing.tasks,
                ...fresh.map((task) =>
                  Task.make({
                    title: retroTaskTitle(runId, task.title),
                    description: task.description
                  })
                )
              ]
            })
          )
          yield* say(`${runId}: ${entry.id} gets ${fresh.length} task(s) from the retro`)
          break
        }
        case "story": {
          const next =
            entry.changes === undefined ? undefined : storyWithChanges(story, entry.changes)
          if (next === undefined) {
            continue
          }
          edited = StoryPlan.make({
            ...edited,
            stories: edited.stories.map((candidate) =>
              candidate.id === entry.id ? next : candidate
            )
          })
          editedIds.push(entry.id)
          break
        }
        case "refine":
          yield* say(
            `${runId}: ${entry.id} needs a refine round (not applied): ${(entry.feedback ?? "").trim()}`
          )
          break
        case "none":
          break
      }
    }
    if (editedIds.length > 0) {
      const valid: { readonly plan: StoryPlan; readonly problem: string | undefined } =
        yield* validateStoryPlan(edited).pipe(
          Effect.map((plan) => ({ plan, problem: undefined })),
          Effect.catch((error: StoryPlanInvalid) =>
            Effect.succeed({ plan: current, problem: error.violations.join("; ") })
          )
        )
      if (valid.problem === undefined) {
        yield* makeStoryPlanStore(files).save(join(stateDir, "plan.md"), valid.plan)
        current = valid.plan
        for (const id of editedIds) {
          yield* say(`${runId}: story ${id} edited, restarting from a fresh worktree`)
        }
      } else {
        yield* say(`${runId}: story edits would leave the plan invalid (${valid.problem}); skipped`)
      }
    }
    yield* files.writeAtomic(
      paths.report,
      `${report.trimEnd()}\n${AppliedMarkerPrefix} ${new Date(now).toISOString()}\n`
    )
  }
  return { plan: current, notes }
})
