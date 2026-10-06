// OpenTelemetry export (ADR 0026): Effect's own OTLP tracer and metrics
// exporters over core's fetch client, so a run can show up in Phoenix,
// Langfuse, SigNoz or any collector with no SDK and no new dependency.
// The standard OTEL_* variables are the truth; `--otel` is the laptop case.
import * as ConfigProvider from "effect/ConfigProvider"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as OtlpExporter from "effect/observability/OtlpExporter"
import * as OtlpMetrics from "effect/observability/OtlpMetrics"
import * as OtlpSerialization from "effect/observability/OtlpSerialization"
import * as OtlpTracer from "effect/observability/OtlpTracer"
import { packageVersion } from "./Package.ts"

export type OtelConfig =
  | { readonly mode: "off" }
  | { readonly mode: "phoenix"; readonly tracesUrl: string }
  | { readonly mode: "env"; readonly endpoint: string }

export const phoenixTracesUrl = "http://localhost:6006/v1/traces"

const truthy = (value: string | undefined): boolean =>
  /^(on|1|true|yes)$/iu.test(value?.trim() ?? "")
const falsy = (value: string | undefined): boolean =>
  /^(off|0|false|no)$/iu.test(value?.trim() ?? "")

/**
 * Off unless asked. An OTLP endpoint in the environment wins and is used as
 * the standard variables say; `LLM4TS_OTEL=on` alone means a local Phoenix,
 * traces only. `OTEL_SDK_DISABLED` or `LLM4TS_OTEL=off` switch everything off.
 */
export const otelConfig = (
  environment: Readonly<Record<string, string | undefined>>
): OtelConfig => {
  if (truthy(environment.OTEL_SDK_DISABLED) || falsy(environment.LLM4TS_OTEL)) {
    return { mode: "off" }
  }
  // Under the test runner the exporter's sleeps run on a TestClock nobody
  // advances, so its final flush would wait forever: a developer with
  // LLM4TS_OTEL=on in the shell must still get a green suite.
  if (environment.VITEST !== undefined) {
    return { mode: "off" }
  }
  const endpoint =
    environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() ||
    environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  if (endpoint !== undefined && endpoint.length > 0) {
    return { mode: "env", endpoint }
  }
  return truthy(environment.LLM4TS_OTEL)
    ? { mode: "phoenix", tracesUrl: phoenixTracesUrl }
    : { mode: "off" }
}

export interface OtelResource {
  readonly serviceVersion: string
  /** Phoenix's project: the repository's basename, never a path. */
  readonly project: string
}

/** The run end may wait this long for the last batch; the event drain waits the same. */
export const flushTimeout = Duration.seconds(3)

/** This runner's version, for `service.version`. */
export const runnerVersion: string = packageVersion

const resourceOf = (resource: OtelResource) => ({
  serviceName: "llm4ts",
  serviceVersion: resource.serviceVersion,
  attributes: { "openinference.project.name": resource.project }
})

/**
 * The exporter for `config`: nothing when off; traces only for Phoenix;
 * traces and metrics from the standard variables for a generic endpoint.
 * Logs are never exported. Export errors are the exporter's to swallow; the
 * run never fails on them.
 */
export const otelLayer = (
  config: OtelConfig,
  resource: OtelResource,
  /** What the standard variables are read from in env mode (the run's environment). */
  environment: Readonly<Record<string, string | undefined>> = process.env
): Layer.Layer<OtlpExporter.Flusher> => {
  switch (config.mode) {
    case "off":
      // The exporter's no-op flusher: nothing to export, nothing to flush.
      return OtlpExporter.layerFlusher
    case "phoenix":
      return OtlpTracer.layer({
        url: config.tracesUrl,
        resource: resourceOf(resource),
        shutdownTimeout: flushTimeout
      }).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer))
    case "env":
      // The standard variables are read from the run's own environment, with
      // the two exporter defaults an endpoint implies; the process env is
      // never written.
      return Layer.mergeAll(
        OtlpTracer.layerFromConfig({ resource: resourceOf(resource) }),
        OtlpMetrics.layerFromConfig({ resource: resourceOf(resource) })
      ).pipe(
        Layer.provide(OtlpSerialization.layerJson),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({
              ...environment,
              ...otelEnvironmentDefaults(config, environment)
            })
          )
        )
      )
  }
}

/**
 * `layerFromConfig` exports nothing unless `OTEL_TRACES_EXPORTER` names
 * `otlp`; an endpoint in the environment is the operator's intent, so the
 * layer reads its variables with that default (and the metrics one) added
 * when they are unset.
 */
export const otelEnvironmentDefaults = (
  config: OtelConfig,
  environment: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string>> =>
  config.mode !== "env"
    ? {}
    : {
        ...(environment.OTEL_TRACES_EXPORTER === undefined ? { OTEL_TRACES_EXPORTER: "otlp" } : {}),
        ...(environment.OTEL_METRICS_EXPORTER === undefined
          ? { OTEL_METRICS_EXPORTER: "otlp" }
          : {})
      }

export const otelSummary = (config: OtelConfig): string | undefined => {
  switch (config.mode) {
    case "off":
      return undefined
    case "phoenix":
      return `otel → Phoenix at ${config.tracesUrl} (traces)`
    case "env":
      return `otel → ${config.endpoint} (traces + metrics, OTEL_* variables)`
  }
}

/**
 * The one warning a run prints when export is on and nothing answers at the
 * endpoint (spec §9): the exporter itself only logs at debug level and drops
 * the batch. Nothing when off or when the endpoint answered.
 */
export const otelWarning = (
  config: OtelConfig,
  answers: boolean | undefined
): string | undefined => {
  if (config.mode === "off" || answers !== false) {
    return undefined
  }
  const where = config.mode === "phoenix" ? config.tracesUrl : config.endpoint
  return (
    `⚠ otel: nothing answers at ${where} — spans will be dropped (the run is unaffected)` +
    (config.mode === "phoenix"
      ? "; start Phoenix with `docker run -p 6006:6006 arizephoenix/phoenix:latest`"
      : "")
  )
}

/** The doctor's line: `answers` is the probe's result, undefined when export is off. */
export const otelDoctorLine = (config: OtelConfig, answers: boolean | undefined): string => {
  switch (config.mode) {
    case "off":
      return "otel: off (LLM4TS_OTEL=on for a local Phoenix, or OTEL_EXPORTER_OTLP_ENDPOINT)"
    case "phoenix":
    case "env": {
      const where = config.mode === "phoenix" ? `Phoenix at ${config.tracesUrl}` : config.endpoint
      return `otel: ${where} — ${
        answers === true
          ? "endpoint answers"
          : "endpoint does not answer (spans will be dropped, the run is unaffected)"
      }`
    }
  }
}

/** Whether anything listens at the endpoint: any HTTP answer counts, a refused connection does not. */
export const probeOtelEndpoint = (config: OtelConfig): Effect.Effect<boolean | undefined> =>
  config.mode === "off"
    ? Effect.succeed(undefined)
    : Effect.tryPromise(() =>
        fetch(config.mode === "phoenix" ? config.tracesUrl : config.endpoint, {
          method: "OPTIONS",
          signal: AbortSignal.timeout(1_500)
        })
      ).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false)
      )
