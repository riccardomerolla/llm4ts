import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { ConnectorCapabilities, LlmChunk } from "@llm4ts/core/Models"
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

const cleanReviewer: LlmServiceShape = {
  executeStream: (_prompt) => Stream.empty,
  executeStreamWithHistory: (_messages) => Stream.empty,
  executeWithTools: (_prompt, _tools) => Effect.fail(unused),
  executeStructured: (_prompt, schema, _jsonSchema) =>
    Schema.decodeUnknownEffect(schema)({ issues: [], summary: "clean" }).pipe(Effect.orDie),
  executeStructuredWithUsage: (_prompt, _schema, _jsonSchema) => Effect.fail(unused),
  isAvailable: Effect.succeed(true)
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

  it.effect(
    "chatPerTask is accepted but unwired: shared-Chat behavior is identical whether it is omitted or true",
    () =>
      Effect.gen(function* () {
        const runPlan = (chatPerTask?: boolean) =>
          Effect.gen(function* () {
            const events = yield* makeFlowEventHub()
            const historyLengths = yield* Ref.make<ReadonlyArray<number>>([])
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
              reviewers: [cleanReviewer],
              coderCapabilities: ConnectorCapabilities.make({}),
              userPrompt: "implement the plan",
              workDir: "/repo",
              workspace: "/repo"
            }

            yield* implementPlanFlow(context, {
              store,
              planPath: ".llm4ts/plan-chat-per-task.md",
              plan: Effect.succeed(plan),
              ...(chatPerTask === undefined ? {} : { chatPerTask })
            })

            return yield* Ref.get(historyLengths)
          })

        const withoutOption = yield* runPlan(undefined)
        const withTrue = yield* runPlan(true)
        const withFalse = yield* runPlan(false)

        // Each history includes the leading git-ownership system message, so the
        // first call already sees length 2 (system + user), not 1. Second task's
        // history is longer than the first's: the Chat is shared across tasks,
        // growing with each round trip, regardless of chatPerTask.
        assert.deepStrictEqual(withoutOption, [2, 4])
        assert.deepStrictEqual(withTrue, withoutOption)
        assert.deepStrictEqual(withFalse, withoutOption)
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

  it.effect("skips review and commit for tasks that produce no changes", () =>
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
        planPath: ".llm4ts/plan-noop.md",
        plan: Effect.succeed(plan)
      })
      const log = yield* Ref.get(gitLog)

      assert.isTrue(completed.tasks.every((task) => task.completed))
      assert.deepStrictEqual(log.commits, [])
    })
  )
})
