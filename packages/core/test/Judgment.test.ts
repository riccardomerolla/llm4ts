import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { InvalidRequestError, ParseError } from "@llm4ts/core/Errors"
import { makeRecordingHttpClient } from "@llm4ts/core/HttpClient"
import { makeFakeJudgment } from "@llm4ts/core/judgment/FakeJudgment"
import { choiceOf, scoreOf, truthOf } from "@llm4ts/core/judgment/Judgment"
import {
  labelPlan,
  LlmJudgmentConfig,
  makeLlmJudgment,
  sequencePlan
} from "@llm4ts/core/judgment/LlmJudgment"
import * as Result from "effect/Result"
import {
  Answer,
  averageProbabilities,
  choice,
  confidenceOf,
  expectedScore,
  JudgmentRequest,
  score,
  truth
} from "@llm4ts/core/judgment/Schemas"
import { makeTypeSafeJudgment, toWireQuestion } from "@llm4ts/core/judgment/TypeSafeJudgment"
import { normalizeLabelProbabilities } from "@llm4ts/core/LabelScoring"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { TokenUsage, type JsonSchema, type LabelDistribution } from "@llm4ts/core/Models"

const unused = InvalidRequestError.make({ message: "unused" })

const questions = {
  department: choice("Which department?", {
    billing: "invoices and refunds",
    technical: "bugs and outages"
  }),
  clarity: score("How clear is the reply?", ["unclear", "adequate", "crisp"]),
  urgent: truth("The customer is blocked.")
}

interface LabelFake {
  readonly service: LlmServiceShape
  readonly prompts: Effect.Effect<ReadonlyArray<string>>
}

/** Answers label questions from a table keyed by the first label offered; verbalized JSON on fallback. */
const makeLabelFake = (
  byLabels: (labels: ReadonlyArray<string>) => Effect.Effect<LabelDistribution, ParseError>,
  structured?: unknown
): Effect.Effect<LabelFake> =>
  Effect.map(Ref.make<ReadonlyArray<string>>([]), (prompts) => ({
    prompts: Ref.get(prompts),
    service: {
      executeStream: () => Stream.empty,
      executeStreamWithHistory: () => Stream.empty,
      executeWithTools: () => Effect.fail(unused),
      executeStructured: () => Effect.fail(unused),
      executeStructuredWithUsage: <A, E, RD, RE>(
        _prompt: string,
        schema: Schema.ConstraintCodec<A, E, RD, RE>,
        _jsonSchema: JsonSchema
      ) =>
        structured === undefined
          ? Effect.fail(unused)
          : Schema.decodeUnknownEffect(schema)(structured).pipe(
              Effect.orDie,
              Effect.map((value) => [value, undefined, undefined] as const)
            ),
      scoreLabels: (prompt, labels) =>
        Ref.update(prompts, (all) => [...all, prompt]).pipe(Effect.andThen(byLabels(labels))),
      isAvailable: Effect.succeed(true)
    }
  }))

const peakedOn = (index: number, usage?: TokenUsage) => (labels: ReadonlyArray<string>) =>
  normalizeLabelProbabilities(
    labels,
    Object.fromEntries(labels.map((label, at) => [label, at === index ? 0.9 : 0.1])),
    "logprobs",
    usage === undefined ? {} : { usage }
  )

describe("judgment/Schemas", () => {
  it("confidence is the peak and score is the expected level", () => {
    assert.strictEqual(confidenceOf({ a: 0.2, b: 0.7, c: 0.1 }), 0.7)
    assert.strictEqual(expectedScore({ "0": 0.2, "1": 0.6, "2": 0.2 }), 1)
    assert.deepStrictEqual(
      averageProbabilities([
        { a: 1, b: 0 },
        { a: 0, b: 1 }
      ]),
      { a: 0.5, b: 0.5 }
    )
  })

  it.effect("answers round-trip through JSON with their origin", () =>
    Effect.gen(function* () {
      const encoded = JSON.stringify({
        type: "score",
        score: 1.5,
        legend: { "0": "low", "1": "high" },
        probabilities: { "0": 0.5, "1": 0.5 },
        confidence: 0.5,
        origin: { backend: "typesafe", method: "hosted", calibration: "claimed" }
      })
      const answer = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Answer))(encoded)
      assert.strictEqual(answer.type, "score")
      assert.strictEqual(answer.origin.calibration, "claimed")
      assert.strictEqual(answer.support, 1)
      const request = yield* Schema.decodeUnknownEffect(JudgmentRequest)({
        state: { message: "hi" },
        questions: { q: { type: "truth", instructions: "Is it?" } }
      })
      assert.strictEqual(request.questions["q"]?.type, "truth")
    })
  )

  it("label plans use letters for options and yes/no for truth, and reverse cleanly", () => {
    const forward = labelPlan("s", questions.department, false)
    assert.deepStrictEqual(forward.labels, ["A", "B"])
    assert.deepStrictEqual(forward.keys, { A: "billing", B: "technical" })
    assert.match(
      forward.prompt,
      /^State:\ns\n\nQuestion: Which department\?\nOptions:\nA\. billing: invoices and refunds\nB\. technical: bugs and outages\nAnswer with exactly one letter\.$/
    )
    const reversed = labelPlan("s", questions.department, true)
    assert.deepStrictEqual(reversed.keys, { A: "technical", B: "billing" })
    const yesNo = labelPlan(["a", "b"], questions.urgent, false)
    assert.deepStrictEqual(yesNo.labels, ["yes", "no"])
    assert.match(yesNo.prompt, /^State:\na\nb\n\nStatement: The customer is blocked\./)
  })
})

describe("judgment/LlmJudgment", () => {
  it.effect("answers every question independently with typed answers and origins", () =>
    Effect.gen(function* () {
      const usage = TokenUsage.make({ prompt: 10, completion: 1, total: 11 })
      const fake = yield* makeLabelFake(peakedOn(1, usage))
      const seen = yield* Ref.make<ReadonlyArray<readonly [TokenUsage, string | undefined]>>([])
      const judgment = makeLlmJudgment(fake.service, undefined, {
        onUsage: (used, model) => Ref.update(seen, (all) => [...all, [used, model] as const])
      })
      const result = yield* judgment.judge({ state: "the invoice bounced", questions })

      const department = yield* choiceOf(result, "department")
      assert.strictEqual(department.choice, "technical")
      assert.strictEqual(department.origin.method, "logprobs")
      assert.strictEqual(department.origin.backend, "llm")
      assert.strictEqual(department.confidence, 0.9)
      assert.strictEqual(department.support, 1)
      assert.strictEqual(judgment.identity, "llm:unknown:default")
      const clarity = yield* scoreOf(result, "clarity")
      assert.deepStrictEqual(clarity.legend, { "0": "unclear", "1": "adequate", "2": "crisp" })
      assert.closeTo(clarity.score, 0.9 * 1 + (0.1 / 1.1) * 0 + 0, 0.2)
      const urgent = yield* truthOf(result, "urgent")
      assert.closeTo(urgent.truth, 0.1, 0.01)
      assert.strictEqual(result.failures.length, 0)
      assert.strictEqual(result.backend, "llm")
      assert.deepStrictEqual(
        result.usage,
        TokenUsage.make({ prompt: 30, completion: 3, total: 33 })
      )
      const recorded = yield* Ref.get(seen)
      assert.strictEqual(recorded.length, 1)
    })
  )

  it.effect("falls back to the verbalized path for one question and reports it", () =>
    Effect.gen(function* () {
      const fallbacks = yield* Ref.make<ReadonlyArray<string>>([])
      const fake = yield* makeLabelFake(
        (labels) =>
          labels[0] === "yes"
            ? Effect.fail(ParseError.make({ message: "no label observed", raw: "" }))
            : peakedOn(0)(labels),
        { label: "yes", probabilities: { yes: 0.7, no: 0.3 } }
      )
      const judgment = makeLlmJudgment(fake.service, undefined, {
        onFallback: (key, reason) => Ref.update(fallbacks, (all) => [...all, `${key}:${reason}`])
      })
      const result = yield* judgment.judge({ state: "s", questions })
      const urgent = yield* truthOf(result, "urgent")
      assert.closeTo(urgent.truth, 0.7, 0.001)
      assert.strictEqual(urgent.origin.method, "verbalized")
      const department = yield* choiceOf(result, "department")
      assert.strictEqual(department.origin.method, "logprobs")
      assert.deepStrictEqual(yield* Ref.get(fallbacks), ["urgent:no label observed"])
    })
  )

  it.effect("isolates a question that fails even after the fallback", () =>
    Effect.gen(function* () {
      const fake = yield* makeLabelFake((labels) =>
        labels[0] === "yes"
          ? Effect.fail(ParseError.make({ message: "unreadable", raw: "" }))
          : peakedOn(0)(labels)
      )
      const judgment = makeLlmJudgment(fake.service)
      const result = yield* judgment.judge({ state: "s", questions })
      assert.strictEqual(Object.keys(result.answers).length, 2)
      assert.deepStrictEqual(
        result.failures.map((failure) => failure.key),
        ["urgent"]
      )
      const mismatch = yield* Effect.flip(truthOf(result, "urgent"))
      assert.strictEqual(mismatch._tag, "AnswerMismatch")
      assert.match(mismatch.message, /no truth answer/)
      const wrongKind = yield* Effect.flip(truthOf(result, "department"))
      assert.strictEqual(wrongKind.actual, "choice")
    })
  )

  it.effect("permutations: 2 asks both orders and averages by option key", () =>
    Effect.gen(function* () {
      // The first label always wins: without averaging, order alone would decide.
      const fake = yield* makeLabelFake(peakedOn(0))
      const judgment = makeLlmJudgment(fake.service, LlmJudgmentConfig.make({ permutations: 2 }))
      const result = yield* judgment.judge({
        state: "s",
        questions: { department: questions.department }
      })
      const department = yield* choiceOf(result, "department")
      assert.closeTo(department.probabilities["billing"] ?? 0, 0.5, 0.001)
      assert.closeTo(department.probabilities["technical"] ?? 0, 0.5, 0.001)
      assert.strictEqual((yield* fake.prompts).length, 2)
    })
  )
})

describe("judgment/TypeSafeJudgment", () => {
  it("translates truth to noul on the wire", () => {
    const wire = toWireQuestion(truth("Is it?", { true: "yes when", false: "no when" }))
    assert.strictEqual(wire.type, "noul")
    assert.strictEqual(toWireQuestion(questions.department).type, "choice")
  })

  it.effect("posts one batched request, decodes calibrated answers, and prices input tokens", () =>
    Effect.gen(function* () {
      const recording = yield* makeRecordingHttpClient(() =>
        Effect.succeed(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              department: {
                type: "choice",
                choice: "billing",
                probabilities: { billing: 0.8, technical: 0.2 },
                confidence: 0.8
              },
              clarity: {
                type: "score",
                score: 1.4,
                legend: { "0": "unclear", "1": "adequate", "2": "crisp" },
                probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 },
                confidence: 0.5
              },
              urgent: { type: "noul", noul: 0.93 }
            },
            usage: { input_tokens: 1000, output_tokens: 48 }
          })
        )
      )
      const priced = yield* Ref.make<TokenUsage | undefined>(undefined)
      const judgment = makeTypeSafeJudgment(
        {
          apiKey: Redacted.make("secret-key"),
          onUsage: (usage) => Ref.set(priced, usage)
        },
        recording.client
      )
      const result = yield* judgment.judge({ state: { message: "help" }, questions })
      const [request] = yield* recording.recorded
      assert.strictEqual(request?.url, "https://api.typesafe.ai/v1/systemone")
      assert.strictEqual(request?.headers["Authorization"], "Bearer secret-key")
      const body = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            model: Schema.String,
            questions: Schema.Record(Schema.String, Schema.Struct({ type: Schema.String }))
          })
        )
      )(request?.body ?? "{}")
      assert.strictEqual(body.model, "jev-latest")
      assert.strictEqual(body.questions["urgent"]?.type, "noul")

      const urgent = yield* truthOf(result, "urgent")
      assert.strictEqual(urgent.truth, 0.93)
      assert.strictEqual(urgent.origin.calibration, "claimed")
      assert.strictEqual(urgent.origin.method, "hosted")
      const department = yield* choiceOf(result, "department")
      assert.strictEqual(department.choice, "billing")
      // Confidence is recomputed as the peak; the wire statistic rides along.
      assert.strictEqual(department.confidence, 0.8)
      assert.strictEqual(department.reportedConfidence, 0.8)
      assert.strictEqual(judgment.identity, "typesafe:jev-latest")
      assert.strictEqual(result.backend, "typesafe")
      assert.strictEqual(result.model, "jev-1.13.0")
      const usage = yield* Ref.get(priced)
      assert.strictEqual(usage?.prompt, 1000)
      assert.closeTo(usage?.costUsd ?? 0, 0.000042, 1e-9)
    })
  )

  it.effect("fails typed without leaking the key, and records unanswered questions", () =>
    Effect.gen(function* () {
      const failing = yield* makeRecordingHttpClient(() =>
        Effect.fail(InvalidRequestError.make({ message: "boom" }))
      )
      const judgment = makeTypeSafeJudgment({ apiKey: Redacted.make("secret-key") }, failing.client)
      const error = yield* Effect.flip(judgment.judge({ state: "s", questions }))
      assert.strictEqual(error._tag, "JudgmentBackendError")
      assert.notInclude(JSON.stringify(error), "secret-key")

      const partial = yield* makeRecordingHttpClient(() =>
        Effect.succeed(
          JSON.stringify({ answers: { urgent: { type: "error", message: "too long" } } })
        )
      )
      const result = yield* makeTypeSafeJudgment(
        { apiKey: Redacted.make("k") },
        partial.client
      ).judge({ state: "s", questions })
      assert.deepStrictEqual(
        result.failures.map((failure) => `${failure.key}:${failure.reason}`).sort(),
        ["clarity:no answer returned", "department:no answer returned", "urgent:too long"]
      )
    })
  )
})

describe("judgment/FakeJudgment", () => {
  it.effect("answers from the plan, defaults the rest, and records requests", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeJudgment({
        failures: { clarity: "planned failure" },
        defaultTruth: 0.25
      })
      const result = yield* fake.judgment.judge({ state: "s", questions })
      const department = yield* choiceOf(result, "department")
      assert.strictEqual(department.choice, "billing")
      const urgent = yield* truthOf(result, "urgent")
      assert.strictEqual(urgent.truth, 0.25)
      assert.deepStrictEqual(
        result.failures.map((failure) => failure.key),
        ["clarity"]
      )
      const recorded = yield* fake.recorded
      assert.strictEqual(recorded.length, 1)
      assert.strictEqual(result.backend, "fake")
    })
  )
})

describe("judgment/LlmJudgment shared-prefix batching", () => {
  const three = {
    department: questions.department,
    clarity: questions.clarity,
    urgent: questions.urgent
  }
  const distributionFor = (labels: ReadonlyArray<string>, peak: number) =>
    normalizeLabelProbabilities(
      labels,
      Object.fromEntries(labels.map((label, at) => [label, at === peak ? 0.8 : 0.2])),
      "logprobs",
      { support: 0.9 }
    )

  /** A fake with a native sequence read that records every batched prompt. */
  const makeSequenceFake = (
    failIndex?: number
  ): Effect.Effect<{
    readonly service: LlmServiceShape
    readonly batched: Effect.Effect<ReadonlyArray<string>>
    readonly single: Effect.Effect<ReadonlyArray<string>>
  }> =>
    Effect.gen(function* () {
      const batched = yield* Ref.make<ReadonlyArray<string>>([])
      const single = yield* Ref.make<ReadonlyArray<string>>([])
      const base = yield* makeLabelFake(peakedOn(0))
      const service: LlmServiceShape = {
        ...base.service,
        scoreLabels: (prompt, labels) =>
          Ref.update(single, (all) => [...all, prompt]).pipe(
            Effect.andThen(base.service.scoreLabels(prompt, labels))
          ),
        scoreLabelSequence: (prompt, labelSets) =>
          Effect.gen(function* () {
            yield* Ref.update(batched, (all) => [...all, prompt])
            const entries = yield* Effect.forEach(
              labelSets,
              (labels, index): Effect.Effect<Result.Result<LabelDistribution, ParseError>> =>
                index === failIndex
                  ? Effect.succeed(
                      Result.fail(ParseError.make({ message: `no label at ${index + 1}`, raw: "" }))
                    )
                  : Effect.result(distributionFor(labels, 1))
            )
            return {
              entries,
              usage: TokenUsage.make({ prompt: 100, completion: 6, total: 106 }),
              model: "batched-model"
            }
          })
      }
      return { service, batched: Ref.get(batched), single: Ref.get(single) }
    })

  it("lays out the state once and every question numbered", () => {
    const plan = sequencePlan("the state", [questions.department, questions.urgent], false)
    assert.strictEqual(plan.prompt.split("State:\nthe state").length, 2)
    assert.match(plan.prompt, /Question 1\.\nQuestion: Which department\?/)
    assert.match(plan.prompt, /Question 2\.\nStatement: The customer is blocked\./)
    assert.match(plan.prompt, /"<number>: <label>"/)
    assert.deepStrictEqual(
      plan.parts.map((part) => part.labels),
      [
        ["A", "B"],
        ["yes", "no"]
      ]
    )
  })

  it.effect("answers three questions with one native call, mapping positions back to keys", () =>
    Effect.gen(function* () {
      const fake = yield* makeSequenceFake()
      const usages = yield* Ref.make<ReadonlyArray<TokenUsage>>([])
      const judgment = makeLlmJudgment(
        fake.service,
        LlmJudgmentConfig.make({ batching: "shared-prefix" }),
        { onUsage: (usage) => Ref.update(usages, (all) => [...all, usage]) }
      )
      const result = yield* judgment.judge({ state: "s", questions: three })
      assert.strictEqual((yield* fake.batched).length, 1)
      assert.strictEqual((yield* fake.single).length, 0)
      const department = yield* choiceOf(result, "department")
      assert.strictEqual(department.choice, "technical")
      assert.strictEqual(department.origin.method, "logprobs")
      assert.strictEqual(department.origin.model, "batched-model")
      assert.closeTo(department.support, 0.9, 1e-9)
      const clarity = yield* scoreOf(result, "clarity")
      assert.closeTo(clarity.probabilities["1"] ?? 0, 0.8 / 1.2, 1e-9)
      const urgent = yield* truthOf(result, "urgent")
      assert.closeTo(urgent.truth, 0.2 / 1.0, 1e-9)
      assert.deepStrictEqual(yield* Ref.get(usages), [
        TokenUsage.make({ prompt: 100, completion: 6, total: 106 })
      ])
    })
  )

  it.effect(
    "falls back to an independent call only for the position the batch could not read",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeSequenceFake(1)
        const fallbacks = yield* Ref.make<ReadonlyArray<string>>([])
        const judgment = makeLlmJudgment(
          fake.service,
          LlmJudgmentConfig.make({ batching: "shared-prefix" }),
          {
            onFallback: (key, reason) =>
              Ref.update(fallbacks, (all) => [...all, `${key}: ${reason}`])
          }
        )
        const result = yield* judgment.judge({ state: "s", questions: three })
        assert.strictEqual((yield* fake.batched).length, 1)
        assert.strictEqual((yield* fake.single).length, 1)
        assert.deepStrictEqual(yield* Ref.get(fallbacks), [
          "clarity: shared-prefix batch: no label at 2"
        ])
        assert.strictEqual(Object.keys(result.answers).length, 3)
        assert.strictEqual((yield* scoreOf(result, "clarity")).origin.method, "logprobs")
        assert.deepStrictEqual(Object.keys(result.answers), ["department", "clarity", "urgent"])
      })
  )

  it.effect("derives a verbalized sequence when the service has no native one", () =>
    Effect.gen(function* () {
      const fake = yield* makeLabelFake(peakedOn(0), {
        answers: [
          { label: "B", probabilities: { A: 0.3, B: 0.7 } },
          { label: "yes", probabilities: { yes: 0.6, no: 0.4 } }
        ]
      })
      const judgment = makeLlmJudgment(
        fake.service,
        LlmJudgmentConfig.make({ batching: "shared-prefix" })
      )
      const result = yield* judgment.judge({
        state: "s",
        questions: { department: questions.department, urgent: questions.urgent }
      })
      assert.strictEqual((yield* fake.prompts).length, 0)
      const department = yield* choiceOf(result, "department")
      assert.strictEqual(department.choice, "technical")
      assert.strictEqual(department.origin.method, "verbalized")
      assert.closeTo((yield* truthOf(result, "urgent")).truth, 0.6, 1e-9)
    })
  )

  it.effect("independent batching still makes one call per question", () =>
    Effect.gen(function* () {
      const fake = yield* makeSequenceFake()
      const judgment = makeLlmJudgment(fake.service)
      yield* judgment.judge({ state: "s", questions: three })
      assert.strictEqual((yield* fake.batched).length, 0)
      assert.strictEqual((yield* fake.single).length, 3)
    })
  )
})
