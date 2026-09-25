import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { elementByName, qname, type WsdlCatalog } from "../flows/lib/soap/Catalog.ts"
import {
  instanceFromXml,
  instanceToXml,
  patternExample,
  skeletonYaml,
  validateInstance
} from "../flows/lib/soap/Instance.ts"
import { DocumentLoader, makeFileDocumentLoader, readCatalog } from "../flows/lib/soap/Wsdl.ts"
import { parseXml } from "../flows/lib/soap/Xml.ts"
import { isYamlMap, parseYaml, type YamlValue } from "../flows/lib/soap/Yaml.ts"

const wsdl = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "demo-bank-soap",
  "wsdl",
  "DemoBank.wsdl"
)
const banking = "http://demobank.example/soap/banking"

const catalog = readCatalog(wsdl).pipe(
  Effect.provideService(DocumentLoader, makeFileDocumentLoader())
)

const element = (catalogValue: WsdlCatalog, local: string) =>
  elementByName(catalogValue, qname(banking, local)) ?? assert.fail(`no element ${local}`)

describe("pattern examples", () => {
  it("builds strings matching simple XSD patterns", () => {
    assert.strictEqual(patternExample("(OK|KO|WA)[0-9]{2}"), "OK00")
    assert.strictEqual(patternExample("[A-Z]{3}"), "AAA")
    assert.strictEqual(patternExample("\\d{5}-[A-Z]?x+"), "00000-x")
    assert.strictEqual(patternExample("[^0-9]+"), undefined)
  })
})

describe("request skeletons", () => {
  it.effect("are valid YAML and valid instances for every operation's request", () =>
    Effect.gen(function* () {
      const read = yield* catalog
      for (const operation of read.operations) {
        const input = elementByName(read, operation.input) ?? assert.fail(operation.input)
        const text = skeletonYaml(read, input, 0).join("\n")
        const value = yield* parseYaml(text)
        const issues = validateInstance(read, input, value)
        assert.deepStrictEqual(issues, [], `${operation.name}:\n${text}`)
      }
    })
  )

  it.effect("fills required fields with checksummed examples and comments optional ones", () =>
    Effect.gen(function* () {
      const read = yield* catalog
      const text = skeletonYaml(read, element(read, "cercaMovimenti"), 0).join("\n")
      assert.include(text, "iban: IT60X0542811101000000123456  # IbanType, string, pattern")
      assert.include(text, "dimensionePagina: 1  #")
      assert.include(text, "paginazione:  # PaginazioneRichiesta [1]")
      const conti = skeletonYaml(read, element(read, "cercaConti"), 0).join("\n")
      assert.include(
        conti,
        "# stato: ATTIVO  # StatoConto, string, one of ATTIVO | BLOCCATO | ESTINTO [0..1]"
      )
      const seeded = skeletonYaml(read, element(read, "dettaglioConto"), 0, {
        seeds: new Map([["iban", "IT02L1234512345123456789012"]])
      }).join("\n")
      assert.include(seeded, "iban: IT02L1234512345123456789012")
    })
  )

  it.effect("includes optional fields on request, still valid, lists as items", () =>
    Effect.gen(function* () {
      const read = yield* catalog
      const input = element(read, "cercaContiResponse")
      const text = skeletonYaml(read, input, 0, { includeOptional: true }).join("\n")
      const value = yield* parseYaml(text)
      assert.deepStrictEqual(validateInstance(read, input, value), [], text)
    })
  )
})

describe("validation", () => {
  it.effect("reports missing, unknown, malformed, and over-long values with paths", () =>
    Effect.gen(function* () {
      const read = yield* catalog
      const value: YamlValue = {
        ibanOrdinante: "IT60X0542811101000000123456",
        beneficiario: { nome: "Beneficiario", iban: "not-an-iban" },
        importo: { valore: "10.123", divisa: "eur" },
        causale: "x".repeat(141),
        dataEsecuzione: ["2026-01-01", "2026-01-02"],
        extra: "?"
      }
      const issues = validateInstance(read, element(read, "inserisciBonifico"), value)
      const byPath = (path: string) =>
        issues.filter((issue) => issue.path === path).map((issue) => issue.detail)
      assert.isNotEmpty(byPath("beneficiario.iban"))
      assert.isTrue(byPath("importo.valore").some((detail) => detail.includes("fraction digits")))
      assert.isNotEmpty(byPath("importo.divisa"))
      assert.isTrue(byPath("causale").some((detail) => detail.includes("above 140")))
      assert.isTrue(byPath("dataEsecuzione").some((detail) => detail.includes("at most once")))
      assert.isTrue(byPath("extra").some((detail) => detail.includes("not a field")))
    })
  )

  it.effect("checks required fields and bounds", () =>
    Effect.gen(function* () {
      const read = yield* catalog
      const issues = validateInstance(read, element(read, "cercaMovimenti"), {
        iban: "IT60X0542811101000000123456",
        dataDa: "2026-13-45x",
        paginazione: { numeroPagina: "uno", dimensionePagina: "101" }
      })
      const paths = issues.map((issue) => issue.path)
      assert.includeMembers(paths, [
        "dataA",
        "dataDa",
        "paginazione.numeroPagina",
        "paginazione.dimensionePagina"
      ])
    })
  )
})

describe("XML conversion", () => {
  it.effect("writes the XSD order and namespaces, and reads back the same value", () =>
    Effect.gen(function* () {
      const read = yield* catalog
      const input = element(read, "cercaMovimenti")
      const value: YamlValue = {
        paginazione: { dimensionePagina: "20", numeroPagina: "1" },
        dataA: "2026-03-31",
        dataDa: "2026-01-01",
        iban: "IT60X0542811101000000123456"
      }
      const xml = instanceToXml(read, input, value)
      assert.match(xml, /^<ns1:cercaMovimenti xmlns:ns1="http:\/\/demobank.example\/soap\/banking"/)
      assert.isBelow(xml.indexOf("ns1:iban"), xml.indexOf("ns1:dataDa"))
      assert.include(xml, "<ns2:numeroPagina>1</ns2:numeroPagina>")
      const back = instanceFromXml(read, input, yield* parseXml(xml))
      assert.deepStrictEqual(back.issues, [])
      assert.deepStrictEqual(back.value, {
        iban: "IT60X0542811101000000123456",
        dataDa: "2026-01-01",
        dataA: "2026-03-31",
        paginazione: { numeroPagina: "1", dimensionePagina: "20" }
      })
    })
  )

  it.effect("keeps a schema-breaking response readable and lists what breaks it", () =>
    Effect.gen(function* () {
      const read = yield* catalog
      const response = element(read, "cercaContiResponse")
      const conto = (valore: string, stato: string, extra = "") =>
        `<b:conto><b:iban>IT60X0542811101000000123456</b:iban><b:intestatario>M</b:intestatario>
          <b:codiceFiscale>RSSMRA85T10A562S</b:codiceFiscale>
          <b:saldo><c:valore>${valore}</c:valore><c:divisa>EUR</c:divisa></b:saldo>
          <b:stato>${stato}</b:stato><b:dataApertura>2020-01-01</b:dataApertura>${extra}</b:conto>`
      const xml = yield* parseXml(
        `<b:cercaContiResponse xmlns:b="${banking}" xmlns:c="http://demobank.example/soap/common">
          <c:esito><c:codice>OK00</c:codice></c:esito>
          ${conto("1.00", "SOSPESO", "<b:nuovoCampo>x</b:nuovoCampo>")}
          ${conto("2.00", "ATTIVO")}
        </b:cercaContiResponse>`
      )
      const result = instanceFromXml(read, response, xml)
      const conti = isYamlMap(result.value) ? result.value["conto"] : undefined
      assert.isTrue(Array.isArray(conti) && conti.length === 2)
      const details = result.issues.map((issue) => `${issue.path}: ${issue.detail}`)
      assert.isTrue(
        details.some((detail) => detail.startsWith("conto[0].stato") && detail.includes("SOSPESO"))
      )
      assert.isTrue(details.some((detail) => detail.startsWith("conto[0].nuovoCampo")))
    })
  )
})
