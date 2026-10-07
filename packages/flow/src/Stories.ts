// The parallel story executor (ADR 0013). One story = one worktree on its
// own branch, created only once every predecessor has merged into the epic
// branch; the inner loop is the unchanged `implementPlanFlow`; a story
// merges back only after its judge and perimeter checks pass, and the
// target's gates run on the epic branch after every merge. Scheduling,
// gating, resume and failure policy live here; seats come from `contextFor`.
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { cap } from "./Context.ts"
import type { LlmChunk, TokenUsage } from "@llm4ts/core/Models"
import type { LlmError } from "@llm4ts/core/Errors"
import { BoardItem, type BoardSyncShape } from "./BoardSync.ts"
import { makeChat } from "./Chat.ts"
import { implementPlanFlow } from "./Flow.ts"
import {
  GateBaseline,
  baselineKey,
  ensureBaseline as ensureStoredBaseline,
  failingLinesOf,
  storyGateLogDir,
  triageGates,
  writeBaseline,
  type GateLogDir
} from "./Gates.ts"
import type { ContextOptions, FlowContextShape } from "./FlowContext.ts"
import {
  describeFlowError,
  rosterExhaustedPrefix,
  EpicCheckoutDirty,
  MissingDependency,
  PerimeterViolation,
  StoryFailed,
  type FlowError
} from "./FlowError.ts"
import {
  Began,
  EvidenceChecked,
  Info,
  JudgedDimension,
  StoryJudged,
  Timed,
  withLane,
  type FlowEventsShape
} from "./FlowEvents.ts"
import { timeEffect, withTimedRole } from "./Timing.ts"
import { statusPaths, type GitToolShape } from "./GitTool.ts"
import {
  checkPerimeter,
  enforcePerimeter,
  isWithinPerimeter,
  perimeterGate,
  strayTasks,
  type PerimeterCheck
} from "./Perimeter.ts"
import {
  loadVersioned,
  makePlanStore,
  saveVersioned,
  type PlainFileStoreShape
} from "./Persistence.ts"
import { Plan, Task } from "./Plan.ts"
import { stage } from "./PlanExecution.ts"
import { planFrom } from "./Planner.ts"
import {
  ReviewIssue,
  ReviewResult,
  applyTriage,
  isBlocking,
  loadRepoReviewRules,
  nonBlockingIssues,
  type FixPromptOptions,
  type GateTriageOptions
} from "./Review.ts"
import {
  type OracleRules,
  checkOracle,
  defaultOracleRules,
  parseUnifiedDiff
} from "./OracleGuard.ts"
import { cachedValue, fingerprintOf } from "./ReviewCache.ts"
import { withContract, type ContractProfile } from "./AutonomyContract.ts"
import { fabricatedStatusIssues, unverifiedClaims } from "./Evidence.ts"
import type { Trailer } from "./CarriedNotes.ts"
import type { StallOptions } from "./Stall.ts"
import type { Reviewer } from "./Reviewer.ts"
import {
  dependentsOf,
  ownerOf,
  pathsNamedIn,
  readyStories,
  relationOf,
  storyHash,
  topologicalWaves,
  validateStoryPlan,
  type Story,
  type StoryPlan,
  type StoryRelation
} from "./StoryPlan.ts"
import { isOutageMessage } from "./TransientRetry.ts"
import { attr, withKindSpan } from "./Spans.ts"

const join = (root: string, path: string): string =>
  `${root.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`

// ---- Story seats ----------------------------------------------------------

/** A flow context rooted in a story's worktree, plus that story's own usage totals. */
/** A story judge's review with the rubric's scores; a plain `ReviewResult` has none. */
export class StoryVerdict extends ReviewResult.extend<StoryVerdict>("StoryVerdict")({
  dimensions: Schema.Array(JudgedDimension)
}) {}

/** What a judge answers: a scored verdict, or a plain review result. */
const Verdict = Schema.Union([StoryVerdict, ReviewResult])

export interface StorySeats {
  readonly context: FlowContextShape
  /** Running usage of this story's seats — estimates where the backend reports none. */
  readonly totals?: Effect.Effect<TokenUsage | undefined>
}

// ---- Durable state ----------------------------------------------------------

export const StoryStateVersion = 1

export const StoryStatus = Schema.Literals(["started", "merged", "failed"])
export type StoryStatus = typeof StoryStatus.Type

/** What the executor remembers about a story between runs. */
export class StoryState extends Schema.Class<StoryState>("StoryState")({
  id: Schema.String,
  /** `storyHash` of the plan entry the branch was created from. */
  hash: Schema.String,
  branch: Schema.String,
  worktree: Schema.String,
  status: StoryStatus,
  /** The roster executor that last held the story's coder (ADR 0019); preferred on resume. */
  executor: Schema.optionalKey(Schema.String)
}) {}

export const EpicReportVersion = 1

/** `waiting`: on hold behind a failed predecessor, runs once that is fixed. */
export const OutcomeStatus = Schema.Literals(["done", "failed", "waiting"])
export type OutcomeStatus = typeof OutcomeStatus.Type

export class StoryOutcome extends Schema.Class<StoryOutcome>("StoryOutcome")({
  id: Schema.String,
  title: Schema.String,
  status: OutcomeStatus,
  branch: Schema.optionalKey(Schema.String),
  /** Failure reason, or what a waiting story waits for. */
  reason: Schema.optionalKey(Schema.String),
  judge: Schema.optionalKey(Schema.String),
  /** The roster executor(s) that coded the story, in order ("codex → claude"). */
  executor: Schema.optionalKey(Schema.String),
  /** ESTIMATES, never measurements (ADR 0012). */
  estimatedTokens: Schema.optionalKey(Schema.Int),
  estimatedCostUsd: Schema.optionalKey(Schema.Number),
  /** Gate failures already red on the story's base, not charged to it (ADR 0027). */
  inherited: Schema.optionalKey(Schema.Array(Schema.String))
}) {}

export class EpicReport extends Schema.Class<EpicReport>("EpicReport")({
  epicId: Schema.String,
  epicBranch: Schema.String,
  /** Always true: the figures come from character-count estimates. */
  estimated: Schema.Boolean,
  stories: Schema.Array(StoryOutcome)
}) {
  count(status: OutcomeStatus): number {
    return this.stories.filter((story) => story.status === status).length
  }
}

const money = (value: number): string => `~$${value.toFixed(2)}`

export const renderEpicReport = (report: EpicReport): string => {
  const lines: Array<string> = [
    `# Epic report: ${report.epicId}`,
    "",
    "> Token and cost figures are ESTIMATES from character counts (ADR 0012):",
    "> the CLI seats report no usage. They are not measurements.",
    "",
    `- Epic branch: \`${report.epicBranch}\``,
    `- Stories: ${report.stories.length} (done ${report.count("done")}, failed ${report.count("failed")}, waiting ${report.count("waiting")})`,
    "",
    "| Story | Status | Branch | Est. tokens | Est. cost | Note |",
    "| --- | --- | --- | --- | --- | --- |"
  ]
  for (const story of report.stories) {
    const note = story.reason ?? story.judge ?? ""
    lines.push(
      `| ${story.id} | ${story.status} | ${story.branch === undefined ? "—" : `\`${story.branch}\``} | ${
        story.estimatedTokens === undefined ? "—" : `~${story.estimatedTokens}`
      } | ${story.estimatedCostUsd === undefined ? "—" : money(story.estimatedCostUsd)} | ${note.replace(/\|/g, "\\|").replace(/\s+/g, " ")} |`
    )
  }
  const tokens = report.stories.flatMap((story) =>
    story.estimatedTokens === undefined ? [] : [story.estimatedTokens]
  )
  const cost = report.stories.flatMap((story) =>
    story.estimatedCostUsd === undefined ? [] : [story.estimatedCostUsd]
  )
  lines.push("")
  if (tokens.length > 0) {
    lines.push(`- Estimated tokens: ~${tokens.reduce((sum, value) => sum + value, 0)}`)
  }
  if (cost.length > 0) {
    lines.push(`- Estimated cost: ${money(cost.reduce((sum, value) => sum + value, 0))}`)
  }
  const inherited = new Map<string, Array<string>>()
  for (const story of report.stories) {
    for (const line of story.inherited ?? []) {
      inherited.set(line, [...(inherited.get(line) ?? []), story.id])
    }
  }
  if (inherited.size > 0) {
    lines.push(
      "",
      "## Inherited gate failures",
      "",
      "Red on the base before the story ran; not charged to it. A cleanup story may own them.",
      ""
    )
    for (const [line, stories] of inherited) {
      lines.push(`- ${line} (stories: ${stories.join(", ")})`)
    }
  }
  const coded = report.stories.filter((story) => story.executor !== undefined)
  if (coded.length > 0) {
    // A story is counted for the executor that finished it; a handover chain
    // is shown in full next to the story.
    const byExecutor = new Map<string, { stories: Array<string>; tokens: number; cost: number }>()
    for (const story of coded) {
      const chain = story.executor ?? ""
      const last = chain.split(" → ").at(-1) ?? chain
      const entry = byExecutor.get(last) ?? { stories: [], tokens: 0, cost: 0 }
      entry.stories.push(chain === last ? story.id : `${story.id} (${chain})`)
      entry.tokens += story.estimatedTokens ?? 0
      entry.cost += story.estimatedCostUsd ?? 0
      byExecutor.set(last, entry)
    }
    lines.push("", "## By executor", "")
    for (const [executor, entry] of byExecutor) {
      lines.push(
        `- ${executor}: ${entry.stories.join(", ")} — ~${entry.tokens} tokens, ${money(entry.cost)} (estimated)`
      )
    }
  }
  lines.push("")
  return lines.join("\n")
}

// ---- Prompts ----------------------------------------------------------------

export const blockedOnSentinel = "BLOCKED_ON:"

const blockedPattern = /^BLOCKED_ON:\s*(.+)$/

/**
 * The text after the sentinel when the coder ENDED its reply with it. A
 * sentinel followed by more work is not a stop — a coder's own skills can
 * make it announce a missing reference and then carry on, and the work it
 * carried on with is what counts. Only the reply's last non-empty line is
 * read.
 */
export const blockedOnIn = (text: string): string | undefined => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const last = lines.at(-1)
  if (last === undefined) {
    return undefined
  }
  const match = blockedPattern.exec(last.replace(/^[`*_\s]+|[`*_\s]+$/g, ""))
  const need = match?.[1]?.trim()
  return need === undefined || need.length === 0 ? undefined : need
}

const bullets = (items: ReadonlyArray<string>): string =>
  items.length === 0 ? "- (none)" : items.map((item) => `- ${item}`).join("\n")

/** Where a story runs, which is what lets its rules name the other stories and checkouts. */
export interface StoryWhereabouts {
  readonly plan: StoryPlan
  /** The story's own worktree — the coder's working directory. */
  readonly worktree: string
  /** The epic branch's checkout, which no coder may touch. */
  readonly epicCheckout: string
}

const relationNotes: Readonly<Record<Exclude<StoryRelation, "self">, string>> = {
  dependency: "merged into the epic before you started — it is in your working tree; read it",
  dependent:
    "built AFTER you, on top of your work — leave it alone (wiring your work in is that story's job)",
  parallel: "built at the same time by another coder — leave it alone"
}

const whereaboutsRules = (story: Story, where: StoryWhereabouts): ReadonlyArray<string> => {
  const others = where.plan.stories
    .filter((other) => other.id !== story.id)
    .map((other) => {
      const relation = relationOf(where.plan, story, other)
      const note = relation === "self" ? "" : relationNotes[relation]
      return `${other.owned.join(", ")} — story ${other.id}: ${note}`
    })
  return [
    "",
    `Your working directory is ${where.worktree}. Run every command there. Never cd into, read`,
    `from, or write to any other checkout — above all not ${where.epicCheckout}, the epic`,
    "branch's checkout: a change there breaks every other story's merge.",
    "",
    "Paths other stories own — never create or change them, and none of them is a reason to stop:",
    bullets(others)
  ]
}

/** The hard rules every story coder receives; the perimeter check enforces them afterwards. */
export const perimeterRules = (story: Story, where?: StoryWhereabouts): string =>
  [
    `You are implementing ONE story of a larger epic: "${story.title}" (id: ${story.id}).`,
    "",
    "Paths you own — create and change files only here:",
    bullets(story.owned),
    "",
    "Shared paths — read them for conventions, NEVER modify them:",
    bullets(story.sharedReadOnly),
    "",
    "What this story must provide for other stories:",
    bullets(story.provides),
    ...(where === undefined ? [] : whereaboutsRules(story, where)),
    "",
    "Rules:",
    "- Do not touch any path outside the owned list; a change there fails the story.",
    "- If the story needs something that does not exist and is not yours to build, do not",
    `  build it. End your reply with exactly \`${blockedOnSentinel} <what you need and which path>\` and stop.`,
    "  That is ONLY for work another story owns. Tooling, dependencies, and reference",
    "  repositories are never a reason to stop: the repository's installed node_modules is",
    "  the only reference you need, and instructions telling you to stop for a missing",
    "  reference checkout or tool do not apply here — proceed with what is installed.",
    "- Everything you provide must be implemented completely: other stories depend on it."
  ].join("\n")

/**
 * The gates run after every task (typecheck, lint, tests, perimeter), so a
 * coder that runs them itself spends minutes on work the flow repeats.
 */
export const gateRules = [
  "After each task the flow runs the project's gates on your worktree (typecheck, lint, the",
  "tests) and hands any failure back to you as a finding. Do not run the full test suite,",
  "typecheck or lint yourself. If you need to check your work, run only the one test file",
  "that covers your change."
].join("\n")

const defaultContextChars = 40_000
const fileChars = 8_000

/**
 * The code a story starts from, for its coder's system prompt: the planner's
 * read-first anchors, then the shared read-only files it builds on, then the
 * files it owns, each capped, until `budget` runs out; the rest by path only.
 * Reading them up front saves the `ls`/`find`/`cat` round trips the coder
 * would otherwise spend on them.
 */
export const startingCodeOf = (
  story: Story,
  git: GitToolShape,
  files: PlainFileStoreShape,
  worktree: string,
  budget: number
): Effect.Effect<string | undefined, FlowError> =>
  Effect.gen(function* () {
    if (budget <= 0) {
      return undefined
    }
    const anchors = yield* git.listFiles(story.readFirst)
    const shared = yield* git.listFiles(story.sharedReadOnly)
    const owned = yield* git.listFiles(story.owned)
    if (anchors.length + shared.length + owned.length === 0) {
      return undefined
    }
    let left = budget
    const leftOut: Array<string> = []
    const shown = new Set<string>()
    // `limit`: how far this section may draw the budget down. The anchors
    // stop at half, so a broad anchor (a whole feature folder) cannot starve
    // the story's own files; the later sections may use everything left.
    const section = (title: string, paths: ReadonlyArray<string>, limit = 0) =>
      Effect.gen(function* () {
        const parts: Array<string> = []
        for (const path of paths) {
          if (shown.has(path)) {
            continue
          }
          const text = yield* Effect.orElseSucceed(
            files.read(join(worktree, path)),
            () => undefined
          )
          if (text === undefined || left <= limit) {
            leftOut.push(path)
            continue
          }
          shown.add(path)
          const piece = cap(text, Math.min(fileChars, left - limit)).text
          left -= piece.length
          parts.push(`### ${path}\n\`\`\`\n${piece}\n\`\`\``)
        }
        return parts.length === 0 ? [] : [title, ...parts]
      })
    return [
      "## The code you start from",
      "Read this before exploring: it is the current content of the files below.",
      ...(yield* section(
        "Read first — what the planner says to imitate or build on:",
        anchors,
        Math.floor(budget / 2)
      )),
      ...(yield* section("Shared, read-only — use these as they are:", shared)),
      ...(yield* section("Yours — the story's owned files so far:", owned)),
      ...(leftOut.length === 0 ? [] : [`Not shown (over the budget): ${leftOut.join(", ")}`])
    ].join("\n\n")
  })

const numbered = (items: ReadonlyArray<string>): ReadonlyArray<string> =>
  items.map((item, index) => `${index + 1}. ${item}`)

export const storyPrompt = (story: Story): string =>
  [
    `Story: ${story.title}`,
    "",
    story.description.trim(),
    ...(story.acceptance.length === 0
      ? []
      : ["", "Done when (each must hold, observably):", ...numbered(story.acceptance)])
  ].join("\n")

export const storyTaskPlanInstructions = (story: Story): string =>
  [
    "You are planning the implementation of ONE story inside a larger epic. Break the story",
    "into an ordered list of small, independently verifiable tasks, each described by its",
    "observable outcome. Every task must stay inside the story's owned paths:",
    bullets(story.owned),
    ...(story.acceptance.length === 0
      ? []
      : [
          "The story is done when every one of these holds:",
          ...numbered(story.acceptance),
          "End every task's description with `Satisfies: <n>` naming the criteria it serves, and",
          "make sure every criterion is served by at least one task."
        ]),
    "Never plan a task that creates or changes anything outside them — registering or wiring",
    "the story in elsewhere (the app's composition point, a shared kit file) is another story's job.",
    `Use exactly this epicId: "${story.id}".`,
    'Respond only with JSON: {"epicId":"' + story.id + '","tasks":',
    '[{"title":"...","description":"...","completed":false}]}'
  ].join("\n")

/** The coder plans its own tasks from the story — the orchestrator split the epic, not the story. */
export const defaultPlanTasks = (
  seats: StorySeats,
  story: Story,
  prompt: string
): Effect.Effect<Plan, FlowError> =>
  planFrom(seats.context.coder, prompt, storyTaskPlanInstructions(story))

/**
 * Asks the planner again, once, when its tasks name paths outside the story;
 * tasks that still name ANOTHER story's paths are then dropped (that work is
 * planned elsewhere) and any remaining stray is left to the perimeter gate.
 */
export const planWithinPerimeter = (
  plan: StoryPlan,
  story: Story,
  planTasks: (prompt: string) => Effect.Effect<Plan, FlowError>,
  prompt: string,
  events: FlowContextShape["events"]
): Effect.Effect<Plan, FlowError> =>
  Effect.gen(function* () {
    const first = yield* planTasks(prompt)
    const strays = strayTasks(plan, story, first.tasks)
    if (strays.length === 0) {
      return first
    }
    const describe = strays.map((stray) => `- "${stray.task.title}": ${stray.paths.join(", ")}`)
    yield* events.publish(
      Info.make({
        message: `story ${story.id}: ${strays.length} planned task(s) name paths outside the story; re-planning:\n${describe.join("\n")}`
      })
    )
    const second = yield* planTasks(
      [
        prompt,
        "",
        "Your previous task list named paths outside this story's owned paths:",
        ...describe,
        "Plan again: only work inside the owned paths. Work on any other path is not this story's."
      ].join("\n")
    )
    const remaining = strayTasks(plan, story, second.tasks)
    const foreign = new Set(remaining.filter((stray) => stray.foreign).map((stray) => stray.task))
    const kept = second.tasks.filter((task) => !foreign.has(task))
    if (remaining.length > 0) {
      yield* events.publish(
        Info.make({
          message:
            `story ${story.id}: the re-plan still names paths outside the story` +
            (foreign.size > 0
              ? `; dropped ${foreign.size} task(s) that belong to other stories`
              : "")
        })
      )
    }
    return kept.length === 0 ? second : Plan.make({ ...second, tasks: kept })
  })

/**
 * Why a BLOCKED_ON claim is wrong, when the plan alone can tell: the named
 * path is the story's own, a dependency's (already merged into the worktree),
 * or a dependent's (built later on top of this story). Undefined when the
 * plan cannot settle it — a path no story owns, or a parallel story's.
 */
export const blockedRebuttal = (
  plan: StoryPlan,
  story: Story,
  need: string
): string | undefined => {
  for (const path of pathsNamedIn(plan, need)) {
    const owner = ownerOf(plan, path)
    if (owner === undefined) {
      continue
    }
    switch (relationOf(plan, story, owner)) {
      case "self":
        return `${path} is under your own owned paths: building it is your job, not another story's.`
      case "dependent":
        return (
          `${path} belongs to story '${owner.id}', which runs AFTER you and builds on your work. ` +
          "Leave it alone: it is neither missing nor a blocker for this story."
        )
      case "dependency":
        return (
          `${path} belongs to story '${owner.id}', merged into the epic branch before you started, ` +
          `so it is already in your working tree: read it there. That story provides: ${owner.provides.join("; ")}.`
        )
      case "parallel":
        continue
    }
  }
  return undefined
}

/** A second opinion on a BLOCKED_ON claim the plan cannot settle. */
export class BlockedVerdict extends Schema.Class<BlockedVerdict>("BlockedVerdict")({
  /** True: the work is genuinely missing and owned by no dependency. */
  real: Schema.Boolean,
  /** Why — shown to the coder when the claim is rejected. */
  reason: Schema.String
}) {}

// ---- BLOCKED_ON detection ---------------------------------------------------

const watchStream = (
  stream: Stream.Stream<LlmChunk, LlmError>,
  blocked: Ref.Ref<string | undefined>
): Stream.Stream<LlmChunk, LlmError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const text = yield* Ref.make("")
      const tapped = stream.pipe(
        Stream.tap((chunk) => Ref.update(text, (current) => current + chunk.delta))
      )
      const check = Stream.fromEffect(
        Effect.gen(function* () {
          const need = blockedOnIn(yield* Ref.get(text))
          if (need !== undefined) {
            yield* Ref.set(blocked, need)
          }
        })
      ).pipe(Stream.drain)
      return Stream.concat(tapped, check)
    })
  )

/**
 * A coder whose turns are watched for the `BLOCKED_ON:` sentinel. The story
 * loop reads the ref after the coder stops, so a blocked turn ends the story
 * as a typed `MissingDependency` instead of an empty-diff abort.
 */
export const watchForBlockedOn = (
  service: LlmServiceShape,
  blocked: Ref.Ref<string | undefined>
): LlmServiceShape => ({
  ...service,
  executeStream: (prompt) => watchStream(service.executeStream(prompt), blocked),
  executeStreamWithHistory: (messages) =>
    watchStream(service.executeStreamWithHistory(messages), blocked)
})

// ---- Options ----------------------------------------------------------------

export interface StoriesOptions {
  readonly plan: StoryPlan
  readonly files: PlainFileStoreShape
  /** The executor's own durable state: story states, task plans, the report. */
  readonly stateDir: string
  /** Where story worktrees are created (`<worktreeRoot>/<story-id>`). */
  readonly worktreeRoot: string
  /** Default `epic/<epicId>`. */
  readonly epicBranch?: string
  /** Seats rooted in a worktree; the executor never resolves seats itself. */
  readonly contextFor: (
    workDir: string,
    options?: ContextOptions
  ) => Effect.Effect<StorySeats, FlowError, Scope.Scope>
  readonly board: BoardSyncShape
  /**
   * Prepares a worktree before its coder runs — a fresh checkout has no
   * installed dependencies, so the gates cannot run there without this.
   * Runs on every start and resume; a failure fails the story.
   */
  readonly setup?: (workDir: string, events?: FlowEventsShape) => Effect.Effect<void, FlowError>
  /**
   * When setup fails, give the story's coder ONE turn to make the worktree
   * ready (install, warm a cache, generate a client), then run setup again as
   * the check. A second failure fails the story with both outputs. Outages
   * are left to the outage retry. Default false.
   */
  readonly setupAgent?: boolean
  /** The target's gates, run in a worktree per task and on the epic checkout after each merge. */
  /**
   * The target's gates in a directory. `events` is the story's lane, so a
   * gate's timing names its story; a gate may ignore it.
   */
  readonly gates: (
    workDir: string,
    events?: FlowEventsShape,
    /** Where to write one log per gate command for this run; absent writes none. */
    log?: GateLogDir
  ) => Effect.Effect<ReviewResult, FlowError>
  /**
   * The gate commands as configured and the application directory (ADR 0027):
   * with them, the gates' result on each epic head is recorded as a baseline
   * and a story is charged only with the failing lines it added. Without
   * them every red line blocks, as before.
   */
  readonly gateCommands?: ReadonlyArray<ReadonlyArray<string>>
  readonly appDir?: string
  /** The test gate alone, for one rerun that tells a flaky line from a new one; omit to never rerun. */
  readonly testGate?: (
    workDir: string,
    events?: FlowEventsShape
  ) => Effect.Effect<ReviewResult, FlowError>
  /** How gate output reaches the coder in the fix prompt. */
  readonly fix?: FixPromptOptions
  /** Test-file and marker patterns for the oracle guard; default rules when absent (ADR 0027). */
  readonly oracleRules?: OracleRules
  /** Independent votes of the adversarial lens per review round (ADR 0027 decision 7). Default 1. */
  readonly votes?: number
  /** Who applies review findings: the implementer's chat (default) or a separate fixer (ADR 0027 decision 8). */
  readonly fixer?: "coder" | "separate"
  /** End a coder turn that repeats one tool call or goes silent (ADR 0027 decision 11). */
  readonly stall?: StallOptions
  /**
   * The autonomy contract profile for the coder's system prompt (ADR 0027
   * decision 5). Default: the roster executor's `contract`, else `full`.
   */
  readonly contract?: ContractProfile
  /**
   * The arguments of every tool call the story's coder made since `since`
   * (epoch ms), from the run's transcript; `undefined` when the run keeps
   * none for it. With it, a task's `verified:` claims are checked
   * (ADR 0027 decision 6).
   */
  readonly toolCalls?: (
    story: Story,
    since: number
  ) => Effect.Effect<ReadonlyArray<string> | undefined, FlowError>
  /** Story-level judge over the branch's diff against the epic branch; omit to skip. */
  readonly judge?: (
    story: Story,
    diff: string,
    seats: StorySeats,
    /**
     * `diff`: the branch's changes against the epic. `code`: the branch has
     * none, so this is the current code of the story's owned paths, to judge
     * whether the story is already in place.
     */
    subject?: "diff" | "code"
  ) => Effect.Effect<ReviewResult, FlowError>
  /**
   * Judge attempts, each but the last followed by a revision task on the
   * story's plan (coder, review, gates, commit). Default 2: one revision.
   */
  readonly judgeRounds?: number
  /**
   * How much of the code a story starts from goes into its coder's system
   * prompt, in characters: the shared read-only files it uses, then its own.
   * Each file read up front is a model round trip the coder does not spend
   * exploring. Default 40 000; 0 leaves it out.
   */
  readonly contextChars?: number
  /** Extra system context per story (house rules, shared read-only excerpts). */
  readonly system?: (story: Story) => Effect.Effect<string, FlowError>
  /** How a story's task plan is produced. Default: the story's own coder plans it. */
  readonly planTasks?: (
    seats: StorySeats,
    story: Story,
    prompt: string
  ) => Effect.Effect<Plan, FlowError>
  /** Stories implemented at once. Default 3. */
  readonly concurrency?: number
  /** Stop the epic at the first failed story instead of skipping its dependents. */
  readonly failFast?: boolean
  readonly reviewers?: ReadonlyArray<Reviewer>
  readonly maxRounds?: number
  /**
   * Defer what does not block (ADR 0031): a task's review settles once its
   * findings are all non-blocking, the judge clears a story whose findings
   * are all non-blocking, and what is left is written to
   * `stories/<id>.deferred.md` (`deferredPath`) when the story finishes,
   * for a follow-up round. Default false: every finding is fixed or fails.
   */
  readonly deferNonBlocking?: boolean
  /**
   * Second opinion on a BLOCKED_ON claim the plan cannot settle (a path no
   * story owns, or a parallel story's). `real: false` sends the coder back
   * once with the reason. Omit to accept every such claim.
   */
  readonly verifyBlocked?: (
    story: Story,
    need: string,
    workDir: string,
    seats: StorySeats
  ) => Effect.Effect<BlockedVerdict, FlowError>
  /**
   * Waits until a serving engine that went down (`isOutageMessage`) is back;
   * the story it interrupted is then retried once. Omit, or fail it, and the
   * executor stops launching stories instead of failing each in turn.
   */
  readonly awaitRecovery?: (reason: string) => Effect.Effect<void, FlowError>
}

/**
 * A failure that says nothing about the story: the serving engine went down,
 * or the epic checkout was dirtied. Launching more stories would only fail
 * them the same way.
 */
type Interruption = "outage" | "halt"

interface Completion {
  readonly story: Story
  readonly outcome: StoryOutcome
  readonly interruption?: Interruption
}

const combined = (first: ReviewResult, second: ReviewResult): ReviewResult =>
  first.isClean && second.isClean
    ? first
    : ReviewResult.make({
        issues: [...first.issues, ...second.issues],
        summary: [first.summary, second.summary].filter((part) => part.length > 0).join("; ")
      })

/**
 * Where a finished story's deferred findings are kept (ADR 0031): one
 * Markdown list per story under the executor's state directory, absent when
 * nothing was deferred.
 */
export const deferredPath = (stateDir: string, storyId: string): string =>
  join(stateDir, `stories/${storyId}.deferred.md`)

/** A deferred finding as one Markdown bullet, prefixed with where it was found. */
export const deferredLine = (source: string, issue: ReviewIssue): string => {
  const where =
    issue.file === undefined
      ? ""
      : ` (${issue.file}${issue.line === undefined ? "" : `:${issue.line}`})`
  const detail = issue.description.trim().length === 0 ? "" : `: ${issue.description.trim()}`
  return `- [${issue.severity}] ${source} — ${issue.title}${where}${detail}`
}

const issueLines = (result: ReviewResult): string =>
  result.issues.map((issue) => `- ${issue.title}: ${issue.description}`).join("\n")

/** The one-shot turn that makes a worktree ready after its setup command failed. */
export const setupRecoveryPrompt = (command: string): string =>
  [
    "The setup of this worktree failed, so the gates cannot run here yet:",
    "",
    command,
    "",
    "Make this worktree ready so that the same setup succeeds when it runs again: install",
    "or fetch dependencies, warm a package cache, generate clients, copy an example env file.",
    "Work only in this worktree. Do not change sources, tests, manifests or lockfiles, and do",
    "not commit: the setup is checked by running it again, and any tracked change is a",
    "perimeter violation. If it cannot be made ready from here, say why in one paragraph."
  ].join("\n")

const failed = (story: Story, reason: string): StoryFailed =>
  StoryFailed.make({ story: story.id, reason })

/** What the story scheduler can say about stories it is not starting. */
export interface LaunchPicture {
  readonly epicId: string
  readonly running: number
  readonly concurrency: number
  /** The roster's coder capacity; absent without a roster. */
  readonly capacity?: number
  /** Ready stories left for a coder slot to free. */
  readonly readyWaiting: number
  /** Stories whose dependencies are not merged yet, with the ones they wait for. */
  readonly blocked: ReadonlyArray<{ readonly id: string; readonly on: ReadonlyArray<string> }>
}

const shownBlocked = 3

/**
 * One line on why fewer stories run than the cap allows, or `undefined`
 * when nothing waits: dependencies first (the common case), then capacity.
 */
export const launchSummary = (picture: LaunchPicture): string | undefined => {
  if (picture.blocked.length === 0 && picture.readyWaiting === 0) {
    return undefined
  }
  const cap =
    picture.capacity === undefined
      ? `concurrency ${picture.concurrency}`
      : `concurrency ${picture.concurrency}, ${picture.capacity} coder slot(s)`
  const blocked =
    picture.blocked.length === 0
      ? []
      : [
          `${picture.blocked.length} waiting on dependencies: ${picture.blocked
            .slice(0, shownBlocked)
            .map((story) => `${story.id} ← ${story.on.join(", ")}`)
            .join("; ")}${
            picture.blocked.length > shownBlocked
              ? ` (+${picture.blocked.length - shownBlocked} more)`
              : ""
          }`
        ]
  const starved =
    picture.readyWaiting === 0 ? [] : [`${picture.readyWaiting} ready, waiting for a coder slot`]
  return [
    `epic ${picture.epicId}: ${picture.running} running (${cap})`,
    ...blocked,
    ...starved
  ].join(" · ")
}

// ---- The executor -------------------------------------------------------------

export const implementStoriesFlow = Effect.fn("@llm4ts/flow/Stories.implement")(function* (
  context: FlowContextShape,
  options: StoriesOptions
): Effect.fn.Return<EpicReport, FlowError> {
  const plan = yield* validateStoryPlan(options.plan)
  const { files, board } = options
  const events = context.events
  const epicBranch = options.epicBranch ?? `epic/${plan.epicId}`
  const concurrency = Math.max(1, options.concurrency ?? 3)
  const judgeRounds = Math.max(1, options.judgeRounds ?? 2)
  const deferring = options.deferNonBlocking === true
  const statePath = (story: Story): string => join(options.stateDir, `stories/${story.id}.json`)
  const planPath = (story: Story): string => join(options.stateDir, `stories/${story.id}.plan.md`)
  /** The judge's last verdict beside a fingerprint of what it judged. */
  const judgePath = (story: Story): string =>
    join(options.stateDir, `stories/${story.id}.judge.json`)
  /** One file per review lens, beside a fingerprint of the task and diff. */
  const reviewCacheDir = (story: Story): string =>
    join(options.stateDir, `stories/${story.id}.review`)
  /** What reviewers and the judge found, round by round, for people to read. */
  const findingsPath = (story: Story): string =>
    join(options.stateDir, `stories/${story.id}.findings.md`)
  /** What the coder's tasks learned, carried into the next task of the same story. */
  const notesPath = (story: Story): string => join(options.stateDir, `stories/${story.id}.notes.md`)
  // Gates with a memory (ADR 0027): baselines are keyed by the commit a
  // change started from, the app dir and the commands; without commands
  // nothing is recorded and every red line blocks, as before.
  const appDir = options.appDir ?? "."
  const gateCommands = options.gateCommands
  const rootsOf = (workDir: string): ReadonlyArray<string> => [join(workDir, appDir), workDir]
  const keyFor = (commit: string): string =>
    baselineKey({ baseCommit: commit, appDir, commands: gateCommands ?? [] })
  const baselineOf = (
    commit: string,
    result: ReviewResult,
    workDir: string
  ): Effect.Effect<GateBaseline> =>
    Effect.map(Clock.currentTimeMillis, (recordedAt) =>
      GateBaseline.make({
        baseCommit: commit,
        appDir,
        commands: (gateCommands ?? []).map((command) => command.join(" ")),
        failingLines: failingLinesOf(result, rootsOf(workDir)),
        ...(result.passed === undefined ? {} : { passedCount: result.passed }),
        recordedAt
      })
    )
  /** The baseline for `commit`, recording one from `run` when none is stored. */
  const ensureBaseline = (
    commit: string,
    run: Effect.Effect<ReviewResult, FlowError>,
    workDir: string
  ): Effect.Effect<GateBaseline | undefined, FlowError> =>
    gateCommands === undefined
      ? Effect.succeed(undefined)
      : ensureStoredBaseline({
          files,
          stateDir: options.stateDir,
          commit,
          appDir,
          commands: gateCommands,
          run,
          roots: rootsOf(workDir),
          now: Clock.currentTimeMillis
        })
  /** What each story inherited, for its outcome. */
  const inheritedByStory = new Map<string, ReadonlyArray<string>>()
  const findingLines = (result: ReviewResult): ReadonlyArray<string> =>
    result.issues.map((issue) => {
      const where =
        issue.file === undefined
          ? ""
          : ` (${issue.file}${issue.line === undefined ? "" : `:${issue.line}`})`
      const detail = issue.description.trim().length === 0 ? "" : `: ${issue.description.trim()}`
      return `- [${issue.severity}] ${issue.title}${where}${detail}`
    })
  const appendFindings = (
    story: Story,
    heading: string,
    result: ReviewResult
  ): Effect.Effect<void, FlowError> =>
    files.append(
      findingsPath(story),
      [
        `## ${heading}`,
        ...(result.issues.length === 0 ? ["- no issues"] : findingLines(result)),
        ""
      ].join("\n") + "\n"
    )
  /** Git's empty tree: a diff against it is a path's whole current content. */
  const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
  const revisionTitle = /^Revision \d+: /u

  /**
   * The epic checkout must hold nothing uncommitted: every merge and epic
   * gate runs there, and git refuses a merge that would overwrite a stray
   * file. A dirty checkout means a coder escaped its worktree.
   */
  const epicCheckoutClean = (story?: Story): Effect.Effect<void, FlowError> =>
    Effect.gen(function* () {
      const paths = statusPaths(yield* context.git.status)
      if (paths.length > 0) {
        return yield* EpicCheckoutDirty.make({
          checkout: context.workDir,
          paths,
          ...(story === undefined ? {} : { story: story.id })
        })
      }
    })

  /** A story's own events say so (a lane), so concurrent stories stay apart on screen. */
  const lanes = new Map<string, FlowEventsShape>()
  const laneOf = (story: Story): FlowEventsShape => {
    const known = lanes.get(story.id)
    if (known !== undefined) {
      return known
    }
    const lane = withLane(events, { lane: story.id })
    lanes.set(story.id, lane)
    return lane
  }

  yield* epicCheckoutClean()
  yield* stage(events, "epic branch", context.git.checkoutOrCreate(epicBranch))
  if (gateCommands !== undefined) {
    // The gates as the epic head stands: what every story may inherit.
    const epicHead = yield* context.git.checkpoint
    yield* ensureBaseline(epicHead, options.gates(context.workDir, events), context.workDir)
  }

  const waves = topologicalWaves(plan)
  const waveOf = (id: string): string | undefined => {
    const index = waves.findIndex((wave) => wave.includes(id))
    return index < 0 ? undefined : `${index + 1}`
  }
  yield* board.plan(
    plan.stories.map((story) => {
      const wave = waveOf(story.id)
      return BoardItem.make({
        id: story.id,
        title: story.title,
        status: "planned",
        ...(wave === undefined ? {} : { wave })
      })
    })
  )

  const mergeLock = yield* Semaphore.make(1)

  /** Merge the story branch into the epic branch and re-gate the epic head, one story at a time. */
  const integrate = (story: Story, branch: string): Effect.Effect<void, FlowError> =>
    Effect.flatMap(Clock.currentTimeMillis, (requested) =>
      Effect.andThen(
        laneOf(story).publish(Began.make({ kind: "wait", label: "merge lock" })),
        mergeLock.withPermit(
          Effect.gen(function* () {
            const lane = laneOf(story)
            // Merges are one at a time: how long this story queued for its turn.
            const turn = yield* Clock.currentTimeMillis
            yield* lane.publish(
              Timed.make({ kind: "wait", label: "merge lock", ms: turn - requested })
            )
            yield* epicCheckoutClean(story)
            const checkpoint = yield* context.git.checkpoint
            yield* timeEffect(
              lane,
              context.git.merge(branch, `${plan.epicId}: merge story ${story.id}`),
              (ms, failed) =>
                Timed.make({ kind: "merge", label: "merge", ms, ...(failed ? { failed } : {}) }),
              () => Began.make({ kind: "merge", label: "merge" })
            )
            const gate = yield* options.gates(context.workDir, lane)
            // Charged only with what the merge added: the head before it had
            // a baseline (run start or the previous merge).
            const before = yield* ensureBaseline(
              checkpoint,
              Effect.succeed(ReviewResult.make({ issues: [] })),
              context.workDir
            )
            const verdict = triageGates(gate, before, rootsOf(context.workDir))
            if (!verdict.blocking.isClean) {
              // Never leave a red epic head for the next story to inherit.
              yield* context.git.rollback(checkpoint)
              return yield* failed(
                story,
                `epic gates failed after merging; merge undone:\n${issueLines(verdict.blocking)}`
              )
            }
            if (gateCommands !== undefined) {
              const mergedHead = yield* context.git.checkpoint
              yield* writeBaseline(
                files,
                options.stateDir,
                keyFor(mergedHead),
                yield* baselineOf(mergedHead, gate, context.workDir)
              )
            }
            yield* laneOf(story).publish(
              Info.make({ message: `story ${story.id}: merged into ${epicBranch}` })
            )
          })
        )
      )
    )

  /** The worktree and branch for a story, honouring the hash-guarded resume rules. */
  const prepareWorktree = Effect.fn("@llm4ts/flow/Stories.prepareWorktree")(function* (
    story: Story
  ): Effect.fn.Return<{ readonly state: StoryState; readonly alreadyMerged: boolean }, FlowError> {
    const hash = storyHash(story)
    const branch = `story/${plan.epicId}/${story.id}`
    const worktree = join(options.worktreeRoot, story.id)
    const path = statePath(story)
    let stored = yield* loadVersioned(files, path, StoryStateVersion, StoryState)
    if (stored !== undefined && stored.hash !== hash) {
      yield* laneOf(story).publish(
        Info.make({
          message: `story ${story.id}: plan entry changed since its branch was created; starting over`
        })
      )
      // The old worktree may already be gone (an operator cleaned up); that is
      // not a failure of this run, so removal errors are reported and dropped.
      yield* context.git
        .removeWorktree(stored.worktree, true)
        .pipe(
          Effect.catch((error) =>
            laneOf(story).publish(
              Info.make({ message: `story ${story.id}: ${describeFlowError(error)}` })
            )
          )
        )
      if (yield* context.git.branchExists(stored.branch)) {
        yield* context.git.deleteBranch(stored.branch)
      }
      // The task checkpoint belongs to the old branch: left in place, the
      // fresh branch would inherit "every task complete" and skip the coder.
      // The notes its tasks carried describe the old definition: gone too.
      yield* files.remove(planPath(story))
      yield* files.remove(notesPath(story))
      stored = undefined
    }
    if (stored !== undefined && stored.status === "merged") {
      return { state: stored, alreadyMerged: true }
    }
    if (stored === undefined) {
      yield* context.git.addWorktreeNewBranch(worktree, branch, epicBranch)
      const state = StoryState.make({ id: story.id, hash, branch, worktree, status: "started" })
      yield* saveVersioned(files, path, StoryStateVersion, StoryState, state)
      return { state, alreadyMerged: false }
    }
    // Resume: the branch exists; the worktree may not (a worktree has a
    // `.git` FILE at its root, which is how its presence is checked). A
    // worktree left under an older root moves to the current one, work and
    // all, so every story of the epic runs under the same root.
    let state = stored
    if (stored.worktree !== worktree) {
      if ((yield* files.read(join(stored.worktree, ".git"))) !== undefined) {
        yield* context.git.moveWorktree(stored.worktree, worktree)
        yield* laneOf(story).publish(
          Info.make({ message: `story ${story.id}: moved its worktree to ${worktree}` })
        )
      }
      state = StoryState.make({ ...stored, worktree })
      yield* saveVersioned(files, path, StoryStateVersion, StoryState, state)
    }
    const marker = yield* files.read(join(state.worktree, ".git"))
    if (marker === undefined) {
      yield* context.git.addWorktree(state.worktree, state.branch)
    }
    yield* laneOf(story).publish(
      Info.make({ message: `story ${story.id}: resuming ${state.branch}` })
    )
    return { state, alreadyMerged: false }
  })

  /**
   * Brings a story branch up to date with the epic branch. A story that
   * started before a dependency was re-merged (or that resumes after other
   * stories merged) would otherwise build on, and be judged against, code
   * the epic no longer has. Conflicting hunks take the epic's side: the epic
   * holds only other stories' merged work, and those paths are theirs.
   */
  const catchUp = (story: Story, git: GitToolShape): Effect.Effect<void, FlowError> =>
    Effect.gen(function* () {
      if (yield* git.isAncestor(epicBranch, "HEAD")) {
        return
      }
      if ((yield* git.uncommittedFiles).length > 0) {
        yield* git.commitAll(`${story.id}: work in progress`)
      }
      yield* git.merge(epicBranch, `${story.id}: catch up with ${epicBranch}`, {
        preferIncoming: true
      })
      yield* laneOf(story).publish(
        Info.make({ message: `story ${story.id}: caught up with ${epicBranch}` })
      )
    })

  /** The perimeter over everything the branch changed, committed or not. */
  const perimeterNow = (
    story: Story,
    git: GitToolShape
  ): Effect.Effect<PerimeterCheck, FlowError> =>
    Effect.gen(function* () {
      const committed = yield* git.changedFilesVsBase(epicBranch)
      const uncommitted = yield* git.uncommittedFiles
      return checkPerimeter([...new Set([...committed, ...uncommitted])], story)
    })

  /** Everything that happens inside a story's worktree: plan, implement, judge, perimeter. */
  const implementStory = Effect.fn("@llm4ts/flow/Stories.implementStory")(function* (
    story: Story,
    state: StoryState
  ): Effect.fn.Return<
    {
      readonly judge: string | undefined
      /** Its branch had no changes and the judge found its code already on the epic. */
      readonly inPlace: boolean
      readonly totals: TokenUsage | undefined
      readonly executor: string | undefined
    },
    FlowError,
    Scope.Scope
  > {
    const seats = yield* options.contextFor(state.worktree, {
      label: story.id,
      ...(state.executor === undefined ? {} : { prefer: state.executor })
    })
    const roster = seats.context.roster
    const coderExecutor = roster === undefined ? undefined : yield* roster.executor
    if (coderExecutor !== undefined && coderExecutor !== state.executor) {
      yield* saveVersioned(
        files,
        statePath(story),
        StoryStateVersion,
        StoryState,
        StoryState.make({ ...state, executor: coderExecutor })
      )
    }
    const blocked = yield* Ref.make<string | undefined>(undefined)
    const pushbacks = yield* Ref.make(0)
    const storyContext: FlowContextShape = {
      ...seats.context,
      coder: watchForBlockedOn(seats.context.coder, blocked)
    }
    const git = storyContext.git
    const watchedSeats: StorySeats = { ...seats, context: storyContext }
    const extra = options.system === undefined ? undefined : yield* options.system(story)
    const contractProfile: ContractProfile =
      options.contract ??
      (coderExecutor === undefined ? undefined : roster?.contractOf?.(coderExecutor)) ??
      "full"
    const system = withContract(
      [
        perimeterRules(story, { plan, worktree: state.worktree, epicCheckout: context.workDir }),
        gateRules,
        extra
      ]
        .filter((part): part is string => part !== undefined && part.trim().length > 0)
        .join("\n\n"),
      contractProfile
    )
    /** What the coder claimed to have run and did not, task by task, for the judge. */
    const evidenceNotes: Array<string> = []
    /** Findings left for a follow-up round (ADR 0031), written when the story finishes. */
    const deferred: Array<string> = []
    const checkEvidence = (
      task: Task,
      trailer: Trailer,
      startedAt: number
    ): Effect.Effect<void, FlowError> =>
      Effect.gen(function* () {
        const calls =
          options.toolCalls === undefined ? undefined : yield* options.toolCalls(story, startedAt)
        const confidence =
          trailer.confidence === undefined ? {} : { confidence: trailer.confidence }
        if (calls === undefined) {
          yield* laneOf(story).publish(
            EvidenceChecked.make({
              task: task.title,
              claimed: trailer.verified.length,
              unverified: 0,
              unchecked: true,
              lane: story.id,
              ...confidence
            })
          )
          return
        }
        const unverified = unverifiedClaims(trailer.verified, calls)
        yield* laneOf(story).publish(
          EvidenceChecked.make({
            task: task.title,
            claimed: trailer.verified.length,
            unverified: unverified.length,
            lane: story.id,
            ...confidence
          })
        )
        if (unverified.length > 0) {
          evidenceNotes.push(
            `task "${task.title}": claimed ${unverified.map((command) => `\`${command}\``).join(", ")} — no tool call ran it`
          )
          yield* appendFindings(
            story,
            `evidence "${task.title}" — ${unverified.length} claimed command(s) never ran`,
            ReviewResult.make({ issues: fabricatedStatusIssues(unverified), summary: "" })
          )
        }
        if (trailer.confidence === "low") {
          evidenceNotes.push(`task "${task.title}": the coder said confidence: low`)
        }
      })
    const prompt = storyPrompt(story)

    // Catch up before setup: the epic may have changed the manifest too.
    yield* catchUp(story, git)
    if (options.setup !== undefined) {
      const setup = options.setup(state.worktree, laneOf(story))
      yield* stage(
        laneOf(story),
        `story ${story.id}: setup`,
        options.setupAgent !== true
          ? setup
          : setup.pipe(
              Effect.catch((error) =>
                isOutageMessage(error.message)
                  ? Effect.fail(error)
                  : Effect.gen(function* () {
                      yield* laneOf(story).publish(
                        Info.make({
                          message: `story ${story.id}: setup failed; the coder gets one turn to make the worktree ready`
                        })
                      )
                      const chat = yield* makeChat(seats.context.coder, {
                        system,
                        events: laneOf(story),
                        agent: "coder"
                      })
                      yield* chat.ask(setupRecoveryPrompt(error.message))
                      yield* setup.pipe(
                        Effect.catch((again) =>
                          Effect.fail(
                            failed(
                              story,
                              `setup still fails after the coder's turn:\n${again.message}\n(first failure:\n${error.message})`
                            )
                          )
                        )
                      )
                    })
              )
            )
      )
    }

    // The target's gates plus the perimeter: a stray path is a gate failure
    // the task review loop hands back to the coder before anything commits.
    // The epic head this worktree started from: what the story may inherit.
    const storyBase = yield* git.checkpoint
    const storyBaseline = ensureBaseline(
      storyBase,
      options.gates(state.worktree, laneOf(story)),
      state.worktree
    )
    // The oracle guard over the story's whole change against the epic:
    // committed on the branch and uncommitted in the worktree (ADR 0027).
    const oracleGate = (target: ReviewResult): Effect.Effect<ReviewResult, FlowError> =>
      story.testsChange
        ? Effect.succeed(ReviewResult.make({ issues: [] }))
        : Effect.gen(function* () {
            const committed = yield* git.diffVsBase(epicBranch)
            const uncommitted = yield* git.diffAll
            const base =
              gateCommands === undefined ? undefined : (yield* storyBaseline)?.passedCount
            const issues = checkOracle(
              parseUnifiedDiff(`${committed}\n${uncommitted}`),
              { base, current: target.passed },
              options.oracleRules ?? defaultOracleRules,
              false
            )
            return ReviewResult.make({ issues, summary: issues.length === 0 ? "" : "oracle guard" })
          })
    const gates: Effect.Effect<ReviewResult, FlowError> = Effect.gen(function* () {
      const target = yield* options.gates(state.worktree, laneOf(story), {
        files,
        dir: storyGateLogDir(options.stateDir, story.id)
      })
      const changed = yield* perimeterNow(story, git)
      return combined(
        combined(target, perimeterGate([...changed.sharedReadOnly, ...changed.outside], story)),
        yield* oracleGate(target)
      )
    })
    const triage: GateTriageOptions = {
      baseline: storyBaseline,
      roots: rootsOf(state.worktree),
      ...(options.testGate === undefined
        ? {}
        : { rerunTest: options.testGate(state.worktree, laneOf(story)) })
    }
    if (gateCommands !== undefined) {
      // Recorded here, before the first task, so the lane says what the time goes to.
      const baseline = yield* stage(
        laneOf(story),
        `story ${story.id}: baseline gates`,
        storyBaseline
      )
      const inherited = baseline?.failingLines ?? []
      if (inherited.length > 0) {
        inheritedByStory.set(story.id, inherited)
        yield* appendFindings(
          story,
          "gate failures inherited from the base (not charged to this story)",
          ReviewResult.make({
            issues: inherited.map((line) =>
              ReviewIssue.make({ severity: "Info", title: line, description: "", origin: "base" })
            ),
            summary: ""
          })
        )
      }
    }

    const coderTurn = (text: string): Effect.Effect<string, FlowError> =>
      Effect.flatMap(makeChat(storyContext.coder, { system, events, agent: "coder" }), (chat) =>
        chat.ask(text)
      )

    const commitGreen = (message: string, why: string): Effect.Effect<void, FlowError> =>
      Effect.gen(function* () {
        const reported = yield* Ref.make<ReadonlySet<string>>(new Set())
        const regated = yield* applyTriage(yield* gates, triage, laneOf(story), reported)
        if (!regated.isClean) {
          return yield* failed(story, `gates broke ${why}:\n${issueLines(regated)}`)
        }
        yield* git.commitAll(`${story.id}: ${message}`)
      })

    /**
     * Runs `effect`; a BLOCKED_ON the plan or the verifier refutes sends the
     * coder back once with the reason, then `resume` runs. Any other claim —
     * or a second one — ends the story as a typed MissingDependency.
     */
    const guarded = <A>(
      effect: Effect.Effect<A, FlowError>,
      resume: Effect.Effect<void, FlowError>
    ): Effect.Effect<void, FlowError> =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(effect)
        const need = yield* Ref.get(blocked)
        if (need === undefined) {
          if (Exit.isFailure(exit)) {
            return yield* Effect.failCause(exit.cause)
          }
          return
        }
        const missing = MissingDependency.make({ story: story.id, need })
        if ((yield* Ref.get(pushbacks)) > 0) {
          return yield* missing
        }
        let rebuttal = blockedRebuttal(plan, story, need)
        if (rebuttal === undefined && options.verifyBlocked !== undefined) {
          const verdict = yield* withTimedRole(
            "verifier",
            options.verifyBlocked(story, need, state.worktree, watchedSeats)
          ).pipe(Effect.catch(() => Effect.succeed(undefined)))
          rebuttal = verdict === undefined || verdict.real ? undefined : verdict.reason
        }
        if (rebuttal === undefined) {
          return yield* missing
        }
        yield* Ref.set(blocked, undefined)
        yield* Ref.update(pushbacks, (count) => count + 1)
        yield* laneOf(story).publish(
          Info.make({ message: `story ${story.id}: BLOCKED_ON rejected — ${rebuttal}` })
        )
        yield* coderTurn(
          [
            `You stopped with "${blockedOnSentinel} ${need}".`,
            "That claim was checked against the epic's plan and rejected:",
            rebuttal,
            "",
            "It is not a missing dependency. Continue the story inside your owned paths until it is",
            `complete, then stop. Use ${blockedOnSentinel} only for work another story owns that is`,
            "absent from your working tree."
          ].join("\n")
        )
        const again = yield* Ref.get(blocked)
        if (again !== undefined) {
          return yield* MissingDependency.make({ story: story.id, need: again })
        }
        yield* commitGreen("continue after a rejected BLOCKED_ON", "after a rejected BLOCKED_ON")
        yield* guarded(resume, Effect.void)
      })

    /**
     * Stray paths go back before a judge sees the branch: first the coder is
     * asked to move or revert them, then whatever is left is restored from
     * the epic branch — a deterministic rule never needs a judge round.
     */
    const repairPerimeter: Effect.Effect<void, FlowError> = Effect.gen(function* () {
      const first = yield* perimeterNow(story, git)
      if (isWithinPerimeter(first)) {
        return
      }
      const violation = PerimeterViolation.make({
        story: story.id,
        outside: first.outside,
        sharedReadOnly: first.sharedReadOnly
      })
      yield* guarded(
        coderTurn(
          [
            violation.message,
            "",
            "Put each of these paths back as it is on the epic branch (restore a changed file, delete",
            "a file you created there). Work that belongs to this story moves into your owned paths.",
            "Then stop."
          ].join("\n")
        ),
        Effect.void
      )
      const second = yield* perimeterNow(story, git)
      if (!isWithinPerimeter(second)) {
        const stray = [...second.sharedReadOnly, ...second.outside]
        yield* git.restorePaths(epicBranch, stray)
        yield* laneOf(story).publish(
          Info.make({
            message: `story ${story.id}: restored ${stray.length} path(s) outside its perimeter from ${epicBranch}: ${stray.join(", ")}`
          })
        )
      }
      yield* git.commitAll(`${story.id}: put paths outside the perimeter back`)
    })

    const planTasks = options.planTasks ?? defaultPlanTasks
    // Taken after catch-up and setup: the code as the first task finds it.
    const startingCode = yield* startingCodeOf(
      story,
      git,
      files,
      state.worktree,
      options.contextChars ?? defaultContextChars
    )
    const taskSystem = [system, startingCode]
      .filter((part): part is string => part !== undefined)
      .join("\n\n")
    const implementTasks = implementPlanFlow(storyContext, {
      store: makePlanStore(files),
      planPath: planPath(story),
      plan: planWithinPerimeter(
        plan,
        story,
        (text) =>
          stage(
            laneOf(story),
            `story ${story.id}: plan tasks`,
            planTasks(watchedSeats, story, text)
          ),
        prompt,
        laneOf(story)
      ),
      system: taskSystem,
      chatPerTask: true,
      carry: {
        read: files.read(notesPath(story)),
        write: (notes) => files.writeAtomic(notesPath(story), notes)
      },
      checkoutBranch: false,
      lint: gates,
      triage,
      ...(options.fix === undefined ? {} : { fix: options.fix }),
      // A story's final state is judged and gated downstream (judge round,
      // perimeter check, epic gates), so a task the coder finds already
      // satisfied — without saying the exact sentinel — must not sink the
      // story: the option exists for pipelines shaped like this one.
      noopTaskPolicy: "complete",
      // A lens's answer is kept beside the task and diff it answered, so a
      // rerun over the same change asks nothing; every round is written to
      // the story's findings log for people to read.
      reviewCache: { files, dir: reviewCacheDir(story) },
      onReview: (task, round, result, settled) =>
        Effect.gen(function* () {
          // A settled round's leftovers are deferred, not dropped: when the
          // rounds ran out, blocking ones too, since the task commits anyway.
          const left = settled && deferring ? result.issues : []
          for (const issue of left) {
            deferred.push(deferredLine(`review "${task.title}"`, issue))
          }
          yield* appendFindings(
            story,
            `review "${task.title}" round ${round} — ${
              result.isClean ? "clean" : `${result.issues.length} issue(s)`
            }${settled ? (left.length === 0 ? "" : ", deferred") : ", fixing"}`,
            result
          )
        }),
      onTaskReply: (task, _reply, trailer, startedAt) => checkEvidence(task, trailer, startedAt),
      // The repository's own review rules ride along as one extra lens
      // (ADR 0027 decision 9), read from the epic checkout.
      repoRules: loadRepoReviewRules(files, context.workDir),
      ...(options.votes === undefined ? {} : { votes: options.votes }),
      ...(options.fixer === undefined ? {} : { fixer: options.fixer }),
      ...(options.stall === undefined ? {} : { stall: options.stall }),
      ...(options.reviewers === undefined ? {} : { reviewers: options.reviewers }),
      ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
      ...(deferring ? { settle: "blocking" as const } : {})
    })
    yield* guarded(implementTasks, implementTasks)

    // Other stories may have merged while this one ran: judge the branch
    // against the epic as it is now.
    yield* catchUp(story, git)
    yield* repairPerimeter

    // A judge finding becomes a revision task on the story's own plan, run by
    // the task loop like any other: coder, review, gates, commit.
    const addRevision = (verdict: ReviewResult, empty: boolean): Effect.Effect<void, FlowError> =>
      Effect.gen(function* () {
        const store = makePlanStore(files)
        const current = yield* store.load(planPath(story))
        if (current === undefined) {
          return
        }
        const number = current.tasks.filter((task) => revisionTitle.test(task.title)).length + 1
        yield* store.save(
          planPath(story),
          Plan.make({
            ...current,
            tasks: [
              ...current.tasks,
              Task.make({
                title: `Revision ${number}: close the judge's findings`,
                description: [
                  empty
                    ? `The story "${story.title}" has no changes yet, and what it must provide is not all in place on the epic branch.`
                    : `The story "${story.title}" was judged short of done.`,
                  "Close these gaps without weakening any test and without leaving your owned paths:",
                  issueLines(verdict)
                ].join("\n")
              })
            ]
          })
        )
      })

    let judgeNote: string | undefined
    let inPlace = false
    if (options.judge !== undefined) {
      const judge = options.judge
      for (let round = 1; round <= judgeRounds; round += 1) {
        const diff = yield* git.diffVsBase(epicBranch)
        // No changes is not a failure by itself: the story's code may already
        // be on the epic (an earlier story or run put it there). Judge that
        // code instead: the owned paths against the empty tree.
        const empty = diff.trim().length === 0
        const judgedCode = empty ? yield* git.diffVsBaseScoped(emptyTree, story.owned, false) : diff
        // What the coder claimed and could not show travels with the subject
        // (ADR 0027 decision 6): the judge weighs the code knowing the
        // story's own account of its testing is not evidence.
        const subject =
          evidenceNotes.length === 0
            ? judgedCode
            : [
                "Evidence notes from the run (not part of the diff):",
                ...evidenceNotes.map((note) => `- ${note}`),
                "",
                judgedCode
              ].join("\n")
        // The verdict is kept beside a fingerprint of what was judged: a
        // rerun that finds the same diff gets the same answer without a
        // model call, and the last verdict is on disk to read. Only the
        // first round reuses it; a later round follows a revision and asks.
        // The round is an EVALUATOR span (ADR 0026): the verdict's scores and
        // findings land on it, so a trace shows why a story was sent back.
        const judged = yield* withKindSpan(
          `story ${story.id}: judge ${round}`,
          { kind: "EVALUATOR" },
          Effect.gen(function* () {
            const outcome =
              empty && subject.trim().length === 0
                ? // Nothing to judge is decided here, not asked of a model.
                  {
                    value: ReviewResult.make({
                      issues: [
                        ReviewIssue.make({
                          severity: "Critical",
                          title: `nothing exists yet under ${story.owned.join(", ")}`,
                          description: "The story's owned paths are empty on the epic branch."
                        })
                      ],
                      summary: `judge:${story.id}`
                    }),
                    reused: false
                  }
                : yield* cachedValue(
                    files,
                    judgePath(story),
                    Verdict,
                    fingerprintOf([
                      empty ? "code" : "diff",
                      subject,
                      story.id,
                      story.title,
                      story.description,
                      story.provides.join("\n")
                    ]),
                    withTimedRole(
                      "judge",
                      judge(story, subject, watchedSeats, empty ? "code" : "diff")
                    ),
                    { reuse: round === 1 }
                  )
            const scored = outcome.value instanceof StoryVerdict ? outcome.value.dimensions : []
            yield* Effect.annotateCurrentSpan({
              "llm4ts.judge.cleared": outcome.value.isClean,
              "llm4ts.judge.reused": outcome.reused,
              ...Object.fromEntries(scored.map((d) => [`llm4ts.judge.${d.id}`, d.score]))
            })
            const now = yield* Clock.currentTimeNanos
            yield* Effect.option(Effect.currentSpan).pipe(
              Effect.map((span) => {
                if (span._tag === "Some") {
                  for (const issue of outcome.value.issues) {
                    span.value.event("judge finding", now, {
                      title: issue.title,
                      severity: issue.severity
                    })
                  }
                }
              })
            )
            return outcome
          })
        )
        const verdict = judged.value
        if (judged.reused) {
          yield* laneOf(story).publish(
            Info.make({
              lane: story.id,
              message: `judge round ${round}: reused the verdict for an unchanged ${empty ? "code" : "diff"}`
            })
          )
        }
        yield* appendFindings(
          story,
          `judge round ${round} — ${verdict.isClean ? "cleared" : "not cleared"}${
            verdict instanceof StoryVerdict
              ? ` (${verdict.dimensions.map((d) => `${d.id} ${d.score}/${d.max}`).join(", ")})`
              : ""
          }${judged.reused ? ", reused" : ""}`,
          verdict
        )
        yield* laneOf(story).publish(
          StoryJudged.make({
            lane: story.id,
            round,
            cleared: verdict.isClean,
            issues: verdict.issues.length,
            dimensions: verdict instanceof StoryVerdict ? verdict.dimensions : []
          })
        )
        // Deferring, a verdict with nothing blocking clears: what it found
        // waits for the follow-up round instead of another revision.
        if (verdict.isClean || (deferring && !verdict.issues.some(isBlocking))) {
          const waiting = nonBlockingIssues(verdict)
          for (const issue of waiting) {
            deferred.push(deferredLine(`judge round ${round}`, issue))
          }
          inPlace = empty
          judgeNote = `${empty ? "verified already in place" : "judge cleared"} (round ${round}${
            waiting.length === 0 ? "" : `, ${waiting.length} finding(s) deferred`
          })`
          break
        }
        if (round >= judgeRounds) {
          const revisions = `${round - 1} revision${round === 2 ? "" : "s"}`
          return yield* failed(
            story,
            empty
              ? `the story's code is not in place after ${revisions}, and its branch has no changes:\n${issueLines(verdict)}`
              : `judge not cleared after ${revisions}:\n${issueLines(verdict)}`
          )
        }
        yield* addRevision(verdict, empty)
        yield* guarded(implementTasks, implementTasks)
        yield* catchUp(story, git)
        yield* repairPerimeter
      }
    }

    const changed = yield* git.changedFilesVsBase(epicBranch)
    yield* enforcePerimeter(changed, story)
    if (deferring) {
      yield* deferred.length === 0
        ? files.remove(deferredPath(options.stateDir, story.id))
        : files.writeAtomic(
            deferredPath(options.stateDir, story.id),
            [`# Deferred from ${story.id}: ${story.title}`, "", ...deferred, ""].join("\n")
          )
    }
    const totals = seats.totals === undefined ? undefined : yield* seats.totals
    const history = roster === undefined ? [] : yield* roster.history
    return {
      judge: judgeNote,
      inPlace,
      totals,
      executor: history.length === 0 ? undefined : history.join(" → ")
    }
  })

  const runStory = Effect.fn("@llm4ts/flow/Stories.runStory")(function* (
    story: Story
  ): Effect.fn.Return<StoryOutcome, FlowError> {
    yield* board.start(story.id)
    const { state, alreadyMerged } = yield* prepareWorktree(story)
    if (alreadyMerged) {
      yield* laneOf(story).publish(
        Info.make({ message: `story ${story.id}: already merged; skipping` })
      )
      return StoryOutcome.make({
        id: story.id,
        title: story.title,
        status: "done",
        branch: state.branch,
        judge: "merged on a previous run"
      })
    }
    const result = yield* Effect.scoped(implementStory(story, state))
    if (result.inPlace) {
      // Verified already on the epic: there is nothing to merge or re-gate.
      yield* laneOf(story).publish(
        Info.make({ message: `story ${story.id}: verified already in place; nothing to merge` })
      )
    } else {
      yield* integrate(story, state.branch)
    }
    const last = result.executor?.split(" → ").at(-1)
    yield* saveVersioned(
      files,
      statePath(story),
      StoryStateVersion,
      StoryState,
      StoryState.make({
        ...state,
        status: "merged",
        ...(last === undefined ? {} : { executor: last })
      })
    )
    const inherited = inheritedByStory.get(story.id)
    return StoryOutcome.make({
      id: story.id,
      title: story.title,
      status: "done",
      branch: state.branch,
      ...(result.judge === undefined ? {} : { judge: result.judge }),
      ...(result.executor === undefined ? {} : { executor: result.executor }),
      ...(result.totals === undefined ? {} : { estimatedTokens: result.totals.total }),
      ...(result.totals?.costUsd === undefined ? {} : { estimatedCostUsd: result.totals.costUsd }),
      ...(inherited === undefined ? {} : { inherited })
    })
  })

  /** A story's run as a completion — failures become outcomes, never fiber deaths. */
  // One trace per story (ADR 0026): the story span roots it, linked to the
  // run's span, and every span under it — tasks, model calls, tools, gates —
  // carries the story, the epic and the run's session.
  const storySpanAttributes = (story: Story): Readonly<Record<string, unknown>> => ({
    [attr.story]: story.id,
    [attr.epic]: plan.epicId,
    ...(context.trace === undefined
      ? {}
      : { [attr.session]: context.trace.runId, [attr.run]: context.trace.runId })
  })
  const annotated = <A, E, R>(
    story: Story,
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> =>
    Object.entries(storySpanAttributes(story)).reduce(
      (acc, [key, value]) => Effect.annotateSpans(key, value)(acc),
      effect
    )
  const attempt = (story: Story): Effect.Effect<Completion> =>
    annotated(
      story,
      stage(laneOf(story), `story ${story.id}`, runStory(story), {
        kind: "AGENT",
        root: true,
        attributes: storySpanAttributes(story)
      })
    ).pipe(
      Effect.map((outcome): Completion => ({ story, outcome })),
      Effect.catch((error) =>
        Effect.gen(function* () {
          const reason = describeFlowError(error)
          const path = statePath(story)
          const stored = yield* loadVersioned(files, path, StoryStateVersion, StoryState).pipe(
            Effect.catch(() => Effect.succeed(undefined))
          )
          if (stored !== undefined && stored.status !== "merged") {
            yield* saveVersioned(
              files,
              path,
              StoryStateVersion,
              StoryState,
              StoryState.make({ ...stored, status: "failed" })
            ).pipe(Effect.ignore)
          }
          const interruption: Interruption | undefined =
            error._tag === "EpicCheckoutDirty" ||
            error._tag === "RosterExhausted" ||
            reason.includes(rosterExhaustedPrefix)
              ? "halt"
              : isOutageMessage(reason)
                ? "outage"
                : undefined
          const completion: Completion = {
            story,
            outcome: StoryOutcome.make({
              id: story.id,
              title: story.title,
              status: "failed",
              reason,
              ...(stored === undefined ? {} : { branch: stored.branch })
            }),
            ...(interruption === undefined ? {} : { interruption })
          }
          return completion
        })
      )
    )

  const outcomes = yield* Ref.make<ReadonlyArray<StoryOutcome>>([])
  const running = yield* Ref.make<ReadonlySet<string>>(new Set())
  const completions = yield* Queue.unbounded<Completion>()

  const progress = Effect.gen(function* () {
    const known = yield* Ref.get(outcomes)
    const byStatus = (status: OutcomeStatus): ReadonlySet<string> =>
      new Set(known.filter((outcome) => outcome.status === status).map((outcome) => outcome.id))
    return {
      done: byStatus("done"),
      failed: byStatus("failed"),
      waiting: byStatus("waiting"),
      running: yield* Ref.get(running)
    }
  })

  const record = (outcome: StoryOutcome): Effect.Effect<void> =>
    Ref.update(outcomes, (current) => [...current, outcome])

  /** Dependents of a failed story go on hold: they run once it is fixed and rerun. */
  const holdDependents = (story: Story): Effect.Effect<void, FlowError> =>
    Effect.gen(function* () {
      const current = yield* progress
      for (const id of dependentsOf(plan, story.id)) {
        const dependent = plan.story(id)
        if (
          dependent === undefined ||
          current.done.has(id) ||
          current.failed.has(id) ||
          current.waiting.has(id)
        ) {
          continue
        }
        const reason = `waiting for ${story.id}`
        yield* record(StoryOutcome.make({ id, title: dependent.title, status: "waiting", reason }))
        yield* board.wait(id, reason)
      }
    })

  /** Why no further story may start in this run; stories already running finish. */
  let halted: string | undefined
  /** The last launch summary said, so a picture is told once, when it changes. */
  let toldLaunch: string | undefined
  /** Stories retried once after the serving engine recovered. */
  const recovered = new Set<string>()

  yield* Effect.scoped(
    Effect.gen(function* () {
      while (true) {
        /** The roster's coder capacity when a ready story was left waiting for it. */
        let starvedAt: number | undefined
        if (halted === undefined) {
          const current = yield* progress
          const ready = readyStories(plan, current)
          // With a roster, never run more stories than the round has coder
          // slots: each running story holds one. Capacity, not the slots free
          // this instant — a review or judge call holding a slot for a moment
          // must not keep a story from starting; its lease waits for that call.
          // With nothing running, launch one anyway — its lease waits for the
          // first executor to come back (ADR 0019).
          const capacity =
            context.roster === undefined
              ? Number.POSITIVE_INFINITY
              : yield* context.roster.capacity("coder")
          const budget = Math.min(concurrency, capacity) - current.running.size
          const slots =
            current.running.size === 0 && ready.length > 0 ? Math.max(1, budget) : budget
          const launching = ready.slice(0, Math.max(0, slots))
          for (const story of launching) {
            yield* Ref.update(running, (set) => new Set([...set, story.id]))
            yield* Effect.forkScoped(
              attempt(story).pipe(
                Effect.flatMap((completion) => Queue.offer(completions, completion))
              )
            )
          }
          if (
            context.roster !== undefined &&
            ready.length > launching.length &&
            current.running.size + launching.length < concurrency
          ) {
            starvedAt = capacity
          }
          // Say why fewer stories run than the cap allows: a plan that
          // chains its stories looks exactly like a scheduler that stalled.
          const started = new Set([...current.running, ...launching.map((story) => story.id)])
          const said = launchSummary({
            epicId: plan.epicId,
            running: started.size,
            concurrency,
            ...(context.roster === undefined ? {} : { capacity }),
            readyWaiting: ready.length - launching.length,
            blocked: plan.stories.flatMap((story) =>
              current.done.has(story.id) ||
              current.failed.has(story.id) ||
              current.waiting.has(story.id) ||
              started.has(story.id) ||
              ready.includes(story)
                ? []
                : [
                    {
                      id: story.id,
                      on: story.dependsOn.filter((dependency) => !current.done.has(dependency))
                    }
                  ]
            )
          })
          if (said !== undefined && said !== toldLaunch) {
            yield* events.publish(Info.make({ message: said }))
          }
          toldLaunch = said
        }
        if ((yield* Ref.get(running)).size === 0) {
          break
        }
        // A story waiting only for coder capacity starts as soon as the round
        // grows (an executor back from a cooldown, a health probe, a resume),
        // not when the next running story happens to end.
        const roster = context.roster
        const next: Option.Option<Completion> =
          starvedAt === undefined || roster === undefined
            ? Option.some(yield* Queue.take(completions))
            : yield* Effect.raceFirst(
                Effect.map(Queue.take(completions), Option.some),
                Effect.as(roster.capacityChanged("coder", starvedAt), Option.none<Completion>())
              )
        if (Option.isNone(next)) {
          continue
        }
        const completion = next.value
        yield* Ref.update(running, (set) => {
          const next = new Set(set)
          next.delete(completion.story.id)
          return next
        })
        const reason = completion.outcome.reason ?? "failed"
        if (completion.interruption === "outage" && halted === undefined) {
          if (options.awaitRecovery !== undefined && !recovered.has(completion.story.id)) {
            recovered.add(completion.story.id)
            yield* laneOf(completion.story).publish(
              Info.make({
                message: `story ${completion.story.id}: the serving engine is down; waiting for it to recover, then retrying the story`
              })
            )
            const back = yield* Effect.result(options.awaitRecovery(reason))
            if (back._tag === "Success") {
              // Not recorded: the story is ready again and relaunches.
              continue
            }
            halted = `the serving engine did not recover (${describeFlowError(back.failure)})`
          } else {
            halted = `the serving engine is down: ${reason}`
          }
        }
        if (completion.interruption === "halt" && halted === undefined) {
          halted = reason
        }
        yield* record(completion.outcome)
        const outcome = completion.outcome
        if (outcome.status === "done") {
          yield* board.complete(outcome.id, {
            ...(outcome.branch === undefined ? {} : { branch: outcome.branch }),
            ...(outcome.judge === undefined && outcome.executor === undefined
              ? {}
              : {
                  detail: [
                    outcome.judge,
                    outcome.executor === undefined ? undefined : `coder ${outcome.executor}`
                  ]
                    .filter((part): part is string => part !== undefined)
                    .join(" · ")
                }),
            ...(outcome.estimatedTokens === undefined
              ? {}
              : { estimatedTokens: outcome.estimatedTokens }),
            ...(outcome.estimatedCostUsd === undefined
              ? {}
              : { estimatedCostUsd: outcome.estimatedCostUsd })
          })
        } else {
          yield* board.fail(outcome.id, outcome.reason ?? "failed")
          if (options.failFast === true) {
            return yield* StoryFailed.make({
              story: outcome.id,
              reason: outcome.reason ?? "failed"
            })
          }
          yield* holdDependents(completion.story)
        }
      }
    })
  )

  if (halted !== undefined) {
    const stopped = halted
    yield* events.publish(
      Info.make({ message: `epic ${plan.epicId}: stopped launching stories — ${stopped}` })
    )
    const known = new Set((yield* Ref.get(outcomes)).map((outcome) => outcome.id))
    for (const story of plan.stories) {
      if (known.has(story.id)) {
        continue
      }
      const reason = `not started: ${stopped}`
      yield* record(
        StoryOutcome.make({ id: story.id, title: story.title, status: "waiting", reason })
      )
      yield* board.wait(story.id, reason)
    }
  }

  const recorded = yield* Ref.get(outcomes)
  const ordered = plan.stories.flatMap((story) => {
    const outcome = recorded.find((candidate) => candidate.id === story.id)
    return outcome === undefined ? [] : [outcome]
  })
  const report = EpicReport.make({
    epicId: plan.epicId,
    epicBranch,
    estimated: true,
    stories: ordered
  })
  yield* saveVersioned(
    files,
    join(options.stateDir, "report.json"),
    EpicReportVersion,
    EpicReport,
    report
  )
  yield* files.writeAtomic(join(options.stateDir, "report.md"), renderEpicReport(report))
  return report
})
