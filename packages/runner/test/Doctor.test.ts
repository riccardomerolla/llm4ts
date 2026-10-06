import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type { NodePreflightReport } from "@llm4ts/flow/NodePreflight"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import { ConnectorIds, HealthStatus } from "@llm4ts/core/Models"
import type { ConnectorRegistryShape } from "@llm4ts/core/ConnectorRegistry"
import {
  bridgeModelRefs,
  geminiBridgePrerequisites,
  geminiPrerequisites,
  makeDoctorProgram,
  piModelRefs,
  piModelsConfig
} from "@llm4ts/runner/Doctor"

// Doctor's gate check is a process spawn; tests hand it an answer.
const noNode: Effect.Effect<NodePreflightReport> = Effect.succeed({
  _tag: "NoPin",
  summary: "node: /repo pins no version (.nvmrc, .node-version, package.json engines.node)"
})
const mismatch: Effect.Effect<NodePreflightReport> = Effect.succeed({
  _tag: "Mismatch",
  node: "v24.12.0",
  unmet: [],
  summary:
    "node: the gates would run on Node v24.12.0 (the node on PATH), but /repo pins 20 (.nvmrc)"
})

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
      const report = yield* makeDoctorProgram(
        fakeRegistry,
        {
          ANTHROPIC_API_KEY: "set-in-test",
          LLM4TS_CODER: "codex"
        },
        undefined,
        noNode
      )
      assert.include(report, "connectors:")
      assert.include(report, "✔ mock")
      assert.include(report, "✖ claude-cli")
      assert.include(report, "✔ ANTHROPIC_API_KEY")
      assert.include(report, "✖ OPENAI_API_KEY")
      assert.include(report, "coder: codex")
      assert.include(report, "otel: off")
    })
  )

  it.effect("says where spans go and whether the endpoint answered", () =>
    Effect.gen(function* () {
      const report = yield* makeDoctorProgram(
        fakeRegistry,
        { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" },
        undefined,
        noNode,
        () => Effect.succeed(false)
      )
      assert.include(
        report,
        "otel: http://collector:4318 — endpoint does not answer (spans will be dropped, the run is unaffected)"
      )
    })
  )

  it.effect("labels the default coder when no environment override exists", () =>
    Effect.gen(function* () {
      const report = yield* makeDoctorProgram(fakeRegistry, {}, undefined, noNode)
      assert.include(report, "coder: claude (default)")
    })
  )

  it.effect("stays quiet about gemini when it is neither selected nor installed", () =>
    Effect.gen(function* () {
      const report = yield* makeDoctorProgram(
        fakeRegistry,
        { LLM4TS_CODER: "codex" },
        undefined,
        noNode
      )
      assert.notInclude(report, "prerequisites:")
    })
  )

  it.effect("stays quiet about the pi-gemini bridge when it wasn't asked for", () =>
    Effect.gen(function* () {
      const report = yield* makeDoctorProgram(fakeRegistry, {}, noModelsJson, noNode)
      assert.notInclude(report, "pi-gemini-bridge")
    })
  )

  it.effect("flags a missing pi models.json when the bridge is requested", () =>
    Effect.gen(function* () {
      const report = yield* makeDoctorProgram(
        fakeRegistry,
        { LLM4TS_GEMINI_BRIDGE: "1" },
        noModelsJson,
        noNode
      )
      assert.include(report, "? pi-gemini-bridge: ~/.pi/agent/models.json not found")
      assert.include(report, "http://127.0.0.1:8731")
      assert.include(report, "ADR 0016")
    })
  )

  it.effect("flags a models.json that doesn't point at the bridge port", () =>
    Effect.gen(function* () {
      const report = yield* makeDoctorProgram(
        fakeRegistry,
        { LLM4TS_GEMINI_BRIDGE: "1" },
        () =>
          JSON.stringify({ providers: { anthropic: { baseUrl: "https://api.anthropic.com" } } }),
        noNode
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
            providers: {
              gemini: {
                baseUrl: "http://127.0.0.1:9000",
                api: "anthropic-messages",
                apiKey: "unused",
                models: [{ id: "gemini-2.5-pro" }]
              }
            }
          }),
        noNode
      )
      assert.include(
        report,
        "✔ pi-gemini-bridge: a provider in ~/.pi/agent/models.json points at 127.0.0.1:9000"
      )
      assert.include(report, "LLM4TS_GEMINI_BRIDGE_MODEL")
      assert.include(report, "gemini/gemini-2.5-pro")
    })
  )

  it.effect("flags a selected gemini with no project or key in the environment", () =>
    Effect.gen(function* () {
      const report = yield* makeDoctorProgram(
        fakeRegistry,
        { LLM4TS_CODER: "gemini" },
        undefined,
        noNode
      )
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
      const report = yield* makeDoctorProgram(
        fakeRegistry,
        {
          LLM4TS_CODER: "gemini",
          GOOGLE_CLOUD_PROJECT: "meridian-modernization"
        },
        undefined,
        noNode
      )
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
      const report = yield* makeDoctorProgram(
        withGemini,
        { LLM4TS_CODER: "claude" },
        undefined,
        noNode
      )
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

  it("is satisfied when a matching provider also lists a model, and names it", () => {
    const result = geminiBridgePrerequisites(
      { LLM4TS_GEMINI_BRIDGE: "1" },
      JSON.stringify({
        providers: {
          gemini: {
            baseUrl: "http://127.0.0.1:8731",
            apiKey: "unused",
            models: [{ id: "gemini-2.5-pro" }]
          }
        }
      })
    )
    assert.isTrue(result?.satisfied)
    assert.include((result?.detail ?? []).join("\n"), "gemini/gemini-2.5-pro")
  })

  // The port check alone reported success here, while the run still failed
  // with pi's "Model not found" — `--model` resolves against `models`.
  it("is unsatisfied when the matching provider lists no models", () => {
    const result = geminiBridgePrerequisites(
      { LLM4TS_GEMINI_BRIDGE: "1" },
      JSON.stringify({ providers: { gemini: { baseUrl: "http://127.0.0.1:8731" } } })
    )
    assert.isFalse(result?.satisfied)
    assert.include(result?.summary ?? "", "lists no models")
  })

  it("names the models pi can resolve when none of them are bridged", () => {
    const result = geminiBridgePrerequisites(
      { LLM4TS_GEMINI_BRIDGE: "1" },
      JSON.stringify({
        providers: {
          other: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-test",
            models: [{ id: "gpt-5.5" }]
          }
        }
      })
    )
    assert.isFalse(result?.satisfied)
    assert.include((result?.detail ?? []).join("\n"), "other/gpt-5.5")
  })

  it("honors a custom LLM4TS_GEMINI_BRIDGE_PORT", () => {
    const result = geminiBridgePrerequisites(
      { LLM4TS_GEMINI_BRIDGE: "1", LLM4TS_GEMINI_BRIDGE_PORT: "9000" },
      JSON.stringify({ providers: { gemini: { baseUrl: "http://127.0.0.1:8731" } } })
    )
    assert.isFalse(result?.satisfied)
  })
})

describe("piModelsConfig", () => {
  const config = JSON.stringify({
    providers: {
      "gemini-bridge": {
        baseUrl: "http://127.0.0.1:8731",
        apiKey: "unused",
        models: [{ id: "gemini-2.5-pro" }, { id: "gemini-2.5-flash" }]
      },
      "openai-codex": {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        models: [{ id: "gpt-5.5" }]
      }
    }
  })

  it("pairs every provider with its models and marks the bridged ones", () => {
    assert.deepStrictEqual(piModelRefs(config, "8731"), [
      { ref: "gemini-bridge/gemini-2.5-pro", bridged: true, authConfigured: true },
      { ref: "gemini-bridge/gemini-2.5-flash", bridged: true, authConfigured: true },
      { ref: "openai-codex/gpt-5.5", bridged: false, authConfigured: true }
    ])
  })

  it("marks nothing bridged when the port differs", () => {
    assert.deepStrictEqual(bridgeModelRefs(config, "9000"), [])
  })

  // pi rejects `models: ["id"]`; the entry must be an object carrying `id`.
  it("reports a bare-string model entry the way pi does", () => {
    const result = piModelsConfig(
      JSON.stringify({
        providers: { "gemini-bridge": { baseUrl: "http://127.0.0.1:8731", models: ["x"] } }
      }),
      "8731"
    )
    assert.deepStrictEqual(result.refs, [])
    assert.include(result.problems.join("\n"), "providers.gemini-bridge.models.0")
  })

  it("tracks whether a provider configures auth at all", () => {
    const keyless = piModelsConfig(
      JSON.stringify({
        providers: {
          "gemini-bridge": { baseUrl: "http://127.0.0.1:8731", models: [{ id: "gemini-2.5-pro" }] }
        }
      }),
      "8731"
    )
    assert.deepStrictEqual(keyless.problems, [])
    assert.isFalse(keyless.refs[0]?.authConfigured)
  })

  it("flags a provider with models but no baseUrl", () => {
    const result = piModelsConfig(
      JSON.stringify({ providers: { broken: { models: [{ id: "x" }] } } }),
      "8731"
    )
    assert.include(result.problems.join("\n"), "providers.broken.baseUrl")
  })

  // This runs only to explain a failure, so it must never raise one itself.
  it("yields problems rather than throwing on unreadable config", () => {
    assert.deepStrictEqual(piModelsConfig(undefined, "8731"), { refs: [], problems: [] })
    assert.deepStrictEqual(piModelsConfig("{ not json", "8731").refs, [])
    assert.isNotEmpty(piModelsConfig("{ not json", "8731").problems)
    assert.isNotEmpty(piModelsConfig(JSON.stringify({ providers: 7 }), "8731").problems)
    assert.isNotEmpty(
      piModelsConfig(JSON.stringify({ providers: { a: { models: "nope" } } }), "8731").problems
    )
  })
})

describe("geminiBridgePrerequisites schema and auth reporting", () => {
  // The two failures this check exists to catch, both of which previously
  // reported ✔ while every pi run failed.
  it("is unsatisfied when the file fails pi's schema", () => {
    const result = geminiBridgePrerequisites(
      { LLM4TS_GEMINI_BRIDGE: "1" },
      JSON.stringify({
        providers: { "gemini-bridge": { baseUrl: "http://127.0.0.1:8731", models: ["x"] } }
      })
    )
    assert.isFalse(result?.satisfied)
    assert.include(result?.summary ?? "", "fails pi's schema")
    assert.include((result?.detail ?? []).join("\n"), "must be an object with a string id")
  })

  it("is unsatisfied when the bridge provider configures no apiKey", () => {
    const result = geminiBridgePrerequisites(
      { LLM4TS_GEMINI_BRIDGE: "1" },
      JSON.stringify({
        providers: {
          "gemini-bridge": { baseUrl: "http://127.0.0.1:8731", models: [{ id: "gemini-2.5-pro" }] }
        }
      })
    )
    assert.isFalse(result?.satisfied)
    assert.include(result?.summary ?? "", "configures no apiKey")
  })
})

describe("doctor gates section", () => {
  it.effect("reports the Node the gates would run on against the application's pin", () =>
    Effect.gen(function* () {
      const fine = yield* makeDoctorProgram(fakeRegistry, {}, noModelsJson, noNode)
      assert.include(fine, "gates:")
      assert.include(fine, "✔ node: /repo pins no version")
      const bad = yield* makeDoctorProgram(fakeRegistry, {}, noModelsJson, mismatch)
      assert.include(bad, "✖ node: the gates would run on Node v24.12.0")
    })
  )
})
