import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { origins, score, scoreAnswer, truth, truthAnswer } from "@llm4ts/core/judgment/Schemas"
import {
  LabelledItem,
  PendingItem,
  appendDataset,
  candidateId,
  isLabelledPending,
  mergeCandidates,
  observationCandidates,
  preparePromotion,
  readDataset,
  readPending,
  reviewCandidates,
  writePending
} from "@llm4ts/flow/JudgmentDataset"
import { JudgmentObservation } from "@llm4ts/flow/JudgmentLog"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { correctnessReviewer, securityReviewer } from "@llm4ts/flow/Review"

const seed = (id = "one") =>
  PendingItem.make({
    id,
    decision: "satisfied-probe",
    state: { reply: "already done\nno change" },
    question: truth("Already satisfied?"),
    source: "observation:run:consumer:key"
  })
const attribution = { labelledBy: "human", labelledAt: "2026-09-20T12:00:00Z" }
const labelled = () => LabelledItem.make({ ...seed(), ...attribution, label: false })

describe("JudgmentDataset", () => {
  it.effect(
    "round trips truth false and score zero, appending to a file without a final newline",
    () =>
      Effect.gen(function* () {
        const first = labelled()
        const second = LabelledItem.make({
          ...first,
          id: "score",
          decision: "program-judge",
          question: score("Rubric", ["no", "yes"]),
          label: 0
        })
        const memory = yield* makeMemoryPlainFileStore({ "/set": JSON.stringify(first) })
        yield* appendDataset(memory.store, "/set", [second])
        assert.deepStrictEqual(yield* readDataset(memory.store, "/set"), [first, second])
        assert.deepStrictEqual(yield* readDataset(memory.store, "/absent"), [])
        assert.isTrue(((yield* memory.files)["/set"] ?? "").endsWith("\n"))
      })
  )

  it.effect(
    "fails typed with path and line for malformed JSON, records, labels and blank lines",
    () =>
      Effect.gen(function* () {
        for (const bad of [
          "{",
          "{}",
          "",
          JSON.stringify({ ...labelled(), label: 1 }),
          JSON.stringify({ ...labelled(), labelledBy: " " })
        ]) {
          const memory = yield* makeMemoryPlainFileStore({
            "/set": `${JSON.stringify(labelled())}\n${bad}\n`
          })
          const error = yield* Effect.flip(readDataset(memory.store, "/set"))
          assert.strictEqual(error._tag, "DatasetParseError")
          if (error._tag === "DatasetParseError") {
            assert.strictEqual(error.path, "/set")
            assert.strictEqual(error.line, 2)
          }
          const before = yield* memory.files
          yield* Effect.flip(appendDataset(memory.store, "/set", [labelled()]))
          assert.deepStrictEqual(yield* memory.files, before)
        }
      })
  )

  it.effect("round trips pending items with absent labels and preserves edits during merging", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const edited = PendingItem.make({ ...seed("edited"), label: true, labelledBy: "human" })
      const merged = mergeCandidates(
        [edited],
        [labelled()],
        [seed("edited"), seed("one"), seed("new"), seed("new")]
      )
      assert.deepStrictEqual(merged, [edited, seed("new")])
      yield* writePending(memory.store, "/pending", merged)
      assert.deepStrictEqual(yield* readPending(memory.store, "/pending"), merged)
      assert.isFalse(Object.hasOwn(seed(), "label"))
    })
  )

  it.effect("leaves unlabelled items pending and refuses wrong-kind or out-of-range labels", () =>
    Effect.gen(function* () {
      const unlabelled = [seed("missing"), PendingItem.make({ ...seed("null"), label: null })]
      const partial = yield* preparePromotion([PendingItem.make(labelled()), ...unlabelled], [])
      assert.strictEqual(partial.items.length, 1)
      assert.deepStrictEqual(
        partial.remaining.map((item) => item.id),
        unlabelled.map((item) => item.id)
      )
      const invalid = [
        PendingItem.make({ ...seed("numeric-truth"), label: 1 }),
        ...[true, -1, 2, 0.5, "1"].map((label, index) =>
          PendingItem.make({
            ...seed(`score-${index}`),
            decision: "program-judge",
            question: score("Rubric", ["no", "yes"]),
            label
          })
        )
      ]
      const error = yield* Effect.flip(
        preparePromotion([PendingItem.make(labelled()), ...invalid], [])
      )
      assert.strictEqual(error._tag, "PromotionRefused")
      if (error._tag === "PromotionRefused") {
        assert.deepStrictEqual(
          error.ids,
          invalid.map((item) => item.id)
        )
        for (const item of invalid) assert.isTrue(error.message.includes(item.id))
      }
    })
  )

  it.effect("promotes complete items, keeps incomplete attribution and deduplicates retries", () =>
    Effect.gen(function* () {
      const complete = PendingItem.make(labelled())
      const incomplete = [
        PendingItem.make({ ...seed("by"), label: true, labelledAt: attribution.labelledAt }),
        PendingItem.make({ ...seed("at"), label: true, labelledBy: "human" }),
        PendingItem.make({
          ...seed("blank"),
          label: true,
          labelledBy: " ",
          labelledAt: "yesterday"
        })
      ]
      assert.isTrue(isLabelledPending(complete))
      const result = yield* preparePromotion([complete, complete, ...incomplete], [])
      assert.deepStrictEqual(result.items, [labelled()])
      assert.deepStrictEqual(result.remaining, incomplete)
      const retry = yield* preparePromotion([complete, ...incomplete], result.items)
      assert.deepStrictEqual(retry.items, [])
      assert.deepStrictEqual(retry.remaining, incomplete)
    })
  )

  it("derives stable, decision-specific ids and one review candidate per commit per lens", () => {
    assert.strictEqual(
      candidateId("review-prescreen", "commit:abc:lens"),
      candidateId("review-prescreen", "commit:abc:lens")
    )
    assert.notStrictEqual(
      candidateId("review-prescreen", "same"),
      candidateId("satisfied-probe", "same")
    )
    const lenses = [correctnessReviewer, securityReviewer]
    const candidates = reviewCandidates(
      [
        { sha: "abc", diff: "diff" },
        { sha: "def", diff: "other" }
      ],
      lenses
    )
    assert.strictEqual(candidates.length, 4)
    assert.strictEqual(new Set(candidates.map((item) => item.id)).size, 4)
    assert.deepStrictEqual(candidates[0]?.state, { diff: "diff" })
    assert.strictEqual(candidates[0]?.question.instructions, correctnessReviewer.screeningStatement)
    assert.isTrue(candidates.every((item) => item.label === undefined))
  })

  it.effect(
    "seeds verbatim observation questions and state, never answers or outcomes as labels",
    () =>
      Effect.gen(function* () {
        const observed = JudgmentObservation.make({
          runId: "run",
          at: 42,
          consumer: "satisfied-probe",
          key: "satisfied",
          state: seed().state,
          question: seed().question,
          answer: truthAnswer(1, origins.fake()),
          outcome: { _tag: "SatisfiedProbe", literalMatch: true },
          decision: "act",
          mode: "observe",
          judgmentIdentity: "fake:1"
        })
        const question = score("dimension", ["no", "yes"])
        const program = JudgmentObservation.make({
          ...observed,
          consumer: "program-judge",
          key: "dimension",
          question,
          state: { spec: "spec", diff: "slice" },
          answer: scoreAnswer(question, { "0": 0, "1": 1 }, origins.fake())
        })
        const observations = [observed, observed, program]
        const candidates = yield* observationCandidates("satisfied-probe", observations)
        assert.strictEqual(candidates.length, 2)
        assert.notStrictEqual(candidates[0]?.id, candidates[1]?.id)
        assert.deepStrictEqual(candidates[0]?.state, observed.state)
        assert.deepStrictEqual(candidates[0]?.question, observed.question)
        assert.isTrue(candidates.every((item) => item.label === undefined))
        const programs = yield* observationCandidates("program-judge", observations)
        assert.deepStrictEqual(programs[0]?.question, question)
        assert.deepStrictEqual(programs[0]?.state, program.state)
        assert.strictEqual(programs[0]?.label, undefined)
        yield* Effect.flip(
          Schema.decodeUnknownEffect(LabelledItem)({ ...labelled(), decision: "program-judge" })
        )
      })
  )
})
