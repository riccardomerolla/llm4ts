import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { makeKey } from "@llm4ts/core/blackboard/Fact"
import { derive, judge, on } from "@llm4ts/core/blackboard/Rule"
import { makeRuleset } from "@llm4ts/core/blackboard/Ruleset"
import { runRuleset } from "@llm4ts/core/blackboard/Run"
import { FakeJudgmentLive, makeFakeJudgment } from "@llm4ts/core/judgment/FakeJudgment"
import { Judgment, JudgmentBackendError } from "@llm4ts/core/judgment/Judgment"
import { origins, truth, TruthAnswer, truthAnswer } from "@llm4ts/core/judgment/Schemas"

const summary = makeKey("review.summary", Schema.String)
const blocking = makeKey("review.blocking", TruthAnswer)
const landable = makeKey("story.landable", Schema.Boolean)

const blockingRule = judge({
  name: "blocking",
  condition: on(summary),
  produces: [blocking],
  ask: (text) => ({
    state: text,
    questions: { blocking: truth("The review reports a blocking defect.") }
  }),
  post: (result) => {
    const answer = result.answers.blocking
    return answer?.type === "truth" ? [blocking.of(answer)] : []
  }
})

const landing = derive({
  name: "landing",
  condition: on(blocking),
  produces: [landable],
  derive: (answer) => [landable.of(answer.truth < 0.5)]
})

describe("judge rules", () => {
  it.effect(
    "asks the Judgment service and posts the typed answer with its origin; the trace names the backend",
    () =>
      Effect.gen(function* () {
        const ruleset = yield* makeRuleset({
          name: "landing",
          imports: [summary],
          exports: [landable],
          rules: [blockingRule, landing]
        })
        const result = yield* runRuleset(ruleset, [summary.of("Two nits, nothing blocking.")])
        const answer = yield* result.board.get(blocking)
        assert.strictEqual(answer.truth, 0.1)
        assert.strictEqual(answer.origin.backend, "fake")
        assert.isTrue(yield* result.board.get(landable))
        const firing = result.trace.find((f) => f.rule === "blocking")
        assert.strictEqual(firing?.kind, "judge")
        assert.deepStrictEqual(firing?.judgment, { backend: "fake", identity: "fake" })
      }).pipe(
        Effect.provide(
          FakeJudgmentLive({ answers: { blocking: truthAnswer(0.1, origins.fake()) } })
        )
      )
  )

  it.effect("a question the backend could not answer still reaches post, as a failure", () =>
    Effect.gen(function* () {
      const cautious = judge({
        name: "blocking",
        condition: on(summary),
        produces: [landable],
        ask: (text) => ({ state: text, questions: { blocking: truth("blocking?") } }),
        post: (result) => [landable.of(result.failures.length === 0)]
      })
      const ruleset = yield* makeRuleset({
        name: "l",
        imports: [summary],
        exports: [landable],
        rules: [cautious]
      })
      const result = yield* runRuleset(ruleset, [summary.of("x")])
      assert.isFalse(yield* result.board.get(landable))
      assert.deepStrictEqual(result.trace[0]?.judgment, { backend: "fake", identity: "fake" })
    }).pipe(Effect.provide(FakeJudgmentLive({ failures: { blocking: "no logprobs" } })))
  )

  it.effect("an unreachable backend is a RuleFailure and the defaults are posted", () =>
    Effect.gen(function* () {
      const down = Layer.succeed(Judgment, {
        backend: "llm",
        identity: "llm:down",
        judge: () =>
          Effect.fail(JudgmentBackendError.make({ backend: "llm", message: "connection refused" }))
      })
      const guarded = judge({
        name: "blocking",
        condition: on(summary),
        produces: [landable],
        defaults: [landable.of(false)],
        ask: (text) => ({ state: text, questions: { blocking: truth("blocking?") } }),
        post: () => [landable.of(true)]
      })
      const ruleset = yield* makeRuleset({
        name: "l",
        imports: [summary],
        exports: [landable],
        rules: [guarded]
      })
      const result = yield* runRuleset(ruleset, [summary.of("x")]).pipe(Effect.provide(down))
      assert.isFalse(yield* result.board.get(landable))
      assert.strictEqual(result.failures[0]?.rule, "blocking")
      assert.instanceOf(result.failures[0]?.error, JudgmentBackendError)
    })
  )

  it.effect("the state and questions reach the backend exactly as asked", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeJudgment()
      const ruleset = yield* makeRuleset({
        name: "landing",
        imports: [summary],
        exports: [landable],
        rules: [blockingRule, landing]
      })
      yield* runRuleset(ruleset, [summary.of("text")]).pipe(
        Effect.provide(Layer.succeed(Judgment, fake.judgment))
      )
      const recorded = yield* fake.recorded
      assert.strictEqual(recorded.length, 1)
      assert.strictEqual(recorded[0]?.state, "text")
      assert.deepStrictEqual(Object.keys(recorded[0]?.questions ?? {}), ["blocking"])
    })
  )
})
