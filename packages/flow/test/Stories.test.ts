import { assert, describe, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { ConnectorCapabilities, LlmChunk, TokenUsage } from "@llm4ts/core/Models"
import { makeLocalBoardSync, type BoardStatus } from "@llm4ts/flow/BoardSync"
import type { FlowContextShape } from "@llm4ts/flow/FlowContext"
import { FlowAborted, MergeConflict, type FlowError } from "@llm4ts/flow/FlowError"
import { makeFlowEventHub } from "@llm4ts/flow/FlowEvents"
import { Committed, type GitToolShape } from "@llm4ts/flow/GitTool"
import type { GitHubToolShape } from "@llm4ts/flow/GitHubTool"
import { makeMemoryPlainFileStore, saveVersioned } from "@llm4ts/flow/Persistence"
import { Plan, Task } from "@llm4ts/flow/Plan"
import { ReviewIssue, ReviewResult } from "@llm4ts/flow/Review"
import {
  StoryState,
  StoryStateVersion,
  blockedOnIn,
  implementStoriesFlow,
  renderEpicReport,
  type StoriesOptions,
  type StorySeats
} from "@llm4ts/flow/Stories"
import { Story, StoryPlan, storyHash } from "@llm4ts/flow/StoryPlan"

// ---- Fakes -------------------------------------------------------------------

const unused = InvalidRequestError.make({ message: "unused in test" })
const unusedFlow: Effect.Effect<never, FlowError> = Effect.fail(
  FlowAborted.make({ message: "unused in test" })
)

const clean = ReviewResult.make({ issues: [], summary: "clean" })
const red = (title: string): ReviewResult =>
  ReviewResult.make({
    issues: [ReviewIssue.make({ severity: "Critical", title, description: "" })],
    summary: "red"
  })

/** A coder that replies `reply` to every chat turn. */
const coder = (reply: string): LlmServiceShape => ({
  executeStream: (_prompt) => Stream.make(LlmChunk.make({ delta: reply, finishReason: "stop" })),
  executeStreamWithHistory: (_messages) =>
    Stream.make(LlmChunk.make({ delta: reply, finishReason: "stop" })),
  executeWithTools: (_prompt, _tools) => Effect.fail(unused),
  executeStructured: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  isAvailable: Effect.succeed(true)
})

/** A reasoning seat whose structured answers are always the clean review. */
const cleanReviewer: LlmServiceShape = {
  executeStream: (_prompt) => Stream.empty,
  executeStreamWithHistory: (_messages) => Stream.empty,
  executeWithTools: (_prompt, _tools) => Effect.fail(unused),
  executeStructured: (_prompt, schema, _jsonSchema) =>
    Schema.decodeUnknownEffect(schema)({ issues: [], summary: "clean" }).pipe(Effect.orDie),
  executeStructuredWithUsage: (_prompt, schema, _jsonSchema) =>
    Schema.decodeUnknownEffect(schema)({ issues: [], summary: "clean" }).pipe(
      Effect.orDie,
      Effect.map((value) => [value, undefined, undefined] as const)
    ),
  isAvailable: Effect.succeed(true)
}

const hosting: GitHubToolShape = {
  createPr: () => unusedFlow,
  readIssue: () => unusedFlow,
  readIssueComments: () => unusedFlow,
  writeIssueComment: () => unusedFlow,
  editIssueComment: () => unusedFlow,
  writePrComment: () => unusedFlow,
  updatePr: () => unusedFlow,
  prChecks: () => unusedFlow,
  viewOpenPr: unusedFlow,
  mergePr: () => unusedFlow,
  listIssues: () => unusedFlow,
  createIssue: () => unusedFlow,
  editIssueLabels: () => unusedFlow,
  assignIssue: () => unusedFlow,
  closeIssue: () => unusedFlow
}

interface Harness {
  /** Every notable git and lifecycle step, in order. */
  readonly log: Ref.Ref<ReadonlyArray<string>>
  /** Branches known to the epic checkout. */
  readonly branches: Ref.Ref<ReadonlySet<string>>
  /** Story branches whose merge conflicts. */
  readonly conflicting: ReadonlySet<string>
  /** Directories whose gates fail (a worktree or the epic checkout). */
  readonly redGates: Ref.Ref<ReadonlySet<string>>
  /** Changed files a story's worktree reports vs the epic branch. */
  readonly changedFor: (story: Story) => ReadonlyArray<string>
  /** What the coder replies inside a given worktree. */
  readonly replyFor: (workDir: string) => string
  /** Latches a story's seats wait on before implementing; absent = no wait. */
  readonly latches: ReadonlyMap<string, Deferred.Deferred<void>>
}

const record = (harness: Harness, entry: string): Effect.Effect<void> =>
  Ref.update(harness.log, (current) => [...current, entry])

const baseGit: GitToolShape = {
  init: Effect.void,
  initBare: Effect.void,
  config: () => Effect.void,
  status: Effect.succeed(""),
  currentBranch: Effect.succeed("main"),
  diff: Effect.succeed(""),
  diffAll: Effect.succeed("diff --git a/file b/file\n+new content"),
  defaultBase: Effect.succeed("main"),
  diffVsBase: () => Effect.succeed("diff --git a/file b/file\n+story work"),
  diffVsBaseScoped: () => Effect.succeed(""),
  changedFilesVsBase: () => Effect.succeed([]),
  addRemote: () => Effect.void,
  checkout: () => Effect.void,
  checkoutOrCreate: () => Effect.void,
  createBranch: () => unusedFlow,
  commitAll: () => Effect.succeed(Committed.make({})),
  commitPaths: () => Effect.succeed(Committed.make({})),
  push: () => Effect.void,
  checkpoint: Effect.succeed("checkpoint"),
  rollback: () => Effect.void,
  addWorktree: () => Effect.void,
  addWorktreeNewBranch: () => Effect.void,
  removeWorktree: () => Effect.void,
  branchExists: () => Effect.succeed(false),
  deleteBranch: () => Effect.void,
  isAncestor: () => Effect.succeed(false),
  merge: () => Effect.void
}

/** The epic checkout's git: branches, worktrees, merges, rollbacks are logged. */
const epicGit = (harness: Harness): GitToolShape => ({
  ...baseGit,
  checkoutOrCreate: (name) => record(harness, `checkout:${name}`),
  addWorktreeNewBranch: (path, branch, start) =>
    Ref.update(harness.branches, (set) => new Set([...set, branch])).pipe(
      Effect.andThen(record(harness, `worktree-new:${branch}@${start}->${path}`))
    ),
  addWorktree: (path, branch) => record(harness, `worktree-existing:${branch}->${path}`),
  removeWorktree: (path, force) =>
    record(harness, `worktree-remove:${path}${force ? ":force" : ""}`),
  branchExists: (name) => Effect.map(Ref.get(harness.branches), (set) => set.has(name)),
  deleteBranch: (name) =>
    Ref.update(harness.branches, (set) => {
      const next = new Set(set)
      next.delete(name)
      return next
    }).pipe(Effect.andThen(record(harness, `branch-delete:${name}`))),
  merge: (branch, _message) =>
    harness.conflicting.has(branch)
      ? Effect.fail(MergeConflict.make({ branch, into: "epic", paths: ["src/App.tsx"] }))
      : record(harness, `merge:${branch}`),
  rollback: (checkpoint) => record(harness, `rollback:${checkpoint}`)
})

/** A story worktree's git: commits are logged per directory. */
const worktreeGit = (harness: Harness, workDir: string, story: Story): GitToolShape => ({
  ...baseGit,
  commitAll: (message) =>
    record(harness, `commit:${workDir}:${message}`).pipe(Effect.as(Committed.make({}))),
  changedFilesVsBase: () => Effect.succeed(harness.changedFor(story))
})

const storyOf = (plan: StoryPlan, workDir: string): Story => {
  const id = workDir.split("/").at(-1) ?? ""
  const found = plan.story(id)
  if (found === undefined) {
    throw new Error(`no story for worktree ${workDir}`)
  }
  return found
}

const memories = new WeakMap<StoriesOptions, Effect.Effect<Readonly<Record<string, string>>>>()
const memoryFilesOf = (options: StoriesOptions): Effect.Effect<Readonly<Record<string, string>>> =>
  memories.get(options) ?? Effect.succeed({})

const makeOptions = (
  harness: Harness,
  plan: StoryPlan,
  context: FlowContextShape,
  overrides: Partial<StoriesOptions> = {}
): Effect.Effect<StoriesOptions> =>
  Effect.gen(function* () {
    const memory = yield* makeMemoryPlainFileStore()
    const built: StoriesOptions = {
      plan,
      files: memory.store,
      stateDir: "/repo/.llm4ts/epics/" + plan.epicId,
      worktreeRoot: "/repo/.llm4ts/worktrees",
      board: makeLocalBoardSync(memory.store, "/repo/.llm4ts/epics/" + plan.epicId, plan.epicId),
      contextFor: (workDir) =>
        Effect.gen(function* () {
          const story = storyOf(plan, workDir)
          yield* record(harness, `seats:${story.id}`)
          const latch = harness.latches.get(story.id)
          if (latch !== undefined) {
            yield* Deferred.await(latch)
          }
          const seats: StorySeats = {
            context: {
              ...context,
              coder: coder(harness.replyFor(workDir)),
              git: worktreeGit(harness, workDir, story),
              workDir
            },
            totals: Effect.succeed(
              TokenUsage.make({ prompt: 100, completion: 20, total: 120, costUsd: 0.01 })
            )
          }
          return seats
        }),
      gates: (workDir) =>
        Effect.map(Ref.get(harness.redGates), (set) =>
          set.has(workDir) ? red(`gates failed in ${workDir}`) : clean
        ),
      planTasks: (_seats, story, _prompt) =>
        Effect.succeed(
          Plan.make({
            epicId: story.id,
            tasks: [Task.make({ title: `${story.id} task`, description: story.description })]
          })
        ),
      ...overrides
    }
    memories.set(built, memory.files)
    return built
  })

const makeHarness = (
  overrides: Partial<Omit<Harness, "log" | "branches" | "redGates">> & {
    readonly redGates?: ReadonlyArray<string>
  } = {}
): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    const log = yield* Ref.make<ReadonlyArray<string>>([])
    const branches = yield* Ref.make<ReadonlySet<string>>(new Set())
    const redGates = yield* Ref.make<ReadonlySet<string>>(new Set(overrides.redGates ?? []))
    return {
      log,
      branches,
      redGates,
      conflicting: overrides.conflicting ?? new Set(),
      changedFor: overrides.changedFor ?? ((story) => [`${story.owned[0] ?? ""}/index.ts`]),
      replyFor: overrides.replyFor ?? (() => "done"),
      latches: overrides.latches ?? new Map()
    }
  })

const makeContext = (harness: Harness) =>
  Effect.map(
    makeFlowEventHub(),
    (events): FlowContextShape => ({
      reasoning: cleanReviewer,
      coder: coder("done"),
      git: epicGit(harness),
      hosting,
      events,
      reviewers: [cleanReviewer],
      coderCapabilities: ConnectorCapabilities.make({}),
      userPrompt: "epic",
      workDir: "/repo",
      workspace: "/repo"
    })
  )

const story = (id: string, dependsOn: ReadonlyArray<string> = []): Story =>
  Story.make({
    id,
    title: `Story ${id}`,
    description: `Implement ${id}.`,
    dependsOn,
    owned: [`src/features/${id}`],
    sharedReadOnly: ["src/kit"],
    provides: [`route /${id}`]
  })

// a and b independent, c needs a, d needs b and c (the fan-in).
const diamond = StoryPlan.make({
  epicId: "diamond",
  epic: "A diamond of four stories.",
  stories: [story("a"), story("b"), story("c", ["a"]), story("d", ["b", "c"])]
})

const statusOf = (
  options: StoriesOptions
): Effect.Effect<ReadonlyMap<string, BoardStatus>, FlowError> =>
  Effect.map(
    options.board.snapshot,
    (board) => new Map(board.items.map((item) => [item.id, item.status] as const))
  )

/** Spin the cooperative scheduler until `condition` holds, or give up loudly. */
const settle = (
  condition: Effect.Effect<boolean, FlowError>,
  what: string
): Effect.Effect<void, FlowError> =>
  Effect.gen(function* () {
    for (let round = 0; round < 500; round += 1) {
      if (yield* condition) {
        return
      }
      yield* Effect.yieldNow
    }
    return yield* FlowAborted.make({ message: `never settled: ${what}` })
  })

// ---- Tests --------------------------------------------------------------------

describe("Stories executor", () => {
  it.effect("merges every story in dependency order and reports estimates", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const context = yield* makeContext(harness)
      const options = yield* makeOptions(harness, diamond, context)

      const report = yield* implementStoriesFlow(context, options)

      assert.strictEqual(report.epicBranch, "epic/diamond")
      assert.isTrue(report.estimated)
      assert.deepStrictEqual(
        report.stories.map((outcome) => [outcome.id, outcome.status]),
        [
          ["a", "done"],
          ["b", "done"],
          ["c", "done"],
          ["d", "done"]
        ]
      )
      assert.strictEqual(report.stories[0]?.estimatedTokens, 120)
      assert.strictEqual(report.stories[0]?.branch, "story/diamond/a")

      const log = yield* Ref.get(harness.log)
      const at = (entry: string): number => log.indexOf(entry)
      assert.strictEqual(log[0], "checkout:epic/diamond")
      // A dependent's worktree is created only after its predecessors merged.
      assert.isAbove(
        at("worktree-new:story/diamond/c@epic/diamond->/repo/.llm4ts/worktrees/c"),
        at("merge:story/diamond/a")
      )
      assert.isAbove(
        at("worktree-new:story/diamond/d@epic/diamond->/repo/.llm4ts/worktrees/d"),
        at("merge:story/diamond/b")
      )
      assert.isAbove(
        at("worktree-new:story/diamond/d@epic/diamond->/repo/.llm4ts/worktrees/d"),
        at("merge:story/diamond/c")
      )
      assert.include(log, "commit:/repo/.llm4ts/worktrees/a:a: a task")

      const statuses = yield* statusOf(options)
      assert.deepStrictEqual([...statuses.values()], ["done", "done", "done", "done"])

      const markdown = renderEpicReport(report)
      assert.include(markdown, "ESTIMATES")
      assert.include(markdown, "| a | done | `story/diamond/a` | ~120 | ~$0.01 |")
      assert.include(markdown, "- Estimated tokens: ~480")
    })
  )

  it.effect(
    "respects the concurrency cap and starts a dependent only after its predecessors merged",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const latchA = yield* Deferred.make<void>()
          const latchB = yield* Deferred.make<void>()
          const harness = yield* makeHarness({
            latches: new Map([
              ["a", latchA],
              ["b", latchB]
            ])
          })
          const context = yield* makeContext(harness)
          const options = yield* makeOptions(harness, diamond, context, { concurrency: 2 })

          const fiber = yield* Effect.forkScoped(implementStoriesFlow(context, options))

          yield* settle(
            Effect.map(
              statusOf(options),
              (status) => status.get("a") === "active" && status.get("b") === "active"
            ),
            "a and b active"
          )
          const early = yield* statusOf(options)
          assert.strictEqual(early.get("c"), "planned")
          assert.strictEqual(early.get("d"), "planned")

          yield* Deferred.succeed(latchA, undefined)
          yield* settle(
            Effect.map(statusOf(options), (status) => status.get("c") === "active"),
            "c active"
          )
          const mid = yield* statusOf(options)
          assert.strictEqual(mid.get("a"), "done")
          assert.strictEqual(mid.get("b"), "active")
          // d needs b, still running under its latch.
          assert.strictEqual(mid.get("d"), "planned")

          yield* Deferred.succeed(latchB, undefined)
          const report = yield* Fiber.join(fiber)
          assert.strictEqual(report.count("done"), 4)
        })
      )
  )

  it.effect(
    "a failed story puts its transitive dependents on hold and independent stories finish",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ redGates: ["/repo/.llm4ts/worktrees/a"] })
        const context = yield* makeContext(harness)
        const options = yield* makeOptions(harness, diamond, context)

        const report = yield* implementStoriesFlow(context, options)

        assert.deepStrictEqual(
          report.stories.map((outcome) => [outcome.id, outcome.status]),
          [
            ["a", "failed"],
            ["b", "done"],
            ["c", "waiting"],
            ["d", "waiting"]
          ]
        )
        assert.include(report.stories[0]?.reason ?? "", "gates failed in /repo/.llm4ts/worktrees/a")
        assert.strictEqual(report.stories[2]?.reason, "waiting for a")
        const statuses = yield* statusOf(options)
        assert.strictEqual(statuses.get("c"), "waiting")
        assert.strictEqual(statuses.get("b"), "done")
        const log = yield* Ref.get(harness.log)
        assert.notInclude(log, "merge:story/diamond/a")
        assert.include(log, "merge:story/diamond/b")
      })
  )

  it.effect("fail-fast stops the epic with a typed StoryFailed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ redGates: ["/repo/.llm4ts/worktrees/a"] })
      const context = yield* makeContext(harness)
      const options = yield* makeOptions(harness, diamond, context, {
        failFast: true,
        concurrency: 1
      })
      const error = yield* Effect.flip(implementStoriesFlow(context, options))
      assert.strictEqual(error._tag, "StoryFailed")
      assert.include(error.message, "story 'a' failed")
    })
  )

  it.effect("a merge conflict fails the story typed and never reaches the epic gates", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ conflicting: new Set(["story/diamond/b"]) })
      const context = yield* makeContext(harness)
      const options = yield* makeOptions(harness, diamond, context)
      const report = yield* implementStoriesFlow(context, options)
      const b = report.stories.find((outcome) => outcome.id === "b")
      assert.strictEqual(b?.status, "failed")
      assert.include(b?.reason ?? "", "conflicted: src/App.tsx")
      assert.strictEqual(report.stories.find((outcome) => outcome.id === "d")?.status, "waiting")
    })
  )

  it.effect("red epic gates after a merge roll the merge back and fail the story", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const context = yield* makeContext(harness)
      const options = yield* makeOptions(harness, diamond, context, {
        concurrency: 1,
        gates: (workDir) =>
          workDir === "/repo"
            ? Effect.map(Ref.get(harness.log), (log) =>
                log.includes("merge:story/diamond/a") && !log.includes("rollback:checkpoint")
                  ? red("epic typecheck")
                  : clean
              )
            : Effect.succeed(clean)
      })
      const report = yield* implementStoriesFlow(context, options)
      const a = report.stories.find((outcome) => outcome.id === "a")
      assert.strictEqual(a?.status, "failed")
      assert.include(a?.reason ?? "", "epic gates failed after merging; merge undone")
      const log = yield* Ref.get(harness.log)
      assert.include(log, "rollback:checkpoint")
      // b merged fine afterwards: the epic head was restored.
      assert.strictEqual(report.stories.find((outcome) => outcome.id === "b")?.status, "done")
    })
  )

  it.effect("a perimeter violation fails the story before it merges", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        changedFor: (item) =>
          item.id === "a"
            ? ["src/features/a/index.ts", "src/kit/components.tsx"]
            : [`src/features/${item.id}/x.ts`]
      })
      const context = yield* makeContext(harness)
      const options = yield* makeOptions(harness, diamond, context)
      const report = yield* implementStoriesFlow(context, options)
      const a = report.stories.find((outcome) => outcome.id === "a")
      assert.strictEqual(a?.status, "failed")
      assert.include(a?.reason ?? "", "src/kit/components.tsx (shared read-only")
      const log = yield* Ref.get(harness.log)
      assert.notInclude(log, "merge:story/diamond/a")
    })
  )

  it.effect("BLOCKED_ON from the coder becomes a typed missing dependency", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        blockedOnIn("I cannot continue.\nBLOCKED_ON: src/kit/iban-field.tsx from story iban-field"),
        "src/kit/iban-field.tsx from story iban-field"
      )
      assert.isUndefined(blockedOnIn("done"))
      // A sentinel followed by more work is not a stop.
      assert.isUndefined(
        blockedOnIn("BLOCKED_ON: reference repo\nCarrying on with node_modules instead.\nDone.")
      )
      assert.strictEqual(
        blockedOnIn("Nothing to do.\n\n`BLOCKED_ON: src/kit/x.tsx` \n"),
        "src/kit/x.tsx"
      )
      const harness = yield* makeHarness({
        replyFor: (workDir) =>
          workDir.endsWith("/a")
            ? "BLOCKED_ON: the accounts contract (src/contracts/accounts.ts)"
            : "done"
      })
      const context = yield* makeContext(harness)
      const options = yield* makeOptions(harness, diamond, context)
      const report = yield* implementStoriesFlow(context, options)
      const a = report.stories.find((outcome) => outcome.id === "a")
      assert.strictEqual(a?.status, "failed")
      assert.include(a?.reason ?? "", "blocked on unplanned work: the accounts contract")
    })
  )

  it.effect("judge feedback gets one fix round, then the story fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const context = yield* makeContext(harness)
      const verdicts = yield* Ref.make(0)
      const options = yield* makeOptions(harness, diamond, context, {
        concurrency: 1,
        judge: (item, _diff) =>
          item.id === "a"
            ? Effect.map(
                Ref.getAndUpdate(verdicts, (n) => n + 1),
                (n) => (n === 0 ? red("missing test") : clean)
              )
            : item.id === "b"
              ? Effect.succeed(red("never good enough"))
              : Effect.succeed(clean)
      })
      const report = yield* implementStoriesFlow(context, options)
      const a = report.stories.find((outcome) => outcome.id === "a")
      assert.strictEqual(a?.status, "done")
      assert.strictEqual(a?.judge, "judge cleared (round 2)")
      const b = report.stories.find((outcome) => outcome.id === "b")
      assert.strictEqual(b?.status, "failed")
      assert.include(b?.reason ?? "", "judge not cleared after 2 round(s)")
      const log = yield* Ref.get(harness.log)
      assert.include(log, "commit:/repo/.llm4ts/worktrees/a:a: address judge feedback")
    })
  )

  it.effect("rerun skips merged stories, resumes unchanged ones, recreates changed ones", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const context = yield* makeContext(harness)
      const options = yield* makeOptions(harness, diamond, context)
      const statePath = (id: string): string => `${options.stateDir}/stories/${id}.json`
      const planned = (id: string): Story => {
        const found = diamond.story(id)
        if (found === undefined) {
          throw new Error(id)
        }
        return found
      }
      // a: merged on a previous run. b: started, same hash → resume. c: hash differs → recreate.
      yield* saveVersioned(
        options.files,
        statePath("a"),
        StoryStateVersion,
        StoryState,
        StoryState.make({
          id: "a",
          hash: storyHash(planned("a")),
          branch: "story/diamond/a",
          worktree: "/repo/.llm4ts/worktrees/a",
          status: "merged"
        })
      )
      yield* saveVersioned(
        options.files,
        statePath("b"),
        StoryStateVersion,
        StoryState,
        StoryState.make({
          id: "b",
          hash: storyHash(planned("b")),
          branch: "story/diamond/b",
          worktree: "/repo/.llm4ts/worktrees/b",
          status: "failed"
        })
      )
      yield* options.files.writeAtomic("/repo/.llm4ts/worktrees/b/.git", "gitdir: elsewhere")
      yield* saveVersioned(
        options.files,
        statePath("c"),
        StoryStateVersion,
        StoryState,
        StoryState.make({
          id: "c",
          hash: "stale",
          branch: "story/diamond/c",
          worktree: "/repo/.llm4ts/worktrees/c",
          status: "failed"
        })
      )
      yield* Ref.set(harness.branches, new Set(["story/diamond/c"]))
      yield* options.files.writeAtomic(
        `${options.stateDir}/stories/c.plan.md`,
        "# Plan: c\n\n## [x] c task\nstale"
      )

      const report = yield* implementStoriesFlow(context, options)
      assert.strictEqual(report.count("done"), 4)
      const log = yield* Ref.get(harness.log)
      assert.notInclude(log, "seats:a")
      assert.notInclude(log, "merge:story/diamond/a")
      assert.notInclude(log, "worktree-new:story/diamond/b@epic/diamond->/repo/.llm4ts/worktrees/b")
      assert.notInclude(log, "worktree-existing:story/diamond/b->/repo/.llm4ts/worktrees/b")
      assert.include(log, "seats:b")
      assert.include(log, "worktree-remove:/repo/.llm4ts/worktrees/c:force")
      // The old task checkpoint went with the old branch; the fresh run wrote its own.
      const filesAfter = yield* memoryFilesOf(options)
      const checkpoint = filesAfter[`${options.stateDir}/stories/c.plan.md`] ?? ""
      assert.notInclude(checkpoint, "stale")
      assert.include(checkpoint, "[x] c task")
      assert.include(log, "branch-delete:story/diamond/c")
      assert.include(log, "worktree-new:story/diamond/c@epic/diamond->/repo/.llm4ts/worktrees/c")
      assert.strictEqual(report.stories[0]?.judge, "merged on a previous run")
    })
  )

  it.effect(
    "setup runs in every worktree before its seats, and a failing setup fails the story",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        const context = yield* makeContext(harness)
        const options = yield* makeOptions(harness, diamond, context, {
          concurrency: 1,
          setup: (workDir) =>
            workDir.endsWith("/b")
              ? Effect.fail(FlowAborted.make({ message: "worktree setup failed (pnpm install)" }))
              : record(harness, `setup:${workDir.split("/").at(-1) ?? ""}`)
        })
        const report = yield* implementStoriesFlow(context, options)
        const log = yield* Ref.get(harness.log)
        assert.isBelow(log.indexOf("setup:a"), log.indexOf("seats:a"))
        assert.isAbove(
          log.indexOf("setup:a"),
          log.indexOf("worktree-new:story/diamond/a@epic/diamond->/repo/.llm4ts/worktrees/a")
        )
        const b = report.stories.find((outcome) => outcome.id === "b")
        assert.strictEqual(b?.status, "failed")
        assert.include(b?.reason ?? "", "worktree setup failed")
        assert.notInclude(log, "seats:b")
        assert.strictEqual(report.stories.find((outcome) => outcome.id === "d")?.status, "waiting")
      })
  )

  it.effect("a story whose branch has no changes fails before the judge is asked", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const context = yield* makeContext(harness)
      const asked = yield* Ref.make(0)
      const options = yield* makeOptions(harness, diamond, context, {
        concurrency: 1,
        judge: () => Ref.update(asked, (n) => n + 1).pipe(Effect.as(clean)),
        contextFor: (workDir) =>
          Effect.gen(function* () {
            const story = storyOf(diamond, workDir)
            const seats: StorySeats = {
              context: {
                ...context,
                coder: coder("done"),
                git: {
                  ...worktreeGit(harness, workDir, story),
                  diffVsBase: () => Effect.succeed(story.id === "a" ? "" : "diff --git a/f b/f\n+x")
                },
                workDir
              }
            }
            return seats
          })
      })
      const report = yield* implementStoriesFlow(context, options)
      const a = report.stories.find((outcome) => outcome.id === "a")
      assert.strictEqual(a?.status, "failed")
      assert.include(a?.reason ?? "", "no changes against the epic branch")
      assert.strictEqual(report.stories.find((outcome) => outcome.id === "b")?.status, "done")
      assert.strictEqual(yield* Ref.get(asked), 1)
    })
  )

  it.effect("an invalid plan fails typed before any branch is touched", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const context = yield* makeContext(harness)
      const bad = StoryPlan.make({
        epicId: "bad",
        epic: "bad",
        stories: [story("a", ["b"]), story("b", ["a"])]
      })
      const options = yield* makeOptions(harness, bad, context)
      const error = yield* Effect.flip(implementStoriesFlow(context, options))
      assert.strictEqual(error._tag, "StoryPlanInvalid")
      assert.deepStrictEqual(yield* Ref.get(harness.log), [])
    })
  )
})
