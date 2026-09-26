import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  ComplexTypeDef,
  elementByName,
  operationByName,
  typeByName,
  type WsdlCatalog
} from "../flows/lib/soap/Catalog.ts"
import { instanceToXml, validateInstance } from "../flows/lib/soap/Instance.ts"
import { DocumentLoader, makeMemoryDocumentLoader, readCatalog } from "../flows/lib/soap/Wsdl.ts"
import { parseXml } from "../flows/lib/soap/Xml.ts"
import type { YamlValue } from "../flows/lib/soap/Yaml.ts"

// Deep review of Xsd.ts. Each case in "reproduced bugs" pins a fixed bug: the
// assertion states the XSD 1.0 behaviour. The "checked and correct" cases
// pin areas that were checked and found correct.

const wsdlWith = (
  schema: string,
  extra: Readonly<Record<string, string>> = {},
  schemaAttributes = 'elementFormDefault="qualified"'
) =>
  Effect.provideService(
    readCatalog("svc.wsdl"),
    DocumentLoader,
    makeMemoryDocumentLoader({
      "svc.wsdl": `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
        xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:t="urn:t" targetNamespace="urn:t">
        <types><xs:schema targetNamespace="urn:t" xmlns:t="urn:t" ${schemaAttributes}>${schema}</xs:schema></types>
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

const opType = (catalog: WsdlCatalog): ComplexTypeDef => {
  const type = typeByName(catalog, opElement(catalog).type)
  return type instanceof ComplexTypeDef ? type : assert.fail("op is not complex")
}

const str = (name: string, extra = "") => `<xs:element name="${name}" type="xs:string"${extra}/>`

describe("Xsd deep review: reproduced bugs", () => {
  it.effect("attributeFormDefault=qualified puts the attribute in the namespace", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(
        `<xs:element name="op"><xs:complexType><xs:sequence>${str("a")}</xs:sequence>
          <xs:attribute name="x" type="xs:string"/></xs:complexType></xs:element>`,
        {},
        'elementFormDefault="qualified" attributeFormDefault="qualified"'
      )
      const xml = yield* parseXml(instanceToXml(catalog, opElement(catalog), { a: "1", "@x": "v" }))
      assert.strictEqual(xml.attributes.find((a) => a.name.local === "x")?.name.namespace, "urn:t")
    })
  )

  it.effect("an attribute ref resolves to the global attribute's name and type", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`
        <xs:attribute name="cur"><xs:simpleType><xs:restriction base="xs:string"><xs:enumeration value="EUR"/></xs:restriction></xs:simpleType></xs:attribute>
        <xs:element name="op"><xs:complexType><xs:sequence>${str("a")}</xs:sequence>
          <xs:attribute ref="t:cur" use="required"/></xs:complexType></xs:element>`)
      assert.deepStrictEqual(
        opType(catalog).attributes.map((a) => a.name),
        ["cur"]
      )
      assert.isNotEmpty(issuesOf(catalog, { a: "1", "@cur": "XXX" }))
    })
  )

  it.effect("a choice nested in a choice is one alternative of the outer choice", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`<xs:element name="op"><xs:complexType><xs:choice>
          ${str("a")}<xs:choice>${str("b")}${str("c")}</xs:choice>
        </xs:choice></xs:complexType></xs:element>`)
      assert.deepStrictEqual(issuesOf(catalog, { b: "1" }), [])
      assert.isNotEmpty(issuesOf(catalog, { a: "1", b: "1" }))
    })
  )

  it.effect("a repeating choice lets different alternatives appear together", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`<xs:element name="op"><xs:complexType>
          <xs:choice maxOccurs="unbounded">${str("a")}${str("b")}</xs:choice>
        </xs:complexType></xs:element>`)
      assert.deepStrictEqual(issuesOf(catalog, { a: ["1"], b: ["2"] }), [])
    })
  )

  it.effect("an optional sequence is all-or-nothing, not every child optional", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`<xs:element name="op"><xs:complexType><xs:sequence>
          ${str("k")}<xs:sequence minOccurs="0">${str("from")}${str("to")}</xs:sequence>
        </xs:sequence></xs:complexType></xs:element>`)
      assert.isNotEmpty(issuesOf(catalog, { k: "1", from: "2026-01-01" }))
    })
  )

  it.effect(
    "a named type and a global element of the same name keep their inline child types apart",
    () =>
      Effect.gen(function* () {
        const inline = (value: string) =>
          `<xs:element name="x"><xs:simpleType><xs:restriction base="xs:string"><xs:enumeration value="${value}"/></xs:restriction></xs:simpleType></xs:element>`
        const catalog = yield* wsdlWith(`
          <xs:element name="op"><xs:complexType><xs:sequence>${inline("FromElement")}</xs:sequence></xs:complexType></xs:element>
          <xs:complexType name="op"><xs:sequence>${inline("FromType")}</xs:sequence></xs:complexType>`)
        assert.deepStrictEqual(issuesOf(catalog, { x: "FromElement" }), [])
      })
  )

  it.effect("simpleContent restriction keeps its facets", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`
        <xs:complexType name="Amount"><xs:simpleContent><xs:extension base="xs:decimal">
          <xs:attribute name="cur" type="xs:string"/></xs:extension></xs:simpleContent></xs:complexType>
        <xs:element name="op"><xs:complexType><xs:simpleContent><xs:restriction base="t:Amount">
          <xs:maxInclusive value="100"/></xs:restriction></xs:simpleContent></xs:complexType></xs:element>`)
      assert.isNotEmpty(issuesOf(catalog, { "#text": "500" }))
    })
  )

  it.effect("a restriction with an inline anonymous base keeps the base's facets", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`
        <xs:simpleType name="Code"><xs:restriction>
          <xs:simpleType><xs:restriction base="xs:string"><xs:enumeration value="A"/><xs:enumeration value="B"/></xs:restriction></xs:simpleType>
          <xs:maxLength value="1"/></xs:restriction></xs:simpleType>
        <xs:element name="op"><xs:complexType><xs:sequence><xs:element name="c" type="t:Code"/></xs:sequence></xs:complexType></xs:element>`)
      assert.isNotEmpty(issuesOf(catalog, { c: "Z" }))
    })
  )

  it.effect("a length facet on a restricted list type is not read as string length", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`
        <xs:simpleType name="Ints"><xs:list itemType="xs:int"/></xs:simpleType>
        <xs:simpleType name="Three"><xs:restriction base="t:Ints"><xs:length value="3"/></xs:restriction></xs:simpleType>
        <xs:element name="op"><xs:complexType><xs:sequence><xs:element name="v" type="t:Three"/></xs:sequence></xs:complexType></xs:element>`)
      // Valid: three list items. Rejected as "length 5, expected 3".
      assert.deepStrictEqual(issuesOf(catalog, { v: "1 2 3" }), [])
    })
  )

  it.effect("a fixed element value is enforced", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`<xs:element name="op"><xs:complexType><xs:sequence>
          ${str("version", ' fixed="1.0"')}</xs:sequence></xs:complexType></xs:element>`)
      assert.isNotEmpty(issuesOf(catalog, { version: "2.0" }))
    })
  )

  it.effect("a fixed attribute value is enforced", () =>
    Effect.gen(function* () {
      const catalog =
        yield* wsdlWith(`<xs:element name="op"><xs:complexType><xs:sequence>${str("a")}</xs:sequence>
          <xs:attribute name="v" type="xs:string" fixed="1.0"/></xs:complexType></xs:element>`)
      assert.isNotEmpty(issuesOf(catalog, { a: "1", "@v": "2.0" }))
    })
  )

  it.effect('nillable="1" is the boolean true', () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`<xs:element name="op"><xs:complexType><xs:sequence>
          ${str("n", ' nillable="1"')}</xs:sequence></xs:complexType></xs:element>`)
      assert.deepStrictEqual(issuesOf(catalog, { n: null }), [])
    })
  )

  it.effect("a complexContent restriction keeps the base's attributes", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`
        <xs:complexType name="Base"><xs:sequence>${str("a", ' minOccurs="0"')}</xs:sequence>
          <xs:attribute name="id" type="xs:string" use="required"/></xs:complexType>
        <xs:element name="op"><xs:complexType><xs:complexContent><xs:restriction base="t:Base">
          <xs:sequence>${str("a")}</xs:sequence></xs:restriction></xs:complexContent></xs:complexType></xs:element>`)
      assert.deepStrictEqual(
        opType(catalog).attributes.map((a) => a.name),
        ["id"]
      )
    })
  )

  it.effect("mixed on complexContent is reported like mixed on complexType", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`
        <xs:complexType name="Base"><xs:sequence>${str("a")}</xs:sequence></xs:complexType>
        <xs:element name="op"><xs:complexType><xs:complexContent mixed="true"><xs:extension base="t:Base"/></xs:complexContent></xs:complexType></xs:element>`)
      assert.isTrue(catalog.openQuestions.some((q) => q.code === "mixed-content"))
    })
  )

  it.effect("xs:redefine is followed or reported, not silently ignored", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(
        `<xs:redefine schemaLocation="base.xsd"/><xs:element name="op" type="t:Holder"/>`,
        {
          "base.xsd": `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t">
            <xs:complexType name="Holder"><xs:sequence><xs:element name="a" type="xs:string"/></xs:sequence></xs:complexType>
          </xs:schema>`
        }
      )
      // Holder exists in base.xsd; the only symptom today is a misleading
      // "type {urn:t}Holder is not defined in any schema that was read".
      assert.isFalse(catalog.openQuestions.some((q) => q.code === "unresolved-type"))
    })
  )

  it.effect("an unresolved simple-type base question carries a document:line", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`
        <xs:simpleType name="S"><xs:restriction base="t:Missing"/></xs:simpleType>
        <xs:element name="op"><xs:complexType><xs:sequence><xs:element name="s" type="t:S"/></xs:sequence></xs:complexType></xs:element>`)
      const question = catalog.openQuestions.find((q) => q.code === "unresolved-type")
      assert.match(question?.location ?? "", /svc\.wsdl:\d+/)
    })
  )
})

describe("Xsd deep review: checked and correct", () => {
  it.effect("unqualified locals, form overrides, and refs keep their wire namespaces", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(
        `<xs:element name="g" type="xs:string"/>
        <xs:element name="op"><xs:complexType><xs:sequence>
          ${str("u")}${str("q", ' form="qualified"')}<xs:element ref="t:g"/>
        </xs:sequence></xs:complexType></xs:element>`,
        {},
        ""
      )
      assert.deepStrictEqual(
        opType(catalog).fields.map((f) => [f.name, f.namespace]),
        [
          ["u", ""],
          ["q", "urn:t"],
          ["g", "urn:t"]
        ]
      )
    })
  )

  it.effect("resolves prefixes in scope, including a redeclared prefix and xsd:", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(
        `<xs:element name="op"><xs:complexType><xs:sequence>
          <xs:element name="a" xmlns:t="urn:other" type="t:X"/>
          <xs:element name="b" xmlns:xsd="http://www.w3.org/2001/XMLSchema" type="xsd:int"/>
        </xs:sequence></xs:complexType></xs:element>`,
        {
          "o.xsd": `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:other"><xs:simpleType name="X"><xs:restriction base="xs:int"/></xs:simpleType></xs:schema>`
        }
      )
      assert.deepStrictEqual(
        opType(catalog).fields.map((f) => f.type),
        ["{urn:other}X", "{http://www.w3.org/2001/XMLSchema}int"]
      )
    })
  )

  it.effect("inherits facets along a restriction chain and ANDs patterns across steps", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`
        <xs:simpleType name="A"><xs:restriction base="xs:string"><xs:maxLength value="4"/><xs:pattern value="[A-Z]+"/></xs:restriction></xs:simpleType>
        <xs:simpleType name="B"><xs:restriction base="t:A"><xs:pattern value="A.*"/></xs:restriction></xs:simpleType>
        <xs:element name="op"><xs:complexType><xs:sequence><xs:element name="v" type="t:B"/></xs:sequence></xs:complexType></xs:element>`)
      assert.deepStrictEqual(issuesOf(catalog, { v: "ABC" }), [])
      assert.isNotEmpty(issuesOf(catalog, { v: "BCD" }))
      assert.isNotEmpty(issuesOf(catalog, { v: "ABCDE" }))
      assert.isNotEmpty(issuesOf(catalog, { v: "Abc" }))
    })
  )

  it.effect("survives extension cycles and recursive types without looping", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`
        <xs:complexType name="A"><xs:complexContent><xs:extension base="t:B"><xs:sequence>${str("a")}</xs:sequence></xs:extension></xs:complexContent></xs:complexType>
        <xs:complexType name="B"><xs:complexContent><xs:extension base="t:A"><xs:sequence>${str("b")}</xs:sequence></xs:extension></xs:complexContent></xs:complexType>
        <xs:complexType name="Node"><xs:sequence><xs:element name="child" type="t:Node" minOccurs="0"/></xs:sequence></xs:complexType>
        <xs:element name="op" type="t:Node"/>`)
      assert.deepStrictEqual(issuesOf(catalog, { child: { child: {} } }), [])
    })
  )

  it.effect("reports dangling type, element, and base references as open questions", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`
        <xs:element name="op"><xs:complexType><xs:complexContent><xs:extension base="t:Nope"><xs:sequence>
          <xs:element name="a" type="t:Gone"/><xs:element ref="t:missing"/><xs:element name="p" type="zz:X"/>
        </xs:sequence></xs:extension></xs:complexContent></xs:complexType></xs:element>`)
      const codes = catalog.openQuestions.map((q) => q.code)
      assert.strictEqual(codes.filter((code) => code === "unresolved-type").length, 3)
      assert.include(codes, "unresolved-element")
    })
  )
})
