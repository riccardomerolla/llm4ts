import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Board, DuplicateFact } from "@llm4ts/core/blackboard/Fact"
import { ExportsMissing, RunResult } from "@llm4ts/core/blackboard/Run"
import { RulesetInvalid } from "@llm4ts/core/blackboard/Ruleset"
import { origins, truthAnswer } from "@llm4ts/core/judgment/Schemas"
import {
  answerKey,
  decideRule,
  decisionKey,
  publishBlackboardRun,
  runErrorToFlowError
} from "@llm4ts/flow/Blackboard"
import { FlowEvent, makeCollectingFlowEvents, type BlackboardRun } from "@llm4ts/flow/FlowEvents"
import { JudgmentPolicy } from "@llm4ts/flow/Judgment"

const blocking = answerKey("review.blocking")
const verdict = decisionKey("decision.blocking")

describe("decideRule", () => {
  it.effect("posts act, caution or hold from the answer and the policy", () =>
    Effect.gen(function* () {
      const rule = decideRule({ name: "decide", answer: blocking, decision: verdict })
      assert.deepStrictEqual(rule.reads, ["review.blocking"])
      assert.deepStrictEqual(rule.produces, ["decision.blocking"])
      const fire = (truth: number, support = 1, policy?: JudgmentPolicy) =>
        Effect.gen(function* () {
          const decider =
            policy === undefined
              ? rule
              : decideRule({ name: "decide", answer: blocking, decision: verdict, policy })
          const encoded = yield* blocking.of(truthAnswer(truth, origins.fake(), support)).encoded
          const prepared = yield* decider.prepare(new Map([["review.blocking", encoded]]))
          if (!Option.isSome(prepared)) return "not-prepared"
          const posted = yield* prepared.value
          const fact = posted.facts[0]
          return fact === undefined ? "not-posted" : yield* verdict.read(yield* fact.encoded)
        })
      assert.strictEqual(yield* fire(0.99), "act")
      assert.strictEqual(yield* fire(0.6), "hold")
      // Support below the policy's floor is always held, however certain.
      assert.strictEqual(yield* fire(0.99, 0.1), "hold")
      assert.strictEqual(yield* fire(0.99, 0.1, JudgmentPolicy.make({ minSupport: 0 })), "act")
    })
  )
})

describe("run errors as flow errors", () => {
  it("names rules and keys, never values", () => {
    const missing = ExportsMissing.make({
      missing: [
        {
          key: "story.mergeable",
          waitingRules: [{ rule: "bar", missingKeys: ["judge.tests"] }],
          silentRules: []
        }
      ],
      trace: [],
      failures: []
    })
    const error = runErrorToFlowError(missing)
    assert.strictEqual(error._tag, "Llm")
    assert.include(error.message, "story.mergeable")
    assert.include(error.message, "judge.tests")
    const invalid = runErrorToFlowError(
      RulesetInvalid.make({ name: "board", problems: [{ kind: "UnproducedExport", key: "x" }] })
    )
    assert.include(invalid.message, "board")
    assert.include(runErrorToFlowError(DuplicateFact.make({ key: "k" })).message, "k")
  })
})

describe("BlackboardRun event", () => {
  it.effect("is published and round-trips through the event schema as trace JSON", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const result = RunResult.make({
        board: Board.make({ facts: { "story.mergeable": true } }),
        trace: [],
        failures: []
      })
      yield* publishBlackboardRun(events, "story-board", result)
      const seen = yield* events.recorded
      const event = seen.find((e): e is BlackboardRun => e._tag === "BlackboardRun")
      assert.isDefined(event)
      if (event === undefined) return
      assert.strictEqual(event.ruleset, "story-board")
      const json = yield* Schema.encodeEffect(FlowEvent)(event)
      // The recorder keeps an event's fields as JSON: the encoded form must be JSON.
      yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(json)
      const back = yield* Schema.decodeUnknownEffect(FlowEvent)(json)
      assert.strictEqual(back._tag, "BlackboardRun")
      if (back._tag === "BlackboardRun") {
        assert.deepStrictEqual(back.result.board.facts, { "story.mergeable": true })
      }
    })
  )
})
