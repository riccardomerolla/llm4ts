import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { ConnectorCapabilities, LlmChunk } from "@llm4ts/core/Models"
import {
  makeFakeProcessExecutor,
  processCommandKey,
  ProcessResult
} from "@llm4ts/core/ProcessExecutor"
import { makeLocalBoardSync } from "@llm4ts/flow/BoardSync"
import type { FlowContextShape } from "@llm4ts/flow/FlowContext"
import { FlowAborted, type FlowError } from "@llm4ts/flow/FlowError"
import { makeFlowEventHub } from "@llm4ts/flow/FlowEvents"
import { Committed, type GitToolShape } from "@llm4ts/flow/GitTool"
import type { GitHubToolShape } from "@llm4ts/flow/GitHubTool"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { Plan, Task } from "@llm4ts/flow/Plan"
import { ReviewResult } from "@llm4ts/flow/Review"
import { implementStoriesFlow, type StorySeats } from "@llm4ts/flow/Stories"
import {
  parseStoryPlan,
  storyPlanViolations,
  topologicalWaves,
  type Story,
  type StoryPlan
} from "@llm4ts/flow/StoryPlan"
import {
  defaultGateCommands,
  epicIdFor,
  gateCommands,
  gatesIn,
  judgeStory,
  parseEpicArgs,
  reasonerFromEnvironment,
  storyCoderFromEnvironment,
  storyPlanInstructions
} from "../lib/epic-stories.ts"

const fixture = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "fixtures",
    "epic-stories",
    "conto-bonifico.md"
  ),
  "utf8"
)

const unused = InvalidRequestError.make({ message: "unused in test" })
const unusedFlow: Effect.Effect<never, FlowError> = Effect.fail(
  FlowAborted.make({ message: "unused in test" })
)

const replying = (reply: string): LlmServiceShape => ({
  executeStream: () => Stream.make(LlmChunk.make({ delta: reply, finishReason: "stop" })),
  executeStreamWithHistory: () =>
    Stream.make(LlmChunk.make({ delta: reply, finishReason: "stop" })),
  executeWithTools: () => Effect.fail(unused),
  executeStructured: () => Effect.fail(unused),
  executeStructuredWithUsage: () => Effect.fail(unused),
  isAvailable: Effect.succeed(true)
})

/** Structured answers decode `value`; used for the review verdicts and the judge scores. */
const structured = (value: unknown): LlmServiceShape => ({
  executeStream: () => Stream.empty,
  executeStreamWithHistory: () => Stream.empty,
  executeWithTools: () => Effect.fail(unused),
  executeStructured: (_prompt, schema) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.orDie),
  executeStructuredWithUsage: (_prompt, schema) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.orDie,
      Effect.map((decoded) => [decoded, undefined, undefined] as const)
    ),
  isAvailable: Effect.succeed(true)
})

const cleanReview = structured({ issues: [], summary: "clean" })

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

const gitOver = (log: Ref.Ref<ReadonlyArray<string>>, prefix: string): GitToolShape => {
  const note = (entry: string): Effect.Effect<void> =>
    Ref.update(log, (current) => [...current, `${prefix}${entry}`])
  return {
    init: Effect.void,
    initBare: Effect.void,
    config: () => Effect.void,
    status: Effect.succeed(""),
    currentBranch: Effect.succeed("main"),
    diff: Effect.succeed(""),
    diffAll: Effect.succeed("diff --git a/file b/file\n+work"),
    defaultBase: Effect.succeed("main"),
    diffVsBase: () => Effect.succeed("diff --git a/file b/file\n+story"),
    diffVsBaseScoped: () => Effect.succeed(""),
    changedFilesVsBase: () => Effect.succeed([]),
    addRemote: () => Effect.void,
    checkout: () => Effect.void,
    checkoutOrCreate: (name) => note(`checkout:${name}`),
    createBranch: () => unusedFlow,
    commitAll: (message) => note(`commit:${message}`).pipe(Effect.as(Committed.make({}))),
    push: () => Effect.void,
    checkpoint: Effect.succeed("head"),
    rollback: () => Effect.void,
    addWorktree: () => Effect.void,
    addWorktreeNewBranch: (_path, branch) => note(`worktree:${branch}`),
    removeWorktree: () => Effect.void,
    branchExists: () => Effect.succeed(false),
    deleteBranch: () => Effect.void,
    isAncestor: () => Effect.succeed(false),
    merge: (branch) => note(`merge:${branch}`)
  }
}

const parsedFixture = Effect.runSync(parseStoryPlan(fixture))

describe("epic-stories flags and seats", () => {
  it.effect("parses its own flags and leaves the rest for the shared parser", () =>
    Effect.gen(function* () {
      const flags = yield* parseEpicArgs([
        "--plan-only",
        "--concurrency",
        "2",
        "--repo",
        "/repo",
        "--fail-fast",
        "Add Conto"
      ])
      assert.isTrue(flags.planOnly)
      assert.isTrue(flags.failFast)
      assert.strictEqual(flags.concurrency, 2)
      assert.deepStrictEqual(flags.rest, ["--repo", "/repo", "Add Conto"])
      const bad = yield* Effect.flip(parseEpicArgs(["--concurrency", "zero"]))
      assert.strictEqual(bad._tag, "ScriptUsage")
    })
  )

  it.effect("defaults to claude as reasoner and pi as coder, refusing unknown names", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* reasonerFromEnvironment({})).connectorId.value, "claude-cli")
      assert.strictEqual(
        (yield* reasonerFromEnvironment({ LLM4TS_REASONER: "gemini" })).connectorId.value,
        "gemini-cli"
      )
      assert.strictEqual((yield* storyCoderFromEnvironment({})).connectorId.value, "pi")
      const bad = yield* Effect.flip(reasonerFromEnvironment({ LLM4TS_REASONER: "nope" }))
      assert.include(bad.message, "unknown LLM4TS_REASONER")
    })
  )

  it("derives a readable, stable epic id and lists the gates", () => {
    const id = epicIdFor("Add the retail customer's current account (Conto)")
    assert.match(id, /^add-the-retail-customer-[0-9a-f]{6}$/)
    assert.strictEqual(id, epicIdFor("Add the retail customer's current account (Conto)"))
    assert.deepStrictEqual(gateCommands({}), defaultGateCommands)
    assert.deepStrictEqual(gateCommands({ LLM4TS_GATES: "pnpm typecheck; pnpm test" }), [
      ["pnpm", "typecheck"],
      ["pnpm", "test"]
    ])
    assert.include(storyPlanInstructions("conto-bonifico", "rules"), 'epicId: "conto-bonifico"')
    assert.include(storyPlanInstructions("conto-bonifico", "rules"), "pairwise DISJOINT")
  })

  it.effect("gates stop at the first red command", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["pnpm", "typecheck"]),
            ProcessResult.make({ exitCode: 0, stdout: [], stderr: [] })
          ],
          [
            processCommandKey(["pnpm", "lint"]),
            ProcessResult.make({ exitCode: 1, stdout: ["nope"], stderr: [] })
          ],
          [
            processCommandKey(["pnpm", "test"]),
            ProcessResult.make({ exitCode: 0, stdout: [], stderr: [] })
          ]
        ])
      })
      const result = yield* gatesIn(fake.executor, events, [
        ["pnpm", "typecheck"],
        ["pnpm", "lint"],
        ["pnpm", "test"]
      ])("/wt")
      assert.isFalse(result.isClean)
      const invoked = yield* fake.recorded
      assert.deepStrictEqual(
        invoked.map((call) => call.argv.join(" ")),
        ["pnpm typecheck", "pnpm lint"]
      )
      assert.isTrue(invoked.every((call) => call.cwd === "/wt"))
    })
  )

  it.effect("the story judge turns sub-bar dimensions into critical issues", () =>
    Effect.gen(function* () {
      const story = parsedFixture.stories[0]
      if (story === undefined) {
        return yield* FlowAborted.make({ message: "fixture has no stories" })
      }
      const strict = structured({
        scores: [
          { name: "provides", score: 2, reasoning: "" },
          { name: "scope", score: 1, reasoning: "touched the kit" },
          { name: "house-style", score: 2, reasoning: "" },
          { name: "tests", score: 2, reasoning: "" }
        ]
      })
      const verdict = yield* judgeStory(strict, story, "diff", 1000)
      assert.strictEqual(verdict.issues.length, 1)
      assert.include(verdict.issues[0]?.title ?? "", "scope scored 1")
    })
  )
})

describe("epic-stories demo plan", () => {
  it("the committed Conto e Bonifico plan is valid and splits into three waves", () => {
    assert.strictEqual(parsedFixture.epicId, "conto-bonifico")
    assert.strictEqual(parsedFixture.stories.length, 8)
    assert.deepStrictEqual(storyPlanViolations(parsedFixture), [])
    assert.deepStrictEqual(topologicalWaves(parsedFixture), [
      ["accounts-contract", "payments-contract", "iban-field"],
      ["conto-overview", "conto-movimenti", "bonifico-form", "bonifici-list"],
      ["home"]
    ])
    const home = parsedFixture.story("home")
    assert.include(home?.owned ?? [], "src/App.tsx")
    // The composition point belongs to the fan-in alone.
    assert.deepStrictEqual(
      parsedFixture.stories.filter((story) => story.owned.includes("src/App.tsx")).map((s) => s.id),
      ["home"]
    )
  })

  it.effect(
    "drives the executor with fakes: every story merges, dependents after their predecessors",
    () =>
      Effect.gen(function* () {
        const events = yield* makeFlowEventHub()
        const log = yield* Ref.make<ReadonlyArray<string>>([])
        const memory = yield* makeMemoryPlainFileStore()
        const plan: StoryPlan = parsedFixture
        const context: FlowContextShape = {
          reasoning: cleanReview,
          coder: replying("done"),
          git: gitOver(log, ""),
          hosting,
          events,
          reviewers: [cleanReview],
          coderCapabilities: ConnectorCapabilities.make({}),
          userPrompt: plan.epic,
          workDir: "/repo",
          workspace: "/repo"
        }
        const stateDir = "/repo/.llm4ts/epics/conto-bonifico"
        const report = yield* implementStoriesFlow(context, {
          plan,
          files: memory.store,
          stateDir,
          worktreeRoot: "/repo/.llm4ts/worktrees",
          board: makeLocalBoardSync(memory.store, stateDir, "Epic: conto-bonifico"),
          contextFor: (workDir) =>
            Effect.succeed<StorySeats>({
              context: {
                ...context,
                git: {
                  ...gitOver(log, `${workDir.split("/").at(-1) ?? ""}:`),
                  changedFilesVsBase: () =>
                    Effect.succeed(
                      (plan.story(workDir.split("/").at(-1) ?? "")?.owned ?? []).map((path) =>
                        path.endsWith(".ts") || path.endsWith(".json") || path.endsWith(".tsx")
                          ? path
                          : `${path}/index.ts`
                      )
                    )
                },
                workDir
              }
            }),
          gates: () => Effect.succeed(ReviewResult.make({ issues: [], summary: "green" })),
          planTasks: (_seats, story: Story) =>
            Effect.succeed(
              Plan.make({
                epicId: story.id,
                tasks: [Task.make({ title: `${story.id} task`, description: story.description })]
              })
            ),
          concurrency: 3
        })

        assert.strictEqual(report.count("done"), 8)
        const entries = yield* Ref.get(log)
        const at = (entry: string): number => entries.indexOf(entry)
        assert.isAbove(
          at("worktree:story/conto-bonifico/home"),
          at("merge:story/conto-bonifico/bonifico-form")
        )
        assert.isAbove(
          at("worktree:story/conto-bonifico/home"),
          at("merge:story/conto-bonifico/conto-movimenti")
        )
        assert.isAbove(
          at("worktree:story/conto-bonifico/bonifico-form"),
          at("merge:story/conto-bonifico/iban-field")
        )
        const files = yield* memory.files
        assert.include(files[`${stateDir}/report.md`] ?? "", "| home | done |")
        assert.include(files[`${stateDir}/board.md`] ?? "", "done: 8")
      })
  )
})
