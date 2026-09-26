import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  ComplexTypeDef,
  elementByName,
  operationByName,
  qname,
  SimpleTypeDef,
  typeByName,
  type WsdlCatalog
} from "../flows/lib/soap/Catalog.ts"
import {
  DocumentLoader,
  makeFileDocumentLoader,
  makeMemoryDocumentLoader,
  readCatalog,
  resolveLocation
} from "../flows/lib/soap/Wsdl.ts"

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "demo-bank-soap",
  "wsdl"
)
const banking = "http://demobank.example/soap/banking"
const common = "http://demobank.example/soap/common"

const fromFiles = <A, E>(effect: Effect.Effect<A, E, DocumentLoader>) =>
  Effect.provideService(effect, DocumentLoader, makeFileDocumentLoader())

const complex = (catalog: WsdlCatalog, name: string): ComplexTypeDef => {
  const type = typeByName(catalog, name)
  return type instanceof ComplexTypeDef ? type : assert.fail(`${name} is not a complex type`)
}

const simple = (catalog: WsdlCatalog, name: string): SimpleTypeDef => {
  const type = typeByName(catalog, name)
  return type instanceof SimpleTypeDef ? type : assert.fail(`${name} is not a simple type`)
}

describe("Wsdl", () => {
  it("resolves locations against paths and URLs", () => {
    assert.strictEqual(resolveLocation("/a/b/x.wsdl", "xsd/c.xsd"), "/a/b/xsd/c.xsd")
    assert.strictEqual(resolveLocation("/a/b/xsd/c.xsd", "../d.xsd"), "/a/b/d.xsd")
    assert.strictEqual(
      resolveLocation("https://h.example/s/x?wsdl", "x.xsd"),
      "https://h.example/s/x.xsd"
    )
    assert.strictEqual(
      resolveLocation("/a/x.wsdl", "http://o.example/y.xsd"),
      "http://o.example/y.xsd"
    )
  })

  it.effect("reads the demo-bank catalog across imports, includes, and a latin-1 schema", () =>
    Effect.gen(function* () {
      const catalog = yield* fromFiles(readCatalog(join(fixture, "DemoBank.wsdl")))

      assert.strictEqual(catalog.wsdlVersion, "1.1")
      assert.deepStrictEqual(
        catalog.operations.map((operation) => operation.name),
        [
          "cercaConti",
          "dettaglioConto",
          "cercaMovimenti",
          "inserisciBonifico",
          "confermaBonifico",
          "revocaBonifico"
        ]
      )
      assert.deepStrictEqual(
        [...catalog.documents.map((document) => document.slice(fixture.length + 1))].sort(),
        [
          "DemoBank.wsdl",
          "xsd/banking.xsd",
          "xsd/bonifici.xsd",
          "xsd/common.xsd",
          "xsd/conti.xsd",
          "xsd/movimenti.xsd"
        ]
      )

      const cercaConti = operationByName(catalog, "cercaConti")
      assert.strictEqual(cercaConti?.wrapped, true)
      assert.strictEqual(cercaConti?.soapVersion, "1.1")
      assert.strictEqual(cercaConti?.soapAction, `${banking}/cercaConti`)
      assert.strictEqual(cercaConti?.input, qname(banking, "cercaConti"))
      assert.strictEqual(cercaConti?.output, qname(banking, "cercaContiResponse"))
      assert.deepStrictEqual(
        cercaConti?.faults.map((fault) => fault.element),
        [qname(common, "ServizioFault")]
      )
      assert.strictEqual(
        cercaConti?.documentation,
        "Lists the customer's current accounts by codice fiscale."
      )

      assert.deepStrictEqual(
        catalog.endpoints.map((endpoint) => [endpoint.port, endpoint.soapVersion]),
        [
          ["DemoBankPort", "1.1"],
          ["DemoBankPort12", "1.2"]
        ]
      )
    })
  )

  it.effect("flattens extensions and keeps occurrence, nillability, and facets", () =>
    Effect.gen(function* () {
      const catalog = yield* fromFiles(readCatalog(join(fixture, "DemoBank.wsdl")))
      const response = elementByName(catalog, qname(banking, "dettaglioContoResponse"))
      const type = complex(catalog, response?.type ?? "")
      assert.strictEqual(type.anonymous, true)
      assert.strictEqual(type.base, qname(common, "RispostaBase"))
      assert.deepStrictEqual(
        type.fields.map((field) => [field.name, field.minOccurs, field.maxOccurs, field.nillable]),
        [
          ["esito", 1, 1, false],
          ["conto", 0, 1, false],
          ["fido", 0, 1, true]
        ]
      )
      assert.strictEqual(type.fields[0]?.namespace, common)
      assert.strictEqual(type.fields[1]?.namespace, banking)

      const movimenti = complex(
        catalog,
        elementByName(catalog, qname(banking, "cercaMovimentiResponse"))?.type ?? ""
      )
      assert.strictEqual(movimenti.fields[1]?.maxOccurs, "unbounded")

      assert.strictEqual(simple(catalog, qname(common, "IbanType")).facets.length, 27)

      const stato = simple(catalog, qname(banking, "StatoConto"))
      assert.deepStrictEqual(stato.facets.enumeration, ["ATTIVO", "BLOCCATO", "ESTINTO"])

      const movimento = complex(catalog, qname(banking, "MovimentoType"))
      assert.include(movimento.documentation ?? "", "città")
    })
  )

  it.effect("records unmodelled constructs as open questions instead of guessing", () =>
    Effect.gen(function* () {
      const catalog = yield* fromFiles(readCatalog(join(fixture, "DemoBank.wsdl")))
      const any = catalog.openQuestions.filter((question) => question.code === "xsd-any")
      assert.strictEqual(any.length, 1)
      assert.include(any[0]?.location ?? "", "bonifici.xsd:")
      assert.include(any[0]?.subject ?? "", "datiAggiuntivi")
      assert.isFalse(catalog.openQuestions.some((question) => question.code === "unresolved-type"))
    })
  )

  it.effect("refuses an RPC/encoded-only WSDL, naming the binding", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(fromFiles(readCatalog(join(fixture, "LegacyRpc.wsdl"))))
      assert.strictEqual(error._tag, "WsdlError")
      assert.include(error.message, "LegacyRpcBinding")
      assert.include(error.message, "rpc/encoded")
    })
  )

  it.effect("refuses a WSDL carrying a DOCTYPE", () =>
    Effect.gen(function* () {
      const loader = makeMemoryDocumentLoader({
        "x.wsdl": '<!DOCTYPE d [<!ENTITY e SYSTEM "file:///etc/passwd">]><d/>'
      })
      const error = yield* Effect.flip(
        Effect.provideService(readCatalog("x.wsdl"), DocumentLoader, loader)
      )
      assert.strictEqual(error._tag, "XmlError")
    })
  )

  it.effect("reports a missing document as a load error", () =>
    Effect.gen(function* () {
      const loader = makeMemoryDocumentLoader({
        "s.wsdl": [
          '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:xs="http://www.w3.org/2001/XMLSchema">',
          '<types><xs:schema><xs:import namespace="urn:x" schemaLocation="missing.xsd"/></xs:schema></types>',
          "</definitions>"
        ].join("")
      })
      const error = yield* Effect.flip(
        Effect.provideService(readCatalog("s.wsdl"), DocumentLoader, loader)
      )
      assert.strictEqual(error._tag, "DocumentLoadError")
      assert.include(error.message, "missing.xsd")
    })
  )

  it.effect("reads a WSDL 2.0 description with a SOAP binding", () =>
    Effect.gen(function* () {
      const loader = makeMemoryDocumentLoader({
        "w2.wsdl": `<description xmlns="http://www.w3.org/ns/wsdl"
            xmlns:wsoap="http://www.w3.org/ns/wsdl/soap"
            xmlns:xs="http://www.w3.org/2001/XMLSchema"
            xmlns:t="urn:t" targetNamespace="urn:t">
          <types>
            <xs:schema targetNamespace="urn:t" elementFormDefault="qualified">
              <xs:element name="saldo"><xs:complexType><xs:sequence>
                <xs:element name="iban" type="xs:string"/>
              </xs:sequence></xs:complexType></xs:element>
              <xs:element name="saldoResponse" type="xs:decimal"/>
              <xs:element name="errore" type="xs:string"/>
            </xs:schema>
          </types>
          <interface name="Conti">
            <fault name="Errore" element="t:errore"/>
            <operation name="saldo" pattern="http://www.w3.org/ns/wsdl/in-out">
              <input element="t:saldo"/>
              <output element="t:saldoResponse"/>
              <outfault ref="t:Errore"/>
            </operation>
          </interface>
          <binding name="ContiSoap" interface="t:Conti" type="http://www.w3.org/ns/wsdl/soap" wsoap:version="1.1">
            <operation ref="t:saldo" wsoap:action="urn:saldo"/>
          </binding>
          <service name="ContiService" interface="t:Conti">
            <endpoint name="ContiEndpoint" binding="t:ContiSoap" address="https://dev.example/conti"/>
          </service>
        </description>`
      })
      const catalog = yield* Effect.provideService(readCatalog("w2.wsdl"), DocumentLoader, loader)
      assert.strictEqual(catalog.wsdlVersion, "2.0")
      const saldo = operationByName(catalog, "saldo")
      assert.strictEqual(saldo?.soapAction, "urn:saldo")
      assert.strictEqual(saldo?.soapVersion, "1.1")
      assert.strictEqual(saldo?.wrapped, true)
      assert.deepStrictEqual(
        saldo?.faults.map((fault) => fault.element),
        ["{urn:t}errore"]
      )
      assert.strictEqual(catalog.endpoints[0]?.address, "https://dev.example/conti")
    })
  )
})
