import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import { ProcessError } from "@llm4ts/flow/FlowError"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"
import { readLedger, runQueue } from "@llm4ts/flow/WorkQueue"

const items = [{ id: "a" }, { id: "b" }, { id: "c" }]

describe("runQueue (ADR 0028)", () => {
  it.effect(
    "works what is not done, skips what is, records a ledger line per item, and resumes",
    () =>
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const memory = yield* makeMemoryPlainFileStore({ "/out/a": "already" })
        const worked: Array<string> = []
        const report = yield* runQueue({
          label: "port",
          items,
          done: (item) =>
            Effect.map(memory.store.read(`/out/${item.id}`), (text) => text !== undefined),
          work: (item) =>
            Effect.gen(function* () {
              worked.push(item.id)
              yield* memory.store.writeAtomic(`/out/${item.id}`, "drafted")
              return { confidence: "high" as const, todos: 1 }
            }),
          events,
          ledger: { files: memory.store, path: "/state/ledger.jsonl" }
        })
        assert.deepStrictEqual(worked, ["b", "c"])
        assert.deepStrictEqual(
          report.skipped.map((item) => item.id),
          ["a"]
        )
        assert.deepStrictEqual(report.pending, [])
        assert.strictEqual(report.rounds, 1)
        const ledger = yield* readLedger(memory.store, "/state/ledger.jsonl")
        assert.deepStrictEqual(
          ledger.map((outcome) => [outcome.id, outcome.status, outcome.todos]),
          [
            ["b", "done", 1],
            ["c", "done", 1]
          ]
        )
        const stages = (yield* events.recorded).filter((event) => event._tag === "StageCompleted")
        assert.strictEqual(stages.length, 2)
      })
  )

  it.effect(
    "a failed item is the next round's item; work that leaves no output is a failure too",
    () =>
      Effect.gen(function* () {
        const events = yield* makeCollectingFlowEvents
        const memory = yield* makeMemoryPlainFileStore()
        const attempts = yield* Ref.make(0)
        const rounds: Array<ReadonlyArray<string>> = []
        const report = yield* runQueue({
          label: "port",
          items,
          done: (item) =>
            Effect.map(memory.store.read(`/out/${item.id}`), (text) => text !== undefined),
          work: (item, round) =>
            Effect.gen(function* () {
              yield* Ref.update(attempts, (count) => count + 1)
              if (item.id === "b" && round === 1) {
                return yield* ProcessError.make({ message: "build", detail: "boom" })
              }
              if (item.id === "c") {
                return { note: "wrote nothing" }
              }
              yield* memory.store.writeAtomic(`/out/${item.id}`, "ok")
              return {}
            }),
          events,
          maxRounds: 2,
          afterRound: (_round, done) =>
            Effect.sync(() => {
              rounds.push(done.map((item) => item.id))
            })
        })
        assert.deepStrictEqual(rounds, [["a"], ["b"]])
        assert.deepStrictEqual(
          report.pending.map((item) => item.id),
          ["c"]
        )
        assert.strictEqual(report.rounds, 2)
        const failedC = report.outcomes.filter((outcome) => outcome.id === "c")
        assert.strictEqual(failedC.length, 2)
        assert.strictEqual(failedC[0]?.note, "wrote nothing")
        assert.include(report.outcomes.find((outcome) => outcome.id === "b")?.note ?? "", "boom")
      })
  )

  it.effect("a round that finishes nothing ends the queue as Stalled", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const memory = yield* makeMemoryPlainFileStore()
      const error = yield* Effect.flip(
        runQueue({
          label: "port",
          items,
          done: (item) =>
            Effect.map(memory.store.read(`/out/${item.id}`), (text) => text !== undefined),
          work: () => Effect.succeed({}),
          events,
          maxRounds: 3
        })
      )
      assert.strictEqual(error._tag, "Stalled")
      assert.match(error.message, /no-progress/)
    })
  )

  it.effect("hands each in-flight item its own shard and never two items the same one", () =>
    Effect.gen(function* () {
      const events = yield* makeCollectingFlowEvents
      const memory = yield* makeMemoryPlainFileStore()
      const inFlight = yield* Ref.make<ReadonlyArray<string>>([])
      const overlaps = yield* Ref.make(0)
      const seen: Array<string> = []
      const report = yield* runQueue({
        label: "sharded",
        items: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }],
        shards: [
          { id: "s1", dir: "/w/s1" },
          { id: "s2", dir: "/w/s2" }
        ],
        concurrency: 4,
        done: (item, shard) =>
          Effect.map(
            memory.store.read(`${shard?.dir ?? "/w"}/${item.id}`),
            (text) => text !== undefined
          ),
        work: (item, _round, shard) =>
          Effect.gen(function* () {
            assert.isDefined(shard)
            const dir = shard?.dir ?? "/w"
            const busy = yield* Ref.get(inFlight)
            if (busy.includes(dir)) {
              yield* Ref.update(overlaps, (n) => n + 1)
            }
            yield* Ref.update(inFlight, (list) => [...list, dir])
            seen.push(`${item.id}@${shard?.id ?? "-"}`)
            yield* Effect.yieldNow
            yield* memory.store.writeAtomic(`${dir}/${item.id}`, "done")
            yield* Ref.update(inFlight, (list) => list.filter((entry) => entry !== dir))
            return {}
          }),
        events
      })
      assert.strictEqual(report.pending.length, 0)
      assert.strictEqual(seen.length, 5)
      assert.strictEqual(yield* Ref.get(overlaps), 0)
      assert.isTrue(seen.some((entry) => entry.endsWith("@s1")))
      assert.isTrue(seen.some((entry) => entry.endsWith("@s2")))
    })
  )
})
