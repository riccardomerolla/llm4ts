import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  FlowEvent,
  Info,
  RoundtableTurn,
  makeCollectingFlowEvents,
  withLane
} from "@llm4ts/flow/FlowEvents"

const codec = Schema.fromJsonString(FlowEvent)

describe("RoundtableTurn (ADR 0046)", () => {
  const turn = RoundtableTurn.make({
    lane: "Cloud Architect",
    meeting: "payments-hub",
    item: 2,
    itemTitle: "Integration",
    round: 1,
    turn: 7,
    kind: "objection",
    blocking: true,
    answers: [5],
    summary: "Point-to-point calls will not scale."
  })

  it.effect("round-trips through the trace codec", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(codec)(turn)
      const decoded = yield* Schema.decodeUnknownEffect(codec)(encoded)
      assert.deepStrictEqual(decoded, turn)
      assert.include(encoded, '"_tag":"RoundtableTurn"')
    })
  )

  it.effect("its lane is the speaker and is never restamped", () =>
    Effect.gen(function* () {
      const collecting = yield* makeCollectingFlowEvents
      const laned = withLane(collecting, { lane: "story-x" })
      yield* laned.publish(turn)
      yield* laned.publish(Info.make({ message: "hello" }))
      const recorded = yield* collecting.recorded
      assert.strictEqual(recorded.length, 2)
      assert.strictEqual(
        recorded[0]?._tag === "RoundtableTurn" ? recorded[0].lane : "",
        "Cloud Architect"
      )
      assert.strictEqual(recorded[1]?._tag === "Info" ? recorded[1].lane : "", "story-x")
    })
  )
})
