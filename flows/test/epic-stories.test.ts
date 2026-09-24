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
  awaitServer,
  defaultGateCommands,
  epicIdFor,
  flagsFromEnvironment,
  gateCommands,
  gatesIn,
  judgeStory,
  localCoderServer,
  parseEpicArgs,
  reasonerFromEnvironment,
  serverHealthUrl,
  setupIn,
  storyCoderFromEnvironment,
  storyPlanInstructions,
  verifyBlockedOn,
  worktreeRootFor,
  worktreeSetupCommand
} from "../lib/epic-stories.ts"
import { unsupportedScoreLabels } from "@llm4ts/core/LabelScoring"

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
  scoreLabels: unsupportedScoreLabels,
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
  scoreLabels: unsupportedScoreLabels,
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
    uncommittedFiles: Effect.succeed([]),
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
    commitPaths: (message) => note(`commit:${message}`).pipe(Effect.as(Committed.make({}))),
    push: () => Effect.void,
    checkpoint: Effect.succeed("head"),
    rollback: () => Effect.void,
    addWorktree: () => Effect.void,
    addWorktreeNewBranch: (_path, branch) => note(`worktree:${branch}`),
    removeWorktree: () => Effect.void,
    moveWorktree: () => Effect.void,
    restorePaths: () => Effect.void,
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

  it("parses seat flags and recognises a local single-model server", () => {
    assert.deepStrictEqual(
      flagsFromEnvironment("config=model_provider=lmstudio; profile=fast;yolo"),
      {
        config: "model_provider=lmstudio",
        profile: "fast",
        yolo: ""
      }
    )
    assert.deepStrictEqual(flagsFromEnvironment(undefined), {})
    assert.strictEqual(localCoderServer("lmstudio/qwen/qwen3.6-35b-a3b:medium", {}, {}), "lmstudio")
    assert.strictEqual(localCoderServer("ollama/qwen3", {}, {}), "ollama")
    assert.strictEqual(
      localCoderServer(undefined, { config: "model_provider=lmstudio" }, {}),
      "lmstudio"
    )
    assert.strictEqual(
      localCoderServer("qwen/qwen3.6-35b-a3b", {}, { ANTHROPIC_BASE_URL: "http://127.0.0.1:1234" }),
      "local"
    )
    assert.isUndefined(localCoderServer("openai-codex/gpt-6-astra:low", {}, {}))
    assert.isUndefined(
      localCoderServer(undefined, {}, { ANTHROPIC_BASE_URL: "https://api.anthropic.com" })
    )
  })

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

  it.effect("worktree setup defaults to an offline install and fails typed with the output", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(worktreeSetupCommand({}), ["pnpm", "install", "--offline"])
      assert.isUndefined(worktreeSetupCommand({ LLM4TS_WORKTREE_SETUP: " " }))
      assert.deepStrictEqual(worktreeSetupCommand({ LLM4TS_WORKTREE_SETUP: "npm ci" }), [
        "npm",
        "ci"
      ])
      const events = yield* makeFlowEventHub()
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [
            processCommandKey(["pnpm", "install", "--offline"]),
            ProcessResult.make({ exitCode: 1, stdout: [], stderr: ["ERR_PNPM_NO_OFFLINE_META"] })
          ]
        ])
      })
      const error = yield* Effect.flip(
        setupIn(fake.executor, events, ["pnpm", "install", "--offline"])("/wt")
      )
      assert.include(error.message, "worktree setup failed (pnpm install --offline)")
      assert.include(error.message, "ERR_PNPM_NO_OFFLINE_META")
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

describe("epic-stories worktrees, outages and blocked claims", () => {
  it("puts worktrees beside the repository and finds a local engine's health URL", () => {
    assert.strictEqual(
      worktreeRootFor("/Users/me/demo/portal/", "conto-bonifico", {}),
      "/Users/me/demo/portal.worktrees/conto-bonifico"
    )
    assert.strictEqual(
      worktreeRootFor("/Users/me/demo/portal", "e", { LLM4TS_WORKTREE_ROOT: "/tmp/trees" }),
      "/tmp/trees/e"
    )
    assert.strictEqual(serverHealthUrl("lmstudio", {}), "http://127.0.0.1:1234/v1/models")
    assert.strictEqual(serverHealthUrl("ollama", {}), "http://127.0.0.1:11434/api/tags")
    assert.strictEqual(
      serverHealthUrl("local", { ANTHROPIC_BASE_URL: "http://127.0.0.1:1234/v1/" }),
      "http://127.0.0.1:1234/v1/models"
    )
    assert.strictEqual(
      serverHealthUrl(undefined, { LLM4TS_CODER_HEALTH_URL: "http://gpu:8080/health" }),
      "http://gpu:8080/health"
    )
    assert.isUndefined(serverHealthUrl(undefined, {}))
  })

  it.effect("waits until the engine answers, and gives up typed when it never does", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const probes = yield* Ref.make(0)
      const timing = { interval: "0 millis", attempts: 5, grace: "0 millis" } as const
      const upOnThird = Effect.map(
        Ref.updateAndGet(probes, (n) => n + 1),
        (n) => n >= 3
      )
      yield* awaitServer(upOnThird, events, timing)("engine is recovering")
      assert.strictEqual(yield* Ref.get(probes), 3)

      const never = yield* Effect.flip(
        awaitServer(Effect.succeed(false), events, timing)("engine is recovering")
      )
      assert.include(never.message, "did not answer after 5 probes")
    })
  )

  it.effect("the verifier reads the named files from the story's worktree", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const memory = yield* makeMemoryPlainFileStore()
      yield* memory.store.writeAtomic(
        "/trees/conto-movimenti/src/contracts/accounts.fake.ts",
        "export const accountsDomain = domain(routes, connect)"
      )
      const prompts = yield* Ref.make<ReadonlyArray<string>>([])
      const reasoning: LlmServiceShape = {
        ...structured({ real: false, reason: "accountsDomain is in accounts.fake.ts" }),
        executeStructured: (prompt, schema) =>
          Ref.update(prompts, (all) => [...all, prompt]).pipe(
            Effect.andThen(
              Schema.decodeUnknownEffect(schema)({
                real: false,
                reason: "accountsDomain is in accounts.fake.ts"
              }).pipe(Effect.orDie)
            )
          ),
        executeStructuredWithUsage: (prompt, schema) =>
          Ref.update(prompts, (all) => [...all, prompt]).pipe(
            Effect.andThen(
              Schema.decodeUnknownEffect(schema)({
                real: false,
                reason: "accountsDomain is in accounts.fake.ts"
              }).pipe(Effect.orDie)
            ),
            Effect.map((decoded) => [decoded, undefined, undefined] as const)
          )
      }
      const movimenti = parsedFixture.story("conto-movimenti")
      if (movimenti === undefined) {
        throw new Error("conto-movimenti")
      }
      const verdict = yield* verifyBlockedOn(
        reasoning,
        events,
        memory.store,
        parsedFixture
      )(
        movimenti,
        "src/contracts/accounts.fake.ts must export accountsDomain; src/features/conta/ContoScreen.tsx",
        "/trees/conto-movimenti"
      )
      assert.isFalse(verdict.real)
      const asked = (yield* Ref.get(prompts)).join("\n")
      assert.include(asked, "export const accountsDomain = domain(routes, connect)")
      assert.include(
        asked,
        "### src/features/conta/ContoScreen.tsx\n(does not exist in the working tree)"
      )
      assert.include(asked, "- home (depends on: conto-overview")
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
