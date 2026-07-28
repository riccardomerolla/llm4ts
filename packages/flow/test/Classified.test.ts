import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { noneGrants, restricted } from "@llm4ts/core/Capability"
import { Classified } from "@llm4ts/flow/Classified"
import { FlowEvents, makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"

describe("Classified", () => {
  it("never reveals its value through string conversion", () => {
    const secret = Classified.of("hunter2")

    assert.strictEqual(secret.toString(), "Classified(…)")
    assert.strictEqual(`token: ${secret}`, "token: Classified(…)")
  })

  it("maps without unwrapping", () => {
    const upper = Classified.of("hunter2").map((value) => value.toUpperCase())

    assert.strictEqual(upper.toString(), "Classified(…)")
  })

  it.effect("declassifies with a grant and emits an audit event", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const value = yield* Classified.of("hunter2")
        .declassify("test-secret")
        .pipe(Effect.provideService(FlowEvents, events))
      const recorded = yield* events.recorded

      assert.strictEqual(value, "hunter2")
      assert.isTrue(
        recorded.some((event) => event._tag === "Declassified" && event.label === "test-secret")
      )
    })
  )

  it.effect("fails typed under narrowed grants and keeps the value sealed", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const operation = Classified.of("hunter2")
        .declassify("blocked")
        .pipe(Effect.provideService(FlowEvents, events), restricted(noneGrants))
      const error = yield* Effect.flip(operation)
      const recorded = yield* events.recorded

      assert.strictEqual(error._tag, "CapabilityDenied")
      assert.strictEqual(error.capability._tag, "Declassify")
      assert.match(error.operation, /declassify blocked/)
      assert.isTrue(
        recorded.some(
          (event) => event._tag === "CapabilityDenied" && event.operation === "declassify blocked"
        )
      )
    })
  )
})
