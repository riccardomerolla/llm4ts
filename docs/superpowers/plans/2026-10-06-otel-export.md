# OpenTelemetry Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every llm4ts run can export what its agents did, their tokens and reported costs as OpenTelemetry spans and metrics over OTLP, with Arize Phoenix as the documented local default and no new dependency.

**Architecture:** Real Effect spans at the seams that already exist (`stage()`, `timedSeat`, the gate runner, the story judge round), carrying OpenTelemetry GenAI attributes plus `openinference.span.kind`; the runner provides `effect/observability`'s OTLP tracer (and metrics for a generic endpoint) over core's `FetchHttpClient`, wraps the run in a root span, and flushes within three seconds at the end. Content stays off unless `LLM4TS_OTEL_CONTENT` says otherwise. Tests assert spans through a recording `Tracer` and never touch the network.

**Tech Stack:** TypeScript, Effect 4.0.0 (`effect/Tracer`, `effect/Metric`, `effect/observability`, `effect/http/FetchHttpClient`), `@effect/vitest`, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-10-06-otel-export-design.md`

## Global Constraints

- Zero new dependencies; Effect pins stay exact `4.0.0`.
- No `any`, no unchecked type assertions, no namespaces; expected failures are typed. Export never fails or slows a run.
- Explicit subpath exports: new `packages/flow/src/X.ts` → `"./X": "./dist/X.js"` in `packages/flow/package.json`; same for `packages/runner`.
- Content-free by default: no prompt, reply, tool argument or output in any span unless `LLM4TS_OTEL_CONTENT` is `on` or `full`; content goes through `redactText` (`@llm4ts/core/observability/Redaction`) with the transcript caps (64 000 chars input/reply, 4 000 tool args/output).
- Attribute names exactly as the spec lists them: `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `openinference.span.kind`, `llm.model_name`, `llm.token_count.prompt|completion|total`, `llm4ts.role|executor|story|epic|flow|run|tool.category|usage.estimated|cost.usd|cost.source|gate.command|gate.exit_code`, `session.id`, resource `openinference.project.name`.
- Deterministic tests with `@effect/vitest`; spans asserted via `Effect.withTracer(effect, recordingTracer)`; the OTLP layer is never run against a network in CI.
- Verification before every commit: `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **A run with neither switch** (`LLM4TS_OTEL` unset, no `OTEL_EXPORTER_OTLP_ENDPOINT`) must build no exporter, open no socket, and behave exactly as 2.29.0; spans still exist in memory (Effect's default tracer) at negligible cost. Pinned in Task 5 (`otelConfig` → `off`, layer is `Layer.empty`).
2. **The collector is down** (`--otel` with no Phoenix running): the run completes, one warning line at most, total added time under the three-second flush. Pinned in Task 5 (shutdownTimeout = 3s; the layer swallows export errors) and documented in the ADR.
3. **A CLI coder that reports no usage** must still show tokens in Phoenix, marked estimated, with a clean model name (never `estimated:<model>`). Pinned in Task 3.
4. **Content flag off** must leave no `input.value`, `output.value`, `gen_ai.*.messages`, tool args or output on any span, even when the chunks carry them. Pinned in Task 3.
5. **Concurrent stories** must each be their own trace (root span) linked to the run span, with every child span carrying `llm4ts.story` and `session.id`. Pinned in Task 2.

---

### Task 1: Span vocabulary and a recording tracer for tests — `packages/flow/src/Spans.ts`

**Files:**

- Create: `packages/flow/src/Spans.ts`
- Create: `packages/flow/test/support/RecordingTracer.ts`
- Modify: `packages/flow/package.json` (exports)
- Test: `packages/flow/test/Spans.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export type SpanKind = "CHAIN" | "AGENT" | "LLM" | "TOOL" | "EVALUATOR"
  export const kindAttribute = "openinference.span.kind"
  export const attr = {
    role: "llm4ts.role",
    executor: "llm4ts.executor",
    story: "llm4ts.story",
    epic: "llm4ts.epic",
    flow: "llm4ts.flow",
    run: "llm4ts.run",
    session: "session.id",
    toolCategory: "llm4ts.tool.category",
    estimated: "llm4ts.usage.estimated",
    costUsd: "llm4ts.cost.usd",
    costSource: "llm4ts.cost.source",
    gateCommand: "llm4ts.gate.command",
    gateExit: "llm4ts.gate.exit_code",
    model: "gen_ai.request.model",
    provider: "gen_ai.provider.name",
    operation: "gen_ai.operation.name",
    inputTokens: "gen_ai.usage.input_tokens",
    outputTokens: "gen_ai.usage.output_tokens",
    oiModel: "llm.model_name",
    oiPrompt: "llm.token_count.prompt",
    oiCompletion: "llm.token_count.completion",
    oiTotal: "llm.token_count.total",
    input: "input.value",
    output: "output.value",
    inputMessages: "gen_ai.input.messages",
    outputMessages: "gen_ai.output.messages"
  } as const
  export type OtelContent = "off" | "on" | "full"
  export const otelContent = (environment: Readonly<Record<string, string | undefined>>) =>
    OtelContent // LLM4TS_OTEL_CONTENT
  export interface SpanOptions {
    readonly kind: SpanKind
    readonly root?: boolean
    readonly attributes?: Readonly<Record<string, unknown>>
  }
  export const withKindSpan = <A, E, R>(
    name: string,
    options: SpanOptions,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>
  export const usageAttributes = (
    model: string | undefined,
    usage: TokenUsage | undefined,
    estimated: boolean
  ) => Record<string, unknown>
  export const modelNameOf = (model: string | undefined) => string | undefined // strips "estimated:" (isEstimatedModel)
  ```
- Test support: `recordingTracer(): { tracer: Tracer.Tracer; spans: () => ReadonlyArray<RecordedSpan> }` where `RecordedSpan = { name, kind, root, parentName?, attributes: Record<string, unknown>, events: Array<{ name, attributes }>, ended: boolean, failed: boolean }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/flow/test/support/RecordingTracer.ts`:

```ts
import * as Context from "effect/Context"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"

export interface RecordedSpan {
  readonly name: string
  readonly kind: Tracer.SpanKind
  readonly root: boolean
  readonly parentName: string | undefined
  readonly attributes: Record<string, unknown>
  readonly events: Array<{ readonly name: string; readonly attributes: Record<string, unknown> }>
  ended: boolean
  failed: boolean
}

let ids = 0

/** A tracer that keeps every span it made, for assertions; no export, no clock. */
export const recordingTracer = (): {
  readonly tracer: Tracer.Tracer
  readonly spans: () => ReadonlyArray<RecordedSpan>
} => {
  const recorded: Array<RecordedSpan> = []
  const tracer = Tracer.make({
    span(options) {
      ids += 1
      const record: RecordedSpan = {
        name: options.name,
        kind: options.kind,
        root: options.root,
        parentName: Option.isSome(options.parent)
          ? options.parent.value._tag === "Span"
            ? options.parent.value.name
            : "(external)"
          : undefined,
        attributes: {},
        events: [],
        ended: false,
        failed: false
      }
      recorded.push(record)
      const attributes = new Map<string, unknown>()
      const span: Tracer.Span = {
        _tag: "Span",
        name: options.name,
        spanId: `span-${ids}`,
        traceId:
          Option.isSome(options.parent) && !options.root
            ? options.parent.value.traceId
            : `trace-${ids}`,
        parent: options.parent,
        annotations: Context.empty(),
        status: { _tag: "Started", startTime: options.startTime },
        attributes,
        links: options.links,
        sampled: options.sampled,
        kind: options.kind,
        end(_endTime, exit) {
          record.ended = true
          record.failed = Exit.isFailure(exit)
        },
        attribute(key, value) {
          attributes.set(key, value)
          record.attributes[key] = value
        },
        event(name, _startTime, eventAttributes = {}) {
          record.events.push({ name, attributes: { ...eventAttributes } })
        },
        addLinks(_links) {}
      }
      return span
    }
  })
  return { tracer, spans: () => recorded }
}
```

If `SpanStatus`'s started shape differs in `effect/dist/Tracer.d.ts` (search `SpanStatus`), match it; the test support only needs the type to compile.

Create `packages/flow/test/Spans.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { TokenUsage } from "@llm4ts/core/Models"
import {
  attr,
  kindAttribute,
  modelNameOf,
  otelContent,
  usageAttributes,
  withKindSpan
} from "@llm4ts/flow/Spans"
import { recordingTracer } from "./support/RecordingTracer.ts"

describe("withKindSpan", () => {
  it.effect("names the span, sets the OpenInference kind, nests, and roots when asked", () =>
    Effect.gen(function* () {
      const { tracer, spans } = recordingTracer()
      yield* withKindSpan(
        "run",
        { kind: "CHAIN", attributes: { [attr.run]: "run-1" } },
        withKindSpan("story a", { kind: "AGENT", root: true }, Effect.void)
      ).pipe(Effect.withTracer(tracer))
      const [run, story] = spans()
      assert.deepStrictEqual(
        [run?.name, run?.attributes[kindAttribute], run?.attributes[attr.run]],
        ["run", "CHAIN", "run-1"]
      )
      assert.deepStrictEqual(
        [story?.name, story?.attributes[kindAttribute], story?.root],
        ["story a", "AGENT", true]
      )
      assert.isTrue(run?.ended)
      assert.isFalse(run?.failed)
    })
  )

  it.effect("a failing effect ends its span failed", () =>
    Effect.gen(function* () {
      const { tracer, spans } = recordingTracer()
      yield* Effect.flip(
        withKindSpan("gate", { kind: "TOOL" }, Effect.fail("red")).pipe(Effect.withTracer(tracer))
      )
      assert.isTrue(spans()[0]?.failed)
    })
  )
})

describe("usageAttributes and modelNameOf", () => {
  it("emits GenAI and OpenInference token keys, flags estimates, strips the estimate label", () => {
    const usage = TokenUsage.make({ prompt: 120, completion: 30, total: 150 })
    const measured = usageAttributes("gemini-2.5-pro", usage, false)
    assert.deepStrictEqual(measured, {
      [attr.model]: "gemini-2.5-pro",
      [attr.oiModel]: "gemini-2.5-pro",
      [attr.inputTokens]: 120,
      [attr.outputTokens]: 30,
      [attr.oiPrompt]: 120,
      [attr.oiCompletion]: 30,
      [attr.oiTotal]: 150,
      [attr.estimated]: false
    })
    const estimated = usageAttributes("estimated:claude-sonnet-4", usage, true)
    assert.strictEqual(estimated[attr.model], "claude-sonnet-4")
    assert.strictEqual(estimated[attr.estimated], true)
    assert.strictEqual(modelNameOf("estimated:x"), "x")
    assert.isUndefined(modelNameOf(undefined))
    assert.deepStrictEqual(usageAttributes(undefined, undefined, false), {})
  })

  it("adds the reported cost only when the backend reported one", () => {
    const paid = TokenUsage.make({ prompt: 1, completion: 1, total: 2, costUsd: 0.0042 })
    const attributes = usageAttributes("gpt-5.5", paid, false)
    assert.strictEqual(attributes[attr.costUsd], 0.0042)
    assert.strictEqual(attributes[attr.costSource], "reported")
    assert.isUndefined(
      usageAttributes("gpt-5.5", TokenUsage.make({ prompt: 1, completion: 1, total: 2 }), false)[
        attr.costUsd
      ]
    )
  })
})

describe("otelContent", () => {
  it("is off unless LLM4TS_OTEL_CONTENT says on or full", () => {
    assert.strictEqual(otelContent({}), "off")
    assert.strictEqual(otelContent({ LLM4TS_OTEL_CONTENT: "on" }), "on")
    assert.strictEqual(otelContent({ LLM4TS_OTEL_CONTENT: "FULL" }), "full")
    assert.strictEqual(otelContent({ LLM4TS_OTEL_CONTENT: "yes" }), "off")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/flow/test/Spans.test.ts`
Expected: FAIL — module `@llm4ts/flow/Spans` not found.

- [ ] **Step 3: Write the module**

Create `packages/flow/src/Spans.ts`:

```ts
// The vocabulary every llm4ts span speaks (ADR 0026): OpenTelemetry GenAI
// attributes first, OpenInference's span kind and token keys beside them so
// Phoenix of any version renders the LLM views, and llm4ts's own keys for
// what no convention names (role, story, epic, estimated usage). Pure: the
// exporter is the runner's, the seams only call `withKindSpan`.
import * as Effect from "effect/Effect"
import type { TokenUsage } from "@llm4ts/core/Models"
import { isEstimatedModel } from "./EstimatedUsage.ts"

export type SpanKind = "CHAIN" | "AGENT" | "LLM" | "TOOL" | "EVALUATOR"

export const kindAttribute = "openinference.span.kind"

export const attr = {
  role: "llm4ts.role",
  executor: "llm4ts.executor",
  story: "llm4ts.story",
  epic: "llm4ts.epic",
  flow: "llm4ts.flow",
  run: "llm4ts.run",
  session: "session.id",
  toolCategory: "llm4ts.tool.category",
  estimated: "llm4ts.usage.estimated",
  costUsd: "llm4ts.cost.usd",
  costSource: "llm4ts.cost.source",
  gateCommand: "llm4ts.gate.command",
  gateExit: "llm4ts.gate.exit_code",
  model: "gen_ai.request.model",
  provider: "gen_ai.provider.name",
  operation: "gen_ai.operation.name",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  oiModel: "llm.model_name",
  oiPrompt: "llm.token_count.prompt",
  oiCompletion: "llm.token_count.completion",
  oiTotal: "llm.token_count.total",
  input: "input.value",
  output: "output.value",
  inputMessages: "gen_ai.input.messages",
  outputMessages: "gen_ai.output.messages"
} as const

/** How much content leaves the machine: nothing, prompts and tools, or the system prompt too. */
export type OtelContent = "off" | "on" | "full"

/** LLM4TS_OTEL_CONTENT: `on` or `full`; anything else is off. */
export const otelContent = (
  environment: Readonly<Record<string, string | undefined>>
): OtelContent => {
  const value = environment.LLM4TS_OTEL_CONTENT?.trim().toLowerCase()
  return value === "on" ? "on" : value === "full" ? "full" : "off"
}

export interface SpanOptions {
  readonly kind: SpanKind
  /** Start a new trace here (a story), linked to the span it was started from. */
  readonly root?: boolean
  readonly attributes?: Readonly<Record<string, unknown>>
}

/** `Effect.withSpan` with the OpenInference kind set, and a link back when the span roots a trace. */
export const withKindSpan = <A, E, R>(
  name: string,
  options: SpanOptions,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const parent = options.root === true ? yield* Effect.option(Effect.currentSpan) : undefined
    return yield* Effect.withSpan(effect, name, {
      kind: options.kind === "LLM" ? "client" : "internal",
      ...(options.root === true ? { root: true } : {}),
      ...(parent !== undefined && parent._tag === "Some"
        ? { links: [{ span: parent.value, attributes: {} }] }
        : {}),
      attributes: { [kindAttribute]: options.kind, ...(options.attributes ?? {}) }
    })
  })

/** The model name a backend would price: the estimate label stripped. */
export const modelNameOf = (model: string | undefined): string | undefined =>
  model === undefined
    ? undefined
    : isEstimatedModel(model)
      ? model.replace(/^estimated:/u, "")
      : model

/** Token and cost attributes for one model call; `{}` when nothing is known. */
export const usageAttributes = (
  model: string | undefined,
  usage: TokenUsage | undefined,
  estimated: boolean
): Record<string, unknown> => {
  const name = modelNameOf(model)
  if (name === undefined && usage === undefined) {
    return {}
  }
  return {
    ...(name === undefined ? {} : { [attr.model]: name, [attr.oiModel]: name }),
    ...(usage === undefined
      ? {}
      : {
          [attr.inputTokens]: usage.prompt,
          [attr.outputTokens]: usage.completion,
          [attr.oiPrompt]: usage.prompt,
          [attr.oiCompletion]: usage.completion,
          [attr.oiTotal]: usage.total,
          ...(usage.costUsd === undefined || estimated
            ? {}
            : { [attr.costUsd]: usage.costUsd, [attr.costSource]: "reported" })
        }),
    [attr.estimated]: estimated
  }
}
```

Check the `SpanLink` shape in `node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/Tracer.d.ts` (search `interface SpanLink`): it is `{ readonly span: AnySpan; readonly attributes: Record<string, unknown> }`; adjust the `links` literal if the field names differ. Add `"./Spans": "./dist/Spans.js",` to `packages/flow/package.json` exports (alphabetically after `"./SpecChecks"`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/flow/test/Spans.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Verify and commit**

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
git add packages/flow/src/Spans.ts packages/flow/test/Spans.test.ts packages/flow/test/support/RecordingTracer.ts packages/flow/package.json
git commit -m "flow: the span vocabulary for OpenTelemetry export, and a recording tracer for tests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Stages, stories and judge rounds become spans

**Files:**

- Modify: `packages/flow/src/PlanExecution.ts` (`stage`)
- Modify: `packages/flow/src/Stories.ts` (story stage as AGENT root; `annotateSpans` for story/epic/session; judge round as EVALUATOR with scores and findings)
- Test: `packages/flow/test/PlanExecution.test.ts`, `packages/flow/test/Stories.test.ts`

**Interfaces:**

- Consumes: `withKindSpan`, `attr`, `SpanOptions` (Task 1).
- Produces: `stage(events, name, effect, span?: SpanOptions)` — default `{ kind: "CHAIN" }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/flow/test/PlanExecution.test.ts` (import `recordingTracer` from `./support/RecordingTracer.ts`, `kindAttribute` from `@llm4ts/flow/Spans`, `makeFlowEventHub` from `@llm4ts/flow/FlowEvents`, `stage` from `@llm4ts/flow/PlanExecution`):

```ts
describe("stage spans", () => {
  it.effect("every stage is a CHAIN span unless told otherwise, failed when the stage fails", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const { tracer, spans } = recordingTracer()
      yield* stage(events, "story plan", Effect.void).pipe(Effect.withTracer(tracer))
      yield* Effect.flip(
        stage(events, "story a", Effect.fail(new Error("boom")), {
          kind: "AGENT",
          root: true
        }).pipe(Effect.withTracer(tracer))
      )
      const [plan, story] = spans()
      assert.deepStrictEqual(
        [plan?.name, plan?.attributes[kindAttribute], plan?.root, plan?.failed],
        ["story plan", "CHAIN", false, false]
      )
      assert.deepStrictEqual(
        [story?.name, story?.attributes[kindAttribute], story?.root, story?.failed],
        ["story a", "AGENT", true, true]
      )
    })
  )
})
```

Append to `packages/flow/test/Stories.test.ts` (imports: `recordingTracer`, `attr`, `kindAttribute`):

```ts
describe("story spans", () => {
  it.effect(
    "each story is its own AGENT trace carrying story, epic and session; the judge round is an EVALUATOR with scores",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness()
        const context = {
          ...(yield* makeContext(harness)),
          trace: { runId: "run-7", path: "/repo/.llm4ts/trace.jsonl" }
        }
        const { tracer, spans } = recordingTracer()
        const options = yield* makeOptions(harness, single, context, {
          concurrency: 1,
          judge: () =>
            Effect.succeed(
              StoryVerdict.make({
                issues: [],
                summary: "judge:a",
                dimensions: [
                  { id: "provides", score: 2, max: 2 },
                  { id: "tests", score: 1, max: 2 }
                ]
              })
            )
        })
        yield* implementStoriesFlow(context, options).pipe(Effect.withTracer(tracer))
        const story = spans().find((span) => span.name === "story a")
        assert.deepStrictEqual(
          [
            story?.attributes[kindAttribute],
            story?.root,
            story?.attributes[attr.story],
            story?.attributes[attr.epic],
            story?.attributes[attr.session]
          ],
          ["AGENT", true, "a", "single", "run-7"]
        )
        const task = spans().find(
          (span) => span.parentName === "story a" && span.attributes[kindAttribute] === "CHAIN"
        )
        assert.strictEqual(task?.attributes[attr.story], "a")
        const judge = spans().find((span) => span.attributes[kindAttribute] === "EVALUATOR")
        assert.strictEqual(judge?.name, "story a: judge 1")
        assert.strictEqual(judge?.attributes["llm4ts.judge.provides"], 2)
        assert.strictEqual(judge?.attributes["llm4ts.judge.tests"], 1)
        assert.strictEqual(judge?.attributes["llm4ts.judge.cleared"], true)
      })
  )
})
```

If the judge in `single`'s harness clears on 2/2 only, keep `tests: 1` and expect `cleared` `false` with one `judge finding` event instead; read the harness's `judgeRounds` default (2) and assert whichever the first round yields.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/flow/test/PlanExecution.test.ts packages/flow/test/Stories.test.ts`
Expected: FAIL — `stage` ignores the fourth argument / no spans named as expected.

- [ ] **Step 3: Implement**

`packages/flow/src/PlanExecution.ts`:

```ts
import { withKindSpan, type SpanOptions } from "./Spans.ts"

/**
 * A named step of a flow: published as StageStarted/Completed/Failed for the
 * terminal, the trace and the profile, and a span of `span.kind` (CHAIN by
 * default) for OpenTelemetry (ADR 0026).
 */
export const stage = <A, E, R>(
  events: FlowEventsShape,
  name: string,
  effect: Effect.Effect<A, E, R>,
  span: SpanOptions = { kind: "CHAIN" }
): Effect.Effect<A, E, R> =>
  withKindSpan(
    name,
    span,
    events.publish(StageStarted.make({ stage: name })).pipe(
      Effect.andThen(effect),
      Effect.tap(() => events.publish(StageCompleted.make({ stage: name }))),
      Effect.tapError((error) =>
        events.publish(StageFailed.make({ stage: name, message: errorMessage(error) }))
      )
    )
  )
```

`packages/flow/src/Stories.ts`:

- Find where a story's stage is opened (`stage(laneOf(story), \`story ${story.id}\`, …)` near the per-story runner; grep `` `story ${story.id}` ``). Pass `{ kind: "AGENT", root: true, attributes: { [attr.story]: story.id, [attr.epic]: plan.epicId } }` as the fourth argument and wrap the stage in
  ```ts
  Effect.annotateSpans({
    [attr.story]: story.id,
    [attr.epic]: plan.epicId,
    ...(context.trace === undefined
      ? {}
      : { [attr.session]: context.trace.runId, [attr.run]: context.trace.runId })
  })
  ```
  so every child span (tasks, model calls, tools, gates) carries them. Check `Effect.annotateSpans`'s signature in `effect/dist/Effect.d.ts:15285` (object form, data-last) and use the matching form.
- The judge round loop (`for (let round = 1; round <= judgeRounds; …)` around line 1235): wrap the body of one round in

  ```ts
  withKindSpan(`story ${story.id}: judge ${round}`, { kind: "EVALUATOR" }, Effect.gen(function* () {
    …existing round body…
    // after the verdict is known:
    yield* Effect.annotateCurrentSpan({
      "llm4ts.judge.cleared": verdict.isClean,
      ...Object.fromEntries(dimensions.map((d) => [`llm4ts.judge.${d.id}`, d.score]))
    })
    for (const issue of verdict.issues) {
      yield* Effect.flatMap(Effect.currentSpan, (span) =>
        Effect.sync(() => span.event("judge finding", BigInt(Date.now()) * 1_000_000n, { title: issue.title, severity: issue.severity }))
      ).pipe(Effect.ignore)
    }
  }))
  ```

  where `dimensions` is what the code already extracts for `StoryJudged`. Use `Clock.currentTimeNanos` (grep `currentTimeNanos` in `effect/dist/Clock.d.ts`) instead of `Date.now()` if available, so tests under `TestClock` stay deterministic.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/flow/test/PlanExecution.test.ts packages/flow/test/Stories.test.ts packages/flow/test/Flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
git add packages/flow/src/PlanExecution.ts packages/flow/src/Stories.ts packages/flow/test/PlanExecution.test.ts packages/flow/test/Stories.test.ts
git commit -m "flow: stages are spans; a story roots its own trace, a judge round is an evaluator

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Model-call spans with usage, tool child spans, content flag, metrics — `Timing.ts`

**Files:**

- Modify: `packages/flow/src/Timing.ts` (`timedSeat`, `timedStream`, `timeEffect`)
- Modify: `packages/runner/src/FlowRunner.ts` (pass `executor` and `content` options where `timedSeat` is built: lines ~493–504, ~666, ~712)
- Test: `packages/flow/test/Timing.test.ts`

**Interfaces:**

- Consumes: `withKindSpan`, `attr`, `usageAttributes`, `otelContent` (Task 1); `estimateUsage`, `estimatedModelLabel` (`EstimatedUsage.ts`); `toolCategory`, `toolUseFrom` (`Activity.ts`); `redactText` (`@llm4ts/core/observability/Redaction`).
- Produces:

  ```ts
  export interface TimedSeatOptions {
    readonly executor?: Effect.Effect<string | undefined>
    readonly content?: OtelContent // default "off"
    readonly estimate?: EstimatedUsageOptions // when set, usage missing from the backend is estimated for the span
  }
  export const timedSeat = (service, events, label, options?: TimedSeatOptions) => LlmServiceShape
  ```

  Metrics (module-level, `effect/Metric`): `llm4ts.tokens` counter (attributes `model`, `role`, `executor`, `direction` ∈ input|output, `estimated`), `llm4ts.cost.usd` counter, `llm4ts.model.calls` counter (`role`, `executor`, `failed`), `llm4ts.tool.calls` counter (`category`).

- [ ] **Step 1: Write the failing tests**

Append to `packages/flow/test/Timing.test.ts` (read its existing fakes first: it has a chunk-emitting fake service; reuse it). Imports: `recordingTracer`, `attr`, `kindAttribute`, `Metric`:

```ts
describe("timedSeat spans", () => {
  const chunks = (...parts: ReadonlyArray<LlmChunk>) => Stream.fromIterable(parts)
  const toolUse = LlmChunk.make({
    delta: "",
    metadata: {
      event: "tool_use",
      tool_name: "grep",
      tool_id: "t1",
      tool_input: '{"pattern":"secret"}'
    }
  })
  const toolResult = LlmChunk.make({
    delta: "",
    metadata: { event: "tool_result", tool_id: "t1", tool_content: "src/a.ts: const secret = 1" }
  })
  const reply = LlmChunk.make({
    delta: "done",
    finishReason: "stop",
    usage: TokenUsage.make({ prompt: 10, completion: 5, total: 15 }),
    metadata: { model: "gemini-2.5-pro" }
  })
  const streaming: LlmServiceShape = {
    ...unusedService,
    executeStreamWithHistory: () => chunks(toolUse, toolResult, reply)
  }

  it.effect(
    "an LLM span per call with GenAI usage, a TOOL child per tool call, no content by default",
    () =>
      Effect.gen(function* () {
        const events = yield* makeFlowEventHub()
        const { tracer, spans } = recordingTracer()
        const seat = timedSeat(streaming, events, "coder", { executor: Effect.succeed("gemini") })
        yield* collect(
          seat.executeStreamWithHistory([Message.make({ role: "User", content: "do it" })])
        ).pipe(Effect.withTracer(tracer))
        const llm = spans().find((span) => span.attributes[kindAttribute] === "LLM")
        assert.strictEqual(llm?.name, "coder")
        assert.strictEqual(llm?.kind, "client")
        assert.deepStrictEqual(
          [
            llm?.attributes[attr.role],
            llm?.attributes[attr.executor],
            llm?.attributes[attr.model],
            llm?.attributes[attr.inputTokens],
            llm?.attributes[attr.outputTokens],
            llm?.attributes[attr.estimated]
          ],
          ["coder", "gemini", "gemini-2.5-pro", 10, 5, false]
        )
        const tool = spans().find((span) => span.attributes[kindAttribute] === "TOOL")
        assert.deepStrictEqual(
          [tool?.name, tool?.parentName, tool?.attributes[attr.toolCategory], tool?.ended],
          ["grep", "coder", "explore", true]
        )
        const everything = JSON.stringify(spans())
        assert.notInclude(everything, "secret")
        assert.notInclude(everything, "do it")
        assert.notInclude(everything, "done")
      })
  )

  it.effect(
    "content on: prompt, reply, tool arguments and outputs travel, redacted and capped",
    () =>
      Effect.gen(function* () {
        const events = yield* makeFlowEventHub()
        const { tracer, spans } = recordingTracer()
        const seat = timedSeat(streaming, events, "coder", { content: "on" })
        yield* collect(
          seat.executeStreamWithHistory([
            Message.make({ role: "System", content: "rules" }),
            Message.make({ role: "User", content: "do it" })
          ])
        ).pipe(Effect.withTracer(tracer))
        const llm = spans().find((span) => span.attributes[kindAttribute] === "LLM")
        assert.strictEqual(llm?.attributes[attr.output], "done")
        assert.include(String(llm?.attributes[attr.input]), "do it")
        assert.notInclude(String(llm?.attributes[attr.input]), "rules")
        const tool = spans().find((span) => span.attributes[kindAttribute] === "TOOL")
        assert.include(String(tool?.attributes[attr.input]), "secret")
        assert.include(String(tool?.attributes[attr.output]), "src/a.ts")
      })
  )

  it.effect("content full: the system prompt travels too", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const { tracer, spans } = recordingTracer()
      const seat = timedSeat(streaming, events, "coder", { content: "full" })
      yield* collect(
        seat.executeStreamWithHistory([
          Message.make({ role: "System", content: "rules" }),
          Message.make({ role: "User", content: "do it" })
        ])
      ).pipe(Effect.withTracer(tracer))
      assert.include(
        String(
          spans().find((span) => span.attributes[kindAttribute] === "LLM")?.attributes[attr.input]
        ),
        "rules"
      )
    })
  )

  it.effect(
    "a backend that reports no usage gets an estimate on the span, flagged, with a clean model name",
    () =>
      Effect.gen(function* () {
        const events = yield* makeFlowEventHub()
        const { tracer, spans } = recordingTracer()
        const silent: LlmServiceShape = {
          ...unusedService,
          executeStreamWithHistory: () =>
            chunks(LlmChunk.make({ delta: "x".repeat(400), finishReason: "stop" }))
        }
        const seat = timedSeat(silent, events, "coder", {
          estimate: { referenceModel: "claude-sonnet-4" }
        })
        yield* collect(
          seat.executeStreamWithHistory([Message.make({ role: "User", content: "y".repeat(800) })])
        ).pipe(Effect.withTracer(tracer))
        const llm = spans().find((span) => span.attributes[kindAttribute] === "LLM")
        assert.strictEqual(llm?.attributes[attr.estimated], true)
        assert.strictEqual(llm?.attributes[attr.model], "claude-sonnet-4")
        assert.isAbove(Number(llm?.attributes[attr.inputTokens]), 0)
        assert.isUndefined(llm?.attributes[attr.costUsd])
      })
  )

  it.effect("structured calls are LLM spans too, under the caller's role", () =>
    Effect.gen(function* () {
      const events = yield* makeFlowEventHub()
      const { tracer, spans } = recordingTracer()
      const seat = timedSeat(structuredService, events, "reasoning")
      yield* withTimedRole("judge", seat.executeStructured("q", Schema.String, {})).pipe(
        Effect.withTracer(tracer)
      )
      const llm = spans().find((span) => span.attributes[kindAttribute] === "LLM")
      assert.deepStrictEqual([llm?.name, llm?.attributes[attr.role]], ["judge", "judge"])
    })
  )
})
```

`unusedService` and `structuredService` are whatever fakes `Timing.test.ts` already defines for a seat that fails every method and a seat whose `executeStructured` succeeds; reuse their names. `EstimatedUsageOptions` field names: read `packages/flow/src/EstimatedUsage.ts:26-33` and use them (`referenceModel` is the one shown there as `defaultReferenceModel`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/flow/test/Timing.test.ts`
Expected: FAIL — no spans recorded; `timedSeat` takes three arguments.

- [ ] **Step 3: Implement in `Timing.ts`**

Add imports:

```ts
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"
import { redactText } from "@llm4ts/core/observability/Redaction"
import type { Message, TokenUsage } from "@llm4ts/core/Models"
import { toolCategory } from "./Activity.ts"
import { estimateUsage, type EstimatedUsageOptions } from "./EstimatedUsage.ts"
import { attr, kindAttribute, usageAttributes, type OtelContent } from "./Spans.ts"
```

Metrics (module level):

```ts
const tokensCounter = Metric.counter("llm4ts.tokens", {
  description: "tokens by model, role, executor and direction"
})
const costCounter = Metric.counter("llm4ts.cost.usd", {
  description: "cost the backend reported, USD"
})
const callsCounter = Metric.counter("llm4ts.model.calls", {
  description: "model calls by role and executor"
})
const toolCallsCounter = Metric.counter("llm4ts.tool.calls", {
  description: "harness tool calls by kind of work"
})
```

(Check `Metric.counter`'s options object in `effect/dist/Metric.d.ts:1688+` and `Metric.withAttributes` / `Metric.update`; attribute values must be strings.)

Options type and content helpers:

```ts
export interface TimedSeatOptions {
  /** Who serves the seat, read at each call (a roster hands the coder over). */
  readonly executor?: Effect.Effect<string | undefined>
  /** What content the spans may carry (ADR 0026); off by default. */
  readonly content?: OtelContent
  /** When set, a call the backend reports no usage for gets an estimate on its span, flagged. */
  readonly estimate?: EstimatedUsageOptions
}

const inputChars = 64_000
const partChars = 4_000

const contentOf = (
  content: OtelContent,
  messages: ReadonlyArray<Message>
): Record<string, unknown> => {
  if (content === "off") return {}
  const shown = messages.filter((message) => content === "full" || message.role !== "System")
  return {
    [attr.input]: redactText(
      shown.map((message) => `${message.role}: ${message.content}`).join("\n\n"),
      { maxLength: inputChars }
    ),
    [attr.inputMessages]: JSON.stringify(
      shown.map((message) => ({
        role: message.role.toLowerCase(),
        content: redactText(message.content, { maxLength: inputChars })
      }))
    )
  }
}
```

`timedStream` gains the span: open it with `Effect.makeSpan(label, { kind: "client", attributes })` at stream start (inside the existing `Stream.unwrap(Effect.gen(…))`), keep `span` in scope, and:

- on each `tool_use` chunk: `const tracer = yield* Effect.tracer; const child = tracer.span({ name: tool, parent: Option.some(span), annotations: Context.empty(), links: [], startTime: yield* Clock.currentTimeNanos, kind: "internal", root: false, sampled: true })`, set `child.attribute(kindAttribute, "TOOL")`, `attr.toolCategory`, `attr.input` when content is on; keep it in a `Map<string, Span>` by `tool_id` (or a queue when ids are absent, mirroring `Activity.ts`'s `toolEnded`), and `Metric.update(Metric.withAttributes(toolCallsCounter, { category }), 1)`;
- on each `tool_result` chunk: look the child up, set `attr.output` when content is on, `child.end(yield* Clock.currentTimeNanos, failed ? Exit.fail(…) : Exit.void)`;
- track `usage` (`chunk.usage`), `model` (`chunk.metadata.model`), and the concatenated reply when content is on;
- in `Stream.ensuring`: compute `measured = usage !== undefined`; if not measured and `options.estimate` is set, `usage = estimateUsage(messages, replyText, options.estimate)` and `model = estimatedModelLabel(options.estimate.referenceModel)` (match `EstimatedUsage.ts`'s actual signature); set `usageAttributes(model, usage, !measured)`, `attr.output` when content is on, `attr.executor`, `attr.role`, `attr.operation = "chat"`, `attr.provider` when `chunk.metadata.provider` exists; update `tokensCounter` twice (input/output) and `callsCounter`, `costCounter` when `usage.costUsd` is defined and measured; finally `span.end(now, failed ? Exit.fail(…) : Exit.void)` after publishing the `Timed` event as today. End any tool span still open.

`timeEffect` (structured calls): wrap in `Effect.withSpan(effect, role ?? label, { kind: "client", attributes: { [kindAttribute]: "LLM", [attr.role]: role ?? label, [attr.operation]: "generate", [attr.executor]: … } })` and, for `executeStructuredWithUsage`, annotate the usage from the result with `Effect.annotateCurrentSpan(usageAttributes(model, usage, false))`.

`timedSeat(service, events, label, options = {})` threads `options` into both helpers. `withTimedRole`'s role is still what names the span.

In `packages/runner/src/FlowRunner.ts`, every `timedSeat(…)` call gets a fourth argument: `{ executor: <the same Effect passed to recorded()/transcriptSeat for that seat>, content: otelContent(environment), estimate: estimateOptions }` where `estimateOptions` is what `makeEstimatedUsageMeter` is given in the same scope (`estimatedUsageOptionsFromEnv(environment)`; pass `undefined` when `estimateUsage === false`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/flow/test/Timing.test.ts packages/flow/test/Activity.test.ts packages/flow/test/Stories.test.ts packages/runner/test/FlowRunner.test.ts`
Expected: PASS. The `Timed` events are unchanged, so `Profile.test.ts` is unaffected; run it too.

- [ ] **Step 5: Verify and commit**

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
git add packages/flow/src/Timing.ts packages/runner/src/FlowRunner.ts packages/flow/test/Timing.test.ts
git commit -m "flow: every seat call is an LLM span with GenAI usage, tool calls are its children, content stays home by default

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Gate commands as TOOL spans

**Files:**

- Modify: `flows/lib/epic-stories.ts` (`lintCommand`, or wherever a gate command runs and publishes `Timed{kind:"gate"}`; grep `kind: "gate"` across `packages/flow/src` and `flows/lib` and change the one producer)
- Test: `flows/test/epic-stories.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("gate spans", () => {
  it.effect("a gate command is a TOOL span with its command and exit code", () =>
    Effect.gen(function* () {
      const { tracer, spans } = recordingTracer()
      const events = yield* makeCollectingFlowEvents
      const process = makeFakeProcessExecutor({
        [processCommandKey(["pnpm", "test"])]: ProcessResult.make({
          exitCode: 1,
          stdout: "",
          stderr: "1 failed"
        })
      })
      yield* gatesIn(process, events, [["pnpm", "test"]])("/repo").pipe(Effect.withTracer(tracer))
      const gate = spans().find((span) => span.attributes[kindAttribute] === "TOOL")
      assert.deepStrictEqual(
        [gate?.name, gate?.attributes[attr.gateCommand], gate?.attributes[attr.gateExit]],
        ["gate pnpm test", "pnpm test", 1]
      )
    })
  )
})
```

Use the fake process executor exactly as the file's existing gate tests build it (`makeFakeProcessExecutor`, `processCommandKey`, `ProcessResult` are already imported there); copy their result shape.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run flows/test/epic-stories.test.ts -t "gate spans"`
Expected: FAIL — no TOOL span.

- [ ] **Step 3: Implement**

Wrap the gate command's execution (the code that publishes `Timed{kind:"gate"}`) in

```ts
withKindSpan(`gate ${command.join(" ")}`, { kind: "TOOL", attributes: { [attr.gateCommand]: command.join(" ") } }, …)
```

and after the exit code is known: `yield* Effect.annotateCurrentSpan(attr.gateExit, exitCode)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run flows/test/epic-stories.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
git add flows/lib/epic-stories.ts flows/test/epic-stories.test.ts
git commit -m "epic-stories: gate commands are TOOL spans

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The exporter layer, the run span and the switch — `packages/runner/src/Otel.ts`

**Files:**

- Create: `packages/runner/src/Otel.ts`
- Modify: `packages/runner/src/FlowRunner.ts` (`runWithBundle`: root span, `annotateSpans`, provide the layer)
- Modify: `packages/runner/package.json` (export `./Otel`), `packages/shell/src/Cli.ts` (`--otel` flag → `LLM4TS_OTEL=on`; forward `LLM4TS_FLOW=<flow basename>`), `packages/runner/src/FlowArgs.ts` (help text)
- Test: `packages/runner/test/Otel.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export type OtelConfig =
    | { readonly mode: "off" }
    | { readonly mode: "phoenix"; readonly tracesUrl: string } // --otel with no endpoint
    | { readonly mode: "env"; readonly endpoint: string } // OTEL_EXPORTER_OTLP_ENDPOINT (or traces endpoint) set
  export const phoenixTracesUrl = "http://localhost:6006/v1/traces"
  export const otelConfig = (environment: Readonly<Record<string, string | undefined>>) =>
    OtelConfig
  export interface OtelResource {
    readonly serviceVersion: string
    readonly project: string
  } // project = repo basename
  export const otelLayer = (config: OtelConfig, resource: OtelResource) => Layer.Layer<never> // Layer.empty when off
  export const otelSummary = (config: OtelConfig) => string | undefined // one line for the terminal
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/runner/test/Otel.test.ts`:

```ts
import { assert, describe, it } from "@effect/vitest"
import { otelConfig, otelSummary, phoenixTracesUrl } from "@llm4ts/runner/Otel"

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
      {
        mode: "env",
        endpoint: "http://x/v1/traces"
      }
    )
    assert.deepStrictEqual(
      otelConfig({ OTEL_SDK_DISABLED: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "http://x" }),
      { mode: "off" }
    )
    assert.deepStrictEqual(
      otelConfig({ LLM4TS_OTEL: "off", OTEL_EXPORTER_OTLP_ENDPOINT: "http://x" }),
      { mode: "off" }
    )
  })

  it("summarises where spans go", () => {
    assert.isUndefined(otelSummary({ mode: "off" }))
    assert.include(
      otelSummary({ mode: "phoenix", tracesUrl: phoenixTracesUrl }) ?? "",
      "localhost:6006"
    )
    assert.include(otelSummary({ mode: "env", endpoint: "http://c:4318" }) ?? "", "http://c:4318")
  })
})
```

Add to `packages/runner/test/FlowRunner.test.ts` a test that a run under `LLM4TS_OTEL` unset produces a root span named `run` with `openinference.span.kind=CHAIN` and `llm4ts.run`/`session.id` set, using `recordingTracer` (import from `../../flow/test/support/RecordingTracer.ts` or copy the helper into `packages/runner/test/support/`) and `Effect.withTracer` around `runWithBundle`. Look at how that file already drives `runWithBundle` with a fake coder and mirror it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/runner/test/Otel.test.ts packages/runner/test/FlowRunner.test.ts`
Expected: FAIL — module not found; no root span.

- [ ] **Step 3: Implement**

Create `packages/runner/src/Otel.ts`:

```ts
// OpenTelemetry export (ADR 0026): Effect's own OTLP tracer and metrics
// exporters over core's fetch client, so a run can show up in Phoenix,
// Langfuse, SigNoz or any collector with no SDK and no new dependency.
// The standard OTEL_* variables are the truth; `--otel` is the laptop case.
import * as Duration from "effect/Duration"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as OtlpMetrics from "effect/observability/OtlpMetrics"
import * as OtlpSerialization from "effect/observability/OtlpSerialization"
import * as OtlpTracer from "effect/observability/OtlpTracer"

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

const resourceOf = (resource: OtelResource) => ({
  serviceName: "llm4ts",
  serviceVersion: resource.serviceVersion,
  attributes: { "openinference.project.name": resource.project }
})

/**
 * The exporter for `config`: nothing when off; traces only for Phoenix;
 * traces and metrics from the standard variables for a generic endpoint
 * (`OTEL_TRACES_EXPORTER` defaults to `otlp` here, since the endpoint is
 * the operator's intent). Logs are never exported.
 */
export const otelLayer = (config: OtelConfig, resource: OtelResource): Layer.Layer<never> => {
  switch (config.mode) {
    case "off":
      return Layer.empty
    case "phoenix":
      return OtlpTracer.layer({
        url: config.tracesUrl,
        resource: resourceOf(resource),
        shutdownTimeout: flushTimeout
      }).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer))
    case "env":
      return Layer.mergeAll(
        OtlpTracer.layerFromConfig({ resource: resourceOf(resource) }),
        OtlpMetrics.layerFromConfig({ resource: resourceOf(resource) })
      ).pipe(Layer.provide(OtlpSerialization.layerJson), Layer.provide(FetchHttpClient.layer))
  }
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
```

`layerFromConfig` is a no-op unless `OTEL_TRACES_EXPORTER` contains `otlp`: in `runWithBundle`, when `config.mode === "env"` and `environment.OTEL_TRACES_EXPORTER` is unset, provide the layer under an environment where it is `otlp` (the layer reads `process.env`; set `process.env.OTEL_TRACES_EXPORTER ??= "otlp"` and `process.env.OTEL_METRICS_EXPORTER ??= "otlp"` before building it, and say so in the ADR). The layer's `R` must be `never` after the two `Layer.provide`s; if `OtlpTracer.layer` returns `Layer<Exporter.Flusher, …>`, add `Layer.discard`/map to `never` as the d.ts allows (read `effect/dist/Layer.d.ts` for the combinator that drops the output; `Layer.mergeAll` keeps outputs, which is fine since nothing requires them).

`packages/runner/src/FlowRunner.ts`, in `runWithBundle`:

- `const otel = otelConfig(environment)`; after the seats line, `if (otel.mode !== "off") yield* surface.log(palette.info(otelSummary(otel) ?? ""))`.
- `const version = runnerVersion()` where `runnerVersion` reads `packages/runner/package.json` the way the shell's `--version` does (grep `version` in `packages/shell/src/Cli.ts`; if it uses `createRequire(import.meta.url)("../package.json")`, do the same in `Otel.ts` and export `runnerVersion`).
- Wrap the body:
  ```ts
  withKindSpan(
    "run",
    {
      kind: "CHAIN",
      attributes: {
        [attr.run]: bundle.runId,
        [attr.session]: bundle.runId,
        ...(environment.LLM4TS_FLOW === undefined ? {} : { [attr.flow]: environment.LLM4TS_FLOW })
      }
    },
    body(context).pipe(
      Effect.annotateSpans({ [attr.run]: bundle.runId, [attr.session]: bundle.runId, ...flow })
    )
  ).pipe(
    Effect.provide(otelLayer(otel, { serviceVersion: version, project: basename(options.workDir) }))
  )
  ```
  placed inside the existing `Effect.provideService(FlowContext, context)` chain so the layer's scope closes (and flushes) with the run.
- Export `"./Otel": "./dist/Otel.js"` in `packages/runner/package.json`.

`packages/shell/src/Cli.ts`: add `otel: Flag.Boolean("otel").pipe(Flag.withDefault(false), Flag.withDescription("Export spans to a local Arize Phoenix (http://localhost:6006) unless OTEL_EXPORTER_OTLP_ENDPOINT points elsewhere; forwarded as LLM4TS_OTEL (ADR 0026)"))`; set `environment.LLM4TS_OTEL = "on"` when given; set `environment.LLM4TS_FLOW = basename(flowPath, extname(flowPath))` always. `FlowArgs.ts` help: add `LLM4TS_OTEL             on: export spans over OTLP (Phoenix at localhost:6006 unless OTEL_* says otherwise)` and `LLM4TS_OTEL_CONTENT     on|full: prompts, replies and tool I/O travel too (off by default)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/runner/test/Otel.test.ts packages/runner/test/FlowRunner.test.ts packages/runner/test/FlowArgs.test.ts`
Expected: PASS. Then a manual smoke with no collector: `LLM4TS_OTEL=on pnpm exec vitest run packages/runner/test/FlowRunner.test.ts` must still pass in about the same time (the exporter fails to connect, swallows it, and the shutdown waits at most 3s per layer scope). If the suite slows by more than a few seconds, lower `shutdownTimeout` for tests via `exportInterval` options or skip the layer when `NODE_ENV === "test"` — and say which in the ledger.

- [ ] **Step 5: Verify and commit**

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
git add packages/runner/src/Otel.ts packages/runner/src/FlowRunner.ts packages/runner/src/FlowArgs.ts packages/runner/package.json packages/shell/src/Cli.ts packages/runner/test/Otel.test.ts packages/runner/test/FlowRunner.test.ts
git commit -m "runner: OTLP export over Effect's own exporter — Phoenix with --otel, any collector with OTEL_*

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `llm4ts doctor` says where spans go and whether anyone listens

**Files:**

- Modify: `packages/runner/src/Doctor.ts`
- Modify: `packages/runner/src/Otel.ts` (`otelDoctorLine`)
- Test: `packages/runner/test/Doctor.test.ts`, `packages/runner/test/Otel.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/runner/test/Otel.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/runner/test/Otel.test.ts`
Expected: FAIL — `otelDoctorLine` not exported.

- [ ] **Step 3: Implement**

In `Otel.ts`:

```ts
/** The doctor's line: `answers` is the probe's result, undefined when export is off. */
export const otelDoctorLine = (config: OtelConfig, answers: boolean | undefined): string => {
  switch (config.mode) {
    case "off":
      return "otel: off (LLM4TS_OTEL=on for a local Phoenix, or OTEL_EXPORTER_OTLP_ENDPOINT)"
    case "phoenix":
    case "env": {
      const where = config.mode === "phoenix" ? `Phoenix at ${config.tracesUrl}` : config.endpoint
      return `otel: ${where} — ${answers === true ? "endpoint answers" : "endpoint does not answer (spans will be dropped, the run is unaffected)"}`
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
```

In `Doctor.ts`, where the other checks print, add `yield* probeOtelEndpoint(config)` and print `otelDoctorLine(config, answers)`; the doctor's existing test for the printed lines gets one more `assert.include(output, "otel: off")`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/runner/test/Otel.test.ts packages/runner/test/Doctor.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
git add packages/runner/src/Otel.ts packages/runner/src/Doctor.ts packages/runner/test/Otel.test.ts packages/runner/test/Doctor.test.ts
git commit -m "doctor: say where spans go and whether the endpoint answers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Deprecations, docs, ADR 0026, changelog, release 2.30.0

**Files:**

- Modify: `packages/core/src/observability/Tracing.ts`, `Metrics.ts`, `MeteredLlmService.ts`, `StructuredLogger.ts` (module-level `@deprecated` JSDoc)
- Create: `docs/adr/0026-opentelemetry-export.md`, `docs/observability.md`
- Modify: `docs/configuration.md`, `docs/api.md` (deprecation note), `docs/parity.md`, `CHANGELOG.md`, `docs/superpowers/specs/2026-10-06-otel-export-design.md` (status), all five `package.json` via `pnpm version:set 2.30.0`

- [ ] **Step 1: Deprecate the home-grown modules**

At the top of each of the four files add:

```ts
/**
 * @deprecated Since 2.30.0 (ADR 0026): llm4ts exports OpenTelemetry spans and
 * metrics over OTLP from `@llm4ts/runner/Otel`; this in-memory module is not
 * used by flow or runner and will be removed in the next major.
 */
```

- [ ] **Step 2: ADR 0026**

Create `docs/adr/0026-opentelemetry-export.md` with sections Context (the workshop, the facts: Effect's exporter, Phoenix 15.10 conversion, cost attribute ignored, no inferred span kind), Decision (the eleven decisions of the spec, verbatim in substance), Consequences (no new dependency; `OTEL_TRACES_EXPORTER`/`OTEL_METRICS_EXPORTER` default to `otlp` when an endpoint is set; estimated usage is visible and flagged; a down collector costs at most three seconds; parity note), Not decided here (logs, Phoenix annotations, sampling, removal of the deprecated modules). Status `Accepted · Date: 2026-10-06`.

- [ ] **Step 3: `docs/observability.md`**

Write it for a person at the workshop:

```markdown
# Seeing a run in Phoenix (or any OpenTelemetry backend)

llm4ts exports what its agents do — stages, stories, tasks, every model call
with its tokens, every tool call, every gate, every judge verdict — as
OpenTelemetry spans over OTLP (ADR 0026). No SDK to install.

## Phoenix on your laptop

    docker run -p 6006:6006 -p 4317:4317 arizephoenix/phoenix:latest
    llm4ts run epic-stories --otel --repo ~/customer/portal "Add the account page"

Open http://localhost:6006. The project is named after the repository
(`portal`). One trace per story (an AGENT span), one for the run's planning
and merges; the session view groups a whole run. Phoenix ≥ 15.10 prices
tokens itself from the model name; estimated usage is marked
`llm4ts.usage.estimated=true`.

## Any other backend

Set the standard variables and drop `--otel`:

    OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318 llm4ts run …

Traces and metrics go out; logs never. Langfuse: `OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel` with its auth header in `OTEL_EXPORTER_OTLP_HEADERS`. SigNoz, Grafana Tempo and Jaeger take the endpoint as is (Jaeger shows the tree but no token views).

## Content

By default no prompt, reply, tool argument or output leaves the machine, the
same policy as the trace file. `LLM4TS_OTEL_CONTENT=on` adds prompts, replies
and tool I/O (redacted, capped); `LLM4TS_OTEL_CONTENT=full` adds the system
prompt. Phoenix renders them from 15.10.

## What you will see

- `openinference.span.kind`: CHAIN (run, planning, task, merge), AGENT (story), LLM (model call), TOOL (harness tool call, gate), EVALUATOR (judge round).
- `gen_ai.request.model`, `gen_ai.usage.input_tokens/output_tokens`; `llm4ts.role` (coder, reviewer, judge, planner); `llm4ts.story`, `llm4ts.epic`, `llm4ts.executor`; `llm4ts.judge.<dimension>` scores; `llm4ts.cost.usd` only when the backend reported a cost.
- Metrics (generic endpoint only): `llm4ts.tokens`, `llm4ts.cost.usd`, `llm4ts.model.calls`, `llm4ts.tool.calls`.

`llm4ts doctor` prints where spans go and whether the endpoint answers. A
collector that is down never fails a run; the run end waits at most three
seconds for the last batch.
```

`docs/configuration.md`: add an "OpenTelemetry" section with `LLM4TS_OTEL`, `LLM4TS_OTEL_CONTENT`, `LLM4TS_FLOW` (set by the shell), and a pointer to `observability.md`. `docs/api.md`: mark `@llm4ts/core/observability/*` deprecated. `docs/parity.md`: one entry ("OpenTelemetry export (ADR 0026, 2026-10-06) … llm4zio has no telemetry export. Additive.").

- [ ] **Step 4: Changelog and version**

Prepend to `CHANGELOG.md`:

```markdown
## 2.30.0

A run in Phoenix, Langfuse or any OpenTelemetry backend (ADR 0026).

- **`llm4ts run --otel`** exports spans to a local Arize Phoenix at
  `localhost:6006`; `OTEL_EXPORTER_OTLP_ENDPOINT` sends traces and metrics to
  any collector instead. Effect's own OTLP exporter, no SDK, no new dependency.
- **One trace per story** (AGENT), one for the run; tasks and merges are
  CHAIN spans, every seat call an LLM span with `gen_ai.*` tokens and the
  model name, harness tool calls TOOL children of it, gates TOOL spans, judge
  rounds EVALUATOR spans with the dimension scores. `session.id` groups a run.
- **Content stays home** unless `LLM4TS_OTEL_CONTENT=on` (prompts, replies,
  tool I/O; redacted, capped) or `full` (the system prompt too).
- **Costs**: exported only when the backend reported one; estimated usage is
  exported with the real model name and `llm4ts.usage.estimated=true`.
- **`llm4ts doctor`** prints where spans go and whether the endpoint answers.
- `@llm4ts/core/observability/{Tracing,Metrics,MeteredLlmService,StructuredLogger}`
  are deprecated; removal in the next major.
```

Then:

```bash
pnpm version:set 2.30.0
pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
pnpm build && node scripts/pack-smoke.mjs
```

Expected: all green; pack smoke resolves `@llm4ts/flow/Spans` and `@llm4ts/runner/Otel`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Release 2.30.0: OpenTelemetry export — a run in Phoenix or any OTLP backend

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Merging, tagging and pushing follow the user's instruction at the handoff.

---

## Self-review

- **Spec coverage**: decision 1 (switch) → Task 5; 2 (runner, FetchHttpClient) → Task 5; 3 (span tree) → Tasks 2, 3, 4, 5; 4 (attributes, resource) → Tasks 1, 3, 5; 5 (cost, estimates) → Tasks 1, 3; 6 (content) → Task 3; 7 (judge as attributes) → Task 2; 8 (metrics) → Task 3 (counters) + Task 5 (exported only in env mode); 9 (failure policy) → Task 5; 10 (deprecations) → Task 7; 11 (docs, doctor) → Tasks 6, 7.
- **Types**: `SpanOptions`/`withKindSpan` (Task 1) consumed by Tasks 2, 4, 5; `TimedSeatOptions` (Task 3) consumed by FlowRunner in Task 3; `OtelConfig` shape identical in Tasks 5 and 6; attribute keys only through `attr`.
- **Review Focus**: 1 → Task 5 `otelConfig({}) → off`, `Layer.empty`; 2 → Task 5 smoke under `LLM4TS_OTEL=on` with no collector; 3 → Task 3 estimate test; 4 → Task 3 "no content by default" test; 5 → Task 2 story span test (root, link, `llm4ts.story` on children).
- **Open API details the executor verifies against the d.ts** (named in the steps, not guessed): `SpanLink` field names, `Effect.annotateSpans` argument order, `Metric.counter` options and `Metric.withAttributes`, `Clock.currentTimeNanos`, `Layer` combinator to drop a layer's output, `EstimatedUsageOptions` field names and `estimateUsage` signature.
