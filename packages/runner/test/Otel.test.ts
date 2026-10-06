import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as OtlpExporter from "effect/observability/OtlpExporter"
import { withKindSpan } from "@llm4ts/flow/Spans"
import {
  otelConfig,
  otelDoctorLine,
  otelLayer,
  otelSummary,
  otelWarning,
  phoenixTracesUrl,
  probeOtelEndpoint
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

describe("otelWarning", () => {
  it("warns once when export is on and nothing answers at the endpoint, else says nothing", () => {
    assert.isUndefined(otelWarning({ mode: "off" }, undefined))
    assert.isUndefined(otelWarning({ mode: "phoenix", tracesUrl: phoenixTracesUrl }, true))
    assert.strictEqual(
      otelWarning({ mode: "phoenix", tracesUrl: phoenixTracesUrl }, false),
      "⚠ otel: nothing answers at http://localhost:6006/v1/traces — spans will be dropped (the run is unaffected); start Phoenix with `docker run -p 6006:6006 arizephoenix/phoenix:latest`"
    )
    assert.strictEqual(
      otelWarning({ mode: "env", endpoint: "http://c:4318" }, false),
      "⚠ otel: nothing answers at http://c:4318 — spans will be dropped (the run is unaffected)"
    )
  })
})

describe("the exporter on the wire", () => {
  it.effect("posts protobuf to Phoenix's traces URL: the one content type it accepts", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<
        ReadonlyArray<{ readonly url: string; readonly contentType: string | undefined }>
      >([])
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.update(seen, (all) => [
            ...all,
            { url: request.url, contentType: request.body.contentType }
          ]).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })))
          )
        )
      )
      yield* withKindSpan("run", { kind: "CHAIN" }, Effect.void).pipe(
        Effect.provide(
          otelLayer(
            { mode: "phoenix", tracesUrl: phoenixTracesUrl },
            { serviceVersion: "0.0.0", project: "portal" },
            {},
            http
          )
        )
      )
      const requests = yield* Ref.get(seen)
      assert.deepStrictEqual(requests, [
        { url: phoenixTracesUrl, contentType: "application/x-protobuf" }
      ])
    })
  )
})

describe("probeOtelEndpoint", () => {
  const config = { mode: "phoenix", tracesUrl: phoenixTracesUrl } as const
  it.effect("posts an empty protobuf batch and trusts only a 2xx", () =>
    Effect.gen(function* () {
      const asked: Array<{ url: string; contentType: string | undefined }> = []
      const answering = (status: number) => (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers)
        asked.push({ url, contentType: headers.get("content-type") ?? undefined })
        return Promise.resolve(new Response(null, { status }))
      }
      assert.strictEqual(yield* probeOtelEndpoint(config, answering(200)), true)
      assert.strictEqual(yield* probeOtelEndpoint(config, answering(415)), false)
      assert.strictEqual(
        yield* probeOtelEndpoint(config, () => Promise.reject(new Error("ECONNREFUSED"))),
        false
      )
      assert.isUndefined(yield* probeOtelEndpoint({ mode: "off" }, answering(200)))
      assert.deepStrictEqual(asked[0], {
        url: phoenixTracesUrl,
        contentType: "application/x-protobuf"
      })
    })
  )
})
