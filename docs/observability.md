# Seeing a run in Phoenix (or any OpenTelemetry backend)

llm4ts exports what its agents do — stages, stories, tasks, every model call
with its tokens, every tool call, every gate, every judge verdict — as
OpenTelemetry spans over OTLP (ADR 0026). There is no SDK to install: the
exporter is Effect's own.

## Phoenix on your laptop

```bash
docker run -p 6006:6006 -p 4317:4317 arizephoenix/phoenix:latest
```

```bash
llm4ts run epic-stories --otel --repo ~/customer/portal "Add the account page"
```

Open http://localhost:6006. The project is named after the repository
(`portal`). You get one trace per story (an AGENT span with the tasks, model
calls, tool calls and gates under it) and one for the run's own planning and
merges; the session view groups a whole run under its run id. Phoenix prices
tokens itself from the model name; rows estimated by llm4ts (a CLI coder that
reports no usage) carry `llm4ts.usage.estimated = true`.

Use Phoenix 15.10 or later: from that version it reads the OpenTelemetry
GenAI attributes llm4ts emits; older versions still show the tree, the token
counts and the kinds.

## Any other backend

Set the standard variables and drop `--otel`:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318 llm4ts run epic-stories --repo ~/customer/portal "…"
```

Traces and metrics go out; logs never. llm4ts defaults `OTEL_TRACES_EXPORTER`
and `OTEL_METRICS_EXPORTER` to `otlp` when an endpoint is set; every other
`OTEL_*` variable (headers, timeouts, batch sizes, resource attributes) is
honoured as the specification says.

- **Langfuse**: `OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel`
  (or your self-hosted host) with `OTEL_EXPORTER_OTLP_HEADERS` carrying its
  Basic auth. It maps both the GenAI and the OpenInference attributes.
- **SigNoz, Grafana Tempo, Honeycomb, an OpenTelemetry Collector**: the
  endpoint as is. Metrics give you token and cost counters per model and
  executor for dashboards.
- **Jaeger**: shows the span tree, no token views.

## Content

By default no prompt, reply, tool argument or output leaves the machine, the
same policy as the trace file. `LLM4TS_OTEL_CONTENT=on` adds prompts, replies
and tool I/O (redacted, capped at the transcript limits);
`LLM4TS_OTEL_CONTENT=full` adds the system prompt too.

## What you will see

| Span                             | `openinference.span.kind`                  | Notable attributes                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the run                          | CHAIN                                      | `llm4ts.run`, `llm4ts.flow`, `session.id`                                                                                                                                                                                        |
| a story                          | AGENT (roots its trace, linked to the run) | `llm4ts.story`, `llm4ts.epic`                                                                                                                                                                                                    |
| planning, setup, a task, a merge | CHAIN                                      |                                                                                                                                                                                                                                  |
| a seat call                      | LLM                                        | `llm4ts.role` (coder, reviewer, judge, planner), `llm4ts.executor`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `llm4ts.usage.estimated`, `llm4ts.cost.usd` when the backend reported one |
| a harness tool call              | TOOL (child of the seat call)              | `tool.name`, `llm4ts.tool.category` (explore, edit, test, …)                                                                                                                                                                     |
| a gate command                   | TOOL                                       | `llm4ts.gate.command`, `llm4ts.gate.exit_code`                                                                                                                                                                                   |
| a judge round                    | EVALUATOR                                  | `llm4ts.judge.<dimension>` scores, `llm4ts.judge.cleared`, findings as events                                                                                                                                                    |

Metrics (generic endpoint only): `llm4ts.tokens`, `llm4ts.cost.usd`,
`llm4ts.model.calls`, `llm4ts.tool.calls`.

## When nothing shows up

`llm4ts doctor` prints where spans go and whether the endpoint answers, and a
run with export on checks once at its start, posting an empty protobuf batch:
anything but a 2xx prints one warning. Bodies are OTLP protobuf, the encoding
Phoenix accepts (it rejects JSON with 415) and every collector understands. A
collector that is down never fails a run: spans are dropped and the run end
waits at most three seconds for the last batch. Nothing is exported while the
test suite runs, whatever the shell says.
