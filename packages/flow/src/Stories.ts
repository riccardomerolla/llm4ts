// The parallel story executor (ADR 0013). One story = one worktree on its
// own branch, created only once every predecessor has merged into the epic
// branch; the inner loop is the unchanged `implementPlanFlow`; a story
// merges back only after its judge and perimeter checks pass, and the
// target's gates run on the epic branch after every merge. Scheduling,
// gating, resume and failure policy live here; seats come from `contextFor`.
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { LlmChunk, TokenUsage } from "@llm4ts/core/Models"
import type { LlmError } from "@llm4ts/core/Errors"
import { BoardItem, type BoardSyncShape } from "./BoardSync.ts"
import { makeChat } from "./Chat.ts"
import { implementPlanFlow } from "./Flow.ts"
import type { FlowContextShape } from "./FlowContext.ts"
import {
  describeFlowError,
  EpicCheckoutDirty,
  MissingDependency,
  PerimeterViolation,
  StoryFailed,
  type FlowError
} from "./FlowError.ts"
import { Info } from "./FlowEvents.ts"
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
import { Plan } from "./Plan.ts"
import { stage } from "./PlanExecution.ts"
import { planFrom } from "./Planner.ts"
import { ReviewResult } from "./Review.ts"
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

const join = (root: string, path: string): string =>
  `${root.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`

// ---- Story seats ----------------------------------------------------------

/** A flow context rooted in a story's worktree, plus that story's own usage totals. */
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
  status: StoryStatus
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
  /** ESTIMATES, never measurements (ADR 0012). */
  estimatedTokens: Schema.optionalKey(Schema.Int),
  estimatedCostUsd: Schema.optionalKey(Schema.Number)
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

export const storyPrompt = (story: Story): string =>
  [`Story: ${story.title}`, "", story.description.trim()].join("\n")

export const storyTaskPlanInstructions = (story: Story): string =>
  [
    "You are planning the implementation of ONE story inside a larger epic. Break the story",
    "into an ordered list of small, independently verifiable tasks, each described by its",
    "observable outcome. Every task must stay inside the story's owned paths:",
    bullets(story.owned),
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
  readonly contextFor: (workDir: string) => Effect.Effect<StorySeats, FlowError, Scope.Scope>
  readonly board: BoardSyncShape
  /**
   * Prepares a worktree before its coder runs — a fresh checkout has no
   * installed dependencies, so the gates cannot run there without this.
   * Runs on every start and resume; a failure fails the story.
   */
  readonly setup?: (workDir: string) => Effect.Effect<void, FlowError>
  /** The target's gates, run in a worktree per task and on the epic checkout after each merge. */
  readonly gates: (workDir: string) => Effect.Effect<ReviewResult, FlowError>
  /** Story-level judge over the branch's diff against the epic branch; omit to skip. */
  readonly judge?: (story: Story, diff: string) => Effect.Effect<ReviewResult, FlowError>
  /** Judge attempts, each but the last followed by one coder feedback round. Default 2. */
  readonly judgeRounds?: number
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
   * Second opinion on a BLOCKED_ON claim the plan cannot settle (a path no
   * story owns, or a parallel story's). `real: false` sends the coder back
   * once with the reason. Omit to accept every such claim.
   */
  readonly verifyBlocked?: (
    story: Story,
    need: string,
    workDir: string
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

const issueLines = (result: ReviewResult): string =>
  result.issues.map((issue) => `- ${issue.title}: ${issue.description}`).join("\n")

const failed = (story: Story, reason: string): StoryFailed =>
  StoryFailed.make({ story: story.id, reason })

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
  const statePath = (story: Story): string => join(options.stateDir, `stories/${story.id}.json`)
  const planPath = (story: Story): string => join(options.stateDir, `stories/${story.id}.plan.md`)

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

  yield* epicCheckoutClean()
  yield* stage(events, "epic branch", context.git.checkoutOrCreate(epicBranch))

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
    mergeLock.withPermit(
      Effect.gen(function* () {
        yield* epicCheckoutClean(story)
        const checkpoint = yield* context.git.checkpoint
        yield* context.git.merge(branch, `${plan.epicId}: merge story ${story.id}`)
        const gate = yield* options.gates(context.workDir)
        if (!gate.isClean) {
          // Never leave a red epic head for the next story to inherit.
          yield* context.git.rollback(checkpoint)
          return yield* failed(
            story,
            `epic gates failed after merging; merge undone:\n${issueLines(gate)}`
          )
        }
        yield* events.publish(
          Info.make({ message: `story ${story.id}: merged into ${epicBranch}` })
        )
      })
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
      yield* events.publish(
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
            events.publish(Info.make({ message: `story ${story.id}: ${describeFlowError(error)}` }))
          )
        )
      if (yield* context.git.branchExists(stored.branch)) {
        yield* context.git.deleteBranch(stored.branch)
      }
      // The task checkpoint belongs to the old branch: left in place, the
      // fresh branch would inherit "every task complete" and skip the coder.
      yield* files.remove(planPath(story))
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
        yield* events.publish(
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
    yield* events.publish(Info.make({ message: `story ${story.id}: resuming ${state.branch}` }))
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
      yield* events.publish(
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
    { readonly judge: string | undefined; readonly totals: TokenUsage | undefined },
    FlowError,
    Scope.Scope
  > {
    const seats = yield* options.contextFor(state.worktree)
    const blocked = yield* Ref.make<string | undefined>(undefined)
    const pushbacks = yield* Ref.make(0)
    const storyContext: FlowContextShape = {
      ...seats.context,
      coder: watchForBlockedOn(seats.context.coder, blocked)
    }
    const git = storyContext.git
    const watchedSeats: StorySeats = { ...seats, context: storyContext }
    const extra = options.system === undefined ? undefined : yield* options.system(story)
    const system = [
      perimeterRules(story, { plan, worktree: state.worktree, epicCheckout: context.workDir }),
      extra
    ]
      .filter((part): part is string => part !== undefined && part.trim().length > 0)
      .join("\n\n")
    const prompt = storyPrompt(story)

    // Catch up before setup: the epic may have changed the manifest too.
    yield* catchUp(story, git)
    if (options.setup !== undefined) {
      yield* stage(events, `story ${story.id}: setup`, options.setup(state.worktree))
    }

    // The target's gates plus the perimeter: a stray path is a gate failure
    // the task review loop hands back to the coder before anything commits.
    const gates: Effect.Effect<ReviewResult, FlowError> = Effect.gen(function* () {
      const target = yield* options.gates(state.worktree)
      const changed = yield* perimeterNow(story, git)
      return combined(target, perimeterGate([...changed.sharedReadOnly, ...changed.outside], story))
    })

    const coderTurn = (text: string): Effect.Effect<string, FlowError> =>
      Effect.flatMap(makeChat(storyContext.coder, { system, events, agent: "coder" }), (chat) =>
        chat.ask(text)
      )

    const commitGreen = (message: string, why: string): Effect.Effect<void, FlowError> =>
      Effect.gen(function* () {
        const regated = yield* gates
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
          const verdict = yield* options
            .verifyBlocked(story, need, state.worktree)
            .pipe(Effect.catch(() => Effect.succeed(undefined)))
          rebuttal = verdict === undefined || verdict.real ? undefined : verdict.reason
        }
        if (rebuttal === undefined) {
          return yield* missing
        }
        yield* Ref.set(blocked, undefined)
        yield* Ref.update(pushbacks, (count) => count + 1)
        yield* events.publish(
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
        yield* events.publish(
          Info.make({
            message: `story ${story.id}: restored ${stray.length} path(s) outside its perimeter from ${epicBranch}: ${stray.join(", ")}`
          })
        )
      }
      yield* git.commitAll(`${story.id}: put paths outside the perimeter back`)
    })

    const planTasks = options.planTasks ?? defaultPlanTasks
    const implementTasks = implementPlanFlow(storyContext, {
      store: makePlanStore(files),
      planPath: planPath(story),
      plan: planWithinPerimeter(
        plan,
        story,
        (text) => planTasks(watchedSeats, story, text),
        prompt,
        events
      ),
      system,
      chatPerTask: true,
      checkoutBranch: false,
      lint: gates,
      // A story's final state is judged and gated downstream (judge round,
      // perimeter check, epic gates), so a task the coder finds already
      // satisfied — without saying the exact sentinel — must not sink the
      // story: the option exists for pipelines shaped like this one.
      noopTaskPolicy: "complete",
      ...(options.reviewers === undefined ? {} : { reviewers: options.reviewers }),
      ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds })
    })
    yield* guarded(implementTasks, implementTasks)

    // Other stories may have merged while this one ran: judge the branch
    // against the epic as it is now.
    yield* catchUp(story, git)
    yield* repairPerimeter

    let judgeNote: string | undefined
    if (options.judge !== undefined) {
      const judge = options.judge
      for (let round = 1; round <= judgeRounds; round += 1) {
        const diff = yield* git.diffVsBase(epicBranch)
        if (diff.trim().length === 0) {
          // Nothing to judge is a deterministic failure, not a model call:
          // a model asked to score an empty diff scores the prompt instead.
          return yield* failed(story, "the story branch has no changes against the epic branch")
        }
        const verdict = yield* judge(story, diff)
        if (verdict.isClean) {
          judgeNote = `judge cleared (round ${round})`
          break
        }
        if (round >= judgeRounds) {
          return yield* failed(
            story,
            `judge not cleared after ${judgeRounds} round(s):\n${issueLines(verdict)}`
          )
        }
        yield* guarded(
          coderTurn(
            [
              `The story "${story.title}" scored below the bar. Close these gaps without`,
              "weakening any test and without leaving your owned paths, then stop:",
              issueLines(verdict)
            ].join("\n")
          ),
          Effect.void
        )
        yield* repairPerimeter
        yield* commitGreen("address judge feedback", "while addressing judge feedback")
      }
    }

    const changed = yield* git.changedFilesVsBase(epicBranch)
    yield* enforcePerimeter(changed, story)
    const totals = seats.totals === undefined ? undefined : yield* seats.totals
    return { judge: judgeNote, totals }
  })

  const runStory = Effect.fn("@llm4ts/flow/Stories.runStory")(function* (
    story: Story
  ): Effect.fn.Return<StoryOutcome, FlowError> {
    yield* board.start(story.id)
    const { state, alreadyMerged } = yield* prepareWorktree(story)
    if (alreadyMerged) {
      yield* events.publish(Info.make({ message: `story ${story.id}: already merged; skipping` }))
      return StoryOutcome.make({
        id: story.id,
        title: story.title,
        status: "done",
        branch: state.branch,
        judge: "merged on a previous run"
      })
    }
    const result = yield* Effect.scoped(implementStory(story, state))
    yield* integrate(story, state.branch)
    yield* saveVersioned(
      files,
      statePath(story),
      StoryStateVersion,
      StoryState,
      StoryState.make({ ...state, status: "merged" })
    )
    return StoryOutcome.make({
      id: story.id,
      title: story.title,
      status: "done",
      branch: state.branch,
      ...(result.judge === undefined ? {} : { judge: result.judge }),
      ...(result.totals === undefined ? {} : { estimatedTokens: result.totals.total }),
      ...(result.totals?.costUsd === undefined ? {} : { estimatedCostUsd: result.totals.costUsd })
    })
  })

  /** A story's run as a completion — failures become outcomes, never fiber deaths. */
  const attempt = (story: Story): Effect.Effect<Completion> =>
    stage(events, `story ${story.id}`, runStory(story)).pipe(
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
            error._tag === "EpicCheckoutDirty"
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
  /** Stories retried once after the serving engine recovered. */
  const recovered = new Set<string>()

  yield* Effect.scoped(
    Effect.gen(function* () {
      while (true) {
        if (halted === undefined) {
          const current = yield* progress
          const ready = readyStories(plan, current)
          const slots = concurrency - current.running.size
          for (const story of ready.slice(0, Math.max(0, slots))) {
            yield* Ref.update(running, (set) => new Set([...set, story.id]))
            yield* Effect.forkScoped(
              attempt(story).pipe(
                Effect.flatMap((completion) => Queue.offer(completions, completion))
              )
            )
          }
        }
        if ((yield* Ref.get(running)).size === 0) {
          break
        }
        const completion = yield* Queue.take(completions)
        yield* Ref.update(running, (set) => {
          const next = new Set(set)
          next.delete(completion.story.id)
          return next
        })
        const reason = completion.outcome.reason ?? "failed"
        if (completion.interruption === "outage" && halted === undefined) {
          if (options.awaitRecovery !== undefined && !recovered.has(completion.story.id)) {
            recovered.add(completion.story.id)
            yield* events.publish(
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
            ...(outcome.judge === undefined ? {} : { detail: outcome.judge }),
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
