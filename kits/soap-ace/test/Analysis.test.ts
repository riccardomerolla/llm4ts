import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { analysisPaths } from "../flows/lib/soap/Analysis.ts"
import { recordedEvidence } from "./support.ts"

const service = "DemoBankService"
const iban = "IT60X0542811101000000123456"

describe("response analysis", () => {
  it.effect("finds undeclared enumeration values and fields the WSDL does not declare", () =>
    Effect.gen(function* () {
      const { byName } = yield* recordedEvidence
      const conti = byName("cercaConti")
      assert.strictEqual(conti.exchanges, 2)
      assert.deepStrictEqual(
        conti.outcomes.map((outcome) => outcome.code),
        ["OK00"]
      )
      const stato = conti.fields.find((field) => field.path === "conto[].stato")
      assert.sameMembers(
        [...(stato?.values.map((entry) => entry.value) ?? [])],
        ["ATTIVO", "BLOCCATO", "SOSPESO"]
      )
      assert.isTrue(
        conti.observations.some((line) =>
          line.includes("outside the declared enumeration: SOSPESO")
        )
      )
      assert.includeMembers(
        conti.findings.map((finding) => finding.path),
        ["conto[].stato", "conto[].canale"]
      )
      assert.strictEqual(conti.fields.find((field) => field.path === "conto[]")?.maxItems, 2)
      assert.include(conti.requestFieldsUnused, "stato")
    })
  )

  it.effect("reads pagination from field names and what responses showed", () =>
    Effect.gen(function* () {
      const { byName } = yield* recordedEvidence
      const pagination = byName("cercaMovimenti").pagination
      assert.strictEqual(pagination?.style, "page-number")
      assert.deepStrictEqual(pagination?.requestFields, [
        "paginazione.numeroPagina",
        "paginazione.dimensionePagina"
      ])
      assert.includeMembers(
        [...(pagination?.responseFields ?? [])],
        ["paginazione.ultimaPagina", "paginazione.totaleRecord"]
      )
      assert.strictEqual(pagination?.items, "movimento[]")
      assert.include(pagination?.observed ?? "", "0 responses marked last page, 1 not; at most 3")
      assert.isFalse(
        byName("cercaMovimenti").observations.some((line) => line.includes("idMovimento")),
        "unique identifiers are not a code list"
      )
    })
  )

  it.effect("surfaces business errors inside 200s, SOAP faults, and nil values", () =>
    Effect.gen(function* () {
      const { byName } = yield* recordedEvidence
      const conferma = byName("confermaBonifico")
      assert.deepStrictEqual(
        conferma.outcomes.map((outcome) => [outcome.code, outcome.description, outcome.count]),
        [["KO17", "Codice OTP non valido", 2]]
      )
      assert.isTrue(
        conferma.observations.some(
          (line) => line.includes("Business errors") && line.includes("KO17")
        )
      )
      const revoca = byName("revocaBonifico")
      assert.deepStrictEqual(
        revoca.faults.map((fault) => [fault.detailElement, fault.reason]),
        [["ServizioFault", "Bonifico gia eseguito"]]
      )
      assert.isTrue(
        byName("dettaglioConto").observations.some((line) =>
          line.startsWith("fido: sent as xsi:nil")
        )
      )
    })
  )

  it.effect("writes a readable report and a typed sidecar", () =>
    Effect.gen(function* () {
      const { workspace } = yield* recordedEvidence
      const paths = analysisPaths(service, "cercaConti")
      const markdown = yield* workspace.read(paths.markdown)
      assert.include(markdown, "# Analysis: cercaConti")
      assert.include(markdown, "| conto[].stato |")
      assert.include(markdown, "## Schema findings")
      assert.notInclude(markdown, iban)
      assert.include(yield* workspace.read(paths.json), '"operation": "cercaConti"')
    })
  )
})
