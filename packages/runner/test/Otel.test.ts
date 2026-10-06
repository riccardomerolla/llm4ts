import { assert, describe, it } from "@effect/vitest"
import * as OtlpExporter from "effect/observability/OtlpExporter"
import {
  otelConfig,
  otelDoctorLine,
  otelLayer,
  otelSummary,
  phoenixTracesUrl
} from "@llm4ts/runner/Otel"

describe("otelConfig", () => {
  it("is off without a switch, Phoenix with --otel alone, env when an endpoint is set", () => {
    assert.deepStrictEqual(otelConfig({}), { mode: "off" })
    assert.deepStrictEqual(otelConfig({ LLM4TS_OTEL: "on" }), {
      mode: "phoenix",
      tracesUrl: phoenixTracesUrl
    })
    assert.deepStrictEqual(otelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }), {
      mode: "env",
      endpoint: "http://collector:4318"
    })
    assert.deepStrictEqual(
      otelConfig({ LLM4TS_OTEL: "on", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://x/v1/traces" }),
      { mode: "env", endpoint: "http://x/v1/traces" }
    )
    assert.deepStrictEqual(
      otelConfig({ OTEL_SDK_DISABLED: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "http://x" }),
      { mode: "off" }
    )
    assert.deepStrictEqual(
      otelConfig({ LLM4TS_OTEL: "off", OTEL_EXPORTER_OTLP_ENDPOINT: "http://x" }),
      { mode: "off" }
    )
    // the test runner: the exporter's clock-driven flush would never fire under a TestClock
    assert.deepStrictEqual(otelConfig({ LLM4TS_OTEL: "on", VITEST: "true" }), { mode: "off" })
  })

  it("summarises where spans go", () => {
    assert.isUndefined(otelSummary({ mode: "off" }))
    assert.include(otelSummary({ mode: "phoenix", tracesUrl: phoenixTracesUrl }) ?? "", "6006")
    assert.include(otelSummary({ mode: "env", endpoint: "http://c:4318" }) ?? "", "http://c:4318")
  })

  it("builds no exporter when off: only the shared no-op flusher", () => {
    const layer = otelLayer({ mode: "off" }, { serviceVersion: "0.0.0", project: "repo" })
    assert.strictEqual(layer, OtlpExporter.layerFlusher)
  })
})

describe("otelDoctorLine", () => {
  it("says off, or where it points and whether the endpoint answered", () => {
    assert.strictEqual(
      otelDoctorLine({ mode: "off" }, undefined),
      "otel: off (LLM4TS_OTEL=on for a local Phoenix, or OTEL_EXPORTER_OTLP_ENDPOINT)"
    )
    assert.strictEqual(
      otelDoctorLine({ mode: "phoenix", tracesUrl: phoenixTracesUrl }, true),
      "otel: Phoenix at http://localhost:6006/v1/traces — endpoint answers"
    )
    assert.strictEqual(
      otelDoctorLine({ mode: "env", endpoint: "http://c:4318" }, false),
      "otel: http://c:4318 — endpoint does not answer (spans will be dropped, the run is unaffected)"
    )
  })
})
