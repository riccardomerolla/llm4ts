import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { ApiConnectorConfig, CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { makeConnectorRegistry } from "@llm4ts/core/ConnectorRegistry"
import type { Message } from "@llm4ts/core/Models"
import { ConnectorIds, LlmChunk, LlmConfig, type ConnectorId } from "@llm4ts/core/Models"
import { collect } from "@llm4ts/core/Streaming"
import { makeFakeProcessExecutor } from "@llm4ts/core/ProcessExecutor"
import { makeMockProvider } from "@llm4ts/core/providers/MockProvider"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { ExecutorSpec, RosterDocument } from "@llm4ts/flow/Roster"
import {
  executorConfig,
  loadRosterDocument,
  pauseExecutor,
  renderRosterReport,
  resumeExecutor,
  rosterReport,
  repoRosterPath,
  rosterStatePath,
  userRosterPath
} from "@llm4ts/runner/ExecutorRoster"
import { makeFlowRunnerContext } from "@llm4ts/runner/FlowRunner"

const environment = {
  HOME: "/home/me",
  LEMONADE_API_KEY: "sk-lemonade"
}

const roster = (executors: ReadonlyArray<Record<string, unknown>>): string =>
  JSON.stringify({ executors })

describe("roster files", () => {
  it("resolves the XDG paths", () => {
    assert.strictEqual(userRosterPath(environment), "/home/me/.config/llm4ts/roster.json")
    assert.strictEqual(
      userRosterPath({ ...environment, XDG_CONFIG_HOME: "/cfg" }),
      "/cfg/llm4ts/roster.json"
    )
    assert.strictEqual(repoRosterPath("/repo"), "/repo/.llm4ts/roster.json")
    assert.strictEqual(
      rosterStatePath(environment),
      "/home/me/.local/state/llm4ts/roster-state.json"
    )
  })

  it.effect("merges the repository roster over the user's, narrows, and opts out", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* memory.store.writeAtomic(
        userRosterPath(environment),
        roster([
          { id: "pi-local", harness: "pi", model: "lmstudio/qwen", roles: ["coder"] },
          { id: "codex", harness: "codex", roles: ["coder", "judge"], slots: 2 },
          { id: "claude", harness: "claude", roles: ["planner", "judge"] }
        ])
      )
      yield* memory.store.writeAtomic(
        repoRosterPath("/repo"),
        roster([{ id: "codex", harness: "codex", roles: ["coder"], disabled: true }])
      )
      const source = { files: memory.store, environment, workDir: "/repo" }
      const merged = yield* loadRosterDocument(source)
      assert.deepStrictEqual(
        merged?.executors.map((spec) => spec.id),
        ["pi-local", "claude"]
      )
      const narrowed = yield* loadRosterDocument({
        ...source,
        environment: { ...environment, LLM4TS_EXECUTORS: "claude" }
      })
      assert.deepStrictEqual(
        narrowed?.executors.map((spec) => spec.id),
        ["claude"]
      )
      assert.isUndefined(
        yield* loadRosterDocument({
          ...source,
          environment: { ...environment, LLM4TS_ROSTER: "none" }
        })
      )
      const unknown = yield* Effect.flip(
        loadRosterDocument({
          ...source,
          environment: { ...environment, LLM4TS_EXECUTORS: "gemini" }
        })
      )
      assert.include(unknown.message, "LLM4TS_EXECUTORS names 'gemini'")
      const empty = yield* makeMemoryPlainFileStore()
      assert.isUndefined(yield* loadRosterDocument({ ...source, files: empty.store }))
    })
  )

  it.effect("refuses a roster it cannot run, naming every problem", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* memory.store.writeAtomic(
        "/tmp/roster.json",
        roster([
          { id: "lm", harness: "lm-studio", roles: ["coder", "judge"] },
          { id: "x", harness: "vim", roles: ["coder"] },
          {
            id: "lemonade",
            harness: "opencode",
            roles: ["coder"],
            env: { LEMONADE_KEY: "${NOT_SET}" }
          }
        ])
      )
      const error = yield* Effect.flip(
        loadRosterDocument({
          files: memory.store,
          environment: { ...environment, LLM4TS_ROSTER: "/tmp/roster.json" },
          workDir: "/repo"
        })
      )
      assert.strictEqual(error._tag, "RosterInvalid")
      assert.include(error.message, "executor 'lm' is an API provider ('lm-studio')")
      assert.include(error.message, "executor 'x' has an unknown harness 'vim'")
      assert.include(error.message, "executor 'lemonade' references unset variable(s) NOT_SET")

      yield* memory.store.writeAtomic("/tmp/broken.json", "{ nope")
      const broken = yield* Effect.flip(
        loadRosterDocument({
          files: memory.store,
          environment: { ...environment, LLM4TS_ROSTER: "/tmp/broken.json" },
          workDir: "/repo"
        })
      )
      assert.include(broken.message, "not JSON")
    })
  )

  it("maps an executor to its harness preset, model, flags, environment and endpoint", () => {
    const opencode = executorConfig(
      ExecutorSpec.make({
        id: "lemonade",
        harness: "opencode",
        model: "lemonade/Ornith-1.5-35B-A3B-GGUF-Q5_K_M",
        roles: ["coder", "judge"],
        flags: { variant: "high" },
        env: { LEMONADE_API_KEY: "${LEMONADE_API_KEY}", MODE: "fast" }
      }),
      true,
      environment
    )
    assert.instanceOf(opencode, CliConnectorConfig)
    if (opencode instanceof CliConnectorConfig) {
      assert.strictEqual(opencode.connectorId.value, ConnectorIds.OpenCode.value)
      assert.strictEqual(opencode.model, "lemonade/Ornith-1.5-35B-A3B-GGUF-Q5_K_M")
      assert.strictEqual(opencode.flags.variant, "high")
      assert.strictEqual(opencode.envVars.LEMONADE_API_KEY, "sk-lemonade")
      assert.strictEqual(opencode.envVars.MODE, "fast")
      assert.isTrue(opencode.readOnly)
    }
    const lm = executorConfig(
      ExecutorSpec.make({
        id: "lm",
        harness: "lm-studio",
        model: "qwen",
        baseUrl: "http://gpu:1234/v1",
        roles: ["judge"]
      }),
      true,
      environment
    )
    assert.instanceOf(lm, ApiConnectorConfig)
    assert.strictEqual(lm?.connectorId.value, ConnectorIds.LmStudio.value)
    if (lm instanceof ApiConnectorConfig) {
      assert.strictEqual(lm.baseUrl, "http://gpu:1234/v1")
    }
    assert.isUndefined(
      executorConfig(
        ExecutorSpec.make({ id: "v", harness: "vim", roles: ["coder"] }),
        false,
        environment
      )
    )
  })
})

describe("llm4ts roster", () => {
  it.effect("reports the executors, pauses one for every run, and resumes it", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      yield* memory.store.writeAtomic(
        userRosterPath(environment),
        roster([
          { id: "pi-local", harness: "pi", model: "lmstudio/qwen", roles: ["coder"] },
          {
            id: "claude",
            harness: "claude",
            roles: ["coder", "judge"],
            slots: 3,
            priority: { coder: 3, default: 1 }
          }
        ])
      )
      const source = { files: memory.store, environment, workDir: "/repo" }
      const before = renderRosterReport(yield* rosterReport(source))
      assert.include(
        before,
        "- claude: claude · coder, judge · 3 slot(s), 2 for coding · priority coder 3, default 1"
      )
      assert.include(before, "in the round")

      const paused = yield* pauseExecutor(source, "claude", "2h")
      assert.strictEqual(paused.kind, "manual")
      assert.include(renderRosterReport(yield* rosterReport(source)), "out paused until")
      const missing = yield* Effect.flip(pauseExecutor(source, "gemini", undefined))
      assert.include(missing.message, "no executor 'gemini'")

      yield* resumeExecutor(source, "claude")
      assert.notInclude(renderRosterReport(yield* rosterReport(source)), "paused")
      const none = yield* makeMemoryPlainFileStore()
      assert.include(
        renderRosterReport(yield* rosterReport({ ...source, files: none.store })),
        "no roster"
      )
    })
  )
})

/** A connector that answers with its own name, so tests can see who served a call. */
const answering = (name: string, calls: Ref.Ref<ReadonlyArray<string>>) => {
  const mock = makeMockProvider(LlmConfig.make({ provider: "Mock", model: "mock" }))
  const answer = (prompt: string) =>
    Stream.unwrap(
      Effect.as(
        Ref.update(calls, (all) => [...all, `${name}: ${prompt}`]),
        Stream.make(LlmChunk.make({ delta: name, finishReason: "stop" }))
      )
    )
  return {
    ...mock,
    executeStream: answer,
    executeStreamWithHistory: (messages: ReadonlyArray<Message>) =>
      answer(messages.at(-1)?.content ?? "")
  }
}

describe("a run served from a roster", () => {
  it.effect("holds a coder per context and leases reasoning away from it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const process = yield* makeFakeProcessExecutor()
        const memory = yield* makeMemoryPlainFileStore()
        const calls = yield* Ref.make<ReadonlyArray<string>>([])
        const factory = (id: ConnectorId, name: string) => ({
          connectorId: id,
          kind: "Api" as const,
          create: () => Effect.succeed(answering(name, calls))
        })
        const registry = makeConnectorRegistry([
          factory(ConnectorIds.Pi, "pi"),
          factory(ConnectorIds.Codex, "codex"),
          factory(ConnectorIds.ClaudeCli, "claude")
        ])
        const document = RosterDocument.make({
          executors: [
            ExecutorSpec.make({ id: "pi-local", harness: "pi", roles: ["coder"], priority: 1 }),
            ExecutorSpec.make({
              id: "codex",
              harness: "codex",
              roles: ["coder", "reviewer", "judge"],
              slots: 2,
              priority: { coder: 2, default: 2 }
            }),
            ExecutorSpec.make({
              id: "claude",
              harness: "claude",
              roles: ["coder", "planner", "reviewer", "judge", "verifier"],
              slots: 3,
              priority: { coder: 3, default: 1 }
            })
          ]
        })
        const bundle = yield* makeFlowRunnerContext(
          {
            workDir: "/repo",
            workspace: "/repo",
            userPrompt: "epic",
            // Ignored under a roster: the flow's own seat choice.
            coder: CliConnectorConfig.make({ connectorId: ConnectorIds.GeminiCli }),
            roster: document,
            environment: { HOME: "/home/me" }
          },
          { registry, process: process.executor, files: memory.store }
        )
        const context = bundle.context
        assert.strictEqual(bundle.roster, document)
        assert.strictEqual(context.roster?.slots("coder"), 1 + 1 + 2)

        // The root planner goes to claude, the highest reasoning priority.
        const planned = yield* collect(context.reasoning.executeStream("split the epic"))
        assert.strictEqual(planned.content, "claude")

        const contextFor = context.contextFor
        if (contextFor === undefined) {
          throw new Error("no contextFor")
        }
        const storyA = yield* contextFor("/wt/a", { label: "story a" })
        const storyB = yield* contextFor("/wt/b", { label: "story b", prefer: "claude" })
        assert.strictEqual(yield* storyA.roster?.executor ?? Effect.succeed(undefined), "pi-local")
        assert.strictEqual(yield* storyB.roster?.executor ?? Effect.succeed(undefined), "claude")
        const coded = yield* collect(storyA.coder.executeStream("task 1"))
        assert.strictEqual(coded.content, "pi")

        // Story b's judge must not be claude, which codes it.
        const judge = storyB.roster?.forRole("judge")
        if (judge === undefined) {
          throw new Error("no judge")
        }
        const judged = yield* collect(judge.executeStream("judge b"))
        assert.strictEqual(judged.content, "codex")
        // pi and one of claude's two coder slots are held; codex and claude have one each left.
        assert.strictEqual(yield* context.roster?.available("coder") ?? Effect.succeed(-1), 2)
      })
    )
  )
})
