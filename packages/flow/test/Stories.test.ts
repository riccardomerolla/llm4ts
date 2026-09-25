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
  BlockedVerdict,
  StoryState,
  StoryStateVersion,
  blockedOnIn,
  blockedRebuttal,
  implementStoriesFlow,
  perimeterRules,
  renderEpicReport,
  type StoriesOptions,
  type StorySeats
} from "@llm4ts/flow/Stories"
import { Story, StoryPlan, storyHash } from "@llm4ts/flow/StoryPlan"
import { unsupportedScoreLabels } from "@llm4ts/core/LabelScoring"

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
  scoreLabels: unsupportedScoreLabels,
  isAvailable: Effect.succeed(true)
})

/** A coder whose reply depends on how many turns it has taken and on the prompt. */
const scriptedCoder = (
  turns: Ref.Ref<number>,
  reply: (turn: number, prompt: string) => string
): LlmServiceShape => {
  const answer = (prompt: string) =>
    Stream.unwrap(
      Effect.map(
        Ref.updateAndGet(turns, (n) => n + 1),
        (turn) => Stream.make(LlmChunk.make({ delta: reply(turn, prompt), finishReason: "stop" }))
      )
    )
  return {
    ...coder("done"),
    executeStream: answer,
    executeStreamWithHistory: (messages) => answer(messages.at(-1)?.content ?? "")
  }
}

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
  scoreLabels: unsupportedScoreLabels,
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
  /** `git status --short` of the epic checkout, given the log so far. */
  readonly epicStatus: (log: ReadonlyArray<string>) => string
  /** Whether story branches already contain the epic head (no catch-up merge). */
  readonly upToDate: boolean
}

const record = (harness: Harness, entry: string): Effect.Effect<void> =>
  Ref.update(harness.log, (current) => [...current, entry])

const baseGit: GitToolShape = {
  init: Effect.void,
  initBare: Effect.void,
  config: () => Effect.void,
  status: Effect.succeed(""),
  uncommittedFiles: Effect.succeed([]),
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
  moveWorktree: () => Effect.void,
  restorePaths: () => Effect.void,
  mergeNoCommit: () => Effect.succeed([]),
  branchExists: () => Effect.succeed(false),
  deleteBranch: () => Effect.void,
  isAncestor: () => Effect.succeed(false),
  merge: () => Effect.void
}

/** The epic checkout's git: branches, worktrees, merges, rollbacks are logged. */
const epicGit = (harness: Harness): GitToolShape => ({
  ...baseGit,
  status: Effect.map(Ref.get(harness.log), harness.epicStatus),
  moveWorktree: (from, to) => record(harness, `worktree-move:${from}->${to}`),
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
  changedFilesVsBase: () => Effect.succeed(harness.changedFor(story)),
  isAncestor: () => Effect.succeed(harness.upToDate),
  merge: (branch, _message, options) =>
    record(
      harness,
      `catch-up:${workDir}:${branch}:${options?.preferIncoming === true ? "theirs" : "plain"}`
    )
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
      latches: overrides.latches ?? new Map(),
      epicStatus: overrides.epicStatus ?? (() => ""),
      upToDate: overrides.upToDate ?? false
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
    "setup runs in every worktree before its coder, and a failing setup fails the story",
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
        // After the seats (the catch-up merge runs in the worktree first),
        // before any coder work is committed.
        assert.isAbove(log.indexOf("setup:a"), log.indexOf("seats:a"))
        assert.isBelow(
          log.indexOf("setup:a"),
          log.indexOf("commit:/repo/.llm4ts/worktrees/a:a: a task")
        )
        const b = report.stories.find((outcome) => outcome.id === "b")
        assert.strictEqual(b?.status, "failed")
        assert.include(b?.reason ?? "", "worktree setup failed")
        assert.isFalse(log.some((entry) => entry.startsWith("commit:/repo/.llm4ts/worktrees/b:")))
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

  it.effect("a dirty epic checkout fails the run before any branch is touched", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        epicStatus: () => "?? src/features/conto/overview/route.tsx\n?? .llm4ts/epics/x/board.md"
      })
      const context = yield* makeContext(harness)
      const options = yield* makeOptions(harness, diamond, context)
      const error = yield* Effect.flip(implementStoriesFlow(context, options))
      assert.strictEqual(error._tag, "EpicCheckoutDirty")
      assert.include(error.message, "- src/features/conto/overview/route.tsx")
      // The runner's own state is not a stray change.
      assert.notInclude(error.message, "board.md")
      assert.deepStrictEqual(yield* Ref.get(harness.log), [])
    })
  )

  it.effect("a coder dirtying the epic checkout stops the epic; unstarted stories wait", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        // The escape happens while story a runs (its seats exist).
        epicStatus: (log) => (log.includes("seats:a") ? "A  src/features/a/leak.ts" : "")
      })
      const context = yield* makeContext(harness)
      const options = yield* makeOptions(harness, diamond, context, { concurrency: 1 })
      const report = yield* implementStoriesFlow(context, options)
      const a = report.stories.find((outcome) => outcome.id === "a")
      assert.strictEqual(a?.status, "failed")
      assert.include(a?.reason ?? "", "found after story 'a' finished")
      assert.include(a?.reason ?? "", "- src/features/a/leak.ts")
      const b = report.stories.find((outcome) => outcome.id === "b")
      assert.strictEqual(b?.status, "waiting")
      assert.include(b?.reason ?? "", "not started: the epic checkout")
      const log = yield* Ref.get(harness.log)
      assert.notInclude(log, "merge:story/diamond/a")
      assert.notInclude(log, "seats:b")
    })
  )

  it.effect("a story branch behind the epic catches up, taking the epic's side", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const context = yield* makeContext(harness)
      const options = yield* makeOptions(harness, diamond, context, { concurrency: 1 })
      yield* implementStoriesFlow(context, options)
      const log = yield* Ref.get(harness.log)
      const catchUps = log.filter((entry) =>
        entry.startsWith("catch-up:/repo/.llm4ts/worktrees/c:")
      )
      // Before the coder, and again before the judge.
      assert.deepStrictEqual(catchUps, [
        "catch-up:/repo/.llm4ts/worktrees/c:epic/diamond:theirs",
        "catch-up:/repo/.llm4ts/worktrees/c:epic/diamond:theirs"
      ])
      assert.isBelow(
        log.indexOf("catch-up:/repo/.llm4ts/worktrees/c:epic/diamond:theirs"),
        log.indexOf("commit:/repo/.llm4ts/worktrees/c:c: c task")
      )

      const current = yield* makeHarness({ upToDate: true })
      const quiet = yield* makeContext(current)
      yield* implementStoriesFlow(quiet, yield* makeOptions(current, diamond, quiet))
      assert.isFalse((yield* Ref.get(current.log)).some((entry) => entry.startsWith("catch-up:")))
    })
  )

  it.effect("stray paths the coder leaves are restored from the epic branch before judging", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const context = yield* makeContext(harness)
      const restored = yield* Ref.make<ReadonlyArray<string>>([])
      const judged = yield* Ref.make<ReadonlyArray<string>>([])
      const options = yield* makeOptions(harness, diamond, context, {
        concurrency: 1,
        judge: (item, _diff) =>
          Ref.update(judged, (ids) => [...ids, item.id]).pipe(Effect.as(clean)),
        contextFor: (workDir) =>
          Effect.gen(function* () {
            const story = storyOf(diamond, workDir)
            yield* record(harness, `seats:${story.id}`)
            const base = worktreeGit(harness, workDir, story)
            const seats: StorySeats = {
              context: {
                ...context,
                coder: coder("done"),
                git: {
                  ...base,
                  // a's task commit carried src/App.tsx along; nobody reverts it.
                  changedFilesVsBase: () =>
                    Effect.gen(function* () {
                      const log = yield* Ref.get(harness.log)
                      const back = yield* Ref.get(restored)
                      const committed = log.includes("commit:/repo/.llm4ts/worktrees/a:a: a task")
                      return story.id === "a" && committed && !back.includes("src/App.tsx")
                        ? ["src/features/a/index.ts", "src/App.tsx"]
                        : [`src/features/${story.id}/index.ts`]
                    }),
                  restorePaths: (source, paths) =>
                    Ref.update(restored, (all) => [...all, ...paths]).pipe(
                      Effect.andThen(record(harness, `restore:${source}:${paths.join(",")}`))
                    )
                },
                workDir
              }
            }
            return seats
          })
      })
      const report = yield* implementStoriesFlow(context, options)
      assert.strictEqual(report.stories.find((outcome) => outcome.id === "a")?.status, "done")
      const log = yield* Ref.get(harness.log)
      assert.include(log, "restore:epic/diamond:src/App.tsx")
      assert.include(
        log,
        "commit:/repo/.llm4ts/worktrees/a:a: put paths outside the perimeter back"
      )
      assert.isBelow(
        log.indexOf("restore:epic/diamond:src/App.tsx"),
        log.indexOf("merge:story/diamond/a")
      )
      assert.include(yield* Ref.get(judged), "a")
    })
  )

  it.effect("planned tasks naming another story's paths are re-planned, then dropped", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const context = yield* makeContext(harness)
      const prompts = yield* Ref.make<ReadonlyArray<string>>([])
      const options = yield* makeOptions(harness, diamond, context, {
        concurrency: 1,
        planTasks: (_seats, item, prompt) =>
          Ref.update(prompts, (all) => [...all, prompt]).pipe(
            Effect.as(
              Plan.make({
                epicId: item.id,
                tasks: [
                  Task.make({ title: `${item.id} task`, description: item.description }),
                  ...(item.id === "a"
                    ? [
                        Task.make({
                          title: "Register a in the shell",
                          description: "Add the route to src/features/d/index.ts."
                        })
                      ]
                    : [])
                ]
              })
            )
          )
      })
      yield* implementStoriesFlow(context, options)
      const asked = yield* Ref.get(prompts)
      // a planned twice (the second time told why), every other story once.
      assert.strictEqual(asked.length, 5)
      assert.include(asked[1] ?? "", "named paths outside this story's owned paths")
      assert.include(asked[1] ?? "", "src/features/d/index.ts")
      const files = yield* memoryFilesOf(options)
      const checkpoint = files[`${options.stateDir}/stories/a.plan.md`] ?? ""
      assert.include(checkpoint, "a task")
      assert.notInclude(checkpoint, "Register a in the shell")
    })
  )

  it.effect("a BLOCKED_ON the plan refutes sends the coder back once", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const context = yield* makeContext(harness)
      const turns = yield* Ref.make(0)
      const heard = yield* Ref.make<ReadonlyArray<string>>([])
      const options = yield* makeOptions(harness, diamond, context, {
        concurrency: 1,
        contextFor: (workDir) =>
          Effect.gen(function* () {
            const story = storyOf(diamond, workDir)
            const seats: StorySeats = {
              context: {
                ...context,
                // c depends on a, whose code is already merged: the claim is wrong.
                coder:
                  story.id === "c"
                    ? scriptedCoder(turns, (turn, prompt) => {
                        Effect.runSync(Ref.update(heard, (all) => [...all, prompt]))
                        return turn === 1
                          ? "I need a.\nBLOCKED_ON: src/features/a/index.ts"
                          : "done"
                      })
                    : coder("done"),
                git: worktreeGit(harness, workDir, story),
                workDir
              }
            }
            return seats
          })
      })
      const report = yield* implementStoriesFlow(context, options)
      assert.strictEqual(report.stories.find((outcome) => outcome.id === "c")?.status, "done")
      const told = (yield* Ref.get(heard)).find((prompt) => prompt.includes("was checked against"))
      assert.include(
        told ?? "",
        "belongs to story 'a', merged into the epic branch before you started"
      )
      assert.include(
        yield* Ref.get(harness.log),
        "commit:/repo/.llm4ts/worktrees/c:c: continue after a rejected BLOCKED_ON"
      )
    })
  )

  it.effect("a BLOCKED_ON the plan cannot settle goes to the verifier", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const context = yield* makeContext(harness)
      const turns = yield* Ref.make(0)
      const options = yield* makeOptions(harness, diamond, context, {
        concurrency: 1,
        verifyBlocked: (item, need) =>
          Effect.succeed(
            item.id === "a"
              ? BlockedVerdict.make({ real: false, reason: `${need} is invented` })
              : BlockedVerdict.make({ real: true, reason: "genuinely missing" })
          ),
        contextFor: (workDir) =>
          Effect.gen(function* () {
            const story = storyOf(diamond, workDir)
            const seats: StorySeats = {
              context: {
                ...context,
                coder:
                  story.id === "a"
                    ? scriptedCoder(turns, (turn) =>
                        turn === 1 ? "BLOCKED_ON: src/features/conta/ContoScreen.tsx" : "done"
                      )
                    : story.id === "b"
                      ? coder("BLOCKED_ON: src/features/elsewhere/thing.ts")
                      : coder("done"),
                git: worktreeGit(harness, workDir, story),
                workDir
              }
            }
            return seats
          })
      })
      const report = yield* implementStoriesFlow(context, options)
      assert.strictEqual(report.stories.find((outcome) => outcome.id === "a")?.status, "done")
      const b = report.stories.find((outcome) => outcome.id === "b")
      assert.strictEqual(b?.status, "failed")
      assert.include(b?.reason ?? "", "blocked on unplanned work: src/features/elsewhere/thing.ts")
    })
  )

  it.effect(
    "an outage waits for the engine and retries the story once; without a wait, it stops",
    () =>
      Effect.gen(function* () {
        const outage = "pi error: 503: engine is recovering; retry shortly"
        const setups = yield* Ref.make(0)
        const flakySetup = (workDir: string) =>
          workDir.endsWith("/a")
            ? Effect.flatMap(
                Ref.getAndUpdate(setups, (n) => n + 1),
                (n) => (n === 0 ? Effect.fail(FlowAborted.make({ message: outage })) : Effect.void)
              )
            : Effect.void

        const harness = yield* makeHarness()
        const context = yield* makeContext(harness)
        const waited = yield* Ref.make<ReadonlyArray<string>>([])
        const options = yield* makeOptions(harness, diamond, context, {
          concurrency: 1,
          setup: flakySetup,
          awaitRecovery: (reason) => Ref.update(waited, (all) => [...all, reason])
        })
        const report = yield* implementStoriesFlow(context, options)
        assert.strictEqual(report.count("done"), 4)
        assert.deepStrictEqual(yield* Ref.get(waited), [outage])

        yield* Ref.set(setups, 0)
        const stopped = yield* makeHarness()
        const stoppedContext = yield* makeContext(stopped)
        const noWait = yield* makeOptions(stopped, diamond, stoppedContext, {
          concurrency: 1,
          setup: flakySetup
        })
        const halted = yield* implementStoriesFlow(stoppedContext, noWait)
        assert.strictEqual(halted.stories.find((outcome) => outcome.id === "a")?.status, "failed")
        const b = halted.stories.find((outcome) => outcome.id === "b")
        assert.strictEqual(b?.status, "waiting")
        assert.include(b?.reason ?? "", "not started: the serving engine is down")
        assert.notInclude(yield* Ref.get(stopped.log), "seats:b")
      })
  )

  it.effect("a resumed worktree under an older root moves to the current one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness()
      const context = yield* makeContext(harness)
      const options = yield* makeOptions(harness, diamond, context)
      const a = diamond.story("a")
      if (a === undefined) {
        throw new Error("a")
      }
      yield* saveVersioned(
        options.files,
        `${options.stateDir}/stories/a.json`,
        StoryStateVersion,
        StoryState,
        StoryState.make({
          id: "a",
          hash: storyHash(a),
          branch: "story/diamond/a",
          worktree: "/old/worktrees/a",
          status: "failed"
        })
      )
      yield* options.files.writeAtomic("/old/worktrees/a/.git", "gitdir: elsewhere")
      yield* implementStoriesFlow(context, options)
      const log = yield* Ref.get(harness.log)
      assert.include(log, "worktree-move:/old/worktrees/a->/repo/.llm4ts/worktrees/a")
      const files = yield* memoryFilesOf(options)
      assert.include(files[`${options.stateDir}/stories/a.json`] ?? "", "/repo/.llm4ts/worktrees/a")
    })
  )

  it("the plan settles a BLOCKED_ON on an own, earlier, or later story's path", () => {
    const c = diamond.story("c")
    if (c === undefined) {
      throw new Error("c")
    }
    assert.include(blockedRebuttal(diamond, c, "src/features/c/x.ts") ?? "", "your own owned paths")
    assert.include(
      blockedRebuttal(diamond, c, "the export in src/features/a/index.ts") ?? "",
      "merged into the epic branch before you started"
    )
    assert.include(blockedRebuttal(diamond, c, "wiring in src/features/d") ?? "", "runs AFTER you")
    // A parallel story's path, or nobody's: the plan cannot tell.
    assert.isUndefined(blockedRebuttal(diamond, c, "src/features/b/x.ts"))
    assert.isUndefined(blockedRebuttal(diamond, c, "src/features/conta/ContoScreen.tsx"))
  })

  it("the rules name the working directory, the epic checkout, and every other story", () => {
    const c = diamond.story("c")
    if (c === undefined) {
      throw new Error("c")
    }
    const rules = perimeterRules(c, {
      plan: diamond,
      worktree: "/repo.worktrees/diamond/c",
      epicCheckout: "/repo"
    })
    assert.include(rules, "Your working directory is /repo.worktrees/diamond/c")
    assert.include(rules, "above all not /repo, the epic")
    assert.include(rules, "src/features/a — story a: merged into the epic before you started")
    assert.include(rules, "src/features/d — story d: built AFTER you")
    assert.include(rules, "src/features/b — story b: built at the same time")
    assert.notInclude(perimeterRules(c), "working directory")
  })

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
