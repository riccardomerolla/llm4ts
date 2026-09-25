import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeFakeJudgment } from "@llm4ts/core/judgment/FakeJudgment"
import { choiceAnswer, origins } from "@llm4ts/core/judgment/Schemas"
import {
  classifyOperations,
  effectiveClass,
  heuristicClass,
  leadingWord,
  parseOperationsFile,
  proposeClass,
  renderOperationsFile
} from "../flows/lib/soap/Classification.ts"
import { CatalogVersion, Operation, WsdlCatalog } from "../flows/lib/soap/Catalog.ts"

const operation = (name: string) =>
  new Operation({
    name,
    soapAction: `urn:${name}`,
    soapVersion: "1.1",
    binding: "B",
    wrapped: true,
    input: `{urn:t}${name}`,
    faults: []
  })

const catalogOf = (names: ReadonlyArray<string>) =>
  new WsdlCatalog({
    version: CatalogVersion,
    wsdlVersion: "1.1",
    targetNamespace: "urn:t",
    documents: ["x.wsdl"],
    endpoints: [],
    operations: names.map(operation),
    elements: [],
    types: [],
    openQuestions: []
  })

describe("Classification", () => {
  it("reads the leading verb from camel, Pascal, snake, and acronym names", () => {
    assert.strictEqual(leadingWord("cercaConti"), "cerca")
    assert.strictEqual(leadingWord("GetBalance"), "get")
    assert.strictEqual(leadingWord("inserisci_bonifico"), "inserisci")
    assert.strictEqual(leadingWord("CRUDOperation"), "crud")
  })

  it("proposes classes from Italian and English verbs", () => {
    assert.strictEqual(heuristicClass("cercaMovimenti").class, "read")
    assert.strictEqual(heuristicClass("dettaglioConto").class, "read")
    assert.strictEqual(heuristicClass("GetAccountList").class, "read")
    assert.strictEqual(heuristicClass("inserisciBonifico").class, "mutating")
    assert.strictEqual(heuristicClass("confermaBonifico").class, "mutating")
    assert.strictEqual(heuristicClass("bloccaCarta").class, "mutating")
    assert.strictEqual(heuristicClass("doStuff").class, "unclassified")
  })

  it("lets an act-level judgment win, ignores a held one, and fills heuristic gaps", () => {
    const read = heuristicClass("cercaConti")
    const none = heuristicClass("doStuff")
    assert.strictEqual(
      proposeClass("x", read, { class: "mutating", confidence: 0.99, decision: "act" }).proposed,
      "mutating"
    )
    assert.strictEqual(
      proposeClass("x", read, { class: "mutating", confidence: 0.5, decision: "hold" }).proposed,
      "read"
    )
    assert.strictEqual(
      proposeClass("x", read, { class: "mutating", confidence: 0.8, decision: "caution" }).proposed,
      "read"
    )
    assert.strictEqual(
      proposeClass("x", none, { class: "mutating", confidence: 0.8, decision: "caution" }).proposed,
      "mutating"
    )
  })

  it.effect("asks the judgment one choice question per operation", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeJudgment({
        answers: { class: choiceAnswer({ read: 0, mutating: 1 }, origins.fake()) }
      })
      const proposals = yield* classifyOperations(
        catalogOf(["doStuff", "cercaConti"]),
        fake.judgment
      )
      assert.deepStrictEqual(
        proposals.map((proposal) => proposal.judged?.class),
        ["mutating", "mutating"]
      )
      const recorded = yield* fake.recorded
      assert.strictEqual(recorded.length, 2)
    })
  )

  it.effect("round-trips the operations file; only a confirmed file grants a class", () =>
    Effect.gen(function* () {
      const catalog = catalogOf(["cercaConti", "revocaBonifico", "doStuff"])
      const text = renderOperationsFile(
        "Demo",
        catalog,
        catalog.operations.map((op) => proposeClass(op.name, heuristicClass(op.name), undefined))
      )
      const proposed = yield* parseOperationsFile(text)
      assert.isFalse(proposed.confirmed)
      assert.strictEqual(proposed.classes.get("revocaBonifico"), "mutating")
      assert.strictEqual(effectiveClass(proposed, "cercaConti"), "unclassified")

      const confirmed = yield* parseOperationsFile(
        text.replace("Status: proposed", "Status: confirmed")
      )
      assert.strictEqual(effectiveClass(confirmed, "cercaConti"), "read")
      assert.strictEqual(effectiveClass(confirmed, "doStuff"), "unclassified")
      assert.strictEqual(effectiveClass(confirmed, "notThere"), "unclassified")
      assert.strictEqual(effectiveClass(undefined, "cercaConti"), "unclassified")
    })
  )

  it.effect("rejects malformed operations files with the offending line", () =>
    Effect.gen(function* () {
      const bad = yield* Effect.flip(
        parseOperationsFile("# Ops\n\nStatus: confirmed\n\n## a\n- class: sometimes\n")
      )
      assert.strictEqual(bad.line, 6)
      const noStatus = yield* Effect.flip(parseOperationsFile("## a\n- class: read\n"))
      assert.include(noStatus.detail, "Status")
      const twice = yield* Effect.flip(
        parseOperationsFile("Status: proposed\n## a\n- class: read\n- class: mutating\n")
      )
      assert.include(twice.detail, "twice")
    })
  )
})
