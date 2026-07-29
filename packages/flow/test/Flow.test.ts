import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { ConnectorCapabilities, LlmChunk, type Message } from "@llm4ts/core/Models"
import { gitOwnershipInstruction } from "@llm4ts/flow/Chat"
import { implementPlanFlow, flowReviewer, completeAndPublish } from "@llm4ts/flow/Flow"
import { FlowAborted, type FlowError } from "@llm4ts/flow/FlowError"
import type { FlowContextShape } from "@llm4ts/flow/FlowContext"
import { makeFlowEventHub } from "@llm4ts/flow/FlowEvents"
import { Committed, type GitToolShape } from "@llm4ts/flow/GitTool"
import type { GitHubToolShape } from "@llm4ts/flow/GitHubTool"
import { Plan, Task } from "@llm4ts/flow/Plan"
import { ReviewIssue, ReviewResult } from "@llm4ts/flow/Review"
import { makeMemoryPlainFileStore, makePlanStore } from "@llm4ts/flow/Persistence"

const unused = InvalidRequestError.make({ message: "unused in test" })
const unusedFlow: Effect.Effect<never, FlowError> = Effect.fail(
  FlowAborted.make({ message: "unused in test" })
)

const coderService = (asked: Ref.Ref<ReadonlyArray<string>>): LlmServiceShape => ({
  executeStream: (_prompt) => Stream.make(LlmChunk.make({ delta: "done", finishReason: "stop" })),
  executeStreamWithHistory: (messages) =>
    Stream.unwrap(
      Ref.update(asked, (current) => [...current, messages.at(-1)?.content ?? ""]).pipe(
        Effect.as(Stream.make(LlmChunk.make({ delta: "done", finishReason: "stop" })))
      )
    ),
  executeWithTools: (_prompt, _tools) => Effect.fail(unused),
  executeStructured: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  isAvailable: Effect.succeed(true)
})

const historyTrackingCoderService = (
  historyLengths: Ref.Ref<ReadonlyArray<number>>
): LlmServiceShape => ({
  executeStream: (_prompt) => Stream.make(LlmChunk.make({ delta: "done", finishReason: "stop" })),
  executeStreamWithHistory: (messages) =>
    Stream.unwrap(
      Ref.update(historyLengths, (current) => [...current, messages.length]).pipe(
        Effect.as(Stream.make(LlmChunk.make({ delta: "done", finishReason: "stop" })))
      )
    ),
  executeWithTools: (_prompt, _tools) => Effect.fail(unused),
  executeStructured: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  isAvailable: Effect.succeed(true)
})

const messageSnapshotCoderService = (
  snapshots: Ref.Ref<ReadonlyArray<ReadonlyArray<Message>>>,
  reply = "done"
): LlmServiceShape => ({
  executeStream: (_prompt) => Stream.make(LlmChunk.make({ delta: "done", finishReason: "stop" })),
  executeStreamWithHistory: (messages) =>
    Stream.unwrap(
      Ref.update(snapshots, (current) => [...current, messages]).pipe(
        Effect.as(Stream.make(LlmChunk.make({ delta: reply, finishReason: "stop" })))
      )
    ),
  executeWithTools: (_prompt, _tools) => Effect.fail(unused),
  executeStructured: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  isAvailable: Effect.succeed(true)
})

const cleanReviewer: LlmServiceShape = {
  executeStream: (_prompt) => Stream.empty,
  executeStreamWithHistory: (_messages) => Stream.empty,
  executeWithTools: (_prompt, _tools) => Effect.fail(unused),
  executeStructured: (_prompt, schema, _jsonSchema) =>
    Schema.decodeUnknownEffect(schema)({ issues: [], summary: "clean" }).pipe(Effect.orDie),
  executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  isAvailable: Effect.succeed(true)
}

// Reports one issue the first time it is asked, then clean forever after —
// enough to force exactly one review-fix round.
const dirtyOnceReviewer = (spent: Ref.Ref<boolean>): LlmServiceShape => ({
  executeStream: (_prompt) => Stream.empty,
  executeStreamWithHistory: (_messages) => Stream.empty,
  executeWithTools: (_prompt, _tools) => Effect.fail(unused),
  executeStructured: (_prompt, schema, _jsonSchema) =>
    Ref.getAndSet(spent, true).pipe(
      Effect.flatMap((wasSpent) =>
        Schema.decodeUnknownEffect(schema)(
          wasSpent
            ? { issues: [], summary: "clean" }
            : { issues: [{ severity: "Warning", title: "nit", description: "" }], summary: "dirty" }
        ).pipe(Effect.orDie)
      )
    ),
  executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  isAvailable: Effect.succeed(true)
})

interface GitLog {
  readonly branches: ReadonlyArray<string>
  readonly commits: ReadonlyArray<string>
}

const makeFakeGit = (log: Ref.Ref<GitLog>): GitToolShape => ({
  init: Effect.void,
  initBare: Effect.void,
  config: (_key, _value) => Effect.void,
  status: Effect.succeed(""),
  currentBranch: Effect.succeed("main"),
  diff: Effect.succeed("diff --git a/file b/file"),
  diffAll: Effect.succeed("diff --git a/file b/file\n+new content"),
  defaultBase: Effect.succeed("main"),
  diffVsBase: (_base, _threeDot) => Effect.succeed(""),
  changedFilesVsBase: (_base, _threeDot) => Effect.succeed([]),
  addRemote: (_name, _url) => Effect.void,
  checkout: (_name) => Effect.void,
  checkoutOrCreate: (name) =>
    Ref.update(log, (current) => ({ ...current, branches: [...current.branches, name] })),
  createBranch: (_name) => unusedFlow,
  commitAll: (message) =>
    Ref.update(log, (current) => ({ ...current, commits: [...current.commits, message] })).pipe(
      Effect.as(Committed.make({}))
    ),
  push: (_remote, _branch) => Effect.void,
  checkpoint: Effect.succeed("checkpoint"),
  rollback: (_checkpoint) => Effect.void,
  addWorktree: (_path, _branch) => Effect.void,
  removeWorktree: (_path) => Effect.void
})

// diffAll reports empty for the first call (the no-op task), non-empty from
// then on — lets a test drive one task through the skip path and the next
// through the normal review+commit path.
const makeFakeGitSkippingFirstDiff = (
  log: Ref.Ref<GitLog>,
  calls: Ref.Ref<number>
): GitToolShape => ({
  ...makeFakeGit(log),
  diffAll: Ref.getAndUpdate(calls, (current) => current + 1).pipe(
    Effect.map((seen) => (seen <= 1 ? "" : "diff --git a/file b/file\n+new content"))
  )
})

const failingHosting: GitHubToolShape = {
  createPr: (_title, _body, _base, _draft) => unusedFlow,
  readIssue: (_ref) => unusedFlow,
  writeIssueComment: (_ref, _body) => unusedFlow,
  writePrComment: (_pr, _body) => unusedFlow,
  updatePr: (_pr, _title, _body) => unusedFlow,
  prChecks: (_pr) => unusedFlow
}

describe("Flow", () => {
  it.effect("implements a plan end to end: branch, per-task coder+review, commit, persist", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      const gitLog = yield* Ref.make<GitLog>({ branches: [], commits: [] })
      const memory = yield* makeMemoryPlainFileStore()
      const store = makePlanStore(memory.store)
      const plan = Plan.make({
        epicId: "epic-1",
        tasks: [
          Task.make({ title: "first task", description: "do the first thing" }),
          Task.make({ title: "second task", description: "do the second thing" })
        ]
      })
      const context: FlowContextShape = {
        reasoning: cleanReviewer,
        coder: coderService(asked),
        git: makeFakeGit(gitLog),
        hosting: failingHosting,
        events,
        reviewers: [cleanReviewer],
        coderCapabilities: ConnectorCapabilities.make({}),
        userPrompt: "implement the plan",
        workDir: "/repo",
        workspace: "/repo"
      }

      const completed = yield* implementPlanFlow(context, {
        store,
        planPath: ".llm4ts/plan.md",
        plan: Effect.succeed(plan)
      })

      const log = yield* Ref.get(gitLog)
      const prompts = yield* Ref.get(asked)
      const persisted = yield* store.load(".llm4ts/plan.md")

      assert.isTrue(completed.tasks.every((task) => task.completed))
      assert.deepStrictEqual(log.branches, ["epic-1"])
      assert.deepStrictEqual(log.commits, ["epic-1: first task", "epic-1: second task"])
      assert.strictEqual(prompts.length, 2)
      assert.match(prompts[0] ?? "", /do the first thing/)
      assert.isTrue(persisted?.tasks.every((task) => task.completed))
    })
  )

  it.effect("falls back to the reasoning service when no reviewer is configured", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      const gitLog = yield* Ref.make<GitLog>({ branches: [], commits: [] })
      const context: FlowContextShape = {
        reasoning: cleanReviewer,
        coder: coderService(asked),
        git: makeFakeGit(gitLog),
        hosting: failingHosting,
        events,
        reviewers: [],
        coderCapabilities: ConnectorCapabilities.make({}),
        userPrompt: "irrelevant",
        workDir: "/repo",
        workspace: "/repo"
      }
      assert.strictEqual(flowReviewer(context), cleanReviewer)
    })
  )

  it.effect("completeAndPublish streams a response and publishes it as an assistant message", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      const content = yield* completeAndPublish(coderService(asked), events, "say hi")
      assert.strictEqual(content, "done")
    })
  )

  it.effect("chatPerTask false or omitted: one Chat is shared across every task", () =>
    Effect.gen(function* () {
      const runPlan = (chatPerTask?: boolean) =>
        Effect.gen(function* () {
          const events = yield* makeFlowEventHub()
          const historyLengths = yield* Ref.make<ReadonlyArray<number>>([])
          const gitLog = yield* Ref.make<GitLog>({ branches: [], commits: [] })
          const memory = yield* makeMemoryPlainFileStore()
          const store = makePlanStore(memory.store)
          const plan = Plan.make({
            epicId: "epic-chat-shared",
            tasks: [
              Task.make({ title: "first task", description: "do the first thing" }),
              Task.make({ title: "second task", description: "do the second thing" })
            ]
          })
          const context: FlowContextShape = {
            reasoning: cleanReviewer,
            coder: historyTrackingCoderService(historyLengths),
            git: makeFakeGit(gitLog),
            hosting: failingHosting,
            events,
            reviewers: [cleanReviewer],
            coderCapabilities: ConnectorCapabilities.make({}),
            userPrompt: "implement the plan",
            workDir: "/repo",
            workspace: "/repo"
          }

          yield* implementPlanFlow(context, {
            store,
            planPath: ".llm4ts/plan-chat-shared.md",
            plan: Effect.succeed(plan),
            ...(chatPerTask === undefined ? {} : { chatPerTask })
          })

          return yield* Ref.get(historyLengths)
        })

      const withoutOption = yield* runPlan(undefined)
      const withFalse = yield* runPlan(false)

      // Each history includes the leading git-ownership system message, so the
      // first call already sees length 2 (system + user), not 1. Second task's
      // history is longer than the first's: the Chat is shared across tasks,
      // growing with each round trip.
      assert.deepStrictEqual(withoutOption, [2, 4])
      assert.deepStrictEqual(withFalse, withoutOption)
    })
  )

  it.effect(
    "chatPerTask false or omitted: the shared Chat's system prompt never carries plan progress",
    () =>
      Effect.gen(function* () {
        const events = yield* makeFlowEventHub()
        const snapshots = yield* Ref.make<ReadonlyArray<ReadonlyArray<Message>>>([])
        const gitLog = yield* Ref.make<GitLog>({ branches: [], commits: [] })
        const memory = yield* makeMemoryPlainFileStore()
        const store = makePlanStore(memory.store)
        const flowSystem = "Stay terse and avoid comments."
        const plan = Plan.make({
          epicId: "epic-chat-shared-content",
          tasks: [
            Task.make({ title: "first task", description: "do the first thing" }),
            Task.make({ title: "second task", description: "do the second thing" })
          ]
        })
        const context: FlowContextShape = {
          reasoning: cleanReviewer,
          coder: messageSnapshotCoderService(snapshots),
          git: makeFakeGit(gitLog),
          hosting: failingHosting,
          events,
          reviewers: [cleanReviewer],
          coderCapabilities: ConnectorCapabilities.make({}),
          userPrompt: "implement the plan",
          workDir: "/repo",
          workspace: "/repo"
        }

        yield* implementPlanFlow(context, {
          store,
          planPath: ".llm4ts/plan-chat-shared-content.md",
          plan: Effect.succeed(plan),
          system: flowSystem
        })

        const seen = yield* Ref.get(snapshots)
        const systemMessage = (index: number) => seen[index]?.[0]?.content

        // The shared-Chat branch builds its system prompt straight from
        // options.system, bypassing composeSystem entirely — so it must stay
        // identical across tasks and must never pick up plan.render, unlike
        // the chatPerTask:true path exercised above.
        const expected = [gitOwnershipInstruction, flowSystem].join("\n\n")
        assert.strictEqual(systemMessage(0), expected)
        assert.strictEqual(systemMessage(1), expected)
      })
  )

  it.effect(
    "chatPerTask true: each task gets a fresh Chat, but its review-fix rounds share it",
    () =>
      Effect.gen(function* () {
        const events = yield* makeFlowEventHub()
        const historyLengths = yield* Ref.make<ReadonlyArray<number>>([])
        const spent = yield* Ref.make(false)
        const gitLog = yield* Ref.make<GitLog>({ branches: [], commits: [] })
        const memory = yield* makeMemoryPlainFileStore()
        const store = makePlanStore(memory.store)
        const plan = Plan.make({
          epicId: "epic-chat-per-task",
          tasks: [
            Task.make({ title: "first task", description: "do the first thing" }),
            Task.make({ title: "second task", description: "do the second thing" })
          ]
        })
        const context: FlowContextShape = {
          reasoning: cleanReviewer,
          coder: historyTrackingCoderService(historyLengths),
          git: makeFakeGit(gitLog),
          hosting: failingHosting,
          events,
          reviewers: [dirtyOnceReviewer(spent)],
          coderCapabilities: ConnectorCapabilities.make({}),
          userPrompt: "implement the plan",
          workDir: "/repo",
          workspace: "/repo"
        }

        yield* implementPlanFlow(context, {
          store,
          planPath: ".llm4ts/plan-chat-per-task.md",
          plan: Effect.succeed(plan),
          chatPerTask: true
        })

        const historyLengthsSeen = yield* Ref.get(historyLengths)

        // Task 1: fresh Chat (system + user = 2), then one fix round on that
        // same Chat after the reviewer's single dirty verdict (system + user +
        // assistant + user = 4). Task 2: a new fresh Chat resets back to 2 —
        // proving cross-task isolation while task 1's rounds shared one Chat.
        assert.deepStrictEqual(historyLengthsSeen, [2, 4, 2])
      })
  )

  it.effect(
    "chatPerTask true: each fresh Chat's system prompt carries the configured system prompt and current plan progress",
    () =>
      Effect.gen(function* () {
        const events = yield* makeFlowEventHub()
        const snapshots = yield* Ref.make<ReadonlyArray<ReadonlyArray<Message>>>([])
        const gitLog = yield* Ref.make<GitLog>({ branches: [], commits: [] })
        const memory = yield* makeMemoryPlainFileStore()
        const store = makePlanStore(memory.store)
        const flowSystem = "Stay terse and avoid comments."
        const plan = Plan.make({
          epicId: "epic-chat-progress",
          tasks: [
            Task.make({ title: "first task", description: "do the first thing" }),
            Task.make({ title: "second task", description: "do the second thing" })
          ]
        })
        const context: FlowContextShape = {
          reasoning: cleanReviewer,
          coder: messageSnapshotCoderService(snapshots),
          git: makeFakeGit(gitLog),
          hosting: failingHosting,
          events,
          reviewers: [cleanReviewer],
          coderCapabilities: ConnectorCapabilities.make({}),
          userPrompt: "implement the plan",
          workDir: "/repo",
          workspace: "/repo"
        }

        yield* implementPlanFlow(context, {
          store,
          planPath: ".llm4ts/plan-chat-progress.md",
          plan: Effect.succeed(plan),
          system: flowSystem,
          chatPerTask: true
        })

        const seen = yield* Ref.get(snapshots)
        const systemMessage = (index: number) => seen[index]?.[0]?.content

        // Chat.ts prepends the fixed git-ownership instruction ahead of the
        // options.system it's given, joined with a blank line; Flow's
        // composeSystem joins the configured system with the plan's render,
        // also with a blank line — both join points are exercised here since
        // `system` is supplied alongside chatPerTask: true.
        assert.strictEqual(
          systemMessage(0),
          [gitOwnershipInstruction, flowSystem, plan.render].join("\n\n")
        )
        assert.strictEqual(
          systemMessage(1),
          [gitOwnershipInstruction, flowSystem, plan.complete("first task").render].join("\n\n")
        )
      })
  )

  it.effect(
    "chatPerTask true: a task skipped for producing no changes still marks progress complete for the next task's fresh Chat",
    () =>
      Effect.gen(function* () {
        const events = yield* makeFlowEventHub()
        const snapshots = yield* Ref.make<ReadonlyArray<ReadonlyArray<Message>>>([])
        const gitLog = yield* Ref.make<GitLog>({ branches: [], commits: [] })
        const diffCalls = yield* Ref.make(0)
        const memory = yield* makeMemoryPlainFileStore()
        const store = makePlanStore(memory.store)
        const plan = Plan.make({
          epicId: "epic-chat-skip-progress",
          tasks: [
            Task.make({ title: "already done", description: "nothing to change" }),
            Task.make({ title: "second task", description: "do the second thing" })
          ]
        })
        const context: FlowContextShape = {
          reasoning: cleanReviewer,
          coder: messageSnapshotCoderService(snapshots, "TASK_ALREADY_SATISFIED"),
          git: makeFakeGitSkippingFirstDiff(gitLog, diffCalls),
          hosting: failingHosting,
          events,
          reviewers: [cleanReviewer],
          coderCapabilities: ConnectorCapabilities.make({}),
          userPrompt: "implement the plan",
          workDir: "/repo",
          workspace: "/repo"
        }

        const completed = yield* implementPlanFlow(context, {
          store,
          planPath: ".llm4ts/plan-chat-skip-progress.md",
          plan: Effect.succeed(plan),
          chatPerTask: true
        })

        const seen = yield* Ref.get(snapshots)
        const log = yield* Ref.get(gitLog)

        assert.isTrue(completed.tasks.every((task) => task.completed))
        // Only the second task commits — the first produced no diff and was
        // skipped — yet its fresh Chat's system prompt must show task one as
        // already complete, proving the skip branch advances `progress` too.
        assert.deepStrictEqual(log.commits, ["epic-chat-skip-progress: second task"])
        assert.strictEqual(seen.length, 3)
        assert.match(seen[1]?.at(-1)?.content ?? "", /TASK_ALREADY_SATISFIED/)
        assert.strictEqual(
          seen[2]?.[0]?.content,
          [gitOwnershipInstruction, plan.complete("already done").render].join("\n\n")
        )
      })
  )

  it.effect(
    "chatPerTask true: resuming a plan with already-completed tasks seeds the first fresh Chat's progress",
    () =>
      Effect.gen(function* () {
        const events = yield* makeFlowEventHub()
        const snapshots = yield* Ref.make<ReadonlyArray<ReadonlyArray<Message>>>([])
        const gitLog = yield* Ref.make<GitLog>({ branches: [], commits: [] })
        const planPath = ".llm4ts/plan-chat-resume.md"
        const plan = Plan.make({
          epicId: "epic-chat-resume",
          tasks: [
            Task.make({
              title: "first task",
              description: "do the first thing",
              completed: true
            }),
            Task.make({ title: "second task", description: "do the second thing" })
          ]
        })
        const memory = yield* makeMemoryPlainFileStore({ [planPath]: plan.render })
        const store = makePlanStore(memory.store)
        const context: FlowContextShape = {
          reasoning: cleanReviewer,
          coder: messageSnapshotCoderService(snapshots),
          git: makeFakeGit(gitLog),
          hosting: failingHosting,
          events,
          reviewers: [cleanReviewer],
          coderCapabilities: ConnectorCapabilities.make({}),
          userPrompt: "implement the plan",
          workDir: "/repo",
          workspace: "/repo"
        }

        yield* implementPlanFlow(context, {
          store,
          planPath,
          // The store already holds `plan`, so recoverOrCreate loads it and
          // this is never invoked.
          plan: unusedFlow,
          chatPerTask: true
        })

        const seen = yield* Ref.get(snapshots)
        const log = yield* Ref.get(gitLog)

        // Only the second task runs perTask (the first is already complete
        // and implementTaskLoop skips it), so exactly one fresh Chat is
        // created — and its system prompt must already show task one as
        // [x], proving progress is seeded from the recovered plan and not
        // from a fresh, all-incomplete copy.
        assert.strictEqual(seen.length, 1)
        assert.strictEqual(
          seen[0]?.[0]?.content,
          [gitOwnershipInstruction, plan.render].join("\n\n")
        )
        assert.deepStrictEqual(log.commits, ["epic-chat-resume: second task"])
      })
  )

  it.effect(
    "chatPerTask true: a lint-gate failure aborts before the failing task's progress is marked complete",
    () =>
      Effect.gen(function* () {
        const events = yield* makeFlowEventHub()
        const snapshots = yield* Ref.make<ReadonlyArray<ReadonlyArray<Message>>>([])
        const gitLog = yield* Ref.make<GitLog>({ branches: [], commits: [] })
        const planPath = ".llm4ts/plan-chat-lint-abort.md"
        const memory = yield* makeMemoryPlainFileStore()
        const store = makePlanStore(memory.store)
        const plan = Plan.make({
          epicId: "epic-chat-lint-abort",
          tasks: [
            Task.make({ title: "impossible task", description: "cannot go green" }),
            Task.make({ title: "second task", description: "do the second thing" })
          ]
        })
        const redGate = Effect.succeed(
          ReviewResult.make({
            issues: [
              ReviewIssue.make({ severity: "Critical", title: "typecheck failed", description: "" })
            ],
            summary: "gate red"
          })
        )
        const context: FlowContextShape = {
          reasoning: cleanReviewer,
          coder: messageSnapshotCoderService(snapshots),
          git: makeFakeGit(gitLog),
          hosting: failingHosting,
          events,
          reviewers: [cleanReviewer],
          coderCapabilities: ConnectorCapabilities.make({}),
          userPrompt: "implement",
          workDir: "/repo",
          workspace: "/repo"
        }

        const error = yield* Effect.flip(
          implementPlanFlow(context, {
            store,
            planPath,
            plan: Effect.succeed(plan),
            chatPerTask: true,
            maxRounds: 1,
            lint: redGate
          })
        )
        const log = yield* Ref.get(gitLog)
        const seen = yield* Ref.get(snapshots)
        const persisted = yield* store.load(planPath)

        assert.strictEqual(error._tag, "Aborted")
        assert.deepStrictEqual(log.commits, [])
        // The flow aborts entirely on the first task's lint failure — a
        // second task (and a second fresh Chat) never runs, and the
        // persisted plan still shows the failing task incomplete.
        assert.strictEqual(seen.length, 1)
        assert.strictEqual(persisted?.tasks[0]?.completed, false)
      })
  )
})

describe("Flow gate and diff safety", () => {
  it.effect("refuses to commit when the lint gate is still failing after review settles", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      const gitLog = yield* Ref.make<GitLog>({ branches: [], commits: [] })
      const memory = yield* makeMemoryPlainFileStore()
      const store = makePlanStore(memory.store)
      const plan = Plan.make({
        epicId: "epic-red",
        tasks: [Task.make({ title: "impossible task", description: "cannot go green" })]
      })
      const redGate = Effect.succeed(
        ReviewResult.make({
          issues: [
            ReviewIssue.make({ severity: "Critical", title: "typecheck failed", description: "" })
          ],
          summary: "gate red"
        })
      )
      const context: FlowContextShape = {
        reasoning: cleanReviewer,
        coder: coderService(asked),
        git: makeFakeGit(gitLog),
        hosting: failingHosting,
        events,
        reviewers: [cleanReviewer],
        coderCapabilities: ConnectorCapabilities.make({}),
        userPrompt: "implement",
        workDir: "/repo",
        workspace: "/repo"
      }

      const error = yield* Effect.flip(
        implementPlanFlow(context, {
          store,
          planPath: ".llm4ts/plan-red.md",
          plan: Effect.succeed(plan),
          maxRounds: 1,
          lint: redGate
        })
      )
      const log = yield* Ref.get(gitLog)

      assert.strictEqual(error._tag, "Aborted")
      assert.match(error.message, /refusing to commit/)
      assert.deepStrictEqual(log.commits, [])
    })
  )

  it.effect("skips no-change tasks only when the coder confirms them satisfied", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      const gitLog = yield* Ref.make<GitLog>({ branches: [], commits: [] })
      const memory = yield* makeMemoryPlainFileStore()
      const store = makePlanStore(memory.store)
      const plan = Plan.make({
        epicId: "epic-noop",
        tasks: [Task.make({ title: "already done", description: "nothing to change" })]
      })
      const confirmingCoder: LlmServiceShape = {
        ...coderService(asked),
        executeStreamWithHistory: (messages) =>
          Stream.unwrap(
            Ref.update(asked, (current) => [...current, messages.at(-1)?.content ?? ""]).pipe(
              Effect.as(
                Stream.make(
                  LlmChunk.make({ delta: "TASK_ALREADY_SATISFIED", finishReason: "stop" })
                )
              )
            )
          )
      }
      const context: FlowContextShape = {
        reasoning: cleanReviewer,
        coder: confirmingCoder,
        git: { ...makeFakeGit(gitLog), diffAll: Effect.succeed("") },
        hosting: failingHosting,
        events,
        reviewers: [cleanReviewer],
        coderCapabilities: ConnectorCapabilities.make({}),
        userPrompt: "implement",
        workDir: "/repo",
        workspace: "/repo"
      }

      const completed = yield* implementPlanFlow(context, {
        store,
        planPath: ".llm4ts/plan-noop.md",
        plan: Effect.succeed(plan)
      })
      const log = yield* Ref.get(gitLog)
      const prompts = yield* Ref.get(asked)

      assert.isTrue(completed.tasks.every((task) => task.completed))
      assert.deepStrictEqual(log.commits, [])
      assert.strictEqual(prompts.length, 2)
      assert.match(prompts[1] ?? "", /TASK_ALREADY_SATISFIED/)
    })
  )

  it.effect("fails a no-change task whose coder does not confirm it satisfied", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      const gitLog = yield* Ref.make<GitLog>({ branches: [], commits: [] })
      const memory = yield* makeMemoryPlainFileStore()
      const store = makePlanStore(memory.store)
      const plan = Plan.make({
        epicId: "epic-silent",
        tasks: [Task.make({ title: "unimplemented task", description: "needs real work" })]
      })
      const context: FlowContextShape = {
        reasoning: cleanReviewer,
        coder: coderService(asked),
        git: { ...makeFakeGit(gitLog), diffAll: Effect.succeed("") },
        hosting: failingHosting,
        events,
        reviewers: [cleanReviewer],
        coderCapabilities: ConnectorCapabilities.make({}),
        userPrompt: "implement",
        workDir: "/repo",
        workspace: "/repo"
      }

      const error = yield* Effect.flip(
        implementPlanFlow(context, {
          store,
          planPath: ".llm4ts/plan-silent.md",
          plan: Effect.succeed(plan)
        })
      )
      const log = yield* Ref.get(gitLog)
      const persisted = yield* store.load(".llm4ts/plan-silent.md")

      assert.strictEqual(error._tag, "Aborted")
      assert.match(error.message, /did not confirm TASK_ALREADY_SATISFIED/)
      assert.deepStrictEqual(log.commits, [])
      assert.isFalse(persisted?.tasks.some((task) => task.completed))
    })
  )
})
