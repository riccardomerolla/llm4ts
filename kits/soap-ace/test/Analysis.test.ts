import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { analysisPaths, writeAnalyses } from "../flows/lib/soap/Analysis.ts"
import { decodeAuthProfile } from "../flows/lib/soap/Auth.ts"
import { callOperation } from "../flows/lib/soap/Call.ts"
import { parseOperationsFile } from "../flows/lib/soap/Classification.ts"
import { renderRequestFile, samplePaths } from "../flows/lib/soap/Samples.ts"
import { importSoapUiProject } from "../flows/lib/soap/SoapUiImport.ts"
import { makeDirectoryStubTransport } from "../flows/lib/soap/Stub.ts"
import type { YamlValue } from "../flows/lib/soap/Yaml.ts"
import { demoCatalog, demoResponses, demoSoapUi, fixedKey } from "./support.ts"

const service = "DemoBankService"
const iban = "IT60X0542811101000000123456"

// Every operation called once through the stub backend, plus the SoapUI
// mocks: the evidence a real rehearsal would collect.
const recorded = Effect.gen(function* () {
  const catalog = yield* demoCatalog
  const workspace = yield* makeMemoryWorkspace()
  const profile = yield* decodeAuthProfile('{"environment":"test"}')
  const operations = yield* parseOperationsFile(
    [
      "Status: confirmed",
      ...catalog.operations.flatMap((operation) => [
        `## ${operation.name}`,
        `- class: ${/^(cerca|dettaglio)/.test(operation.name) ? "read" : "mutating"}`
      ]),
      ""
    ].join("\n")
  )
  const bodies: Record<string, YamlValue> = {
    cercaConti: { codiceFiscale: "RSSMRA85T10A562S" },
    dettaglioConto: { iban },
    cercaMovimenti: {
      iban,
      dataDa: "2026-03-01",
      dataA: "2026-03-31",
      paginazione: { numeroPagina: "1", dimensionePagina: "3" }
    },
    inserisciBonifico: {
      ibanOrdinante: iban,
      beneficiario: { nome: "Beneficiario Demo", iban: "IT02L1234512345123456789012" },
      importo: { valore: "10.00", divisa: "EUR" },
      causale: "prova"
    },
    confermaBonifico: { idBonifico: "BN20260325001", codiceOtp: "000000" },
    revocaBonifico: { idBonifico: "BN20260301009" }
  }
  const transport = makeDirectoryStubTransport(demoResponses, catalog)
  for (const operation of catalog.operations) {
    yield* workspace.write(
      samplePaths(service, operation.name, "sample").yaml,
      renderRequestFile({
        catalog,
        operation: operation.name,
        purpose: "analysis test",
        body: bodies[operation.name] ?? {}
      })
    )
    yield* callOperation({
      workspace,
      catalog,
      service,
      operation: operation.name,
      name: "sample",
      profile,
      operations,
      secrets: { environment: {}, readFile: () => Effect.die("unused") },
      transport,
      allowMutating: operation.name,
      confirm: () => Effect.succeed(false)
    })
  }
  yield* importSoapUiProject({
    workspace,
    catalog,
    service,
    project: readFileSync(demoSoapUi, "utf8"),
    key: fixedKey
  })
  const analyses = yield* writeAnalyses(workspace, catalog, service)
  const byName = (name: string) =>
    analyses.find((analysis) => analysis.operation === name) ?? assert.fail(name)
  return { workspace, byName }
})

describe("response analysis", () => {
  it.effect("finds undeclared enumeration values and fields the WSDL does not declare", () =>
    Effect.gen(function* () {
      const { byName } = yield* recorded
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
      const { byName } = yield* recorded
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
      const { byName } = yield* recorded
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
      const { workspace } = yield* recorded
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
