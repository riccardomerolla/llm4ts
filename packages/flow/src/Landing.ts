// Landing a finished epic (`epic-stories --land`): every story merged into the
// epic branch, the target (main by default) merged INTO the epic branch first
// so conflicts are resolved on the epic side, a coder resolving them in a
// bounded loop with the target's gates as the bar, and only then a merge
// commit on the target. Nothing touches the target until the epic branch is
// green with the target's history in it.
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { makeChat } from "./Chat.ts"
import type { FlowContextShape } from "./FlowContext.ts"
import { EpicCheckoutDirty, EpicIncomplete, LandingFailed, type FlowError } from "./FlowError.ts"
import { Info } from "./FlowEvents.ts"
import { statusPaths } from "./GitTool.ts"
import { loadVersioned, saveVersioned, type PlainFileStoreShape } from "./Persistence.ts"
import type { ReviewResult } from "./Review.ts"
import { StoryState, StoryStateVersion } from "./Stories.ts"
import type { StoryPlan } from "./StoryPlan.ts"

const join = (root: string, path: string): string =>
  `${root.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`

export const EpicLandedVersion = 1

/** Written to the epic's state directory once it lands: listings show it, reruns see it. */
export class EpicLanded extends Schema.Class<EpicLanded>("EpicLanded")({
  target: Schema.String,
  epicBranch: Schema.String
}) {}

export const landedPath = (stateDir: string): string => join(stateDir, "landed.json")

export interface LandOptions {
  readonly plan: StoryPlan
  readonly files: PlainFileStoreShape
  /** The executor's state directory, where each story's state says whether it merged. */
  readonly stateDir: string
  /** Default `epic/<epicId>`. */
  readonly epicBranch?: string
  /** Default `main`. */
  readonly target?: string
  /** The target's gates, run in the epic checkout. */
  readonly gates: (workDir: string) => Effect.Effect<ReviewResult, FlowError>
  /** Who resolves conflicts and red gates. Default: the context's coder. */
  readonly coder?: LlmServiceShape
  /** House rules for the coder. */
  readonly system?: string
  /** Fix rounds before giving up. Default 3. */
  readonly maxRounds?: number
  /** Keep the story worktrees and branches after landing. Default false: they go. */
  readonly keepWorktrees?: boolean
}

export interface LandReport {
  readonly epicBranch: string
  readonly target: string
  /** The target's paths that conflicted with the epic, if any. */
  readonly conflicts: ReadonlyArray<string>
  /** Coder rounds it took (0: clean and green on the first try). */
  readonly rounds: number
  /** Story worktrees removed after landing. */
  readonly removedWorktrees: number
  /** Story branches deleted after landing (each fully merged into the target). */
  readonly deletedBranches: number
}

const markerPattern = /^(<{7} |={7}$|>{7} )/m

const issueLines = (result: ReviewResult): string =>
  result.issues
    .map(
      (issue) =>
        `- ${issue.title}${issue.description.length === 0 ? "" : `: ${issue.description.slice(-1500)}`}`
    )
    .join("\n")

export const landEpic = Effect.fn("@llm4ts/flow/Landing.land")(function* (
  context: FlowContextShape,
  options: LandOptions
): Effect.fn.Return<LandReport, FlowError> {
  const { plan, files } = options
  const git = context.git
  const events = context.events
  const epicBranch = options.epicBranch ?? `epic/${plan.epicId}`
  const target = options.target ?? "main"
  const maxRounds = Math.max(1, options.maxRounds ?? 3)
  const say = (message: string) => events.publish(Info.make({ message: `land: ${message}` }))
  const failed = (reason: string) => LandingFailed.make({ epicBranch, target, reason })

  // 1. Only a finished epic lands.
  const unmerged: Array<string> = []
  for (const story of plan.stories) {
    const state = yield* loadVersioned(
      files,
      join(options.stateDir, `stories/${story.id}.json`),
      StoryStateVersion,
      StoryState
    )
    if (state?.status !== "merged") {
      unmerged.push(story.id)
    }
  }
  if (unmerged.length > 0) {
    return yield* EpicIncomplete.make({ epicId: plan.epicId, stories: unmerged })
  }
  if (!(yield* git.branchExists(target))) {
    return yield* failed(`there is no branch '${target}'`)
  }
  const dirty = statusPaths(yield* git.status)
  if (dirty.length > 0) {
    return yield* EpicCheckoutDirty.make({ checkout: context.workDir, paths: dirty })
  }

  // 2. Bring the target's history into the epic branch, on the epic side.
  yield* git.checkout(epicBranch)
  const before = yield* git.checkpoint
  const behind = !(yield* git.isAncestor(target, epicBranch))
  const conflicts = behind ? yield* git.mergeNoCommit(target) : []
  if (behind) {
    yield* say(
      conflicts.length === 0
        ? `merged ${target} into ${epicBranch} cleanly; checking the gates`
        : `merging ${target} into ${epicBranch} conflicted in ${conflicts.length} file(s): ${conflicts.join(", ")}`
    )
  } else {
    yield* say(`${epicBranch} already contains ${target}; checking the gates`)
  }

  // 3. Conflicts and red gates go to the coder, a bounded number of times.
  const coder = options.coder ?? context.coder
  const chat = yield* makeChat(coder, {
    ...(options.system === undefined ? {} : { system: options.system }),
    events,
    agent: "coder"
  })
  const stories = plan.stories.map((story) => `- ${story.id}: ${story.provides.join("; ")}`)
  let rounds = 0
  while (true) {
    const withMarkers: Array<string> = []
    for (const path of conflicts) {
      const text = yield* files.read(join(context.workDir, path))
      if (text !== undefined && markerPattern.test(text)) {
        withMarkers.push(path)
      }
    }
    const gate = withMarkers.length > 0 ? undefined : yield* options.gates(context.workDir)
    if (withMarkers.length === 0 && gate !== undefined && gate.isClean) {
      break
    }
    if (rounds >= maxRounds) {
      yield* git.rollback(before)
      return yield* failed(
        withMarkers.length > 0
          ? `conflict markers still in ${withMarkers.join(", ")} after ${rounds} round(s)`
          : `the gates are still red after ${rounds} round(s):\n${gate === undefined ? "" : issueLines(gate)}`
      )
    }
    rounds += 1
    yield* say(
      withMarkers.length > 0
        ? `round ${rounds}: asking the coder to resolve ${withMarkers.length} conflicted file(s)`
        : `round ${rounds}: asking the coder to fix ${gate?.issues.length ?? 0} gate failure(s)`
    )
    yield* chat.ask(
      withMarkers.length > 0
        ? [
            `The finished epic "${plan.epic}" (branch ${epicBranch}) is landing on ${target}.`,
            `Merging ${target} into ${epicBranch} left conflicts in these files:`,
            ...withMarkers.map((path) => `- ${path}`),
            "",
            `${target} holds newer mainline work; ${epicBranch} holds the epic's stories, which provide:`,
            ...stories,
            "",
            "Resolve every conflict so both sides' intent survives, remove every conflict marker,",
            "and keep the repository's gates (typecheck, lint, tests, build) green. Do not commit,",
            "do not switch branches, and do not run git merge or git rebase: the flow owns git."
          ].join("\n")
        : [
            `After merging ${target} into ${epicBranch}, the repository's gates fail:`,
            gate === undefined ? "" : issueLines(gate),
            "",
            "Fix them without weakening any test. Do not commit or switch branches."
          ].join("\n")
    )
  }

  // 4. Green with the target's history: record it, then land on the target.
  if (behind) {
    yield* git.commitAll(`${plan.epicId}: merge ${target} into ${epicBranch} before landing`)
  } else if (rounds > 0) {
    yield* git.commitAll(`${plan.epicId}: fix the gates before landing`)
  }
  yield* git.checkout(target)
  yield* git.merge(epicBranch, `${plan.epicId}: land ${epicBranch}`)
  yield* saveVersioned(
    files,
    landedPath(options.stateDir),
    EpicLandedVersion,
    EpicLanded,
    EpicLanded.make({ target, epicBranch })
  )
  yield* say(
    `landed ${epicBranch} on ${target}${rounds === 0 ? "" : ` after ${rounds} fix round(s)`}`
  )

  // 5. The stories' worktrees and branches have done their job: their work
  // is in the target's history. The epic's record (plan, board, report,
  // story states, traces) stays. A worktree with uncommitted work, or a
  // branch not fully merged, is kept and named.
  let removedWorktrees = 0
  let deletedBranches = 0
  if (options.keepWorktrees !== true) {
    const kept: Array<string> = []
    for (const story of plan.stories) {
      const state = yield* loadVersioned(
        files,
        join(options.stateDir, `stories/${story.id}.json`),
        StoryStateVersion,
        StoryState
      )
      if (state === undefined) {
        continue
      }
      if ((yield* files.read(join(state.worktree, ".git"))) !== undefined) {
        const removed = yield* git.removeWorktree(state.worktree).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false))
        )
        if (removed) {
          removedWorktrees += 1
        } else {
          kept.push(`${state.worktree} (uncommitted work)`)
        }
      }
      if (yield* git.branchExists(state.branch)) {
        if (yield* git.isAncestor(state.branch, target)) {
          yield* git.deleteBranch(state.branch)
          deletedBranches += 1
        } else {
          kept.push(`${state.branch} (not merged into ${target})`)
        }
      }
    }
    yield* say(
      `removed ${removedWorktrees} story worktree(s) and deleted ${deletedBranches} merged story branch(es)` +
        (kept.length === 0 ? "" : `; kept: ${kept.join(", ")}`)
    )
  }
  return { epicBranch, target, conflicts, rounds, removedWorktrees, deletedBranches }
})
