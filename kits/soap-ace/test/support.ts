import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as Effect from "effect/Effect"
import { InvalidRequestError } from "@llm4ts/core/Errors"
import { unsupportedScoreLabels } from "@llm4ts/core/LabelScoring"
import type { LlmServiceShape } from "@llm4ts/core/LlmService"
import { parseFromText } from "@llm4ts/core/StructuredOutput"
import * as Stream from "effect/Stream"
import { readFileSync } from "node:fs"
import { assert } from "@effect/vitest"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { writeAnalyses } from "../flows/lib/soap/Analysis.ts"
import { decodeAuthProfile } from "../flows/lib/soap/Auth.ts"
import { callOperation } from "../flows/lib/soap/Call.ts"
import { parseOperationsFile } from "../flows/lib/soap/Classification.ts"
import { renderRequestFile, samplePaths } from "../flows/lib/soap/Samples.ts"
import { importSoapUiProject } from "../flows/lib/soap/SoapUiImport.ts"
import { makeDirectoryStubTransport } from "../flows/lib/soap/Stub.ts"
import type { YamlValue } from "../flows/lib/soap/Yaml.ts"
import { DocumentLoader, makeFileDocumentLoader, readCatalog } from "../flows/lib/soap/Wsdl.ts"

export const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "demo-bank-soap"
)
export const demoWsdl = join(fixtureRoot, "wsdl", "DemoBank.wsdl")
export const demoResponses = join(fixtureRoot, "responses")
export const demoSoapUi = join(fixtureRoot, "soapui", "DemoBank-soapui-project.xml")

export const demoCatalog = readCatalog(demoWsdl).pipe(
  Effect.provideService(DocumentLoader, makeFileDocumentLoader())
)

export const fixedKey = new Uint8Array(32).fill(7)

const unused = InvalidRequestError.make({ message: "unused" })

/** A reasoning seat that answers every structured request with `reply`. */
export const replyingService = (reply: string): LlmServiceShape => ({
  executeStream: () => Stream.empty,
  executeStreamWithHistory: () => Stream.empty,
  executeWithTools: () => Effect.fail(unused),
  executeStructured: (_prompt, schema, jsonSchema) => parseFromText(reply, schema, jsonSchema),
  executeStructuredWithUsage: () => Effect.fail(unused),
  scoreLabels: unsupportedScoreLabels,
  isAvailable: Effect.succeed(true)
})

const service = "DemoBankService"
const iban = "IT60X0542811101000000123456"

// Every operation called once through the stub backend, plus the SoapUI
// mocks: the evidence a real rehearsal would collect.
export const recordedEvidence = Effect.gen(function* () {
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
  return { workspace, catalog, operations, analyses, byName }
})
