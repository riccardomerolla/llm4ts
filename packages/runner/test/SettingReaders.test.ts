import { assert, describe, it } from "@effect/vitest"
import { CliConnectorConfig } from "@llm4ts/core/ConnectorConfig"
import { idleAfterFrom } from "@llm4ts/runner/AgentTree"
import { codex, prepareConnector } from "@llm4ts/runner/Connectors"
import { geminiBridgePrerequisites } from "@llm4ts/runner/Doctor"
import { otelConfig, phoenixTracesUrl } from "@llm4ts/runner/Otel"
import { geminiBridgeMode, geminiBridgePort } from "@llm4ts/runner/PiModels"
import { parseVerbosity } from "@llm4ts/runner/Terminal"
import { builtinSpecs, toolBrief } from "@llm4ts/runner/Tools"
import { transcriptsWanted } from "@llm4ts/runner/Transcripts"

const onWords = ["1", "true", "on", "yes", "TRUE", " On "]
const offWords = ["0", "false", "off", "no", "FALSE", " Off "]
const unreadable = ["maybe", "2", "enabled"]

type Environment = Readonly<Record<string, string | undefined>>

/** Each toggle reader as "is it on", with what unset and an unreadable value give. */
const toggles: ReadonlyArray<{
  readonly name: string
  readonly unset: boolean
  readonly on: (environment: Environment) => boolean
}> = [
  {
    name: "LLM4TS_TOOL_BRIEF",
    unset: true,
    on: (environment) => toolBrief([], builtinSpecs(), environment) !== undefined
  },
  { name: "LLM4TS_TRANSCRIPT", unset: false, on: transcriptsWanted },
  {
    name: "LLM4TS_ISOLATED",
    unset: false,
    on: (environment) => {
      const prepared = prepareConnector(codex, "/work/repo", environment)
      return prepared instanceof CliConnectorConfig && prepared.isolated === true
    }
  },
  {
    name: "LLM4TS_GEMINI_BRIDGE",
    unset: false,
    on: (environment) => geminiBridgePrerequisites(environment, undefined) !== undefined
  },
  {
    name: "LLM4TS_OTEL",
    unset: false,
    on: (environment) => otelConfig(environment).mode === "phoenix"
  }
]

describe("toggle readers of the runner", () => {
  for (const toggle of toggles) {
    it(`${toggle.name} takes 1|true|on|yes and 0|false|off|no in any case`, () => {
      assert.strictEqual(toggle.on({}), toggle.unset, "unset")
      assert.strictEqual(toggle.on({ [toggle.name]: "" }), toggle.unset, "empty")
      for (const word of onWords) {
        assert.isTrue(toggle.on({ [toggle.name]: word }), word)
      }
      for (const word of offWords) {
        assert.isFalse(toggle.on({ [toggle.name]: word }), word)
      }
      for (const word of unreadable) {
        assert.strictEqual(toggle.on({ [toggle.name]: word }), toggle.unset, word)
      }
    })
  }

  it("LLM4TS_OTEL=off silences an endpoint; an unreadable value leaves it in force", () => {
    const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }
    for (const word of offWords) {
      assert.deepStrictEqual(otelConfig({ ...endpoint, LLM4TS_OTEL: word }), { mode: "off" }, word)
    }
    assert.deepStrictEqual(otelConfig({ ...endpoint, LLM4TS_OTEL: "maybe" }), {
      mode: "env",
      endpoint: "http://collector:4318"
    })
    assert.deepStrictEqual(otelConfig({ LLM4TS_OTEL: "YES" }), {
      mode: "phoenix",
      tracesUrl: phoenixTracesUrl
    })
  })
})

describe("readers that keep a rule of their own", () => {
  it("the bridge port is the default when unset and stays as typed when unreadable", () => {
    assert.strictEqual(geminiBridgePort({}), "8731")
    assert.strictEqual(geminiBridgePort({ LLM4TS_GEMINI_BRIDGE_PORT: " " }), "8731")
    assert.strictEqual(geminiBridgePort({ LLM4TS_GEMINI_BRIDGE_PORT: " 9000 " }), "9000")
    // The caller refuses it (`--port must be a port number`); it never becomes the default.
    assert.strictEqual(geminiBridgePort({ LLM4TS_GEMINI_BRIDGE_PORT: "http" }), "http")
    assert.strictEqual(geminiBridgePort({ LLM4TS_GEMINI_BRIDGE_PORT: "0" }), "0")
  })

  it("an unknown bridge mode is still refused by name, not read as acp", () => {
    assert.deepStrictEqual(geminiBridgeMode({ LLM4TS_GEMINI_BRIDGE_MODE: "" }), {
      _tag: "Mode",
      mode: "acp"
    })
    assert.deepStrictEqual(geminiBridgeMode({ LLM4TS_GEMINI_BRIDGE_MODE: " OpenAI " }), {
      _tag: "Unknown",
      value: "openai"
    })
  })

  it("the idle span is milliseconds; an unreadable span is two minutes", () => {
    assert.strictEqual(idleAfterFrom({ LLM4TS_IDLE_AFTER: "45" }), 45_000)
    assert.strictEqual(idleAfterFrom({ LLM4TS_IDLE_AFTER: "2 m" }), 120_000)
    assert.strictEqual(idleAfterFrom({ LLM4TS_IDLE_AFTER: "1.5m" }), 120_000)
    assert.strictEqual(idleAfterFrom({ LLM4TS_IDLE_AFTER: "" }), 120_000)
  })

  it("an unreadable verbosity is normal", () => {
    assert.strictEqual(parseVerbosity("loud"), "Normal")
    assert.strictEqual(parseVerbosity(" QUIET "), "Quiet")
  })
})
