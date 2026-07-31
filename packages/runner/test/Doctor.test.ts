import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import { ConnectorIds, HealthStatus } from "@llm4ts/core/Models"
import type { ConnectorRegistryShape } from "@llm4ts/core/ConnectorRegistry"
import { geminiPrerequisites, makeDoctorProgram } from "@llm4ts/runner/Doctor"

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
