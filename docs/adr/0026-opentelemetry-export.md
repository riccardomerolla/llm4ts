# ADR 0026: OpenTelemetry Export — A Run In Phoenix Or Any OTLP Backend

Status: Accepted · Date: 2026-10-06

## Context

A workshop with datapizza proposed a local Arize Phoenix fed by OpenTelemetry
to see what the agents do, how many tokens they burn and what it costs.
llm4ts records all of that per run already — the trace file, the cost
ledger, transcripts, `llm4ts profile`, `llm4ts costs`, `llm4ts watch` — but
each is a file or a terminal view. A platform team looks at one UI across
runs, hosts and tools, and that UI speaks OTLP.

What the design rests on, verified on 2026-10-06:

- `effect` 4.0.0 ships `effect/observability` (`OtlpTracer`, `OtlpMetrics`,
  `Otlp.layerFromConfig`), needing only `effect/http/HttpClient`, which core's
  `FetchHttpClient.layer` provides. No SDK, no new dependency.
  `layerFromConfig` reads the standard `OTEL_*` variables and exports nothing
  unless `OTEL_TRACES_EXPORTER` names `otlp`.
- Effect names a span for every `Effect.fn`, so a story produces dozens of
  internal spans between the ones a person wants to see.
- A CLI harness streams `tool_use` when a tool starts and `tool_result` when
  it ends, so tool spans can be opened and closed live.
- Phoenix: OTLP HTTP on `:6006/v1/traces`; the project comes from the resource
  attribute `openinference.project.name`; since 15.10.0 (2026-05-15) it
  converts `gen_ai.*` to OpenInference at ingest, but it does not infer
  `openinference.span.kind`, and it ignores `llm.cost.*`, pricing tokens
  itself from `llm.model_name` (Arize-ai/phoenix#15240).
- `@llm4ts/core/observability/{Tracing,Metrics,MeteredLlmService,StructuredLogger}`
  are home-grown, exported, and used by nothing in flow or runner.

## Decision

1. **Switch.** The standard `OTEL_*` variables are the source of truth.
   `llm4ts run --otel` (`LLM4TS_OTEL=on`) is a convenience: with no OTLP
   endpoint configured it exports traces only to `http://localhost:6006`
   (Phoenix). With an endpoint configured, traces and metrics go through the
   standard variables, and the run defaults `OTEL_TRACES_EXPORTER` and
   `OTEL_METRICS_EXPORTER` to `otlp` when they are unset — the endpoint is the
   operator's intent. Logs are never exported. Without either switch no
   exporter is built. Under the test runner (`VITEST`) export is off: the
   exporter's interval, retry and shutdown sleeps run on Effect's clock, which
   a `TestClock` never advances.
2. **Where.** The exporter layer lives in the runner (`runner/src/Otel.ts`,
   provided in `runWithBundle`) over `FetchHttpClient`; every flow gets it.
   The shell passes the flag and the flow's name (`LLM4TS_FLOW`).
3. **Kind spans, chained.** Real spans at the existing seams, each carrying
   `openinference.span.kind`: the run (CHAIN, root of the run trace), a story
   (AGENT, root of its own trace, linked to the run), every other `stage()`
   (CHAIN), a story judge round (EVALUATOR, with `llm4ts.judge.<dimension>`
   scores and findings as events), every seat call (LLM, `kind: client`), a
   harness tool call (TOOL, child of the LLM span), a gate command (TOOL).
   Kind spans parent to the nearest kind span through a context reference
   (`flow/src/Spans.ts`), not to the fiber's current span, and are always
   sampled; the run sets `Tracer.MinimumTraceLevel` so Effect's own function
   spans are unsampled and never exported. An exported trace shows the flow,
   not the call stack.
4. **One trace per story, one for the run.** `session.id` is the run id, so
   Phoenix's session view shows a whole run; `llm4ts.epic`, `llm4ts.story`,
   `llm4ts.run` and `llm4ts.flow` ride on every span under their scope via
   `Effect.annotateSpans`.
5. **Attributes.** `gen_ai.*` first (`gen_ai.operation.name`,
   `gen_ai.request.model`, `gen_ai.usage.input_tokens|output_tokens`), then
   OpenInference's `llm.model_name` and `llm.token_count.*` beside them for
   older Phoenix, and llm4ts's own keys for what no convention names:
   `llm4ts.role`, `llm4ts.executor`, `llm4ts.tool.category`,
   `llm4ts.usage.estimated`, `llm4ts.cost.usd`, `llm4ts.cost.source`,
   `llm4ts.gate.command`, `llm4ts.gate.exit_code`. Resource:
   `service.name=llm4ts`, `service.version`, `openinference.project.name` =
   the repository's basename (override with `OTEL_RESOURCE_ATTRIBUTES`), never
   a path.
6. **Cost and estimates.** Token counts always. A cost travels only when the
   backend reported it (`llm4ts.cost.source=reported`); the backends price the
   rest from the model name. A call the backend reports no usage for (a CLI
   coder) gets the same character-count estimate the cost meter uses, with
   the real model name and `llm4ts.usage.estimated=true`: visible, and marked.
7. **Content.** Off by default — no prompt, reply, tool argument or output
   leaves the machine, the trace file's policy. `LLM4TS_OTEL_CONTENT=on` adds
   prompts, replies and tool I/O (`input.value`, `output.value`,
   `gen_ai.input.messages`, `gen_ai.output.messages`) through `redactText`
   with the transcript caps; `full` adds the system prompt.
8. **Metrics.** Four counters, exported only with a generic endpoint:
   `llm4ts.tokens` (model, role, executor, direction, estimated),
   `llm4ts.cost.usd` (reported only), `llm4ts.model.calls` (role, executor,
   failed), `llm4ts.tool.calls` (category).
9. **Failure policy.** Export is batched in the background; the run end
   flushes within three seconds (the event drain's budget); a collector that
   is down never fails or slows a run beyond that. `llm4ts doctor` prints
   where spans go and whether the endpoint answers.
10. **Deprecations.** The four home-grown core observability modules are
    deprecated in 2.30.0 and removed in the next major.

## Consequences

- Zero new dependencies; Effect pins unchanged.
- Each seat call's span adds a few hundred bytes; with content on, up to the
  transcript caps. Internal Effect spans cost nothing on the wire.
- Phoenix shows every AGENT as a story and every EVALUATOR as a judge round,
  so its filters mean something without inventing kinds.
- Estimated usage reaches the backend's cost view as an estimate of an
  estimate; the attribute says which rows are measured.
- Divergence from the pinned llm4zio (no telemetry export) is recorded in
  `docs/parity.md`.

## Not decided here

Logs over OTLP; Phoenix's evaluations/annotations API; sampling (a run is
small by telemetry standards); removing the deprecated modules (next major).
