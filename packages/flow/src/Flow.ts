import { join } from "node:path"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { collect } from "@llm4ts/core/Streaming"
import { withToolActivity } from "./Activity.ts"
import {
  appendNote,
  findingsIn,
  trailerIn,
  type Trailer,
  findingsRequest,
  withNotes,
  type CarriedNotes
} from "./CarriedNotes.ts"
import { makeChat, type Chat } from "./Chat.ts"
import type { FlowContextShape } from "./FlowContext.ts"
import { FlowAborted, FlowLlmError, type FlowError } from "./FlowError.ts"
import {
  AssistantMessage,
  Info,
  JudgmentObserved,
  publishJudgmentObserved,
  TokensUsed,
  type FlowEventsShape
} from "./FlowEvents.ts"
import type { Plan, Task } from "./Plan.ts"
import type { PlainFileStoreShape, PlanStoreShape } from "./Persistence.ts"
import { ensureBaseline } from "./GateTriage.ts"
import { implementTaskLoop, stage } from "./PlanExecution.ts"
import { truth } from "@llm4ts/core/judgment/Schemas"
import { certaintyOf, decide, judgmentOf, type JudgmentMode } from "./Judgment.ts"
import {
  applyTriage,
  minimalReviewers,
  reviewAndFixLoop,
  withOracle,
  type FixPromptOptions,
  type GateTriageOptions,
  type OracleGateOptions,
  type ReviewResult,
  type ReviewCacheLocation
} from "./Review.ts"
import type { OracleRules } from "./OracleGuard.ts"
import type { Reviewer } from "./Reviewer.ts"
import { withContract } from "./AutonomyContract.ts"

export { publishUsage, structuredAndPublish } from "./Usage.ts"

export const flowReviewer = (context: FlowContextShape): LlmServiceShape =>
  context.reviewers[0] ?? context.reasoning

export const completeAndPublish = Effect.fn("@llm4ts/flow/Flow.completeAndPublish")(function* (
  service: LlmServiceShape,
  events: FlowEventsShape,
  prompt: string
): Effect.fn.Return<string, FlowLlmError> {
  const response = yield* collect(withToolActivity(events, service.executeStream(prompt))).pipe(
    Effect.mapError(FlowLlmError.from)
  )
  if (response.usage !== undefined) {
    yield* events.publish(
      TokensUsed.make({
        agent: "assistant",
        usage: response.usage,
        ...(response.metadata.model === undefined ? {} : { model: response.metadata.model })
      })
    )
  }
  yield* events.publish(AssistantMessage.make({ text: response.content }))
  return response.content
})

export interface ImplementPlanOptions {
  readonly store: PlanStoreShape
  readonly planPath: string
  readonly plan: Effect.Effect<Plan, FlowError>
  readonly system?: string
  /**
   * When true, each task gets a fresh Chat (system prompt plus the plan's
   * current render, showing prior tasks' completion status); that task's
   * review-fix rounds share the same Chat. When false or omitted (default),
   * one Chat is shared across every task in the plan.
   */
  readonly chatPerTask?: boolean
  readonly reviewers?: ReadonlyArray<Reviewer>
  readonly commitMessage?: (plan: Plan, task: Task) => string
  readonly checkoutBranch?: boolean
  readonly maxRounds?: number
  readonly lint?: Effect.Effect<ReviewResult, FlowError>
  readonly format?: Effect.Effect<void, FlowError>
  /** Charge the lint gate only with failures the task caused (ADR 0027). */
  readonly triage?: GateTriageOptions
  /**
   * Without `triage`: record the gates' result on each task's starting
   * commit under this store and triage against it (ADR 0027). The gates run
   * once per new commit, before the task; `lint` is what they are.
   */
  readonly baseline?: {
    readonly files: PlainFileStoreShape
    readonly dir: string
    readonly commands: ReadonlyArray<ReadonlyArray<string>>
    readonly appDir?: string
  }
  /**
   * The oracle guard (ADR 0027 decision 4) over each task's diff: deleted
   * test files, skip or focus markers and a passed-count drop (against the
   * baseline, when both counts are known) fail the round unless
   * `testsChange` is true.
   */
  readonly oracle?: { readonly rules?: OracleRules; readonly testsChange?: boolean }
  /** Independent votes of the adversarial lens per round (ADR 0027 decision 7). Default 1. */
  readonly votes?: number
  /**
   * Who applies review findings (ADR 0027 decision 8): the implementer's own
   * chat (default), or a fresh chat on the coder seat briefed to apply the
   * findings and nothing else, with the carried notes for orientation.
   */
  readonly fixer?: "coder" | "separate"
  /** The repository's own review rules (`.llm4ts/review-rules.md`), loaded by the caller, as one extra lens. */
  readonly repoRules?: Effect.Effect<Reviewer | undefined, FlowError>
  /** How gate output reaches the coder in the fix prompt. */
  readonly fix?: FixPromptOptions
  /** Where each review lens's answer is kept, so a rerun over the same diff asks nothing. */
  readonly reviewCache?: ReviewCacheLocation
  /** Told after every review round of every task, settled or not. */
  readonly onReview?: (
    task: Task,
    round: number,
    result: ReviewResult,
    settled: boolean
  ) => Effect.Effect<void, FlowError>
  /**
   * What to do when a task produces no file changes and the coder does not
   * confirm TASK_ALREADY_SATISFIED. "fail" (default) aborts the flow —
   * the safe reading when nothing downstream re-checks the work. "complete"
   * marks the task complete with an Info notice — for pipelines whose final
   * state is judged downstream anyway (a CI gate, a fresh-context review),
   * where one unconfirmed no-op should not sink otherwise-finished work.
   */
  readonly noopTaskPolicy?: "fail" | "complete"
  /**
   * How the "already satisfied" confirmation is read (ADR 0017): "literal"
   * (default) looks for TASK_ALREADY_SATISFIED without any judgment call.
   * { mode } asks the run's judgment service, defaulting to observe: observe
   * and advise publish the literal outcome and keep using it. Explicit act
   * uses a confident judgment, falling back to the literal reading on doubt
   * or failure. The legacy "judgment" string remains an alias for { mode: "act" }.
   */
  readonly satisfiedProbe?: "literal" | "judgment" | { readonly mode?: JudgmentMode }
  /**
   * Notes carried from one task to the next (meant for `chatPerTask`, where
   * every task starts cold): the accumulated notes open each task's prompt,
   * the task is asked to end with a Findings section, and what it reports is
   * appended. Omit to carry nothing.
   */
  readonly carry?: CarriedNotes
  /**
   * Called with every task's final reply and its parsed trailer, after the
   * findings are kept (ADR 0027 decision 6): the caller checks the
   * `verified:` claims against what actually ran.
   */
  readonly onTaskReply?: (
    task: Task,
    reply: string,
    trailer: Trailer,
    startedAt: number
  ) => Effect.Effect<void, FlowError>
}

/** The judgment form of the empty-diff probe: one Truth question over the coder's reply. */
export const satisfiedByJudgment = Effect.fn("@llm4ts/flow/Flow.satisfiedByJudgment")(function* (
  context: FlowContextShape,
  taskTitle: string,
  reply: string,
  mode: JudgmentMode = "observe"
): Effect.fn.Return<boolean | undefined> {
  const literalMatch = reply.includes("TASK_ALREADY_SATISFIED")
  const judgment = judgmentOf(context)
  const state = { task: taskTitle, reply }
  const question = truth(
    "The reply states that the task is already fully satisfied by the current repository and that no change was made."
  )
  const result = yield* judgment
    .judge({ state, questions: { satisfied: question } })
    .pipe(Effect.option)
  if (result._tag === "None") {
    return mode === "act" ? undefined : literalMatch
  }
  const answer = result.value.answers["satisfied"]
  if (answer === undefined || answer.type !== "truth") {
    return mode === "act" ? undefined : literalMatch
  }
  const decision = decide(answer)
  if (mode !== "act") {
    yield* publishJudgmentObserved(
      context.events,
      JudgmentObserved.make({
        consumer: "satisfied-probe",
        key: "satisfied",
        state,
        question,
        answer,
        judgmentIdentity: judgment.identity,
        decision,
        certainty: certaintyOf(answer),
        support: answer.support,
        origin: answer.origin,
        outcome: { _tag: "SatisfiedProbe", literalMatch },
        mode
      })
    )
    return literalMatch
  }
  if (decision !== "act") return undefined
  return answer.truth >= 0.5
})

const defaultCommitMessage = (plan: Plan, task: Task): string => `${plan.epicId}: ${task.title}`

const composeSystem = (base: string | undefined, note: string): string =>
  [base, note].filter((part): part is string => part !== undefined && part.length > 0).join("\n\n")

/** The separate fixer's brief (ADR 0027 decision 8): the Bun port's fixer, word for word in spirit. */
export const fixerBrief = [
  "You apply review findings to a change another coder made. Apply the findings. Nothing else.",
  "Surgical edits only: no refactors, no extras, no new tests beyond what a finding asks for.",
  "If a finding is wrong (the reviewer misread the code), skip it and say so in one line.",
  "Then stop."
].join("\n")

/**
 * The task's triage: the explicit one, or one built from `baseline` over the
 * commit the task starts from (HEAD now), or none.
 */
const triageFor = (
  context: FlowContextShape,
  options: ImplementPlanOptions
): Effect.Effect<GateTriageOptions | undefined, FlowError> =>
  Effect.gen(function* () {
    if (options.triage !== undefined) {
      return options.triage
    }
    if (options.baseline === undefined || options.lint === undefined) {
      return undefined
    }
    const base = options.baseline
    const appDir = base.appDir ?? "."
    const roots = [join(context.workDir, appDir), context.workDir]
    const commit = yield* context.git.checkpoint
    return {
      baseline: ensureBaseline({
        files: base.files,
        stateDir: base.dir,
        commit,
        appDir,
        commands: base.commands,
        run: options.lint,
        roots,
        now: Clock.currentTimeMillis
      }),
      roots
    }
  })

export const implementPlanFlow = Effect.fn("@llm4ts/flow/Flow.implementPlan")(function* (
  context: FlowContextShape,
  options: ImplementPlanOptions
): Effect.fn.Return<Plan, FlowError> {
  const plan = yield* options.store.recoverOrCreate(options.planPath, options.plan)
  if (options.checkoutBranch !== false) {
    yield* stage(context.events, "branch", context.git.checkoutOrCreate(plan.epicId))
  }
  let sharedCoder: Chat | undefined
  if (options.chatPerTask !== true) {
    sharedCoder = yield* makeChat(context.coder, {
      events: context.events,
      agent: "coder",
      ...(options.system === undefined ? {} : { system: options.system })
    })
  }

  return yield* implementTaskLoop(
    options.store,
    context.events,
    options.planPath,
    plan,
    (task, planSoFar) =>
      Effect.gen(function* () {
        // `sharedCoder`'s definedness mirrors `options.chatPerTask !== true`
        // above: when it's set, every task reuses it; when it's undefined,
        // chatPerTask is active and each task builds its own fresh Chat.
        let coder: Chat
        if (sharedCoder !== undefined) {
          coder = sharedCoder
        } else {
          coder = yield* makeChat(context.coder, {
            events: context.events,
            agent: "coder",
            system: composeSystem(options.system, planSoFar.render)
          })
        }
        // `plan.taskPrompt` deliberately reads the frozen `plan` captured at
        // the top of this function: a task prompt only needs that task's own
        // details. `planSoFar`, threaded through by implementTaskLoop, is the
        // single source of truth for completion progress instead.
        const notes = options.carry === undefined ? undefined : yield* options.carry.read
        const taskStartedAt = yield* Clock.currentTimeMillis
        /** What the task's reply learned goes to the carried notes, whichever turn did the work. */
        const keepFindings = (reply: string): Effect.Effect<void, FlowError> =>
          Effect.gen(function* () {
            const found = findingsIn(reply)
            if (options.carry !== undefined && found !== undefined) {
              yield* options.carry.write(appendNote(notes, task.title, found))
            }
            if (options.onTaskReply !== undefined) {
              yield* options.onTaskReply(task, reply, trailerIn(found), taskStartedAt)
            }
          })
        yield* keepFindings(
          yield* coder.ask(
            options.carry === undefined
              ? plan.taskPrompt(task)
              : `${withNotes(plan.taskPrompt(task), notes)}\n${findingsRequest}`
          )
        )
        const produced = yield* context.git.diffAll
        if (produced.trim().length === 0) {
          // An empty diff is ambiguous: the task may be genuinely satisfied
          // already, or the coder may simply have produced nothing. Ask
          // explicitly instead of inferring from absence; a task that
          // produces no changes and no confirmation fails rather than being
          // silently marked complete.
          const confirmation = yield* coder.ask(
            [
              "Your previous turn produced no file changes.",
              `If the task "${task.title}" is already fully satisfied by the current state of the repository, reply with exactly TASK_ALREADY_SATISFIED and nothing else.`,
              "Otherwise, implement the task now."
            ].join("\n")
          )
          yield* keepFindings(confirmation)
          const afterConfirmation = yield* context.git.diffAll
          if (afterConfirmation.trim().length === 0) {
            const judged =
              options.satisfiedProbe !== undefined && options.satisfiedProbe !== "literal"
                ? yield* satisfiedByJudgment(
                    context,
                    task.title,
                    confirmation,
                    options.satisfiedProbe === "judgment" ? "act" : options.satisfiedProbe.mode
                  )
                : undefined
            if (judged ?? confirmation.includes("TASK_ALREADY_SATISFIED")) {
              yield* context.events.publish(
                Info.make({
                  message: `task "${task.title}" confirmed already satisfied; skipping review and commit`
                })
              )
              return
            }
            if (options.noopTaskPolicy === "complete") {
              yield* context.events.publish(
                Info.make({
                  message: `task "${task.title}" produced no changes without confirming TASK_ALREADY_SATISFIED; marking complete per noopTaskPolicy`
                })
              )
              return
            }
            return yield* FlowAborted.make({
              message: `task "${task.title}" produced no changes and did not confirm TASK_ALREADY_SATISFIED; failing instead of marking it complete`
            })
          }
        }
        const triage = yield* triageFor(context, options)
        const repoRules = options.repoRules === undefined ? undefined : yield* options.repoRules
        const reviewers = [
          ...(options.reviewers ?? minimalReviewers),
          ...(repoRules === undefined ? [] : [repoRules])
        ]
        const fixWith =
          options.fixer === "separate"
            ? (prompt: string): Effect.Effect<string, FlowError> =>
                Effect.flatMap(
                  makeChat(context.coder, {
                    events: context.events,
                    agent: "coder",
                    system: withContract(fixerBrief)
                  }),
                  (fixer) => fixer.ask(withNotes(prompt, notes))
                )
            : undefined
        const oracle: OracleGateOptions | undefined =
          options.oracle === undefined
            ? undefined
            : {
                diff: context.git.diffAll,
                ...(options.oracle.rules === undefined ? {} : { rules: options.oracle.rules }),
                ...(options.oracle.testsChange === undefined
                  ? {}
                  : { declared: options.oracle.testsChange }),
                ...(triage === undefined
                  ? {}
                  : { baseCount: Effect.map(triage.baseline, (base) => base?.passedCount) })
              }
        yield* reviewAndFixLoop({
          reviewers,
          reviewerService: flowReviewer(context),
          coder,
          taskTitle: task.title,
          currentDiff: context.git.diffAll,
          events: context.events,
          ...(options.maxRounds === undefined ? {} : { maxRounds: options.maxRounds }),
          ...(options.lint === undefined ? {} : { lint: options.lint }),
          ...(options.format === undefined ? {} : { format: options.format }),
          ...(triage === undefined ? {} : { triage }),
          ...(oracle === undefined ? {} : { oracle }),
          ...(options.votes === undefined ? {} : { votes: options.votes }),
          ...(fixWith === undefined ? {} : { fixWith }),
          ...(options.fix === undefined ? {} : { fix: options.fix }),
          ...(options.reviewCache === undefined ? {} : { cache: options.reviewCache }),
          ...(options.onReview === undefined
            ? {}
            : {
                onRound: (round: number, result: ReviewResult, settled: boolean) =>
                  options.onReview === undefined
                    ? Effect.void
                    : options.onReview(task, round, result, settled)
              })
        })
        if (options.lint !== undefined) {
          const reported = yield* Ref.make<ReadonlySet<string>>(new Set())
          const gate = yield* withOracle(
            yield* applyTriage(yield* options.lint, triage, context.events, reported),
            oracle,
            context.events,
            yield* Ref.make(true)
          )
          if (!gate.isClean) {
            return yield* FlowAborted.make({
              message: [
                `task "${task.title}": the lint gate is still failing after review settled; refusing to commit`,
                ...gate.issues.map((issue) => {
                  const detail =
                    issue.description.length === 0 ? "" : `\n${issue.description.slice(-2000)}`
                  return `- [${issue.severity}] ${issue.title}${detail}`
                })
              ].join("\n")
            })
          }
        }
        yield* context.git.commitAll((options.commitMessage ?? defaultCommitMessage)(plan, task))
      })
  )
})
