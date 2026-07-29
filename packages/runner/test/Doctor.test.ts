import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import { ConnectorIds, HealthStatus } from "@llm4ts/core/Models"
import type { ConnectorRegistryShape } from "@llm4ts/core/ConnectorRegistry"
import { makeDoctorProgram } from "@llm4ts/runner/Doctor"

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
})
