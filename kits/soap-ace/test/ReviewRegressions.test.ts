import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { storyPlanViolations } from "@llm4ts/flow/StoryPlan"
import { isSuccessCode } from "../flows/lib/soap/Analysis.ts"
import { elementByName, operationByName, type WsdlCatalog } from "../flows/lib/soap/Catalog.ts"
import { ApiDesign, checkDesign, parseDesignFile } from "../flows/lib/soap/Design.ts"
import { storyPlanFor } from "../flows/lib/soap/Epic.ts"
import {
  instanceFromXml,
  instanceToXml,
  skeletonYaml,
  validateInstance
} from "../flows/lib/soap/Instance.ts"
import { renderTypedYaml } from "../flows/lib/soap/OpenApi.ts"
import { renderRequestFile } from "../flows/lib/soap/Samples.ts"
import { DocumentLoader, makeMemoryDocumentLoader, readCatalog } from "../flows/lib/soap/Wsdl.ts"
import { parseXml, renderXml } from "../flows/lib/soap/Xml.ts"
import { parseYaml, renderYaml, type YamlValue } from "../flows/lib/soap/Yaml.ts"
import { fixtureRoot, recordedEvidence } from "./support.ts"

// Regressions from the parsing and design reviews.

const wsdlWith = (schema: string, extra: Readonly<Record<string, string>> = {}) =>
  Effect.provideService(
    readCatalog("svc.wsdl"),
    DocumentLoader,
    makeMemoryDocumentLoader({
      "svc.wsdl": `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
        xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:t" targetNamespace="urn:t">
        <types><xs:schema targetNamespace="urn:t" xmlns:t="urn:t" elementFormDefault="qualified">${schema}</xs:schema></types>
        <message name="in"><part name="p" element="t:op"/></message>
        <portType name="P"><operation name="op"><input message="t:in"/></operation></portType>
        <binding name="B" type="t:P"><soap:binding style="document"/><operation name="op"><soap:operation soapAction="urn:op"/><input><soap:body use="literal"/></input></operation></binding>
      </definitions>`,
      ...extra
    })
  )

const opElement = (catalog: WsdlCatalog) =>
  elementByName(catalog, operationByName(catalog, "op")?.input ?? "") ??
  assert.fail("no op element")

const issuesOf = (catalog: WsdlCatalog, value: YamlValue) =>
  validateInstance(catalog, opElement(catalog), value).map(
    (issue) => `${issue.path}: ${issue.detail}`
  )

describe("YAML round trips", () => {
  it.effect("keeps #text keys, trailing colons, nested lists, and control escapes", () =>
    Effect.gen(function* () {
      const value = { a: { "#text": "x", "@id": "1" }, notes: ["Note:", ["a", "b"]], k: "a\bb\fc" }
      assert.deepStrictEqual(yield* parseYaml(renderYaml(value)), value)
    })
  )

  it.effect(
    "keeps a block scalar's first line even when it starts with #, and quotes inside plain values",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* parseYaml("k: |\n  # heading\n  body\n"), {
          k: "# heading\nbody\n"
        })
        assert.deepStrictEqual(yield* parseYaml("k: 5 'ft  # note\n"), { k: "5 'ft" })
      })
  )
})

describe("XSD content models", () => {
  it.effect("treats a sequence inside a choice as one alternative", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`<xs:element name="op"><xs:complexType><xs:choice>
          <xs:sequence><xs:element name="a" type="xs:string"/><xs:element name="b" type="xs:string"/></xs:sequence>
          <xs:element name="c" type="xs:string"/></xs:choice></xs:complexType></xs:element>`)
      assert.deepStrictEqual(issuesOf(catalog, { a: "1", b: "2" }), [])
      assert.deepStrictEqual(issuesOf(catalog, { a: "1" }), ["b: required field is missing"])
      assert.isTrue(
        issuesOf(catalog, { a: "1", b: "2", c: "3" })[0]?.includes("choose one of a + b, c")
      )
      assert.isTrue(issuesOf(catalog, {})[0]?.includes("one of a + b, c is required"))
      const skeleton = yield* parseYaml(skeletonYaml(catalog, opElement(catalog), 0).join("\n"))
      assert.deepStrictEqual(issuesOf(catalog, skeleton), [])
    })
  )

  it.effect("keeps a base choice and a derived choice apart", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`
        <xs:complexType name="Base"><xs:choice><xs:element name="a" type="xs:string"/><xs:element name="b" type="xs:string"/></xs:choice></xs:complexType>
        <xs:element name="op"><xs:complexType><xs:complexContent><xs:extension base="t:Base">
          <xs:choice><xs:element name="c" type="xs:string"/><xs:element name="d" type="xs:string"/></xs:choice>
        </xs:extension></xs:complexContent></xs:complexType></xs:element>`)
      assert.deepStrictEqual(issuesOf(catalog, { a: "1", c: "2" }), [])
      assert.isTrue(
        issuesOf(catalog, { a: "1" }).some((line) => line.includes("one of c, d is required"))
      )
    })
  )

  it.effect("passes a group's repetition down, and a ref's nillability", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`
        <xs:element name="n" type="xs:string" nillable="true"/>
        <xs:element name="op"><xs:complexType><xs:sequence>
          <xs:sequence maxOccurs="unbounded"><xs:sequence><xs:element name="r" type="xs:string"/></xs:sequence></xs:sequence>
          <xs:element ref="t:n"/>
        </xs:sequence></xs:complexType></xs:element>`)
      assert.deepStrictEqual(issuesOf(catalog, { r: ["1", "2"], n: null }), [])
    })
  )

  it.effect("inherits text and attributes through simpleContent over a complex base", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`
        <xs:complexType name="A"><xs:simpleContent><xs:extension base="xs:decimal"><xs:attribute name="x" type="xs:string"/></xs:extension></xs:simpleContent></xs:complexType>
        <xs:element name="op"><xs:complexType><xs:simpleContent><xs:extension base="t:A"><xs:attribute name="y" type="xs:string"/></xs:extension></xs:simpleContent></xs:complexType></xs:element>`)
      const value = { "#text": "1.5", "@x": "a", "@y": "b" }
      assert.deepStrictEqual(issuesOf(catalog, value), [])
      assert.include(instanceToXml(catalog, opElement(catalog), value), 'x="a"')
      assert.deepStrictEqual(issuesOf(catalog, { "#text": "abc" }).length, 1)
    })
  )

  it.effect("resolves no-namespace references inside a chameleon include", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(
        `<xs:include schemaLocation="codes.xsd"/><xs:element name="op" type="t:Holder"/>`,
        {
          "codes.xsd": `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
            <xs:simpleType name="Code"><xs:restriction base="xs:string"><xs:enumeration value="A"/></xs:restriction></xs:simpleType>
            <xs:complexType name="Holder"><xs:sequence><xs:element name="code" type="Code"/></xs:sequence></xs:complexType>
          </xs:schema>`
        }
      )
      assert.isFalse(catalog.openQuestions.some((question) => question.code === "unresolved-type"))
      assert.strictEqual(issuesOf(catalog, { code: "B" }).length, 1)
    })
  )

  it.effect("writes a required element with only optional children as an empty map", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`<xs:element name="op"><xs:complexType><xs:sequence>
          <xs:element name="o"><xs:complexType><xs:sequence><xs:element name="x" type="xs:string" minOccurs="0"/></xs:sequence></xs:complexType></xs:element>
        </xs:sequence></xs:complexType></xs:element>`)
      const value = yield* parseYaml(skeletonYaml(catalog, opElement(catalog), 0).join("\n"))
      assert.deepStrictEqual(issuesOf(catalog, value), [])
    })
  )

  it.effect('reads xsi:nil="1" as nil and does not read a cycling root twice', () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(
        `<xs:element name="op"><xs:complexType><xs:sequence><xs:element name="n" type="xs:string" nillable="true"/></xs:sequence></xs:complexType></xs:element>`
      )
      const xml = yield* parseXml(
        '<t:op xmlns:t="urn:t" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><t:n xsi:nil="1"/></t:op>'
      )
      assert.deepStrictEqual(instanceFromXml(catalog, opElement(catalog), xml).value, { n: null })

      const loader = makeMemoryDocumentLoader({
        "a.wsdl":
          '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" targetNamespace="urn:a"><import location="b.wsdl"/></definitions>',
        "b.wsdl":
          '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" targetNamespace="urn:b"><import location="a.wsdl"/></definitions>'
      })
      const error = yield* Effect.flip(
        Effect.provideService(readCatalog("./a.wsdl"), DocumentLoader, loader)
      )
      assert.strictEqual(error._tag, "WsdlError")
    })
  )
})

describe("XML", () => {
  it.effect("keeps attribute line breaks, normalizes CRLF, and rejects malformed references", () =>
    Effect.gen(function* () {
      const root = yield* parseXml('<r a="1&#10;2">x\r\ny</r>')
      const again = yield* parseXml(renderXml(root))
      assert.strictEqual(again.attributes[0]?.value, "1\n2")
      assert.strictEqual(again.children[0]?._tag === "text" ? again.children[0].value : "", "x\ny")
      assert.strictEqual((yield* Effect.flip(parseXml("<r>&#12a;</r>"))).reason, "syntax")
    })
  )
})

describe("request files", () => {
  it.effect("write empty and scalar bodies inline", () =>
    Effect.gen(function* () {
      const { catalog } = yield* recordedEvidence
      for (const body of [{}, null, "x"]) {
        const text = renderRequestFile({ catalog, operation: "cercaConti", purpose: "p", body })
        const parsed = yield* parseYaml(text)
        assert.deepStrictEqual(parsed, { operation: "cercaConti", purpose: "p", body })
      }
    })
  )
})

describe("design and epic", () => {
  const reference = parseDesignFile(
    readFileSync(join(fixtureRoot, "design", "api-design.md"), "utf8")
  )
  const edit = (
    design: ApiDesign,
    change: (encoded: typeof ApiDesign.Encoded) => typeof ApiDesign.Encoded
  ) =>
    Schema.decodeUnknownSync(ApiDesign)(
      change(structuredClone(Schema.encodeSync(ApiDesign)(design)))
    )
  const renamePath = (from: string, to: string) => (encoded: typeof ApiDesign.Encoded) => ({
    ...encoded,
    endpoints: encoded.endpoints.map((endpoint) => ({
      ...endpoint,
      path: endpoint.path.replace(from, to)
    }))
  })

  it.effect("survives cyclic model references and catches route, name, and resource clashes", () =>
    Effect.gen(function* () {
      const { catalog, operations, analyses } = yield* recordedEvidence
      const { design } = yield* reference
      const context = { catalog, operations, analyses }
      const cyclic = edit(design, (encoded) => ({
        ...encoded,
        models: encoded.models.map((model) =>
          model.name === "Amount"
            ? {
                ...model,
                properties: [
                  ...model.properties,
                  {
                    name: "self",
                    type: "object" as const,
                    required: false,
                    ref: "Amount",
                    source: "valore"
                  }
                ]
              }
            : model
        )
      }))
      assert.isArray(checkDesign(cyclic, context))

      const sameShape = edit(design, (encoded) => ({
        ...encoded,
        endpoints: encoded.endpoints.map((endpoint) =>
          endpoint.operationId === "revokeCreditTransfer"
            ? {
                ...endpoint,
                path: "/credit-transfers/{id}/confirmation",
                parameters: [
                  {
                    name: "id",
                    in: "path" as const,
                    required: true,
                    type: "string" as const,
                    source: "idBonifico"
                  }
                ]
              }
            : endpoint
        )
      }))
      assert.isTrue(
        checkDesign(sameShape, context).some((issue) => issue.detail.startsWith("duplicate route"))
      )

      const reserved = edit(design, (encoded) => ({
        ...encoded,
        models: encoded.models.map((model) =>
          model.name === "TransferRevocation" ? { ...model, name: "Problem" } : model
        ),
        endpoints: encoded.endpoints.map((endpoint) => ({
          ...endpoint,
          responses: endpoint.responses.map((response) =>
            response.model === "TransferRevocation" ? { ...response, model: "Problem" } : response
          )
        }))
      }))
      assert.isTrue(
        checkDesign(reserved, context).some(
          (issue) => issue.where === "model Problem" && issue.severity === "error"
        )
      )

      const rootParam = edit(design, renamePath("/accounts/{iban}", "/{iban}"))
      assert.isTrue(
        checkDesign(rootParam, context).some((issue) => issue.detail.includes("first path segment"))
      )

      for (const name of ["support", "gen", "contract"]) {
        const plan = storyPlanFor({
          design: edit(design, renamePath("/credit-transfers", `/${name}`)),
          service: "S",
          api: "SApi",
          analyses: []
        })
        assert.deepStrictEqual(storyPlanViolations(plan), [], name)
      }
    })
  )

  it("quotes strings YAML readers retype and treats 017 as an error code", () => {
    assert.strictEqual(
      renderTypedYaml({ a: "Statuses:", b: ".inf", c: "1_000", d: "12:30" }),
      'a: "Statuses:"\nb: ".inf"\nc: "1_000"\nd: "12:30"\n'
    )
    assert.isFalse(isSuccessCode("017"))
    assert.isTrue(isSuccessCode("OK00"))
    assert.isTrue(isSuccessCode("000"))
  })
})
