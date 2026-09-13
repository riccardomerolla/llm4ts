// The parallel story executor (ADR 0013). One story = one worktree on its
// own branch, created only once every predecessor has merged into the epic
// branch; the inner loop is the unchanged `implementPlanFlow`; a story
// merges back only after its judge and perimeter checks pass, and the
// target's gates run on the epic branch after every merge. Scheduling,
// gating, resume and failure policy live here; seats come from `contextFor`.
import * as Effect from "effect/Effect"
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
import { describeFlowError, MissingDependency, StoryFailed, type FlowError } from "./FlowError.ts"
import { Info } from "./FlowEvents.ts"
import { enforcePerimeter } from "./Perimeter.ts"
import {
  loadVersioned,
  makePlanStore,
  saveVersioned,
  type PlainFileStoreShape
} from "./Persistence.ts"
import type { Plan } from "./Plan.ts"
import { stage } from "./PlanExecution.ts"
import { planFrom } from "./Planner.ts"
import type { ReviewResult } from "./Review.ts"
import type { Reviewer } from "./Reviewer.ts"
import {
  dependentsOf,
  readyStories,
  storyHash,
  topologicalWaves,
  validateStoryPlan,
  type Story,
  type StoryPlan
} from "./StoryPlan.ts"

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

export const OutcomeStatus = Schema.Literals(["done", "failed", "skipped"])
export type OutcomeStatus = typeof OutcomeStatus.Type

export class StoryOutcome extends Schema.Class<StoryOutcome>("StoryOutcome")({
  id: Schema.String,
  title: Schema.String,
  status: OutcomeStatus,
  branch: Schema.optionalKey(Schema.String),
  /** Failure or skip reason. */
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
    `- Stories: ${report.stories.length} (done ${report.count("done")}, failed ${report.count("failed")}, skipped ${report.count("skipped")})`,
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

/** The hard rules every story coder receives; the perimeter check enforces them afterwards. */
export const perimeterRules = (story: Story): string =>
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
    "observable outcome. Every task must stay inside the story's owned paths.",
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
}

interface Completion {
  readonly story: Story
  readonly outcome: StoryOutcome
}

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
    // `.git` FILE at its root, which is how its presence is checked).
    const marker = yield* files.read(join(stored.worktree, ".git"))
    if (marker === undefined) {
      yield* context.git.addWorktree(stored.worktree, stored.branch)
    }
    yield* events.publish(Info.make({ message: `story ${story.id}: resuming ${stored.branch}` }))
    return { state: stored, alreadyMerged: false }
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
    const storyContext: FlowContextShape = {
      ...seats.context,
      coder: watchForBlockedOn(seats.context.coder, blocked)
    }
    const watchedSeats: StorySeats = { ...seats, context: storyContext }
    const extra = options.system === undefined ? undefined : yield* options.system(story)
    const system = [perimeterRules(story), extra]
      .filter((part): part is string => part !== undefined && part.trim().length > 0)
      .join("\n\n")
    const prompt = storyPrompt(story)
    const blockedOr = <A>(effect: Effect.Effect<A, FlowError>): Effect.Effect<A, FlowError> =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.flatMap(Ref.get(blocked), (need) =>
            need === undefined
              ? Effect.fail(error)
              : Effect.fail(MissingDependency.make({ story: story.id, need }))
          )
        ),
        Effect.tap(() =>
          Effect.flatMap(Ref.get(blocked), (need) =>
            need === undefined
              ? Effect.void
              : Effect.fail(MissingDependency.make({ story: story.id, need }))
          )
        )
      )

    yield* blockedOr(
      implementPlanFlow(storyContext, {
        store: makePlanStore(files),
        planPath: planPath(story),
        plan: (options.planTasks ?? defaultPlanTasks)(watchedSeats, story, prompt),
        system,
        chatPerTask: true,
        checkoutBranch: false,
        lint: options.gates(state.worktree),
        ...(options.reviewers === undefined ? {} : { reviewers: options.reviewers }),
        ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds })
      })
    )

    let judgeNote: string | undefined
    if (options.judge !== undefined) {
      const judge = options.judge
      for (let round = 1; round <= judgeRounds; round += 1) {
        const diff = yield* storyContext.git.diffVsBase(epicBranch)
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
        const feedback = yield* makeChat(storyContext.coder, {
          system,
          events,
          agent: "coder"
        })
        yield* blockedOr(
          feedback.ask(
            [
              `The story "${story.title}" scored below the bar. Close these gaps without`,
              "weakening any test and without leaving your owned paths, then stop:",
              issueLines(verdict)
            ].join("\n")
          )
        )
        const regated = yield* options.gates(state.worktree)
        if (!regated.isClean) {
          return yield* failed(
            story,
            `gates broke while addressing judge feedback:\n${issueLines(regated)}`
          )
        }
        yield* storyContext.git.commitAll(`${story.id}: address judge feedback`)
      }
    }

    const changed = yield* storyContext.git.changedFilesVsBase(epicBranch)
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
    if (options.setup !== undefined) {
      yield* stage(events, `story ${story.id}: setup`, options.setup(state.worktree))
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
          return {
            story,
            outcome: StoryOutcome.make({
              id: story.id,
              title: story.title,
              status: "failed",
              reason,
              ...(stored === undefined ? {} : { branch: stored.branch })
            })
          }
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
      skipped: byStatus("skipped"),
      running: yield* Ref.get(running)
    }
  })

  const record = (outcome: StoryOutcome): Effect.Effect<void> =>
    Ref.update(outcomes, (current) => [...current, outcome])

  const skipDependents = (story: Story): Effect.Effect<void, FlowError> =>
    Effect.gen(function* () {
      const current = yield* progress
      for (const id of dependentsOf(plan, story.id)) {
        const dependent = plan.story(id)
        if (
          dependent === undefined ||
          current.done.has(id) ||
          current.failed.has(id) ||
          current.skipped.has(id)
        ) {
          continue
        }
        const reason = `blocked by ${story.id}`
        yield* record(StoryOutcome.make({ id, title: dependent.title, status: "skipped", reason }))
        yield* board.skip(id, reason)
      }
    })

  yield* Effect.scoped(
    Effect.gen(function* () {
      while (true) {
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
        if ((yield* Ref.get(running)).size === 0) {
          break
        }
        const completion = yield* Queue.take(completions)
        yield* Ref.update(running, (set) => {
          const next = new Set(set)
          next.delete(completion.story.id)
          return next
        })
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
          yield* skipDependents(completion.story)
        }
      }
    })
  )

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
