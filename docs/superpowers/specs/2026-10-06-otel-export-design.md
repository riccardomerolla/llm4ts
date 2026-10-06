# OpenTelemetry export: what the agents do, tokens and costs, in Phoenix or any OTLP backend

Date: 2026-10-06 · Status: implemented in 2.30.0 (ADR 0026)

## Why

A workshop with datapizza proposed a local Arize Phoenix with OpenTelemetry to
see what the agents do, how many tokens they burn and what it costs. llm4ts
already records all of that per run (trace file, cost ledger, transcripts,
`llm4ts profile`, `llm4ts costs`, `llm4ts watch`), but each is a file or a
terminal view. An OTLP export puts the same facts in one UI across runs, hosts
and tools, the UI a customer's platform team already looks at.

## Facts the design rests on (verified 2026-10-06)

- `effect` 4.0.0 ships `effect/observability`: `OtlpTracer`, `OtlpMetrics`,
  `Otlp.layerFromConfig`, needing only `effect/http/HttpClient`, which core's
  `FetchHttpClient.layer` provides. **No new dependency.**
  `layerFromConfig` reads the standard `OTEL_*` variables and is a no-op when
  `OTEL_TRACES_EXPORTER` does not contain `otlp` or no endpoint is set.
- `Effect.withSpan` nests spans through the fiber; `Tracer.span` lets code open
  a span with an explicit parent. A CLI harness streams `tool_use` at tool start
  and `tool_result` at its end, so tool spans can be opened and closed live.
- Phoenix: OTLP HTTP on `:6006/v1/traces` (gRPC `:4317`); project from the
  resource attribute `openinference.project.name` (default project `default`);
  since 15.10.0 (2026-05-15) it converts `gen_ai.*` to OpenInference at ingest
  but does **not** infer `openinference.span.kind`; it ignores `llm.cost.*` and
  prices tokens itself from `llm.model_name` (Arize-ai/phoenix#15240).
- Langfuse accepts OTLP at `/api/public/otel/v1/traces` and maps `gen_ai.*` and
  OpenInference. SigNoz, Grafana Tempo, Jaeger accept plain OTLP.
- `@llm4ts/core/observability/{Tracing,Metrics,MeteredLlmService,StructuredLogger}`
  are home-grown, exported, and unused by flow and runner.

## Decisions

1. **Switch.** The standard `OTEL_*` variables are the source of truth.
   `llm4ts run --otel` (env `LLM4TS_OTEL=on`) is a convenience: with no OTLP
   endpoint configured it exports traces only to `http://localhost:6006`
   (Phoenix) and behaves as if `OTEL_TRACES_EXPORTER=otlp`. With an endpoint
   configured, traces and metrics go through the standard variables. Logs are
   never exported (they would carry content; the trace file and transcripts
   cover them). Without either switch nothing is exported and nothing is built.
2. **Where.** The exporter layer lives in the runner (`runWithBundle`), over
   core's `FetchHttpClient`; every flow gets it. The shell only passes the flag.
3. **Span tree.** Real spans at the existing seams:

   | Seam                                                 | Span                                                  | `openinference.span.kind` |
   | ---------------------------------------------------- | ----------------------------------------------------- | ------------------------- |
   | the run (`runWithBundle`)                            | root of the run trace                                 | CHAIN                     |
   | `stage("story <id>")`                                | root of the story's own trace, linked to the run span | AGENT                     |
   | other `stage()` calls (planning, setup, task, merge) | child                                                 | CHAIN                     |
   | story judge round                                    | child of the story                                    | EVALUATOR                 |
   | every seat call (`timedSeat`)                        | child, `kind: client`                                 | LLM                       |
   | harness tool call (`tool_use` → `tool_result`)       | child of the LLM span                                 | TOOL                      |
   | gate command                                         | child                                                 | TOOL                      |

   One trace per story plus one for the run; `session.id` = run id groups them
   in Phoenix's session view; `llm4ts.epic` lets several runs of one epic be
   filtered together.

4. **Attributes.** `gen_ai.*` is the primary set (`gen_ai.operation.name`,
   `gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.usage.input_tokens`,
   `gen_ai.usage.output_tokens`); `openinference.span.kind` always;
   `llm.model_name`, `llm.token_count.prompt|completion|total` duplicated for
   older Phoenix. llm4ts-specific: `llm4ts.role` (coder, reviewer, judge,
   planner, verifier, judgment), `llm4ts.executor`, `llm4ts.story`,
   `llm4ts.epic`, `llm4ts.flow`, `llm4ts.run`, `llm4ts.tool.category`,
   `llm4ts.judge.<dimension>` scores on the judge-round span, review findings
   as span events. Resource: `service.name=llm4ts`, `service.version`,
   `openinference.project.name` = repository basename (override with
   `OTEL_RESOURCE_ATTRIBUTES`), never a path.
5. **Cost and estimates.** Token counts always. Cost only when the backend
   reported it (`llm4ts.cost.usd`, `llm4ts.cost.source=reported`); backends
   price the rest from the model name. Estimated usage (CLI connectors that
   report none) is exported with the clean model name and
   `llm4ts.usage.estimated=true`, so a Gemini CLI story shows tokens, visibly
   marked as an estimate.
6. **Content.** Off by default: no prompt, reply, tool argument or output
   leaves the machine. `LLM4TS_OTEL_CONTENT=on` adds the prompt and reply
   (`gen_ai.input.messages`, `gen_ai.output.messages`, `input.value`,
   `output.value`) and tool arguments and outputs, through the existing
   redaction and the transcript caps; `LLM4TS_OTEL_CONTENT=full` adds the
   system prompt on a chat's first call. Documented minimum for prompt
   rendering in Phoenix: 15.10.
7. **Judge verdicts.** Span attributes and events only; no Phoenix-specific
   REST (annotations API). The exporter stays a pure OTLP layer.
8. **Metrics.** A small fixed set, exported only with a generic endpoint:
   `llm4ts.tokens` (counter; attributes model, role, executor, direction,
   estimated), `llm4ts.cost.usd` (counter; reported only), `llm4ts.model.calls`
   (counter; role, executor, failed), `llm4ts.tool.calls` (counter; category).
9. **Failure policy.** Export is batched; the run end flushes within three
   seconds (the event drain's budget); one warning line when delivery failed;
   never a failure, never a slower run. Same posture as the trace writer.
10. **Deprecations.** `@llm4ts/core/observability/Tracing`, `Metrics`,
    `MeteredLlmService`, `StructuredLogger` are marked deprecated in this
    release and removed in the next major.
11. **Docs and doctor.** `docs/observability.md`: the Phoenix `docker run`
    line, the two variables, what to look for, the alternatives (Langfuse,
    SigNoz, Grafana). `llm4ts doctor` prints whether export is on, where it
    points, and whether the endpoint answers.

## Not decided here

Logs over OTLP; a Phoenix evaluations integration; sampling (every span is
exported; a run is small by telemetry standards); removing the deprecated
core observability modules (next major).

## Constraints

- Zero new dependencies; Effect pins stay exact.
- Content-free by default, like the trace file; the content flag goes through
  `Redaction` and the transcript caps.
- Deterministic tests only: spans are asserted through a recording tracer and
  the OTLP layer is never exercised against the network in CI.
- `llm4ts profile`, `llm4ts costs` and the trace file are unchanged; OTLP is
  additive.
