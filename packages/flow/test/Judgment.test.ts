import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import { unsupportedScoreLabels } from "@llm4ts/core/LabelScoring"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import type { JsonSchema } from "@llm4ts/core/Models"
import { makeFakeJudgment } from "@llm4ts/core/judgment/FakeJudgment"
import { JudgmentBackendError, choiceOf, truthOf } from "@llm4ts/core/judgment/Judgment"
import { choice, choiceAnswer, origins, truth, truthAnswer } from "@llm4ts/core/judgment/Schemas"
import {
  FlowEvent,
  JudgmentObserved,
  makeCollectingFlowEvents,
  type JudgmentOutcome
} from "@llm4ts/flow/FlowEvents"
import {
  JudgmentPolicy,
  CertaintyBands,
  cachedJudgment,
  certaintyOf,
  decide,
  defaultJudgmentPolicy,
  judgeOrEscalate
} from "@llm4ts/flow/Judgment"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { prescreenReviewers, securityReviewer, testReviewer } from "@llm4ts/flow/Review"
import { Reviewer } from "@llm4ts/flow/Reviewer"

const unused = InvalidRequestError.make({ message: "unused" })

/** A reasoning seat that answers every structured call with one canned JSON value. */
const reasoningReplying = (reply: unknown, calls?: Ref.Ref<number>): LlmServiceShape => {
  const answer = <A, E, RD, RE>(schema: Schema.ConstraintCodec<A, E, RD, RE>) =>
    (calls === undefined ? Effect.void : Ref.update(calls, (count) => count + 1)).pipe(
      Effect.andThen(Schema.decodeUnknownEffect(schema)(reply).pipe(Effect.orDie))
    )
  return {
    executeStream: () => Stream.empty,
    executeStreamWithHistory: () => Stream.empty,
    executeWithTools: () => Effect.fail(unused),
    executeStructured: (_prompt, schema, _jsonSchema: JsonSchema) => answer(schema),
    executeStructuredWithUsage: (_prompt, schema) =>
      answer(schema).pipe(Effect.map((value) => [value, undefined, undefined] as const)),
    scoreLabels: unsupportedScoreLabels,
    isAvailable: Effect.succeed(true)
  }
}

const failingReasoning: LlmServiceShape = {
  ...reasoningReplying({}),
  executeStructured: () => Effect.fail(unused)
}

const questions = {
  lane: choice("Which lane?", { fast: "no review", slow: "full review" }),
  risky: truth("The change is risky.")
}

describe("JudgmentPolicy and decide", () => {
  it.effect("round-trips observations through the FlowEvent schema", () =>
    Effect.gen(function* () {
      const outcomes: ReadonlyArray<JudgmentOutcome> = [
        { _tag: "ReviewPrescreen", lens: "security", issues: { Critical: 1, Warning: 0, Info: 2 } },
        { _tag: "SatisfiedProbe", literalMatch: false },
        { _tag: "ProgramJudge", score: 2 }
      ]
      for (const outcome of outcomes) {
        const event = JudgmentObserved.make({
          consumer:
            outcome._tag === "ReviewPrescreen"
              ? "review-prescreen"
              : outcome._tag === "SatisfiedProbe"
                ? "satisfied-probe"
                : "program-judge",
          state: "state",
          question: truth("Question?"),
          answer: truthAnswer(0.85, origins.llm("logprobs"), 0.8),
          judgmentIdentity: "llm:test-checkpoint",
          key: "question",
          decision: "caution",
          certainty: 0.7,
          support: 0.8,
          origin: origins.llm("logprobs"),
          outcome,
          mode: "observe"
        })
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(FlowEvent))(event)
        const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(FlowEvent))(encoded)
        assert.deepStrictEqual(decoded, event)
      }
    })
  )

  it("holds verbalized answers to a higher bar than logprobs, and claimed calibration higher than measured", () => {
    const logprobs = choiceAnswer({ a: 0.92, b: 0.08 }, origins.llm("logprobs"))
    const verbalized = choiceAnswer({ a: 0.92, b: 0.08 }, origins.llm("verbalized"))
    assert.strictEqual(decide(logprobs), "act")
    assert.strictEqual(decide(verbalized), "caution")
    assert.isAbove(defaultJudgmentPolicy.verbalized.act, defaultJudgmentPolicy.logprobs.act)
    assert.isAbove(defaultJudgmentPolicy.logprobs.act, defaultJudgmentPolicy.claimed.act)
    assert.isAbove(defaultJudgmentPolicy.claimed.act, defaultJudgmentPolicy.measured.act)
  })

  it("holds any answer rebuilt from too little mass on the offered options", () => {
    const sliver = choiceAnswer({ a: 1, b: 0 }, origins.llm("logprobs"), 0.05)
    assert.strictEqual(sliver.confidence, 1)
    assert.strictEqual(decide(sliver), "hold")
    assert.strictEqual(decide(sliver, JudgmentPolicy.make({ minSupport: 0.01 })), "act")
  })

  it("bands on certainty, and a truth's certainty is its distance from even", () => {
    assert.closeTo(certaintyOf(truthAnswer(0.1, origins.hosted())), 0.8, 1e-9)
    assert.strictEqual(decide(truthAnswer(0.05, origins.hosted())), "act")
    assert.strictEqual(decide(truthAnswer(0.55, origins.hosted())), "hold")
    assert.strictEqual(decide(truthAnswer(0.7, origins.hosted())), "hold")
    assert.strictEqual(decide(truthAnswer(0.85, origins.hosted())), "caution")
    const strict = JudgmentPolicy.make({
      claimed: CertaintyBands.make({ act: 0.99, hold: 0.95 })
    })
    assert.strictEqual(decide(truthAnswer(0.05, origins.hosted()), strict), "hold")
  })
})

describe("judgeOrEscalate", () => {
  it.effect("leaves confident answers alone", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeJudgment({
        answers: {
          lane: choiceAnswer({ fast: 0.95, slow: 0.05 }, origins.llm("logprobs")),
          risky: truthAnswer(0.02, origins.llm("logprobs"))
        }
      })
      const calls = yield* Ref.make(0)
      const events = yield* makeCollectingFlowEvents
      const result = yield* judgeOrEscalate({
        judgment: fake.judgment,
        reasoning: reasoningReplying({}, calls),
        events,
        request: { state: "s", questions }
      })
      assert.strictEqual((yield* choiceOf(result, "lane")).origin.method, "logprobs")
      assert.strictEqual(yield* Ref.get(calls), 0)
      assert.strictEqual((yield* events.recorded).length, 0)
    })
  )

  it.effect("escalates held answers and failed questions to the reasoning seat", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeJudgment({
        answers: { lane: choiceAnswer({ fast: 0.55, slow: 0.45 }, origins.llm("verbalized")) },
        failures: { risky: "no label observed" }
      })
      const events = yield* makeCollectingFlowEvents
      const result = yield* judgeOrEscalate({
        judgment: fake.judgment,
        reasoning: reasoningReplying({
          choice: "slow",
          probabilities: { fast: 0.1, slow: 0.9 },
          truth: 0.8
        }),
        events,
        request: { state: "s", questions }
      })
      const lane = yield* choiceOf(result, "lane")
      assert.strictEqual(lane.choice, "slow")
      assert.strictEqual(lane.origin.method, "reasoning")
      assert.isTrue(lane.origin.escalated)
      const risky = yield* truthOf(result, "risky")
      assert.strictEqual(risky.truth, 0.8)
      assert.isTrue(risky.origin.escalated)
      assert.strictEqual(result.failures.length, 0)
      const messages = (yield* events.recorded).map((event) =>
        event._tag === "Info" ? event.message : event._tag
      )
      assert.match(messages[0] ?? "", /'lane' escalated .* below hold/)
      assert.match(messages[1] ?? "", /'risky' escalated .* no label observed/)
    })
  )

  it.effect("keeps the original answer when the escalation itself fails", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeJudgment({
        answers: { lane: choiceAnswer({ fast: 0.55, slow: 0.45 }, origins.llm("verbalized")) },
        failures: { risky: "boom" }
      })
      const events = yield* makeCollectingFlowEvents
      const result = yield* judgeOrEscalate({
        judgment: fake.judgment,
        reasoning: failingReasoning,
        events,
        request: { state: "s", questions }
      })
      const lane = yield* choiceOf(result, "lane")
      assert.strictEqual(lane.origin.method, "verbalized")
      assert.isFalse(lane.origin.escalated)
      assert.deepStrictEqual(
        result.failures.map((failure) => failure.key),
        ["risky"]
      )
      const messages = (yield* events.recorded).map((event) =>
        event._tag === "Info" ? event.message : ""
      )
      assert.isTrue(messages.some((message) => /escalation failed/.test(message)))
    })
  )
})

describe("cachedJudgment", () => {
  it.effect("answers once per fingerprint and re-judges when the checkpoint changes", () =>
    Effect.gen(function* () {
      const files = yield* makeMemoryPlainFileStore()
      const fake = yield* makeFakeJudgment()
      const request = { state: "s", questions }
      const first = yield* cachedJudgment(files.store, "cache/j.json", fake.judgment, request)
      const second = yield* cachedJudgment(files.store, "cache/j.json", fake.judgment, request)
      assert.deepStrictEqual(second, first)
      assert.strictEqual((yield* fake.recorded).length, 1)

      yield* cachedJudgment(files.store, "cache/j.json", fake.judgment, {
        state: "changed",
        questions
      })
      assert.strictEqual((yield* fake.recorded).length, 2)

      const other = yield* makeFakeJudgment()
      const relabeled = { ...other.judgment, identity: "fake:retrained-checkpoint" }
      yield* cachedJudgment(files.store, "cache/j.json", relabeled, {
        state: "changed",
        questions
      })
      assert.strictEqual((yield* other.recorded).length, 1)
    })
  )
})

describe("prescreenReviewers", () => {
  const lenses: ReadonlyArray<Reviewer> = [securityReviewer, testReviewer]

  it.effect("skips a lens only when the screen is confidently negative", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeJudgment({
        answers: {
          [securityReviewer.name]: truthAnswer(0.02, origins.llm("logprobs")),
          [testReviewer.name]: truthAnswer(0.4, origins.llm("logprobs"))
        }
      })
      const events = yield* makeCollectingFlowEvents
      const { reviewers: kept } = yield* prescreenReviewers(
        { judgment: fake.judgment, mode: "act" },
        events,
        "+x",
        lenses
      )
      assert.deepStrictEqual(
        kept.map((lens) => lens.name),
        [testReviewer.name]
      )
      const [request] = yield* fake.recorded
      assert.deepStrictEqual(request?.state, { diff: "+x" })
      assert.match(
        (yield* events.recorded).map((event) => (event._tag === "Info" ? event.message : ""))[0] ??
          "",
        /skipped security/
      )
    })
  )

  it.effect(
    "runs every lens whose question failed, and holds verbalized screens to the higher bar",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeJudgment({
          answers: { [securityReviewer.name]: truthAnswer(0.15, origins.llm("verbalized")) },
          failures: { [testReviewer.name]: "unreadable" }
        })
        const events = yield* makeCollectingFlowEvents
        const { reviewers: kept } = yield* prescreenReviewers(
          { judgment: fake.judgment, mode: "act" },
          events,
          "+x",
          lenses
        )
        // 0.85 certainty is "act" for logprobs but only "caution" for verbalized.
        assert.strictEqual(kept.length, 2)
      })
  )

  it.effect("runs every lens when the backend is unavailable", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const broken = {
        backend: "llm" as const,
        identity: "llm:down",
        judge: () => Effect.fail(JudgmentBackendError.make({ backend: "llm", message: "down" }))
      }
      const { reviewers: kept } = yield* prescreenReviewers(
        { judgment: broken, mode: "act" },
        events,
        "+x",
        lenses
      )
      assert.strictEqual(kept.length, 2)
      const messages = (yield* events.recorded).map((event) =>
        event._tag === "Info" ? event.message : ""
      )
      assert.match(messages[0] ?? "", /pre-screen unavailable/)
    })
  )

  it("derives a screening statement from the system prompt when none is declared", () => {
    const lens = Reviewer.make({ name: "custom", systemPrompt: "Check the docs." })
    assert.match(
      lens.screeningStatement,
      /would report at least one concrete issue.*Check the docs/
    )
    assert.match(securityReviewer.screeningStatement, /trust boundary/)
  })
})
