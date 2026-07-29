import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Redacted from "effect/Redacted"
import { ApiConnectorConfig, CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { ConnectorIds } from "@llm4ts/core/Models"
import * as Effect from "effect/Effect"
import {
  anthropic,
  apiConnectorFromEnvironment,
  asReadOnly,
  antigravity,
  claude,
  coderFromEnv,
  codex,
  cursor,
  enrichApiConnector,
  gemini,
  geminiApi,
  grok,
  lmStudio,
  mock,
  ollama,
  openAI,
  opencode,
  pi,
  prepareConnector,
  withEnvironment,
  withModel,
  withTimeoutSeconds,
  withTurnLimit
} from "@llm4ts/runner/Connectors"

describe("runner connector presets", () => {
  it("targets edit-capable defaults", () => {
    assert.strictEqual(claude.connectorId.value, "claude-cli")
    assert.deepStrictEqual(claude.flags, {
      "permission-mode": "acceptEdits"
    })
    assert.deepStrictEqual(codex.flags, {
      sandbox: "workspace-write"
    })
    assert.strictEqual(gemini.connectorId.value, "gemini-cli")
    assert.strictEqual(pi.connectorId.value, "pi")
    assert.deepStrictEqual(antigravity.flags, {
      mode: "accept-edits"
    })
    assert.strictEqual(grok.connectorId.value, "grok")
    assert.strictEqual(cursor.connectorId.value, "cursor")
    assert.strictEqual(opencode.connectorId.value, "opencode")
  })

  it("provides a local LM Studio reasoning seat", () => {
    assert.strictEqual(lmStudio.connectorId.value, "lm-studio")
    assert.strictEqual(lmStudio.baseUrl, "http://localhost:1234/v1")
  })

  it("provides API presets for every live HTTP family", () => {
    assert.strictEqual(openAI.connectorId.value, "openai")
    assert.strictEqual(anthropic.connectorId.value, "anthropic")
    assert.strictEqual(geminiApi.connectorId.value, "gemini-api")
    assert.strictEqual(ollama.connectorId.value, "ollama")
    assert.strictEqual(mock.connectorId.value, "mock")
  })

  it("composes model and turn-limit transforms immutably", () => {
    const configured = withTurnLimit(withModel(gemini, "gemini-2.5-pro"), 40)

    assert.strictEqual(configured.model, "gemini-2.5-pro")
    assert.strictEqual(configured.turnLimit, 40)
    assert.strictEqual(gemini.model, undefined)
    assert.strictEqual(gemini.turnLimit, undefined)
    assert.strictEqual(withModel(openAI, "gpt-test").model, "gpt-test")
    assert.strictEqual(withTimeoutSeconds(openAI, 600).timeout.pipe(Duration.toSeconds), 600)
  })

  it("merges CLI environment and derives a read-only seat immutably", () => {
    const local = withEnvironment(claude, {
      ANTHROPIC_BASE_URL: "http://localhost:1234",
      ANTHROPIC_AUTH_TOKEN: "lmstudio"
    })

    assert.strictEqual(local.envVars.ANTHROPIC_BASE_URL, "http://localhost:1234")
    assert.isTrue(asReadOnly(local).readOnly)
    assert.deepStrictEqual(claude.envVars, {})
  })

  it("enriches API defaults and credentials without replacing explicit values", () => {
    const enriched = enrichApiConnector(openAI, {
      OPENAI_API_KEY: "secret"
    })
    const explicit = enrichApiConnector(
      ApiConnectorConfig.make({
        connectorId: ConnectorIds.OpenAI,
        baseUrl: "https://proxy.example/v1",
        apiKey: Redacted.make("explicit")
      }),
      { OPENAI_API_KEY: "ignored" }
    )

    assert.strictEqual(enriched.baseUrl, "https://api.openai.com/v1")
    assert.strictEqual(
      enriched.apiKey === undefined ? undefined : Redacted.value(enriched.apiKey),
      "secret"
    )
    assert.strictEqual(explicit.baseUrl, "https://proxy.example/v1")
    assert.strictEqual(
      explicit.apiKey === undefined ? undefined : Redacted.value(explicit.apiKey),
      "explicit"
    )
  })

  it("roots CLI configurations in the target repository", () => {
    const prepared = prepareConnector(codex, "/work/repo", {})
    assert.isTrue(prepared instanceof CliConnectorConfig)
    assert.strictEqual(
      prepared instanceof CliConnectorConfig ? prepared.workingDir : undefined,
      "/work/repo"
    )
  })

  it("selects from LLM4TS_CODER, retains the legacy name, and defaults to Claude", () => {
    assert.strictEqual(coderFromEnv({}), claude)
    assert.strictEqual(coderFromEnv({ LLM4TS_CODER: "codex" }), codex)
    assert.strictEqual(coderFromEnv({ LLM4TS_CODER: "pi", LLM4ZIO_CODER: "codex" }), pi)
    assert.strictEqual(coderFromEnv({ LLM4ZIO_CODER: "codex" }), codex)
    assert.strictEqual(coderFromEnv({ LLM4ZIO_CODER: "gemini" }), gemini)
    assert.strictEqual(coderFromEnv({ LLM4ZIO_CODER: "pi" }), pi)
    assert.strictEqual(coderFromEnv({ LLM4ZIO_CODER: "agy" }), antigravity)
    assert.strictEqual(coderFromEnv({ LLM4ZIO_CODER: "grok" }), grok)
    assert.strictEqual(coderFromEnv({ LLM4ZIO_CODER: "cursor" }), cursor)
    assert.strictEqual(coderFromEnv({ LLM4ZIO_CODER: "opencode" }), opencode)
    assert.strictEqual(coderFromEnv({ LLM4ZIO_CODER: "unknown" }), claude)
  })
})

describe("api connector from environment", () => {
  it.effect("defaults to the mock connector with zero configuration", () =>
    Effect.gen(function* () {
      const config = yield* apiConnectorFromEnvironment({})
      assert.strictEqual(config.connectorId.value, "mock")
    })
  )

  it.effect("selects the provider and applies the model", () =>
    Effect.gen(function* () {
      const config = yield* apiConnectorFromEnvironment({
        LLM4TS_PROVIDER: "anthropic",
        LLM4TS_MODEL: "claude-sonnet-4-5"
      })
      assert.strictEqual(config.connectorId.value, "anthropic")
      assert.strictEqual(config.model, "claude-sonnet-4-5")
    })
  )

  it.effect("fails with guidance for unknown providers and missing models", () =>
    Effect.gen(function* () {
      const unknown = yield* Effect.flip(apiConnectorFromEnvironment({ LLM4TS_PROVIDER: "nope" }))
      assert.strictEqual(unknown._tag, "ScriptUsage")
      assert.include(unknown.message, "mock|openai|anthropic|gemini|lm-studio|ollama")
      const missingModel = yield* Effect.flip(
        apiConnectorFromEnvironment({ LLM4TS_PROVIDER: "openai" })
      )
      assert.strictEqual(missingModel._tag, "ScriptUsage")
      assert.include(missingModel.message, "LLM4TS_MODEL is required")
    })
  )
})
