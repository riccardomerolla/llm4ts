import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
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
        [story?.name, story?.attributes[kindAttribute], story?.root, story?.linkedTo],
        ["story a", "AGENT", true, ["run"]]
      )
      assert.isTrue(run?.ended)
      assert.isFalse(run?.failed)
    })
  )

  it.effect(
    "with no kind parent a kind span roots a trace, whatever internal span is current",
    () =>
      Effect.gen(function* () {
        const { tracer, spans } = recordingTracer()
        yield* Effect.withSpan(
          withKindSpan("run", { kind: "CHAIN" }, Effect.void),
          "internal fn"
        ).pipe(Effect.withTracer(tracer))
        const run = spans().find((span) => span.name === "run")
        assert.deepStrictEqual([run?.root, run?.parentName, run?.linkedTo], [true, undefined, []])
      })
  )

  it.effect(
    "the wrapped effect keeps the caller's scope: its finalizers run when that scope closes",
    () =>
      Effect.gen(function* () {
        const { tracer } = recordingTracer()
        const released = yield* Ref.make(false)
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* withKindSpan(
              "stage",
              { kind: "CHAIN" },
              Effect.addFinalizer(() => Ref.set(released, true))
            )
            // still inside the caller's scope: the span ended, the resource did not
            assert.isFalse(yield* Ref.get(released))
          })
        ).pipe(Effect.withTracer(tracer))
        assert.isTrue(yield* Ref.get(released))
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
    // an estimate never carries a cost, whatever the usage says
    assert.isUndefined(usageAttributes("gpt-5.5", paid, true)[attr.costUsd])
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
