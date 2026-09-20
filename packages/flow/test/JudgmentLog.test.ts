import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Ref from "effect/Ref"
import { origins, score, scoreAnswer, truth, truthAnswer } from "@llm4ts/core/judgment/Schemas"
import { Classified } from "@llm4ts/flow/Classified"
import { Info, JudgmentObserved, makeFlowEventHub } from "@llm4ts/flow/FlowEvents"
import { JudgmentObservation, judgmentLogPath, makeJudgmentLog } from "@llm4ts/flow/JudgmentLog"
import { PersistenceError } from "@llm4ts/flow/FlowError"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"

const observation = (consumer: JudgmentObserved["consumer"] = "satisfied-probe") =>
  JudgmentObserved.make({
    consumer,
    key: "satisfied",
    state: { task: "task", reply: "unchanged\nverbatim" },
    question: truth("Satisfied?"),
    answer: truthAnswer(0.9, origins.fake()),
    judgmentIdentity: "fake:checkpoint-1",
    decision: "act",
    certainty: 0.8,
    support: 1,
    origin: origins.fake(),
    outcome: { _tag: "SatisfiedProbe", literalMatch: false },
    mode: "observe"
  })

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(JudgmentObservation))

describe("JudgmentLog", () => {
  it.effect("appends two schema-valid lines without changing the training state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memory = yield* makeMemoryPlainFileStore()
        const hub = yield* makeFlowEventHub()
        const log = yield* makeJudgmentLog({ files: memory.store, root: "/repo/", runId: "run-1" })
        yield* log.consume(hub)
        const first = observation()
        const second = JudgmentObserved.make({ ...first, state: ["second", "  exact\ntext  "] })
        yield* hub.publish(first)
        yield* hub.publish(Info.make({ message: "not an observation" }))
        yield* hub.publish(second)
        yield* log.awaitDrained(hub)
        const contents = (yield* memory.files)[judgmentLogPath("/repo", first.consumer)] ?? ""
        assert.isTrue(contents.endsWith("\n"))
        const lines = contents.trimEnd().split("\n")
        assert.strictEqual(lines.length, 2)
        const records = yield* Effect.forEach(lines, (line) => decode(line))
        for (const [index, event] of [first, second].entries()) {
          assert.deepStrictEqual(
            records[index],
            JudgmentObservation.make({
              runId: "run-1",
              at: 0,
              consumer: event.consumer,
              key: event.key,
              state: event.state,
              question: event.question,
              answer: event.answer,
              outcome: event.outcome,
              decision: event.decision,
              mode: event.mode,
              judgmentIdentity: event.judgmentIdentity
            })
          )
        }
      })
    )
  )

  it.effect("separates consumers and appends across runs", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      for (const runId of ["run-1", "run-2"]) {
        const log = yield* makeJudgmentLog({ files: memory.store, root: "/repo", runId })
        yield* log.record(observation())
        yield* log.record(
          JudgmentObserved.make({
            ...observation("review-prescreen"),
            outcome: {
              _tag: "ReviewPrescreen",
              lens: "security",
              issues: { Critical: 0, Warning: 1, Info: 0 }
            }
          })
        )
      }
      const files = yield* memory.files
      assert.deepStrictEqual(Object.keys(files).sort(), [
        "/repo/.llm4ts/judgments/review-prescreen.jsonl",
        "/repo/.llm4ts/judgments/satisfied-probe.jsonl"
      ])
      for (const contents of Object.values(files)) {
        const records = yield* Effect.forEach(contents.trimEnd().split("\n"), (line) =>
          decode(line)
        )
        assert.deepStrictEqual(
          records.map((record) => record.runId),
          ["run-1", "run-2"]
        )
      }
    })
  )

  it.effect("redacts sealed state and answer text before schema traversal or file append", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const log = yield* makeJudgmentLog({
        files: memory.store,
        root: "/repo",
        runId: "secret-run"
      })
      const secret = Classified.of("never-write-this-secret")
      const state = { public: "preserve me", nested: { token: "placeholder" }, text: `${secret}` }
      const question = score("Score?", ["no", "yes"])
      const answer = scoreAnswer(question, { "0": 0, "1": 1 }, origins.fake())
      const event = JudgmentObserved.make({ ...observation(), state, question, answer })
      // Exercise the runtime JSON boundary as an untyped JS caller could:
      // sealed objects are not part of core's typed State/Answer contract.
      // The log must redact before a schema can inspect their private fields.
      Object.assign(state.nested, { token: secret })
      Object.assign(answer.legend, { "1": secret.map((value) => `${value}-answer`) })
      yield* log.record(event)
      const contents = (yield* memory.files)[judgmentLogPath("/repo", event.consumer)] ?? ""
      assert.isFalse(contents.includes("never-write-this-secret"))
      const stored = yield* decode(contents.trimEnd())
      assert.deepStrictEqual(stored.state, {
        public: "preserve me",
        nested: { token: "Classified(…)" },
        text: "Classified(…)"
      })
      assert.strictEqual(stored.answer.type, "score")
      if (stored.answer.type === "score") {
        assert.strictEqual(stored.answer.legend["1"], "Classified(…)")
      }
    })
  )

  it.effect("degrades on a write failure and still drains all hub events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const memory = yield* makeMemoryPlainFileStore()
        const attempts = yield* Ref.make(0)
        const log = yield* makeJudgmentLog({
          root: "/repo",
          runId: "run-1",
          files: {
            ...memory.store,
            append: () =>
              Ref.update(attempts, (n) => n + 1).pipe(
                Effect.andThen(Effect.fail(PersistenceError.make({ message: "unavailable" })))
              )
          }
        })
        const hub = yield* makeFlowEventHub()
        yield* log.consume(hub)
        yield* hub.publish(observation())
        yield* hub.publish(observation())
        yield* log.awaitDrained(hub)
        assert.strictEqual(yield* Ref.get(attempts), 1)
        assert.deepStrictEqual(yield* memory.files, {})
      })
    )
  )
})
