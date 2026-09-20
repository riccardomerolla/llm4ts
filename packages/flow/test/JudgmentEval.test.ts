import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { LlmConfig } from "@llm4ts/core/Models"
import { makeMockProvider } from "@llm4ts/core/providers/MockProvider"
import { makeLlmJudgment } from "@llm4ts/core/judgment/LlmJudgment"
import { makeFakeJudgment } from "@llm4ts/core/judgment/FakeJudgment"
import {
  origins,
  score,
  scoreAnswer,
  truth,
  truthAnswer,
  type Answer
} from "@llm4ts/core/judgment/Schemas"
import { LabelledItem } from "../src/JudgmentDataset.ts"
import {
  EvalReport,
  evaluateJudgments,
  renderEvalReport,
  replayEvalItems,
  replayMissesAgree,
  type EvalItem
} from "../src/JudgmentEval.ts"

import { decide } from "../src/Judgment.ts"
import { makeCollectingFlowEvents } from "../src/FlowEvents.ts"
import {
  prescreenReviewers,
  reviewWith,
  correctnessReviewer,
  securityReviewer,
  testReviewer,
  ReviewIssue,
  ReviewResult,
  type ReviewPrescreenResult
} from "../src/Review.ts"

const attribution = { source: "fixture", labelledBy: "test", labelledAt: "2026-09-20T00:00:00Z" }
const truthItem = (id: string, label: boolean): LabelledItem =>
  LabelledItem.make({
    ...attribution,
    id,
    label,
    decision: "review-prescreen",
    state: `diff ${id}`,
    question: truth("Does the lens find an issue?")
  })
const scoreQuestion = score("Quality", ["poor", "fair", "good"])
const scoreItem = (id: string, label: number): LabelledItem =>
  LabelledItem.make({
    ...attribution,
    id,
    label,
    decision: "program-judge",
    state: `spec and diff ${id}`,
    question: scoreQuestion
  })
const observation = (probability: number, label = true, latencyMs = 10): EvalItem => ({
  item: truthItem("truth", label),
  answer: truthAnswer(probability, origins.fake()),
  latencyMs
})
const close = (actual: number | null, expected: number) => {
  assert.isNotNull(actual)
  assert.isTrue(Math.abs((actual ?? NaN) - expected) < 1e-10)
}

describe("JudgmentEval", () => {
  it.effect(
    "evaluates completed mock-provider reviews without inventing a failed-review label",
    () =>
      Effect.gen(function* () {
        const provider = makeMockProvider(LlmConfig.make({ provider: "Mock", model: "mock" }))
        const events = yield* makeCollectingFlowEvents
        const result = yield* reviewWith(provider, events, correctnessReviewer, "task", "diff")
        assert.deepStrictEqual(result.issues, [])
        const screen = yield* prescreenReviewers(
          { judgment: makeLlmJudgment(provider), mode: "act" },
          events,
          "diff",
          [correctnessReviewer]
        )
        const report = evaluateJudgments(
          replayEvalItems(
            { sha: "mock", diff: "diff" },
            [{ lens: correctnessReviewer, result }],
            screen.observations,
            10,
            attribution.labelledAt
          )
        )
        assert.strictEqual(report.overall.answered, 1)
        assert.strictEqual(report.overall.failed, 0)
        close(report.overall.ece, 0.6)
        close(report.overall.brier, 0.36)
        assert.isTrue(replayMissesAgree(report, { Critical: 0, Warning: 0, Info: 0 }, 0))
      })
  )

  it.effect("builds outcome labels from full lenses and reuses actual act-mode observations", () =>
    Effect.gen(function* () {
      const lenses = [correctnessReviewer, securityReviewer, testReviewer]
      const fake = yield* makeFakeJudgment({
        answers: {
          [correctnessReviewer.name]: truthAnswer(0, origins.fake()),
          [securityReviewer.name]: truthAnswer(0, origins.fake(), 0.1),
          [testReviewer.name]: truthAnswer(0, origins.fake())
        }
      })
      const events = yield* makeCollectingFlowEvents
      const screen = yield* prescreenReviewers(
        { judgment: fake.judgment, mode: "act" },
        events,
        "diff",
        lenses
      )
      const runs = lenses.map((lens) => ({
        lens,
        result: ReviewResult.make({
          issues:
            lens === testReviewer
              ? []
              : [
                  ReviewIssue.make({ severity: "Critical", title: "critical" }),
                  ReviewIssue.make({ severity: "Warning", title: "warning 1" }),
                  ReviewIssue.make({ severity: "Warning", title: "warning 2" }),
                  ReviewIssue.make({ severity: "Info", title: "info" })
                ]
        })
      }))
      // Reverse observations to prove matching is by lens key, not array position.
      const items = replayEvalItems(
        { sha: "abc", diff: "diff" },
        runs,
        [...screen.observations].reverse(),
        90,
        attribution.labelledAt
      )
      assert.strictEqual((yield* fake.recorded).length, 1)
      assert.deepStrictEqual(
        items.map(({ item }) => item.label),
        [true, true, false]
      )
      assert.deepStrictEqual(
        items.map(({ item }) => item.source),
        lenses.map((lens) => `commit:abc:${lens.name}`)
      )
      assert.strictEqual(new Set(items.map(({ item }) => item.id)).size, 3)
      for (const entry of items) {
        assert.strictEqual(entry.item.labelledBy, "outcome")
        assert.strictEqual(entry.item.labelledAt, attribution.labelledAt)
        assert.strictEqual(entry.latencyMs, 30)
        const original = screen.observations.find(({ key }) =>
          entry.item.source.endsWith(`:${key}`)
        )
        assert.strictEqual(entry.answer, original?.answer)
        assert.strictEqual(entry.decision, original?.decision)
        assert.deepStrictEqual(entry.item.question, original?.question)
        assert.deepStrictEqual(entry.item.state, original?.state)
        yield* Schema.decodeUnknownEffect(LabelledItem)(entry.item)
      }
      const report = evaluateJudgments(items)
      assert.deepStrictEqual(report.missedIssues, {
        count: 1,
        positiveAnswered: 2,
        rate: 0.5,
        severities: { Critical: 1, Warning: 2, Info: 1 }
      })
      close(report.overall.ece, 2 / 3)
      close(report.overall.brier, 2 / 3)
      const skipped = runs.filter(({ lens }) => !screen.reviewers.includes(lens))
      const lost = skipped.flatMap(({ result }) => result.issues)
      const counts = {
        Critical: lost.filter(({ severity }) => severity === "Critical").length,
        Warning: lost.filter(({ severity }) => severity === "Warning").length,
        Info: lost.filter(({ severity }) => severity === "Info").length
      }
      assert.isTrue(
        replayMissesAgree(
          report,
          counts,
          skipped.filter(({ result }) => result.issues.length > 0).length
        )
      )
      assert.isFalse(replayMissesAgree(report, { ...counts, Warning: 1 }, 1))
      assert.isFalse(replayMissesAgree(report, counts, lost.length))
      const rendered = renderEvalReport(report, {
        date: "2026-09-20",
        decision: "review-prescreen",
        backend: "fake",
        model: "fake",
        title: "Outcome-derived labels (lens reported an issue), not human labels"
      })
      assert.isTrue(
        rendered.startsWith("# Outcome-derived labels (lens reported an issue), not human labels")
      )
      assert.include(rendered, "| 1 | 2 | 1 |")
      assert.notInclude(rendered, "Severity breakdown unavailable")
      const codec = Schema.fromJsonString(EvalReport)
      assert.deepStrictEqual(
        yield* Schema.decodeUnknownEffect(codec)(yield* Schema.encodeEffect(codec)(report)),
        report
      )
    })
  )

  it("retains labels for missing screens, preserves recorded decisions and handles empty runs", () => {
    const runs = [correctnessReviewer, securityReviewer, testReviewer].map((lens) => ({
      lens,
      result: ReviewResult.make({
        issues: [ReviewIssue.make({ severity: "Critical", title: "issue" })]
      })
    }))
    const answer = truthAnswer(0, origins.fake())
    assert.strictEqual(decide(answer), "act")
    const observations: ReviewPrescreenResult["observations"] = [
      {
        key: correctnessReviewer.name,
        answer,
        decision: "hold",
        state: { diff: "actual state" },
        question: truth("Actual question"),
        judgmentIdentity: "fake"
      }
    ]
    const items = replayEvalItems(
      { sha: "abc", diff: "diff" },
      runs,
      observations,
      90,
      attribution.labelledAt
    )
    assert.strictEqual(items.length, 3)
    assert.isTrue(items.every(({ item }) => item.label === true))
    assert.strictEqual(items[1]?.failure, "Pre-screen returned no matching answer.")
    assert.deepStrictEqual(items[1]?.item.state, { diff: "diff" })
    assert.deepStrictEqual(items[1]?.item.question, truth(securityReviewer.screeningStatement))
    const report = evaluateJudgments(items)
    assert.strictEqual(report.overall.failed, 2)
    assert.deepStrictEqual(report.overall.decisions, { act: 0, caution: 0, hold: 1 })
    assert.deepStrictEqual(report.overall.latencyMs, { p50: 30, p95: 30 })
    assert.deepStrictEqual(report.missedIssues, {
      count: 0,
      positiveAnswered: 1,
      rate: 0,
      severities: { Critical: 0, Warning: 0, Info: 0 }
    })
    const allFailed = evaluateJudgments(
      replayEvalItems({ sha: "abc", diff: "diff" }, runs, [], 90, attribution.labelledAt)
    )
    assert.strictEqual(allFailed.overall.failed, 3)
    assert.strictEqual(allFailed.missedIssues?.rate, null)
    assert.isTrue(replayMissesAgree(allFailed, { Critical: 0, Warning: 0, Info: 0 }, 0))
    assert.deepStrictEqual(
      replayEvalItems({ sha: "abc", diff: "diff" }, [], [], 0, attribution.labelledAt),
      []
    )
  })

  it("computes Truth accuracy at 0.5 and Score accuracy from rounded expected probabilities", () => {
    const answer = scoreAnswer(scoreQuestion, { "0": 0.5, "1": 0, "2": 0.5 }, origins.fake())
    const report = evaluateJudgments([
      observation(0.5),
      observation(0.5, false),
      observation(0.1, false),
      { item: scoreItem("middle", 1), answer: { ...answer, score: 0 }, latencyMs: 20 },
      {
        item: scoreItem("round-up", 2),
        answer: scoreAnswer(scoreQuestion, { "1": 0.5, "2": 0.5 }, origins.fake()),
        latencyMs: 30
      }
    ])
    close(report.overall.accuracy, 4 / 5)
    close(report.overall.brier, (0.25 + 0.25 + 0.01 + 1 + 0.25) / 5)
  })

  it("has zero ECE/Brier for certain correct labels and one for certain wrong labels", () => {
    const perfect = evaluateJudgments([observation(1), observation(0, false)]).overall
    const wrong = evaluateJudgments([observation(0), observation(1, false)]).overall
    assert.strictEqual(perfect.ece, 0)
    assert.strictEqual(perfect.brier, 0)
    assert.strictEqual(perfect.bins[9]?.count, 2)
    assert.strictEqual(wrong.ece, 1)
    assert.strictEqual(wrong.brier, 1)
    assert.strictEqual(wrong.bins[0]?.count, 2)
  })

  it("uses ten equal-width label-probability bins, including both endpoints", () => {
    const report = evaluateJudgments(
      [0, 0.05, 0.1, 0.55, 0.9, 1].map((p) => observation(p))
    ).overall
    assert.deepStrictEqual(
      report.bins.map((bin) => bin.count),
      [2, 1, 0, 0, 0, 1, 0, 0, 0, 2]
    )
    close(report.bins[0]?.meanLabelProbability ?? null, 0.025)
    close(report.bins[9]?.meanLabelProbability ?? null, 0.95)
    close(report.ece, (2 * 0.975 + 0.9 + 0.45 + 2 * 0.05) / 6)
    close(report.brier, (1 + 0.95 ** 2 + 0.9 ** 2 + 0.45 ** 2 + 0.1 ** 2) / 6)
  })

  it("only counts positive labels that would actually skip a lens under default act policy", () => {
    const held = { ...observation(0), answer: truthAnswer(0, origins.fake(), 0.1) }
    const report = evaluateJudgments([
      observation(0),
      observation(0.1),
      observation(0.5),
      observation(0, false),
      held,
      { ...observation(0), answer: undefined, failure: "unavailable" }
    ])
    assert.deepStrictEqual(report.missedIssues, { count: 1, positiveAnswered: 4, rate: 0.25 })
    assert.deepStrictEqual(report.overall.decisions, { act: 2, caution: 1, hold: 2 })
    assert.strictEqual(evaluateJudgments([observation(0, false)]).missedIssues?.rate, null)
  })

  it("uses nearest-rank latency percentiles and excludes failures and mismatched kinds", () => {
    const report = evaluateJudgments([
      ...Array.from({ length: 20 }, (_, i) => observation(1, true, (20 - i) * 10)),
      { ...observation(1, true, 9999), failure: "failed" },
      { ...observation(1, true, 9999), answer: undefined },
      {
        ...observation(1, true, 9999),
        answer: scoreAnswer(scoreQuestion, { "0": 1 }, origins.fake())
      }
    ])
    assert.strictEqual(report.overall.items, 23)
    assert.strictEqual(report.overall.answered, 20)
    assert.strictEqual(report.overall.failed, 3)
    assert.deepStrictEqual(report.overall.latencyMs, { p50: 100, p95: 190 })
    assert.deepStrictEqual(evaluateJudgments([observation(1, true, 7)]).overall.latencyMs, {
      p50: 7,
      p95: 7
    })
    const empty = evaluateJudgments([])
    const failed = evaluateJudgments([{ ...observation(1), answer: undefined }])
    for (const report of [empty, failed]) {
      assert.strictEqual(report.overall.accuracy, null)
      assert.strictEqual(report.overall.ece, null)
      assert.strictEqual(report.overall.brier, null)
      assert.deepStrictEqual(report.overall.latencyMs, { p50: null, p95: null })
    }
  })

  it.effect(
    "renders a fixed six-item fake-backend snapshot and round-trips the report schema",
    () =>
      Effect.gen(function* () {
        const items = [
          truthItem("t1", true),
          truthItem("t2", false),
          truthItem("t3", true),
          scoreItem("s1", 0),
          scoreItem("s2", 1),
          scoreItem("s3", 2)
        ]
        const answers: Readonly<Record<string, Answer>> = {
          t1: truthAnswer(0, origins.fake()),
          t2: truthAnswer(0.1, origins.fake()),
          t3: truthAnswer(0.5, origins.fake()),
          s1: scoreAnswer(scoreQuestion, { "0": 1, "1": 0, "2": 0 }, origins.fake()),
          s2: scoreAnswer(scoreQuestion, { "0": 0.5, "1": 0, "2": 0.5 }, origins.fake()),
          s3: scoreAnswer(scoreQuestion, { "0": 0, "1": 0.2, "2": 0.8 }, origins.fake())
        }
        const fake = yield* makeFakeJudgment({ answers })
        const evaluated = yield* Effect.forEach(items, (item, index) =>
          Effect.map(
            fake.judgment.judge({ state: item.state, questions: { [item.id]: item.question } }),
            (result): EvalItem => ({
              item,
              answer: result.answers[item.id],
              latencyMs: (index + 1) * 10
            })
          )
        )
        const recorded = yield* fake.recorded
        assert.strictEqual(recorded.length, 6)
        assert.isTrue(recorded.every((request) => Object.keys(request.questions).length === 1))
        assert.deepStrictEqual(
          recorded.map((request) => request.state),
          items.map((item) => item.state)
        )
        const report = evaluateJudgments(evaluated, { restMb: 100, peakMb: 150 })
        const codec = Schema.fromJsonString(EvalReport)
        assert.deepStrictEqual(
          yield* Schema.decodeUnknownEffect(codec)(yield* Schema.encodeEffect(codec)(report)),
          report
        )
        assert.strictEqual(
          renderEvalReport(report, {
            date: "2026-09-20",
            decision: "fixture",
            backend: fake.judgment.identity,
            model: "planned"
          }),
          snapshot
        )
      })
  )

  it.effect("counts a fake question failure without losing the other answers", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeJudgment({ failures: { failed: "planned failure" } })
      const items = [truthItem("ok", true), truthItem("failed", true)]
      const results = yield* Effect.forEach(items, (item) =>
        Effect.map(
          fake.judgment.judge({ state: item.state, questions: { [item.id]: item.question } }),
          (result): EvalItem => ({ item, answer: result.answers[item.id], latencyMs: 1 })
        )
      )
      const report = evaluateJudgments(results)
      assert.strictEqual(report.overall.failed, 1)
      assert.strictEqual(report.overall.answered, 1)
      assert.strictEqual(report.overall.accuracy, 1)
    })
  )
})

const snapshot = `# Judgment evaluation

- Date: 2026-09-20
- Decision: fixture
- Backend identity: fake
- Model: planned

## Measures

| Decision | Items | Answered | Failed | Accuracy | ECE (10 bins) | Brier | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| program-judge | 3 | 3 | 0 | 1.0000 | 0.4000 | 0.3467 | 50.0000 | 60.0000 |
| review-prescreen | 3 | 3 | 0 | 0.6667 | 0.5333 | 0.4200 | 20.0000 | 30.0000 |
| Overall | 6 | 6 | 0 | 0.8333 | 0.4667 | 0.3833 | 30.0000 | 60.0000 |

Metrics use answered items only; n/a means no observations. Overall is item-weighted.
Accuracy: Truth >= 0.5; Score rounds the expected level index.
ECE bins the labelled-outcome probability p into [0, 0.1), ..., [0.9, 1]; target = 1.
ECE = sum(bin count / answered * |1 - mean p|); Brier = mean((1 - p)^2).
These are labelled-outcome metrics, not predicted-confidence ECE or multiclass Brier.
Latency uses nearest-rank percentiles per independent question, excluding failures.

## Default policy decisions

| Decision | Act | Caution | Hold |
| --- | ---: | ---: | ---: |
| program-judge | 1 | 1 | 1 |
| review-prescreen | 1 | 1 | 1 |
| Overall | 2 | 2 | 2 |

## Pre-screen missed issues

| Missed positive items | Answered positive items | Missed rate |
| ---: | ---: | ---: |
| 1 | 2 | 0.5000 |

A miss requires label=true, truth<0.5 and decide=act (the lens would be skipped).
Severity breakdown unavailable: LabelledItem records presence, not issue counts or severity.

## Judgment seat resident memory

| Rest MiB | Sampled peak MiB |
| ---: | ---: |
| 100.0000 | 150.0000 |

Memory supplied by the caller; peak is the maximum sampled RSS.
`
