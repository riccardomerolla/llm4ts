import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { ConnectorCapabilities, LlmChunk } from "@llm4ts/core/Models"
import { unsupportedScoreLabels } from "@llm4ts/core/LabelScoring"
import type { FlowContextShape } from "@llm4ts/flow/FlowContext"
import { FlowAborted, type FlowError } from "@llm4ts/flow/FlowError"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import { Committed, type GitToolShape } from "@llm4ts/flow/GitTool"
import type { GitHubToolShape } from "@llm4ts/flow/GitHubTool"
import { landEpic } from "@llm4ts/flow/Landing"
import {
  makeMemoryPlainFileStore,
  saveVersioned,
  type PlainFileStoreShape
} from "@llm4ts/flow/Persistence"
import { ReviewIssue, ReviewResult } from "@llm4ts/flow/Review"
import { StoryState, StoryStateVersion } from "@llm4ts/flow/Stories"
import { Story, StoryPlan } from "@llm4ts/flow/StoryPlan"

const unused = InvalidRequestError.make({ message: "unused" })
const unusedFlow: Effect.Effect<never, FlowError> = Effect.fail(
  FlowAborted.make({ message: "unused" })
)

const story = (id: string): Story =>
  Story.make({
    id,
    title: id,
    description: id,
    dependsOn: [],
    owned: [`src/${id}`],
    sharedReadOnly: [],
    provides: [`${id} screen`]
  })

const plan = StoryPlan.make({
  epicId: "bank",
  epic: "Conto e Bonifico",
  stories: [story("a"), story("b")]
})

const stateDir = "/repo/.llm4ts/epics/bank"

const merged = (files: PlainFileStoreShape, id: string, status: "merged" | "failed" = "merged") =>
  saveVersioned(
    files,
    `${stateDir}/stories/${id}.json`,
    StoryStateVersion,
    StoryState,
    StoryState.make({ id, hash: "h", branch: `story/bank/${id}`, worktree: `/wt/${id}`, status })
  )

/** A coder whose every turn runs `onAsk` (it edits files as a coder would). */
const coder = (onAsk: (prompt: string) => Effect.Effect<void>): LlmServiceShape => {
  const answer = (prompt: string) =>
    Stream.unwrap(
      Effect.as(onAsk(prompt), Stream.make(LlmChunk.make({ delta: "done", finishReason: "stop" })))
    )
  return {
    executeStream: answer,
    executeStreamWithHistory: (messages) => answer(messages.at(-1)?.content ?? ""),
    executeWithTools: () => Effect.fail(unused),
    executeStructured: () => Effect.fail(unused),
    executeStructuredWithUsage: () => Effect.fail(unused),
    scoreLabels: unsupportedScoreLabels,
    isAvailable: Effect.succeed(true)
  }
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

interface Scenario {
  readonly behind: boolean
  readonly conflicts: ReadonlyArray<string>
}

const gitFor = (log: Ref.Ref<ReadonlyArray<string>>, scenario: Scenario): GitToolShape => {
  const record = (entry: string) => Ref.update(log, (all) => [...all, entry])
  const ok = Effect.void
  return {
    init: ok,
    initBare: ok,
    config: () => ok,
    status: Effect.succeed(""),
    uncommittedFiles: Effect.succeed([]),
    currentBranch: Effect.succeed("epic/bank"),
    diff: Effect.succeed(""),
    diffAll: Effect.succeed(""),
    defaultBase: Effect.succeed("main"),
    diffVsBase: () => Effect.succeed(""),
    diffVsBaseScoped: () => Effect.succeed(""),
    changedFilesVsBase: () => Effect.succeed([]),
    addRemote: () => ok,
    checkout: (name) => record(`checkout:${name}`),
    checkoutOrCreate: () => ok,
    createBranch: () => unusedFlow,
    commitAll: (message) => record(`commit:${message}`).pipe(Effect.as(Committed.make({}))),
    commitPaths: () => Effect.succeed(Committed.make({})),
    push: () => ok,
    checkpoint: Effect.succeed("before"),
    rollback: (checkpoint) => record(`rollback:${checkpoint}`),
    addWorktree: () => ok,
    addWorktreeNewBranch: () => ok,
    removeWorktree: () => ok,
    moveWorktree: () => ok,
    restorePaths: () => ok,
    branchExists: (name) => Effect.succeed(name === "main"),
    deleteBranch: () => ok,
    isAncestor: () => Effect.succeed(!scenario.behind),
    merge: (branch, message) => record(`merge:${branch}:${message}`),
    mergeNoCommit: (branch) =>
      record(`merge-no-commit:${branch}`).pipe(Effect.as(scenario.conflicts))
  }
}

const contextFor = (
  git: GitToolShape,
  service: LlmServiceShape,
  events: FlowContextShape["events"]
): FlowContextShape => ({
  reasoning: service,
  coder: service,
  git,
  hosting,
  events,
  reviewers: [],
  coderCapabilities: ConnectorCapabilities.make({}),
  userPrompt: "land",
  workDir: "/repo",
  workspace: "/repo"
})

const red = ReviewResult.make({
  issues: [ReviewIssue.make({ severity: "Critical", title: "pnpm typecheck failed" })]
})
const clean = ReviewResult.make({ issues: [] })

describe("landEpic", () => {
  it.effect("refuses an epic with stories not merged, naming them", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* merged(memory.store, "a")
      yield* merged(memory.store, "b", "failed")
      const events = yield* makeCollectingFlowEvents
      const log = yield* Ref.make<ReadonlyArray<string>>([])
      const error = yield* Effect.flip(
        landEpic(
          contextFor(
            gitFor(log, { behind: false, conflicts: [] }),
            coder(() => Effect.void),
            events
          ),
          {
            plan,
            files: memory.store,
            stateDir,
            gates: () => Effect.succeed(clean)
          }
        )
      )
      assert.strictEqual(error._tag, "EpicIncomplete")
      assert.include(error.message, "not merged yet: b")
      assert.deepStrictEqual(yield* Ref.get(log), [])
    })
  )

  it.effect("lands a green epic that already contains the target with a merge commit", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* merged(memory.store, "a")
      yield* merged(memory.store, "b")
      const events = yield* makeCollectingFlowEvents
      const log = yield* Ref.make<ReadonlyArray<string>>([])
      const report = yield* landEpic(
        contextFor(
          gitFor(log, { behind: false, conflicts: [] }),
          coder(() => Effect.void),
          events
        ),
        { plan, files: memory.store, stateDir, gates: () => Effect.succeed(clean) }
      )
      assert.deepStrictEqual(report, {
        epicBranch: "epic/bank",
        target: "main",
        conflicts: [],
        rounds: 0
      })
      assert.deepStrictEqual(yield* Ref.get(log), [
        "checkout:epic/bank",
        "checkout:main",
        "merge:epic/bank:bank: land epic/bank"
      ])
    })
  )

  it.effect("has the coder resolve conflicts and red gates, then lands", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* merged(memory.store, "a")
      yield* merged(memory.store, "b")
      yield* memory.store.writeAtomic(
        "/repo/src/App.tsx",
        "<<<<<<< HEAD\nconst a = 1\n=======\nconst a = 2\n>>>>>>> main\n"
      )
      const gatesRun = yield* Ref.make(0)
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      const service = coder((prompt) =>
        Ref.update(asked, (all) => [...all, prompt]).pipe(
          Effect.andThen(
            Effect.orDie(memory.store.writeAtomic("/repo/src/App.tsx", "const a = 2\n"))
          )
        )
      )
      const events = yield* makeCollectingFlowEvents
      const log = yield* Ref.make<ReadonlyArray<string>>([])
      const report = yield* landEpic(
        contextFor(gitFor(log, { behind: true, conflicts: ["src/App.tsx"] }), service, events),
        {
          plan,
          files: memory.store,
          stateDir,
          // Red once after the conflict is resolved, then green.
          gates: () =>
            Effect.map(
              Ref.getAndUpdate(gatesRun, (n) => n + 1),
              (n) => (n === 0 ? red : clean)
            )
        }
      )
      assert.strictEqual(report.rounds, 2)
      assert.deepStrictEqual(report.conflicts, ["src/App.tsx"])
      const prompts = yield* Ref.get(asked)
      assert.include(prompts[0] ?? "", "left conflicts in these files:\n- src/App.tsx")
      assert.include(prompts[0] ?? "", "- a: a screen")
      assert.include(prompts[1] ?? "", "pnpm typecheck failed")
      assert.deepStrictEqual(yield* Ref.get(log), [
        "checkout:epic/bank",
        "merge-no-commit:main",
        "commit:bank: merge main into epic/bank before landing",
        "checkout:main",
        "merge:epic/bank:bank: land epic/bank"
      ])
    })
  )

  it.effect("gives up after the rounds, rolls the epic back and leaves the target alone", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* merged(memory.store, "a")
      yield* merged(memory.store, "b")
      yield* memory.store.writeAtomic(
        "/repo/src/App.tsx",
        "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\n"
      )
      const events = yield* makeCollectingFlowEvents
      const log = yield* Ref.make<ReadonlyArray<string>>([])
      const error = yield* Effect.flip(
        landEpic(
          contextFor(
            gitFor(log, { behind: true, conflicts: ["src/App.tsx"] }),
            coder(() => Effect.void),
            events
          ),
          { plan, files: memory.store, stateDir, gates: () => Effect.succeed(clean), maxRounds: 2 }
        )
      )
      assert.strictEqual(error._tag, "LandingFailed")
      assert.include(error.message, "'main' is untouched")
      assert.include(error.message, "conflict markers still in src/App.tsx after 2 round(s)")
      const entries = yield* Ref.get(log)
      assert.include(entries, "rollback:before")
      assert.isFalse(entries.some((entry) => entry.startsWith("checkout:main")))
    })
  )
})
