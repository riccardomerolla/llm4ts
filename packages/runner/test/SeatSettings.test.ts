import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { CliConnectorConfig, type ConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { makeConnectorRegistry } from "@llm4ts/core/ConnectorRegistry"
import { makeFakeProcessExecutor } from "@llm4ts/core/ProcessExecutor"
import { makeMockProvider } from "@llm4ts/core/providers/MockProvider"
import { ConnectorIds, LlmConfig } from "@llm4ts/core/Models"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { asReadOnly, claude, codex, pi, withModel } from "@llm4ts/runner/Connectors"
import { runEmbedded, type FlowRunnerOptions } from "@llm4ts/runner/FlowRunner"
import { plainTerminalPalette } from "@llm4ts/runner/Terminal"

interface Resolved {
  readonly connector: string
  readonly model?: string
  readonly flags: Readonly<Record<string, string>>
  readonly readOnly: boolean
}

/**
 * Runs a flow the way `runNode` does, with fake CLI connectors that record
 * the configuration each seat was resolved with, and the run's banner.
 */
const run = (
  seats: Pick<FlowRunnerOptions, "coder" | "reasoning" | "reviewers">,
  environment: Readonly<Record<string, string>>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const resolved = yield* Ref.make<ReadonlyArray<Resolved>>([])
      const banner = yield* Ref.make<ReadonlyArray<string>>([])
      const record = (configuration: ConnectorConfig) =>
        Ref.update(resolved, (current) => [
          ...current,
          {
            connector: configuration.connectorId.value,
            ...(configuration.model === undefined ? {} : { model: configuration.model }),
            flags: configuration instanceof CliConnectorConfig ? configuration.flags : {},
            readOnly: configuration instanceof CliConnectorConfig && configuration.readOnly
          }
        ]).pipe(Effect.as(makeMockProvider(LlmConfig.make({ provider: "Mock", model: "mock" }))))
      const registry = makeConnectorRegistry([
        { connectorId: ConnectorIds.ClaudeCli, kind: "Cli", create: record },
        { connectorId: ConnectorIds.Codex, kind: "Cli", create: record },
        { connectorId: ConnectorIds.Pi, kind: "Cli", create: record }
      ])
      const process = yield* makeFakeProcessExecutor()
      const { store: files } = yield* makeMemoryPlainFileStore()
      yield* runEmbedded(
        {
          workDir: "/repo",
          workspace: "/repo",
          userPrompt: "do it",
          roster: "none",
          persistRun: false,
          environment,
          surface: {
            palette: plainTerminalPalette,
            log: (line) => Ref.update(banner, (current) => [...current, line]),
            setStatus: (_label) => Effect.void,
            suspend: (effect) => effect
          },
          ...seats
        },
        () => Effect.void,
        { registry, process: process.executor, files }
      )
      return { seats: yield* Ref.get(resolved), banner: (yield* Ref.get(banner)).join("\n") }
    })
  )

/** Seats in the runner's resolution order: coder, reasoning, reviewers, then the judge. */
const models = (seats: ReadonlyArray<Resolved>) => seats.map((seat) => seat.model)

describe("the model settings reach every flow's seats", () => {
  it.effect(
    "an implement-shaped flow (claude coder, no reasoning seat) takes LLM4TS_CODER_MODEL",
    () =>
      Effect.gen(function* () {
        const { seats, banner } = yield* run(
          { coder: claude },
          { LLM4TS_CODER_MODEL: "some-model" }
        )
        // The reasoning seat is the coder seat when the flow names none, model included.
        assert.deepStrictEqual(models(seats), ["some-model", "some-model", "some-model"])
        assert.include(banner, "coder claude-cli (some-model)")
      })
  )

  it.effect("the reasoning seat takes LLM4TS_REASONING_MODEL over the coder's", () =>
    Effect.gen(function* () {
      const { seats } = yield* run(
        { coder: claude },
        { LLM4TS_CODER_MODEL: "coder-model", LLM4TS_REASONING_MODEL: "reasoning-model" }
      )
      assert.deepStrictEqual(models(seats), ["coder-model", "reasoning-model", "reasoning-model"])
    })
  )

  it.effect("a separate reasoner keeps the coder's model off: it runs another agent", () =>
    Effect.gen(function* () {
      const { seats } = yield* run(
        { coder: claude, reasoning: codex, reviewers: [asReadOnly(claude), asReadOnly(codex)] },
        { LLM4TS_CODER_MODEL: "claude-model" }
      )
      // coder, reasoning (codex), the claude reviewer, the codex reviewer, the judge (codex).
      assert.deepStrictEqual(models(seats), [
        "claude-model",
        undefined,
        "claude-model",
        undefined,
        undefined
      ])
    })
  )

  it.effect("a seat on the reasoner's agent takes the reasoning model", () =>
    Effect.gen(function* () {
      const { seats } = yield* run(
        { coder: claude, reasoning: codex, reviewers: [asReadOnly(codex)] },
        { LLM4TS_CODER_MODEL: "claude-model", LLM4TS_REASONING_MODEL: "codex-model" }
      )
      assert.deepStrictEqual(models(seats), [
        "claude-model",
        "codex-model",
        "codex-model",
        "codex-model"
      ])
    })
  )
})

describe("the flag settings reach every flow's seats", () => {
  it.effect("LLM4TS_CODER_FLAGS adds to the coder's preset flags, not to the reasoner's", () =>
    Effect.gen(function* () {
      const { seats } = yield* run(
        { coder: claude },
        { LLM4TS_CODER_FLAGS: "allowedTools=Bash(git:*),Edit; max-turns=4" }
      )
      assert.deepStrictEqual(seats[0]?.flags, {
        "permission-mode": "acceptEdits",
        allowedTools: "Bash(git:*),Edit",
        "max-turns": "4"
      })
      // The read-only reasoning seat runs the coder's agent but not its edit permissions.
      assert.deepStrictEqual(seats[1], {
        connector: "claude-cli",
        flags: { "permission-mode": "acceptEdits" },
        readOnly: true
      })
    })
  )

  it.effect("LLM4TS_REASONING_FLAGS reaches the reasoning seat and the seats on its agent", () =>
    Effect.gen(function* () {
      const { seats } = yield* run(
        { coder: claude, reasoning: codex, reviewers: [asReadOnly(codex)] },
        { LLM4TS_REASONING_FLAGS: "config=model_provider=lmstudio" }
      )
      assert.deepStrictEqual(seats[0]?.flags, { "permission-mode": "acceptEdits" })
      for (const seat of seats.slice(1)) {
        assert.deepStrictEqual(seat.flags, {
          sandbox: "workspace-write",
          config: "model_provider=lmstudio"
        })
      }
    })
  )

  it.effect("a flag replaces the preset's value for the same key", () =>
    Effect.gen(function* () {
      const { seats } = yield* run(
        { coder: claude },
        { LLM4TS_CODER_FLAGS: "permission-mode=bypassPermissions" }
      )
      assert.deepStrictEqual(seats[0]?.flags, { "permission-mode": "bypassPermissions" })
    })
  )
})

describe("the epic flows' seats come out as before", () => {
  // epic-stories applied the four settings itself until 4.1.0: model and
  // flags of each role on its own seat, the reviewer built from the reasoner.
  it.effect("pi codes, claude reasons and reviews, each with its own settings", () =>
    Effect.gen(function* () {
      const { seats } = yield* run(
        { coder: pi, reasoning: claude, reviewers: [asReadOnly(claude)] },
        {
          LLM4TS_CODER_MODEL: "openai-codex/gpt-5.5",
          LLM4TS_CODER_FLAGS: "thinking=high",
          LLM4TS_REASONING_MODEL: "opus",
          LLM4TS_REASONING_FLAGS: "allowedTools=Read"
        }
      )
      const reasoner = { "permission-mode": "acceptEdits", allowedTools: "Read" }
      assert.deepStrictEqual(seats, [
        {
          connector: "pi",
          model: "openai-codex/gpt-5.5",
          flags: { thinking: "high" },
          readOnly: false
        },
        { connector: "claude-cli", model: "opus", flags: reasoner, readOnly: false },
        { connector: "claude-cli", model: "opus", flags: reasoner, readOnly: true },
        { connector: "claude-cli", model: "opus", flags: reasoner, readOnly: true }
      ])
    })
  )
})

describe("what a flow sets in code beats the environment", () => {
  it.effect("an explicit model stays", () =>
    Effect.gen(function* () {
      const { seats } = yield* run(
        { coder: withModel(claude, "flow-model"), reasoning: withModel(codex, "flow-reasoner") },
        { LLM4TS_CODER_MODEL: "env-model", LLM4TS_REASONING_MODEL: "env-reasoner" }
      )
      assert.deepStrictEqual(models(seats), ["flow-model", "flow-reasoner", "flow-reasoner"])
    })
  )

  it.effect("a flag the flow set stays; the flags it did not set are added", () =>
    Effect.gen(function* () {
      const coder = CliConnectorConfig.make({
        ...claude,
        flags: { ...claude.flags, "permission-mode": "plan" }
      })
      const { seats } = yield* run(
        { coder },
        { LLM4TS_CODER_FLAGS: "permission-mode=bypassPermissions; allowedTools=Edit" }
      )
      assert.deepStrictEqual(seats[0]?.flags, { "permission-mode": "plan", allowedTools: "Edit" })
    })
  )

  it.effect("with nothing set, every seat is the flow's own", () =>
    Effect.gen(function* () {
      const { seats } = yield* run({ coder: claude, reasoning: codex }, {})
      assert.deepStrictEqual(seats, [
        { connector: "claude-cli", flags: { "permission-mode": "acceptEdits" }, readOnly: false },
        { connector: "codex", flags: { sandbox: "workspace-write" }, readOnly: false },
        { connector: "codex", flags: { sandbox: "workspace-write" }, readOnly: true }
      ])
    })
  )
})
