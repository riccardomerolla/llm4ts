import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import { ConnectorIds, HealthStatus } from "@llm4ts/core/Models"
import type { ConnectorRegistryShape } from "@llm4ts/core/ConnectorRegistry"
import {
  geminiBridgePrerequisites,
  geminiPrerequisites,
  makeDoctorProgram
} from "@llm4ts/runner/Doctor"

const noModelsJson = (): string | undefined => undefined

const unsupported = Effect.fail(InvalidRequestError.make({ message: "not supported in test" }))

const fakeRegistry: ConnectorRegistryShape = {
  resolve: () => unsupported,
  resolveApi: () => unsupported,
  resolveCli: () => unsupported,
  resolveFallback: () => unsupported,
  available: Effect.succeed([ConnectorIds.Mock]),
  healthCheckAll: Effect.succeed(
    new Map([
      [ConnectorIds.Mock, HealthStatus.make({ availability: "Healthy", authStatus: "Valid" })],
      [
        ConnectorIds.ClaudeCli,
        HealthStatus.make({ availability: "Unhealthy", authStatus: "Unknown" })
      ]
    ])
  )
}

describe("doctor", () => {
  it.effect("reports connector health, credentials, and the selected coder", () =>
    Effect.gen(function* () {
      const report = yield* makeDoctorProgram(fakeRegistry, {
        ANTHROPIC_API_KEY: "set-in-test",
        LLM4TS_CODER: "codex"
      })
      assert.include(report, "connectors:")
      assert.include(report, "✔ mock")
      assert.include(report, "✖ claude-cli")
      assert.include(report, "✔ ANTHROPIC_API_KEY")
      assert.include(report, "✖ OPENAI_API_KEY")
      assert.include(report, "coder: codex")
    })
  )

  it.effect("labels the default coder when no environment override exists", () =>
    Effect.gen(function* () {
      const report = yield* makeDoctorProgram(fakeRegistry, {})
      assert.include(report, "coder: claude (default)")
    })
  )

  it.effect("stays quiet about gemini when it is neither selected nor installed", () =>
    Effect.gen(function* () {
      const report = yield* makeDoctorProgram(fakeRegistry, { LLM4TS_CODER: "codex" })
      assert.notInclude(report, "prerequisites:")
    })
  )

  it.effect("stays quiet about the pi-gemini bridge when it wasn't asked for", () =>
    Effect.gen(function* () {
      const report = yield* makeDoctorProgram(fakeRegistry, {}, noModelsJson)
      assert.notInclude(report, "pi-gemini-bridge")
    })
  )

  it.effect("flags a missing pi models.json when the bridge is requested", () =>
    Effect.gen(function* () {
      const report = yield* makeDoctorProgram(
        fakeRegistry,
        { LLM4TS_GEMINI_BRIDGE: "1" },
        noModelsJson
      )
      assert.include(report, "? pi-gemini-bridge: ~/.pi/agent/models.json not found")
      assert.include(report, "http://127.0.0.1:8731")
      assert.include(report, "ADR 0016")
    })
  )

  it.effect("flags a models.json that doesn't point at the bridge port", () =>
    Effect.gen(function* () {
      const report = yield* makeDoctorProgram(fakeRegistry, { LLM4TS_GEMINI_BRIDGE: "1" }, () =>
        JSON.stringify({ providers: { anthropic: { baseUrl: "https://api.anthropic.com" } } })
      )
      assert.include(report, "? pi-gemini-bridge: no provider in ~/.pi/agent/models.json")
    })
  )

  it.effect("reports the bridge satisfied when a provider points at the configured port", () =>
    Effect.gen(function* () {
      const report = yield* makeDoctorProgram(
        fakeRegistry,
        { LLM4TS_GEMINI_BRIDGE: "1", LLM4TS_GEMINI_BRIDGE_PORT: "9000" },
        () =>
          JSON.stringify({
            providers: { gemini: { baseUrl: "http://127.0.0.1:9000", api: "anthropic-messages" } }
          })
      )
      assert.include(
        report,
        "✔ pi-gemini-bridge: a provider in ~/.pi/agent/models.json points at 127.0.0.1:9000"
      )
    })
  )

  it.effect("flags a selected gemini with no project or key in the environment", () =>
    Effect.gen(function* () {
      const report = yield* makeDoctorProgram(fakeRegistry, { LLM4TS_CODER: "gemini" })
      assert.include(report, "prerequisites:")
      assert.include(report, "gemini: no project or API key in the environment")
      // The report must name the failure the user would otherwise have to
      // decode from the Gemini CLI's own wording.
      assert.include(report, "No project found")
      assert.include(report, "GOOGLE_CLOUD_PROJECT")
    })
  )

  it.effect("reports gemini as satisfied when a project is configured", () =>
    Effect.gen(function* () {
      const report = yield* makeDoctorProgram(fakeRegistry, {
        LLM4TS_CODER: "gemini",
        GOOGLE_CLOUD_PROJECT: "meridian-modernization"
      })
      assert.include(report, "✔ gemini: GOOGLE_CLOUD_PROJECT=meridian-modernization")
      assert.notInclude(report, "No project found")
    })
  )

  it.effect("surfaces the check when the gemini CLI is installed but not selected", () =>
    Effect.gen(function* () {
      const withGemini: ConnectorRegistryShape = {
        ...fakeRegistry,
        healthCheckAll: Effect.succeed(
          new Map([
            [
              ConnectorIds.GeminiCli,
              HealthStatus.make({ availability: "Healthy", authStatus: "Unknown" })
            ]
          ])
        )
      }
      const report = yield* makeDoctorProgram(withGemini, { LLM4TS_CODER: "claude" })
      assert.include(report, "gemini: no project or API key in the environment")
    })
  )
})

describe("geminiPrerequisites", () => {
  it("accepts an AI Studio API key on its own", () => {
    const result = geminiPrerequisites({ GEMINI_API_KEY: "key" })
    assert.isTrue(result.satisfied)
    assert.include(result.summary, "GEMINI_API_KEY")
  })

  it("accepts Vertex AI configured with a project", () => {
    const result = geminiPrerequisites({
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "meridian"
    })
    assert.isTrue(result.satisfied)
    assert.include(result.summary, "Vertex AI")
    assert.include(result.summary, "meridian")
  })

  it("accepts the legacy GOOGLE_CLOUD_PROJECT_ID spelling", () => {
    assert.isTrue(geminiPrerequisites({ GOOGLE_CLOUD_PROJECT_ID: "meridian" }).satisfied)
  })

  it("treats a blank value as unset", () => {
    const result = geminiPrerequisites({ GOOGLE_CLOUD_PROJECT: "   " })
    assert.isFalse(result.satisfied)
  })

  it("reports unconfigured as a caveat, since personal OAuth needs no environment", () => {
    const result = geminiPrerequisites({})
    assert.isFalse(result.satisfied)
    assert.include(result.hint ?? "", "personal OAuth login still works")
    // The hint must explain the shell-startup trap that hides the variable.
    assert.include(result.hint ?? "", "IDE terminals")
  })

  it("never echoes an API key's value", () => {
    const result = geminiPrerequisites({ GEMINI_API_KEY: "super-secret-value" })
    assert.notInclude(result.summary, "super-secret-value")
    assert.notInclude(result.hint ?? "", "super-secret-value")
  })
})

describe("geminiBridgePrerequisites", () => {
  it("does not apply when the bridge wasn't requested", () => {
    assert.isUndefined(geminiBridgePrerequisites({}, undefined))
  })

  it("is unsatisfied when models.json is missing", () => {
    const result = geminiBridgePrerequisites({ LLM4TS_GEMINI_BRIDGE: "true" }, undefined)
    assert.isDefined(result)
    assert.isFalse(result?.satisfied)
    assert.include(result?.hint ?? "", "llm4ts never writes this file for you")
  })

  it("is unsatisfied when no provider baseUrl matches the port", () => {
    const result = geminiBridgePrerequisites(
      { LLM4TS_GEMINI_BRIDGE: "yes" },
      JSON.stringify({ providers: { other: { baseUrl: "http://127.0.0.1:9999" } } })
    )
    assert.isFalse(result?.satisfied)
  })

  it("is satisfied when a provider baseUrl matches the default port", () => {
    const result = geminiBridgePrerequisites(
      { LLM4TS_GEMINI_BRIDGE: "1" },
      JSON.stringify({ providers: { gemini: { baseUrl: "http://127.0.0.1:8731" } } })
    )
    assert.isTrue(result?.satisfied)
  })

  it("honors a custom LLM4TS_GEMINI_BRIDGE_PORT", () => {
    const result = geminiBridgePrerequisites(
      { LLM4TS_GEMINI_BRIDGE: "1", LLM4TS_GEMINI_BRIDGE_PORT: "9000" },
      JSON.stringify({ providers: { gemini: { baseUrl: "http://127.0.0.1:8731" } } })
    )
    assert.isFalse(result?.satisfied)
  })
})
