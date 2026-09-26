import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { decodeAuthProfile } from "../flows/lib/soap/Auth.ts"
import { callOperation } from "../flows/lib/soap/Call.ts"
import { parseOperationsFile } from "../flows/lib/soap/Classification.ts"
import { maskDocument, maskText } from "../flows/lib/soap/Masking.ts"
import { renderRequestFile, samplePaths } from "../flows/lib/soap/Samples.ts"
import { importSoapUiProject } from "../flows/lib/soap/SoapUiImport.ts"
import { makeFakeSoapTransport } from "../flows/lib/soap/Transport.ts"
import {
  DocumentLoader,
  makeMemoryDocumentLoader,
  readCatalog,
  safeLocation
} from "../flows/lib/soap/Wsdl.ts"
import { parseXml, renderXml } from "../flows/lib/soap/Xml.ts"
import { demoCatalog, demoSoapUi, fixedKey } from "./support.ts"

// Regressions from the security review: nothing unmasked, no credential,
// and no secret-bearing URL may reach a persisted file or an error.

const service = "DemoBankService"
const iban = "IT60X0542811101000000123456"
const cf = "RSSMRA85T10A562S"

const callWith = (responseXml: string) =>
  Effect.gen(function* () {
    const catalog = yield* demoCatalog
    const workspace = yield* makeMemoryWorkspace()
    yield* workspace.write(
      samplePaths(service, "cercaConti", "x").yaml,
      renderRequestFile({
        catalog,
        operation: "cercaConti",
        purpose: "x",
        body: { codiceFiscale: cf }
      })
    )
    const fake = yield* makeFakeSoapTransport(() =>
      Effect.succeed({
        status: 500,
        headers: {},
        body: new TextEncoder().encode(responseXml),
        elapsedMs: 1
      })
    )
    const result = yield* callOperation({
      workspace,
      catalog,
      service,
      operation: "cercaConti",
      name: "x",
      profile: yield* decodeAuthProfile('{"environment":"dev"}'),
      operations: yield* parseOperationsFile("Status: confirmed\n## cercaConti\n- class: read\n"),
      secrets: { environment: {}, readFile: () => Effect.die("unused") },
      transport: fake.transport,
      allowMutating: undefined,
      confirm: () => Effect.succeed(false)
    })
    return yield* workspace.read(result.path)
  })

describe("security regressions", () => {
  it.effect("masks SOAP 1.1 and 1.2 fault text before recording it", () =>
    Effect.gen(function* () {
      const fault11 = yield* callWith(
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Server</faultcode><faultstring>conto ${iban} di ${cf} bloccato</faultstring></s:Fault></s:Body></s:Envelope>`
      )
      assert.notInclude(fault11, iban)
      assert.notInclude(fault11, cf)
      const fault12 = yield* callWith(
        `<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"><e:Body><e:Fault><e:Code><e:Value>e:Receiver</e:Value></e:Code><e:Reason><e:Text>cliente ${cf} mario.rossi@banca.it</e:Text></e:Reason></e:Fault></e:Body></e:Envelope>`
      )
      assert.notInclude(fault12, cf)
      assert.notInclude(fault12, "mario.rossi@banca.it")
    })
  )

  it.effect("records schema findings from the masked response", () =>
    Effect.gen(function* () {
      const stored = yield* callWith(
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><b:cercaContiResponse xmlns:b="http://demobank.example/soap/banking" xmlns:c="http://demobank.example/soap/common"><c:esito><c:codice>OK00</c:codice></c:esito><b:conto><b:iban>IT60 X054 2811 1010 0000 0123 456</b:iban><b:intestatario>Mario Rossi</b:intestatario><b:codiceFiscale>12345678903</b:codiceFiscale><b:saldo><c:valore>1</c:valore><c:divisa>EUR</c:divisa></b:saldo><b:stato>ATTIVO</b:stato><b:dataApertura>2020-01-01</b:dataApertura></b:conto></b:cercaContiResponse></s:Body></s:Envelope>`
      )
      assert.include(stored, "responseIssues")
      for (const leak of ["IT60 X054 2811", "12345678903", "Mario Rossi"])
        assert.notInclude(stored, leak)
    })
  )

  it("catches identifiers as people type them", () => {
    const text = `iban it60x0542811101000000123456, spaced IT60 X054 2811 1010 0000 0123 456, cf rssmra85t10a562s, tel +39 02 1234 5678`
    const masked = maskText(fixedKey, text)
    for (const leak of [
      "it60x0542811101000000123456",
      "IT60 X054 2811 1010 0000 0123 456",
      "rssmra85t10a562s",
      "1234 5678"
    ]) {
      assert.notInclude(masked.text, leak)
    }
    assert.sameMembers([...masked.kinds], ["iban", "iban", "codice-fiscale", "phone"])
    // One IBAN, however written, maps to one pseudonym.
    const [lower, spaced] = [
      maskText(fixedKey, "it60x0542811101000000123456").text,
      maskText(fixedKey, "IT60 X054 2811 1010 0000 0123 456").text
    ]
    assert.strictEqual(lower, spaced)
  })

  it.effect("treats nominativo-style fields as names", () =>
    Effect.gen(function* () {
      const root = yield* parseXml(
        "<r><nominativo>Mario Rossi</nominativo><firmatario>Anna Bianchi</firmatario></r>"
      )
      const xml = renderXml(maskDocument(root, { key: fixedKey }).document)
      assert.notInclude(xml, "Mario Rossi")
      assert.notInclude(xml, "Anna Bianchi")
    })
  )

  it.effect("strips WS-Security from SoapUI mocks and masks call labels", () =>
    Effect.gen(function* () {
      const catalog = yield* demoCatalog
      const workspace = yield* makeMemoryWorkspace()
      const project = readFileSync(demoSoapUi, "utf8")
        .replace('name="Conti attivi"', `name="Conti di ${cf}"`)
        .replace(
          "<soapenv:Header/><soapenv:Body><ban:cercaContiResponse>",
          '<soapenv:Header><wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><wsse:UsernameToken><wsse:Username>svc-prod-user</wsse:Username></wsse:UsernameToken></wsse:Security></soapenv:Header><soapenv:Body><ban:cercaContiResponse>'
        )
      yield* importSoapUiProject({ workspace, catalog, service, project, key: fixedKey })
      for (const file of yield* workspace.discover(".llm4ts/**")) {
        assert.notInclude(file.toLowerCase(), cf.toLowerCase(), file)
        const text = yield* workspace.read(file)
        for (const leak of ["svc-prod-user", "UsernameToken", cf])
          assert.notInclude(text, leak, file)
      }
    })
  )

  it.effect("refuses URL credentials and redacts secret query parameters", () =>
    Effect.gen(function* () {
      const loader = makeMemoryDocumentLoader({})
      const error = yield* Effect.flip(
        Effect.provideService(
          readCatalog("https://u:Sup3rS3cret@esb.example/svc?wsdl"),
          DocumentLoader,
          loader
        )
      )
      assert.notInclude(error.message, "Sup3rS3cret")
      assert.include(error.message, "credentials in the URL")
      assert.strictEqual(
        safeLocation("https://esb.example/svc?wsdl"),
        "https://esb.example/svc?wsdl"
      )
      assert.notInclude(safeLocation("https://esb.example/svc?wsdl&token=abc"), "abc")
      const missing = yield* Effect.flip(
        Effect.provideService(
          readCatalog("https://esb.example/svc?apikey=abc"),
          DocumentLoader,
          loader
        )
      )
      assert.notInclude(missing.message, "abc")
      const endpoint = yield* Effect.flip(
        decodeAuthProfile('{"environment":"dev","endpoint":"https://svc:Sup3rS3cret@host/ws"}')
      )
      assert.notInclude(endpoint.message, "Sup3rS3cret")
    })
  )
})
