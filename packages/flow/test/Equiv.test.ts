import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { ExecGrants, Grants, allGrants, restricted } from "@llm4ts/core/Capability"
import {
  ProcessResult,
  makeFakeProcessExecutor,
  processCommandKey
} from "@llm4ts/core/ProcessExecutor"
import {
  CurrentEquivSchema,
  EquivVector,
  Observations,
  diffObservations,
  readEquivVectors,
  replayEquivVector,
  writeEquivVectors
} from "@llm4ts/flow/Equiv"
import { renderEquivReport } from "@llm4ts/flow/EquivReport"
import { makeCollectingFlowEvents } from "@llm4ts/flow/FlowEvents"
import { ComparisonPolicy } from "@llm4ts/flow/Pack"
import { makeMemoryPlainFileStore } from "@llm4ts/flow/Persistence"

const policy = (
  ordering: "Ordered" | "Unordered" | "PerKey",
  ignore: ReadonlySet<string> = new Set()
): ComparisonPolicy => ComparisonPolicy.make({ ordering, ignore })

const vector = EquivVector.make({
  schemaVersion: CurrentEquivSchema,
  program: "TRANSFER",
  id: "fee",
  tier: "generated",
  rules: ["calculate-fee"],
  inputs: { amount: "500.00" },
  observations: [
    Observations.record("output", {
      status: "POSTED",
      fee: "2.50"
    })
  ]
})

describe("equivalence diff and report", () => {
  it("produces field diffs and honors ignored fields and unordered matching", () => {
    const actual = [
      Observations.record("audit", { id: "2" }),
      Observations.record("output", {
        status: "POSTED",
        fee: "2.60",
        timestamp: "now"
      })
    ]
    const expected = [
      Observations.record("output", {
        status: "POSTED",
        fee: "2.50",
        timestamp: "then"
      }),
      Observations.record("audit", { id: "2" })
    ]
    const mismatches = diffObservations(
      expected,
      actual,
      policy("Unordered", new Set(["timestamp"]))
    )

    assert.strictEqual(mismatches.length, 1)
    assert.strictEqual(mismatches[0]?._tag, "FieldDiff")
    const report = renderEquivReport(
      [{ vector, mismatches }],
      ["calculate-fee", "unexercised-rule"]
    )
    assert.match(report, /calculate-fee.*FAILING/)
    assert.match(report, /unexercised-rule.*UNEXERCISED/)
    assert.match(report, /2\.50.*2\.60/)
    assert.match(report, /never summed/)
  })

  it("keeps per-key stream ordering separate", () => {
    const first = Observations.message("events", "A", { sequence: "1" })
    const second = Observations.message("events", "A", { sequence: "2" })
    const other = Observations.message("events", "B", { sequence: "1" })

    assert.strictEqual(
      diffObservations([first, second, other], [other, first, second], policy("PerKey")).length,
      0
    )
    assert.isAbove(diffObservations([first, second], [second, first], policy("PerKey")).length, 0)
  })
})

describe("equivalence vector boundaries", () => {
  it.effect("round-trips vectors and rejects malformed lines", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const files = memory.store
      yield* writeEquivVectors(files, "vectors.jsonl", [vector])
      const loaded = yield* readEquivVectors(files, "vectors.jsonl")
      yield* memory.replace({ "vectors.jsonl": "not-json\n" })
      const malformed = yield* Effect.flip(readEquivVectors(files, "vectors.jsonl"))

      assert.deepStrictEqual(loaded, [vector])
      assert.strictEqual(malformed._tag, "PlanParse")
    })
  )

  // A harness dumping a COBOL record emits numerics as JSON numbers; the
  // string-only schema turned that into a stage-killing schema error rather
  // than a diff.
  it.effect("accepts replay output whose field values are JSON scalars", () =>
    Effect.gen(function* () {
      const command = ["replay"]
      const output = JSON.stringify([
        { type: "record", kind: "output", fields: { ZSTC: 0, FEE: 2.5, OK: true, NOTE: null } },
        {
          type: "db",
          table: "LEDGER",
          op: "insert",
          key: { ID: 42 },
          set: { AMOUNT: 10.25, FLAG: false }
        }
      ])
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [processCommandKey(command), ProcessResult.make({ stdout: [output], exitCode: 0 })]
        ])
      })
      const events = yield* makeCollectingFlowEvents
      const replayed = yield* replayEquivVector(fake.executor, events, command, "/repo", vector)

      assert.strictEqual(replayed._tag, "Observed")
      const observed = replayed._tag === "Observed" ? replayed.actual : []
      assert.deepStrictEqual(observed[0]?.type === "record" ? observed[0].fields : undefined, {
        ZSTC: "0",
        FEE: "2.5",
        OK: "true",
        // null reads as "no value", which the legacy side renders as empty.
        NOTE: ""
      })
      assert.deepStrictEqual(observed[1]?.type === "db" ? observed[1].set : undefined, {
        AMOUNT: "10.25",
        FLAG: "false"
      })
    })
  )

  it.effect("reads stored vectors whose field values are JSON scalars", () =>
    Effect.gen(function* () {
      const memory = yield* makeMemoryPlainFileStore()
      const line = JSON.stringify({
        schemaVersion: CurrentEquivSchema,
        program: "ACCTXFR",
        id: "test1",
        tier: "generated",
        rules: ["R-1"],
        inputs: { AMOUNT: "10" },
        observations: [{ type: "record", kind: "output", fields: { ZSTC: 0 } }]
      })
      yield* memory.replace({ "vectors.jsonl": `${line}\n` })
      const loaded = yield* readEquivVectors(memory.store, "vectors.jsonl")
      const first = loaded[0]?.observations[0]

      assert.deepStrictEqual(first?.type === "record" ? first.fields : undefined, { ZSTC: "0" })
    })
  )

  it.effect("runs replay commands behind Exec capability and decodes observations", () =>
    Effect.gen(function* () {
      const command = ["replay"]
      const output = JSON.stringify([
        Observations.record("output", {
          status: "POSTED",
          fee: "2.50"
        })
      ])
      const fake = yield* makeFakeProcessExecutor({
        responses: new Map([
          [processCommandKey(command), ProcessResult.make({ stdout: [output], exitCode: 0 })]
        ])
      })
      const events = yield* makeCollectingFlowEvents
      const replayed = yield* replayEquivVector(fake.executor, events, command, "/repo", vector)
      const deniedGrants = new Grants({
        ...allGrants,
        exec: ExecGrants.Denied
      })
      const denied = yield* Effect.flip(
        restricted(deniedGrants)(replayEquivVector(fake.executor, events, command, "/repo", vector))
      )

      assert.strictEqual(replayed._tag, "Observed")
      assert.strictEqual(denied._tag, "CapabilityDenied")
      assert.strictEqual((yield* fake.recorded).length, 1)
    })
  )
})
