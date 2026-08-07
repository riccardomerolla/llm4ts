import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ProviderError } from "@llm4ts/core/Errors"
import {
  budget,
  cap,
  capped,
  defaultContextBudget,
  isolateTruncations,
  renderTruncation,
  truncations,
  withShrink,
  type Truncation
} from "@llm4ts/flow/Context"
import { FlowLlmError, ProcessError, type FlowError } from "@llm4ts/flow/FlowError"
import { FlowEvents, Info, makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import { Provenance } from "@llm4ts/flow/Provenance"

const marker = "\n\n… [truncated] …\n\n"

describe("Context.cap", () => {
  it("returns text at or under the limit untouched", () => {
    const out = cap("short", 10)
    assert.strictEqual(out.text, "short")
    assert.strictEqual(out.originalChars, 5)
    assert.isFalse(out.truncated)
  })

  it("never returns more than the limit, marker included", () => {
    const text = "x".repeat(1000)
    for (const limit of [0, -5, 1, 10, marker.length, marker.length + 1, 100, 999]) {
      const out = cap(text, limit)
      assert.isAtMost(out.text.length, Math.max(limit, 0), `limit ${limit}`)
      assert.isTrue(out.truncated, `limit ${limit}`)
      assert.strictEqual(out.originalChars, 1000)
    }
  })

  it("keeps the head (3/4) and the tail (1/4) around the marker", () => {
    const text = `${"a".repeat(500)}${"z".repeat(500)}`
    const out = cap(text, 100)
    const room = 100 - marker.length
    const head = Math.floor((room * 3) / 4)
    assert.strictEqual(out.text, `${"a".repeat(head)}${marker}${"z".repeat(room - head)}`)
    assert.strictEqual(out.text.length, 100)
  })
})

describe("Context.budget", () => {
  it("prefers LLM4TS_CONTEXT_BUDGET, falls back to the deprecated alias, then the default", () => {
    assert.strictEqual(
      budget({ LLM4TS_CONTEXT_BUDGET: "1000", LLM4TS_JUDGE_SOURCES_LIMIT: "2000" }),
      1000
    )
    assert.strictEqual(budget({ LLM4TS_JUDGE_SOURCES_LIMIT: "2000" }), 2000)
    assert.strictEqual(budget({}), defaultContextBudget)
  })

  it("ignores non-positive and non-numeric values", () => {
    assert.strictEqual(budget({ LLM4TS_CONTEXT_BUDGET: "0" }), defaultContextBudget)
    assert.strictEqual(budget({ LLM4TS_CONTEXT_BUDGET: "-3" }), defaultContextBudget)
    assert.strictEqual(budget({ LLM4TS_CONTEXT_BUDGET: "many" }), defaultContextBudget)
  })
})

describe("Context.capped", () => {
  it.effect("passes fitting text through without event or record", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const program = Effect.gen(function* () {
        const text = yield* capped("specs", "fits", 100)
        return { text, recorded: yield* truncations }
      })
      const { text, recorded } = yield* isolateTruncations(program).pipe(
        Effect.provideService(FlowEvents, events)
      )
      assert.strictEqual(text, "fits")
      assert.deepStrictEqual(recorded, [])
      assert.deepStrictEqual(yield* events.recorded, [])
    })
  )

  it.effect("publishes an Info event and records the truncation", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const program = Effect.gen(function* () {
        const text = yield* capped("branch diff", "y".repeat(200), 50)
        return { text, recorded: yield* truncations }
      })
      const { text, recorded } = yield* isolateTruncations(program).pipe(
        Effect.provideService(FlowEvents, events)
      )
      assert.strictEqual(text.length, 50)
      assert.deepStrictEqual(recorded, [
        { label: "branch diff", originalChars: 200, keptChars: 50, kind: "capped" }
      ])
      const published = yield* events.recorded
      assert.deepStrictEqual(published, [
        Info.make({ message: "⚠ context: branch diff truncated 200 → 50 chars" })
      ])
    })
  )
})

describe("Context.withShrink", () => {
  const overflowAt = (threshold: number) => (chars: number) =>
    chars > threshold
      ? Effect.fail(
          FlowLlmError.make({
            message: "prompt is too long",
            cause: ProviderError.make({ message: "context length exceeded" })
          })
        )
      : Effect.succeed(chars)

  it.effect("retries an oversized prompt at 1/2 then 1/4, recording each shrink", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const program = Effect.gen(function* () {
        const result = yield* withShrink("judge context", overflowAt(30), { start: 100 })
        return { result, recorded: yield* truncations }
      })
      const { result, recorded } = yield* isolateTruncations(program).pipe(
        Effect.provideService(FlowEvents, events)
      )
      assert.strictEqual(result, 25)
      assert.deepStrictEqual(recorded, [
        { label: "judge context", originalChars: 100, keptChars: 50, kind: "shrunk" },
        { label: "judge context", originalChars: 50, keptChars: 25, kind: "shrunk" }
      ])
      assert.strictEqual((yield* events.recorded).length, 2)
    })
  )

  it.effect("fails naming the knob when the ladder is exhausted, with no typed cause", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const error = yield* Effect.flip(
        isolateTruncations(withShrink("specs", overflowAt(0), { start: 100 })).pipe(
          Effect.provideService(FlowEvents, events)
        )
      )
      assert.isTrue(error instanceof FlowLlmError)
      if (error instanceof FlowLlmError) {
        assert.include(error.message, "LLM4TS_CONTEXT_BUDGET")
        assert.include(error.message, "specs")
        assert.strictEqual(error.cause, undefined)
      }
    })
  )

  it.effect("passes non-shrinkable failures through untouched", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const failure: FlowError = ProcessError.make({ message: "git diff", detail: "boom" })
      const error = yield* Effect.flip(
        isolateTruncations(withShrink("specs", () => Effect.fail(failure), { start: 100 })).pipe(
          Effect.provideService(FlowEvents, events)
        )
      )
      assert.strictEqual(error, failure)
      assert.deepStrictEqual(yield* events.recorded, [])
    })
  )

  it.effect("treats a gemini empty response as shrinkable", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const attempts: Array<number> = []
      const f = (chars: number) => {
        attempts.push(chars)
        return chars > 50
          ? Effect.fail(FlowLlmError.make({ message: "Invalid stream: empty response" }))
          : Effect.succeed("ok")
      }
      const result = yield* isolateTruncations(withShrink("triage", f, { start: 100 })).pipe(
        Effect.provideService(FlowEvents, events)
      )
      assert.strictEqual(result, "ok")
      assert.deepStrictEqual(attempts, [100, 50])
    })
  )

  it.effect("isolateTruncations keeps concurrent logs private", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const one = isolateTruncations(
        Effect.gen(function* () {
          yield* capped("one", "x".repeat(100), 10)
          return yield* truncations
        })
      )
      const other = isolateTruncations(truncations)
      const [first, second] = yield* Effect.all([one, other]).pipe(
        Effect.provideService(FlowEvents, events)
      )
      assert.strictEqual(first.length, 1)
      assert.deepStrictEqual(second, [])
    })
  )
})

describe("Context.renderTruncation", () => {
  it("renders capped counts and shrunk ceilings distinctly", () => {
    const cappedEntry: Truncation = {
      label: "specs",
      originalChars: 200,
      keptChars: 50,
      kind: "capped"
    }
    const shrunkEntry: Truncation = {
      label: "specs",
      originalChars: 100,
      keptChars: 50,
      kind: "shrunk"
    }
    assert.strictEqual(renderTruncation(cappedEntry), "specs: truncated 200 → 50 chars")
    assert.strictEqual(
      renderTruncation(shrunkEntry),
      "specs: retried at a lower budget, 100 → 50 chars (ceilings, not text size)"
    )
  })
})

describe("Provenance.contextTruncations", () => {
  const base = {
    schema: 1,
    pack: "demo",
    llm4tsVersion: "0.0.0",
    createdAt: "2026-08-07T00:00:00Z",
    seats: {},
    specs: {},
    gateVerdicts: {},
    fixSpecs: []
  }

  it.effect("manifests written before the field still load", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(Provenance)(base)
      assert.deepStrictEqual(decoded.contextTruncations, [])
    })
  )

  it.effect("round-trips recorded truncations", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(Provenance)({
        ...base,
        contextTruncations: ["specs: truncated 200 → 50 chars"]
      })
      assert.deepStrictEqual(decoded.contextTruncations, ["specs: truncated 200 → 50 chars"])
      const encoded = yield* Schema.encodeEffect(Provenance)(decoded)
      assert.deepStrictEqual(encoded.contextTruncations, ["specs: truncated 200 → 50 chars"])
    })
  )
})
