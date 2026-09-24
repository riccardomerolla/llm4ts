import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { ConnectorCapabilities, LlmChunk, TokenUsage, type Message } from "@llm4ts/core/Models"
import { gitOwnershipInstruction } from "@llm4ts/flow/Chat"
import {
  implementPlanFlow,
  flowReviewer,
  completeAndPublish,
  satisfiedByJudgment,
  structuredAndPublish
} from "@llm4ts/flow/Flow"
import { FlowAborted, type FlowError } from "@llm4ts/flow/FlowError"
import type { FlowContextShape } from "@llm4ts/flow/FlowContext"
import { makeCollectingFlowEvents, makeFlowEventHub, type FlowEvent } from "@llm4ts/flow/FlowEvents"
import { Committed, type GitToolShape } from "@llm4ts/flow/GitTool"
import type { GitHubToolShape } from "@llm4ts/flow/GitHubTool"
import { Plan, Task } from "@llm4ts/flow/Plan"
import { ReviewIssue, ReviewResult } from "@llm4ts/flow/Review"
import { makeMemoryPlainFileStore, makePlanStore } from "@llm4ts/flow/Persistence"
import { unsupportedScoreLabels } from "@llm4ts/core/LabelScoring"
import { makeFakeJudgment } from "@llm4ts/core/judgment/FakeJudgment"
import { JudgmentBackendError } from "@llm4ts/core/judgment/Judgment"
import { origins, truthAnswer } from "@llm4ts/core/judgment/Schemas"
import type { JudgmentMode } from "@llm4ts/flow/Judgment"

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
  scoreLabels: unsupportedScoreLabels,
  isAvailable: Effect.succeed(true)
})

const structuredService = (
  value: unknown,
  usage: TokenUsage | undefined,
  model: string | undefined
): LlmServiceShape => ({
  executeStream: (_prompt) => Stream.make(LlmChunk.make({ delta: "done", finishReason: "stop" })),
  executeStreamWithHistory: (_messages) =>
    Stream.make(LlmChunk.make({ delta: "done", finishReason: "stop" })),
  executeWithTools: (_prompt, _tools) => Effect.fail(unused),
  executeStructured: (_prompt, schema, _jsonSchema) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.orDie),
  executeStructuredWithUsage: (_prompt, schema, _jsonSchema) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.orDie,
      Effect.map((decoded) => [decoded, usage, model] as const)
    ),
  scoreLabels: unsupportedScoreLabels,
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
  scoreLabels: unsupportedScoreLabels,
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
  scoreLabels: unsupportedScoreLabels,
  isAvailable: Effect.succeed(true)
})

const cleanReviewer: LlmServiceShape = {
  executeStream: (_prompt) => Stream.empty,
  executeStreamWithHistory: (_messages) => Stream.empty,
  executeWithTools: (_prompt, _tools) => Effect.fail(unused),
  executeStructured: (_prompt, schema, _jsonSchema) =>
    Schema.decodeUnknownEffect(schema)({ issues: [], summary: "clean" }).pipe(Effect.orDie),
  // The review path asks for usage; this backend reports none.
  executeStructuredWithUsage: (_prompt, schema, _jsonSchema) =>
    Schema.decodeUnknownEffect(schema)({ issues: [], summary: "clean" }).pipe(
      Effect.orDie,
      Effect.map((value) => [value, undefined, undefined] as const)
    ),
  scoreLabels: unsupportedScoreLabels,
  isAvailable: Effect.succeed(true)
}

// Reports one issue the first time it is asked, then clean forever after —
// enough to force exactly one review-fix round.
const dirtyOnceReviewer = (spent: Ref.Ref<boolean>): LlmServiceShape => {
  const next = <A, E, RD, RE>(schema: Schema.ConstraintCodec<A, E, RD, RE>) =>
    Ref.getAndSet(spent, true).pipe(
      Effect.flatMap((wasSpent) =>
        Schema.decodeUnknownEffect(schema)(
          wasSpent
            ? { issues: [], summary: "clean" }
            : { issues: [{ severity: "Warning", title: "nit", description: "" }], summary: "dirty" }
        ).pipe(Effect.orDie)
      )
    )
  return {
    executeStream: (_prompt) => Stream.empty,
    executeStreamWithHistory: (_messages) => Stream.empty,
    executeWithTools: (_prompt, _tools) => Effect.fail(unused),
    executeStructured: (_prompt, schema, _jsonSchema) => next(schema),
    executeStructuredWithUsage: (_prompt, schema, _jsonSchema) =>
      next(schema).pipe(Effect.map((value) => [value, undefined, undefined] as const)),
    scoreLabels: unsupportedScoreLabels,
    isAvailable: Effect.succeed(true)
  }
}

interface GitLog {
  readonly branches: ReadonlyArray<string>
  readonly commits: ReadonlyArray<string>
}

const makeFakeGit = (log: Ref.Ref<GitLog>): GitToolShape => ({
  init: Effect.void,
  initBare: Effect.void,
  config: (_key, _value) => Effect.void,
  status: Effect.succeed(""),
  uncommittedFiles: Effect.succeed([]),
  currentBranch: Effect.succeed("main"),
  diff: Effect.succeed("diff --git a/file b/file"),
  diffAll: Effect.succeed("diff --git a/file b/file\n+new content"),
  defaultBase: Effect.succeed("main"),
  diffVsBase: (_base, _threeDot) => Effect.succeed(""),
  diffVsBaseScoped: (_base, _paths, _threeDot) => Effect.succeed(""),
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
  commitPaths: (message, _paths) =>
    Ref.update(log, (current) => ({ ...current, commits: [...current.commits, message] })).pipe(
      Effect.as(Committed.make({}))
    ),
  push: (_remote, _branch) => Effect.void,
  checkpoint: Effect.succeed("checkpoint"),
  rollback: (_checkpoint) => Effect.void,
  addWorktree: (_path, _branch) => Effect.void,
  addWorktreeNewBranch: (_path, _branch, _startPoint) => Effect.void,
  removeWorktree: (_path, _force) => Effect.void,
  moveWorktree: (_from, _to) => Effect.void,
  restorePaths: () => Effect.void,
  branchExists: (_name) => Effect.succeed(false),
  deleteBranch: (_name) => Effect.void,
  isAncestor: (_commit, _of) => Effect.succeed(false),
  merge: (_branch, _message) => Effect.void
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
  readIssueComments: (_ref) => unusedFlow,
  writeIssueComment: (_ref, _body) => unusedFlow,
  editIssueComment: (_comment, _body) => unusedFlow,
  writePrComment: (_pr, _body) => unusedFlow,
  updatePr: (_pr, _title, _body) => unusedFlow,
  prChecks: (_pr) => unusedFlow,
  viewOpenPr: unusedFlow,
  mergePr: (_pr, _method, _deleteBranch) => unusedFlow,
  listIssues: (_repo, _filter) => unusedFlow,
  createIssue: (_repo, _title, _body, _labels) => unusedFlow,
  editIssueLabels: (_ref, _add, _remove) => unusedFlow,
  assignIssue: (_ref, _login) => unusedFlow,
  closeIssue: (_ref, _comment) => unusedFlow
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

  // Structured calls are the whole spine of the modernization phases; when
  // their usage went unpublished every such run summarised as "no usage
  // reported" no matter how many tokens the backend counted.
  it.effect("structuredAndPublish publishes the usage its provider reported", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const seen: Array<FlowEvent> = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* events.subscribe
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
            Effect.forkScoped
          )
          const value = yield* structuredAndPublish(
            structuredService(
              { summary: "ok" },
              TokenUsage.make({ prompt: 900, completion: 500, total: 1500, cached: 100 }),
              "gemini-2.5-pro"
            ),
            events,
            "summarise",
            Schema.Struct({ summary: Schema.String }),
            {}
          )
          assert.deepStrictEqual(value, { summary: "ok" })
          yield* Effect.yieldNow
        })
      )

      const tokens = seen.filter((event) => event._tag === "TokensUsed")
      assert.strictEqual(tokens.length, 1)
      assert.strictEqual(
        tokens[0]?._tag === "TokensUsed" ? tokens[0].model : undefined,
        "gemini-2.5-pro"
      )
      assert.strictEqual(tokens[0]?._tag === "TokensUsed" ? tokens[0].usage.prompt : undefined, 900)
      assert.strictEqual(
        tokens[0]?._tag === "TokensUsed" ? tokens[0].agent : undefined,
        "reasoning"
      )
    })
  )

  it.effect("structuredAndPublish stays silent when the provider reports no usage", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const seen: Array<FlowEvent> = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* events.subscribe
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
            Effect.forkScoped
          )
          yield* structuredAndPublish(
            structuredService({ summary: "ok" }, undefined, undefined),
            events,
            "summarise",
            Schema.Struct({ summary: Schema.String }),
            {}
          )
          yield* Effect.yieldNow
        })
      )

      assert.isTrue(seen.every((event) => event._tag !== "TokensUsed"))
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
  it.effect("keeps the literal probe result on held or failed judgments", () =>
    Effect.gen(function* () {
      const held = yield* makeFakeJudgment({
        answers: { satisfied: truthAnswer(0.5, origins.fake()) }
      })
      const failed = yield* makeFakeJudgment({ failures: { satisfied: "no answer" } })
      const broken = {
        ...failed.judgment,
        judge: () =>
          Effect.fail(JudgmentBackendError.make({ backend: "fake", message: "unavailable" }))
      }
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      const gitLog = yield* Ref.make<GitLog>({ branches: [], commits: [] })
      for (const judgment of [held.judgment, failed.judgment, broken]) {
        const events = yield* makeCollectingFlowEvents
        const context: FlowContextShape = {
          reasoning: cleanReviewer,
          coder: coderService(asked),
          judgment,
          git: makeFakeGit(gitLog),
          hosting: failingHosting,
          events,
          reviewers: [cleanReviewer],
          coderCapabilities: ConnectorCapabilities.make({}),
          userPrompt: "implement",
          workDir: "/repo",
          workspace: "/repo"
        }
        for (const literalMatch of [true, false]) {
          const reply = literalMatch ? "TASK_ALREADY_SATISFIED" : "No work done."
          assert.strictEqual(yield* satisfiedByJudgment(context, "task", reply), literalMatch)
          assert.strictEqual(yield* satisfiedByJudgment(context, "task", reply, "act"), undefined)
        }
        const observations = (yield* events.recorded).filter(
          (event) => event._tag === "JudgmentObserved"
        )
        assert.strictEqual(observations.length, judgment === held.judgment ? 2 : 0)
        if (judgment === held.judgment) assert.strictEqual(observations[0]?.decision, "hold")
      }
    })
  )

  const modes: ReadonlyArray<JudgmentMode | undefined> = [undefined, "observe", "advise", "act"]
  for (const mode of modes) {
    for (const literalMatch of [true, false]) {
      it.effect(`satisfied probe ${mode ?? "default"} with literal match ${literalMatch}`, () =>
        Effect.gen(function* () {
          const events = yield* makeCollectingFlowEvents
          const snapshots = yield* Ref.make<ReadonlyArray<ReadonlyArray<Message>>>([])
          const gitLog = yield* Ref.make<GitLog>({ branches: [], commits: [] })
          const memory = yield* makeMemoryPlainFileStore()
          const store = makePlanStore(memory.store)
          const plan = Plan.make({
            epicId: "probe",
            tasks: [Task.make({ title: "task", description: "task" })]
          })
          const reply = literalMatch ? "TASK_ALREADY_SATISFIED" : "Already done."
          // Deliberately disagree with the literal path in both directions.
          const answer = truthAnswer(literalMatch ? 0 : 1, origins.llm("logprobs"))
          const fake = yield* makeFakeJudgment({ answers: { satisfied: answer } })
          const context: FlowContextShape = {
            reasoning: cleanReviewer,
            coder: messageSnapshotCoderService(snapshots, reply),
            judgment: fake.judgment,
            git: { ...makeFakeGit(gitLog), diffAll: Effect.succeed("") },
            hosting: failingHosting,
            events,
            reviewers: [cleanReviewer],
            coderCapabilities: ConnectorCapabilities.make({}),
            userPrompt: "implement",
            workDir: "/repo",
            workspace: "/repo"
          }
          const result = yield* implementPlanFlow(context, {
            store,
            planPath: "plan.md",
            plan: Effect.succeed(plan),
            satisfiedProbe: mode === undefined ? {} : { mode }
          }).pipe(Effect.result)
          const completes = mode === "act" ? !literalMatch : literalMatch
          assert.strictEqual(result._tag, completes ? "Success" : "Failure")
          assert.strictEqual((yield* store.load("plan.md"))?.tasks[0]?.completed, completes)
          assert.strictEqual((yield* Ref.get(snapshots)).length, 2)
          assert.deepStrictEqual((yield* Ref.get(gitLog)).commits, [])
          const requests = yield* fake.recorded
          assert.strictEqual(requests.length, 1)
          assert.deepStrictEqual(requests[0]?.state, { task: "task", reply })
          const recorded = yield* events.recorded
          const observations = recorded.filter((event) => event._tag === "JudgmentObserved")
          assert.strictEqual(observations.length, mode === "act" ? 0 : 1)
          if (mode !== "act") {
            assert.deepStrictEqual(observations[0]?.outcome, {
              _tag: "SatisfiedProbe",
              literalMatch
            })
            assert.strictEqual(observations[0]?.consumer, "satisfied-probe")
            assert.strictEqual(observations[0]?.key, "satisfied")
            assert.deepStrictEqual(observations[0]?.state, (yield* fake.recorded)[0]?.state)
            assert.deepStrictEqual(
              observations[0]?.question,
              (yield* fake.recorded)[0]?.questions["satisfied"]
            )
            assert.strictEqual(observations[0]?.judgmentIdentity, fake.judgment.identity)
            assert.deepStrictEqual(observations[0]?.answer, answer)
            assert.strictEqual(observations[0]?.mode, mode ?? "observe")
            assert.strictEqual(observations[0]?.decision, "act")
            assert.strictEqual(observations[0]?.certainty, 1)
            assert.strictEqual(observations[0]?.support, 1)
            assert.deepStrictEqual(observations[0]?.origin, answer.origin)
          }
          const advice = recorded.filter(
            (event) => event._tag === "Info" && event.message.includes("judgment satisfied-probe")
          )
          assert.strictEqual(advice.length, mode === "advise" ? 1 : 0)
          if (mode === "advise") {
            const first = advice[0]
            assert.include(
              first?._tag === "Info" ? first.message : "",
              `act; outcome {"_tag":"SatisfiedProbe","literalMatch":${literalMatch}}`
            )
          }
        })
      )
    }
  }

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
      const fake = yield* makeFakeJudgment({ defaultTruth: 0 })
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
        judgment: fake.judgment,
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
      assert.strictEqual((yield* fake.recorded).length, 0)
      assert.match(prompts[1] ?? "", /TASK_ALREADY_SATISFIED/)
    })
  )

  it.effect("reads the confirmation through the judgment service when asked to", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      const gitLog = yield* Ref.make<GitLog>({ branches: [], commits: [] })
      const memory = yield* makeMemoryPlainFileStore()
      const store = makePlanStore(memory.store)
      const plan = Plan.make({
        epicId: "epic-noop-judged",
        tasks: [Task.make({ title: "already done", description: "nothing to change" })]
      })
      // The coder says so in its own words, without the literal token.
      const proseCoder: LlmServiceShape = {
        ...coderService(asked),
        executeStreamWithHistory: (messages) =>
          Stream.unwrap(
            Ref.update(asked, (current) => [...current, messages.at(-1)?.content ?? ""]).pipe(
              Effect.as(
                Stream.make(
                  LlmChunk.make({
                    delta: "Nothing to do: the guard already exists at line 40.",
                    finishReason: "stop"
                  })
                )
              )
            )
          )
      }
      const judgment = yield* makeFakeJudgment({
        answers: { satisfied: truthAnswer(0.97, origins.llm("logprobs")) }
      })
      const context: FlowContextShape = {
        reasoning: cleanReviewer,
        coder: proseCoder,
        judgment: judgment.judgment,
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
        planPath: ".llm4ts/plan-noop-judged.md",
        plan: Effect.succeed(plan),
        satisfiedProbe: "judgment"
      })
      const [request] = yield* judgment.recorded

      assert.isTrue(completed.tasks.every((task) => task.completed))
      assert.deepStrictEqual((yield* Ref.get(gitLog)).commits, [])
      assert.deepStrictEqual(request?.state, {
        task: "already done",
        reply: "Nothing to do: the guard already exists at line 40."
      })
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

  it.effect("completes an unconfirmed no-change task when noopTaskPolicy is complete", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const asked = yield* Ref.make<ReadonlyArray<string>>([])
      const gitLog = yield* Ref.make<GitLog>({ branches: [], commits: [] })
      const memory = yield* makeMemoryPlainFileStore()
      const store = makePlanStore(memory.store)
      const plan = Plan.make({
        epicId: "epic-lenient",
        tasks: [Task.make({ title: "unconfirmed no-op", description: "already satisfied" })]
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

      const completed = yield* implementPlanFlow(context, {
        store,
        planPath: ".llm4ts/plan-lenient.md",
        plan: Effect.succeed(plan),
        noopTaskPolicy: "complete"
      })
      const log = yield* Ref.get(gitLog)

      assert.isTrue(completed.tasks.every((task) => task.completed))
      assert.deepStrictEqual(log.commits, [])
    })
  )
})
