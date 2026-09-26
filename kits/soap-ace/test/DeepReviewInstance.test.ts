import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  elementByName,
  operationByName,
  type ElementDecl,
  type WsdlCatalog
} from "../flows/lib/soap/Catalog.ts"
import {
  instanceFromXml,
  instanceToXml,
  skeletonYaml,
  validateInstance
} from "../flows/lib/soap/Instance.ts"
import { DocumentLoader, makeMemoryDocumentLoader, readCatalog } from "../flows/lib/soap/Wsdl.ts"
import { parseXml } from "../flows/lib/soap/Xml.ts"
import { parseYaml, type YamlValue } from "../flows/lib/soap/Yaml.ts"

// Deep review of Instance.ts: each test states the XSD-correct behaviour.
// Tests marked "(control)" pinned behaviour that was already correct.

const wsdlWith = (schema: string) =>
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
      </definitions>`
    })
  )

const opElement = (catalog: WsdlCatalog): ElementDecl =>
  elementByName(catalog, operationByName(catalog, "op")?.input ?? "") ??
  assert.fail("no op element")

const issuesOf = (catalog: WsdlCatalog, value: YamlValue) =>
  validateInstance(catalog, opElement(catalog), value).map(
    (issue) => `${issue.path}: ${issue.detail}`
  )

/** An `op` element with one child `v` of the given simple type (inline restriction or builtin). */
const simpleField = (typeXml: string) =>
  wsdlWith(
    `<xs:simpleType name="T">${typeXml}</xs:simpleType>
     <xs:element name="op"><xs:complexType><xs:sequence>
       <xs:element name="v" type="t:T"/>
     </xs:sequence></xs:complexType></xs:element>`
  )

const builtinField = (builtin: string) =>
  wsdlWith(
    `<xs:element name="op"><xs:complexType><xs:sequence>
       <xs:element name="v" type="xs:${builtin}"/>
     </xs:sequence></xs:complexType></xs:element>`
  )

describe("builtin value spaces", () => {
  it.effect("rejects integers outside the range of int/byte/unsigned/positive types", () =>
    Effect.gen(function* () {
      const accepted: Array<string> = []
      for (const [builtin, value] of [
        ["int", "2147483648"],
        ["long", "9223372036854775808"],
        ["short", "40000"],
        ["byte", "300"],
        ["unsignedInt", "-1"],
        ["nonNegativeInteger", "-5"],
        ["positiveInteger", "0"],
        ["negativeInteger", "0"]
      ] as const) {
        const catalog = yield* builtinField(builtin)
        if (issuesOf(catalog, { v: value }).length === 0) accepted.push(`${builtin} ${value}`)
      }
      assert.deepStrictEqual(accepted, [])
    })
  )

  it.effect("rejects impossible calendar dates and times", () =>
    Effect.gen(function* () {
      const date = yield* builtinField("date")
      const dateTime = yield* builtinField("dateTime")
      const accepted = [
        ...["2026-02-30", "2026-13-01", "2026-00-10"].filter(
          (v) => issuesOf(date, { v }).length === 0
        ),
        ...["2026-01-15T25:61:00Z"].filter((v) => issuesOf(dateTime, { v }).length === 0)
      ]
      assert.deepStrictEqual(accepted, [])
    })
  )

  it.effect("checks the lexical form of duration and the g* date types", () =>
    Effect.gen(function* () {
      const accepted: Array<string> = []
      for (const [builtin, value] of [
        ["duration", "three days"],
        ["gYearMonth", "not-a-month"],
        ["gMonth", "13"]
      ] as const) {
        const catalog = yield* builtinField(builtin)
        if (issuesOf(catalog, { v: value }).length === 0) accepted.push(`${builtin} ${value}`)
      }
      assert.deepStrictEqual(accepted, [])
    })
  )

  it.effect("rejects base64 that is not a whole number of quanta", () =>
    Effect.gen(function* () {
      const catalog = yield* builtinField("base64Binary")
      assert.isNotEmpty(issuesOf(catalog, { v: "abc" }))
    })
  )

  it.effect("accepts the correct built-in forms (control)", () =>
    Effect.gen(function* () {
      for (const [builtin, value] of [
        ["decimal", "+1.50"],
        ["decimal", "-0"],
        ["decimal", ".5"],
        ["boolean", "1"],
        ["date", "2026-02-28Z"],
        ["dateTime", "2026-01-15T10:00:00.123+01:00"],
        ["time", "23:59:59"],
        ["hexBinary", "0AFF"],
        ["int", "+42"]
      ] as const) {
        const catalog = yield* builtinField(builtin)
        assert.deepStrictEqual(issuesOf(catalog, { v: value }), [], `${builtin} ${value}`)
      }
      const decimal = yield* builtinField("decimal")
      assert.isNotEmpty(issuesOf(decimal, { v: "1e3" }))
    })
  )
})

describe("facets", () => {
  it.effect("a pattern with the XSD escape \\- still constrains the value", () =>
    Effect.gen(function* () {
      const catalog = yield* simpleField(
        `<xs:restriction base="xs:string"><xs:pattern value="[0-9]{3}\\-[0-9]{4}"/></xs:restriction>`
      )
      assert.deepStrictEqual(issuesOf(catalog, { v: "123-4567" }), [])
      assert.isNotEmpty(issuesOf(catalog, { v: "anything at all" }))
    })
  )

  it.effect("a pattern with an XSD block escape (\\p{IsBasicLatin}) still constrains", () =>
    Effect.gen(function* () {
      const catalog = yield* simpleField(
        `<xs:restriction base="xs:string"><xs:pattern value="\\p{IsBasicLatin}+"/></xs:restriction>`
      )
      assert.isNotEmpty(issuesOf(catalog, { v: "città" }))
    })
  )

  it.effect("totalDigits counts 0.1234 as four digits, not five", () =>
    Effect.gen(function* () {
      const catalog = yield* simpleField(
        `<xs:restriction base="xs:decimal"><xs:totalDigits value="4"/><xs:fractionDigits value="4"/></xs:restriction>`
      )
      assert.deepStrictEqual(issuesOf(catalog, { v: "0.1234" }), [])
    })
  )

  it.effect("totalDigits/fractionDigits ignore trailing zeros (control)", () =>
    Effect.gen(function* () {
      const catalog = yield* simpleField(
        `<xs:restriction base="xs:decimal"><xs:totalDigits value="3"/><xs:fractionDigits value="1"/></xs:restriction>`
      )
      assert.deepStrictEqual(issuesOf(catalog, { v: "12.500" }), [])
      assert.isNotEmpty(issuesOf(catalog, { v: "12.55" }))
    })
  )

  it.effect("range facets apply to a double written with an exponent", () =>
    Effect.gen(function* () {
      const catalog = yield* simpleField(
        `<xs:restriction base="xs:double"><xs:maxInclusive value="100"/></xs:restriction>`
      )
      assert.isNotEmpty(issuesOf(catalog, { v: "1e3" }))
    })
  )

  it.effect("range facets on long compare exactly beyond 2^53", () =>
    Effect.gen(function* () {
      const catalog = yield* simpleField(
        `<xs:restriction base="xs:long"><xs:maxInclusive value="9007199254740992"/></xs:restriction>`
      )
      assert.isNotEmpty(issuesOf(catalog, { v: "9007199254740993" }))
    })
  )

  it.effect("length on hexBinary counts octets, not characters", () =>
    Effect.gen(function* () {
      const catalog = yield* simpleField(
        `<xs:restriction base="xs:hexBinary"><xs:length value="4"/></xs:restriction>`
      )
      assert.deepStrictEqual(issuesOf(catalog, { v: "DEADBEEF" }), [])
    })
  )

  it.effect("length counts code points, not UTF-16 units (control)", () =>
    Effect.gen(function* () {
      const catalog = yield* simpleField(
        `<xs:restriction base="xs:string"><xs:length value="2"/></xs:restriction>`
      )
      assert.deepStrictEqual(issuesOf(catalog, { v: "a😀" }), [])
    })
  )
})

describe("content models", () => {
  it.effect("a repeating choice accepts a mix of its alternatives", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(
        `<xs:element name="op"><xs:complexType><xs:choice maxOccurs="unbounded">
           <xs:element name="a" type="xs:string"/><xs:element name="b" type="xs:string"/>
         </xs:choice></xs:complexType></xs:element>`
      )
      assert.deepStrictEqual(issuesOf(catalog, { a: ["1", "2"], b: "3" }), [])
    })
  )

  it.effect("a choice with an emptiable branch is not required", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(
        `<xs:element name="op"><xs:complexType><xs:choice>
           <xs:element name="a" type="xs:string" minOccurs="0"/><xs:element name="b" type="xs:string"/>
         </xs:choice></xs:complexType></xs:element>`
      )
      assert.deepStrictEqual(issuesOf(catalog, {}), [])
    })
  )

  it.effect("a nested choice is one alternative of its outer choice", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(
        `<xs:element name="op"><xs:complexType><xs:choice>
           <xs:element name="a" type="xs:string"/>
           <xs:choice><xs:element name="b" type="xs:string"/><xs:element name="c" type="xs:string"/></xs:choice>
         </xs:choice></xs:complexType></xs:element>`
      )
      // Choosing b alone is valid; a together with b is not.
      assert.deepStrictEqual(issuesOf(catalog, { b: "1" }), [])
      assert.isNotEmpty(issuesOf(catalog, { a: "1", b: "2" }))
    })
  )

  it.effect("a repeating sequence is written as interleaved groups, not per field", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(
        `<xs:element name="op"><xs:complexType><xs:sequence maxOccurs="unbounded">
           <xs:element name="k" type="xs:string"/><xs:element name="v" type="xs:string"/>
         </xs:sequence></xs:complexType></xs:element>`
      )
      const value = { k: ["k1", "k2"], v: ["v1", "v2"] }
      assert.deepStrictEqual(issuesOf(catalog, value), [])
      // The wire must be k1 v1 k2 v2; k k v v violates the schema.
      assert.include(
        instanceToXml(catalog, opElement(catalog), value),
        "<ns1:k>k1</ns1:k><ns1:v>v1</ns1:v><ns1:k>k2</ns1:k>"
      )
    })
  )

  it.effect("a repeating sequence rejects unbalanced counts", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(
        `<xs:element name="op"><xs:complexType><xs:sequence maxOccurs="unbounded">
           <xs:element name="k" type="xs:string"/><xs:element name="v" type="xs:string"/>
         </xs:sequence></xs:complexType></xs:element>`
      )
      assert.isNotEmpty(issuesOf(catalog, { k: ["k1", "k2"], v: "v1" }))
    })
  )

  it.effect("reading XML reports children out of sequence order", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(
        `<xs:element name="op"><xs:complexType><xs:sequence>
           <xs:element name="a" type="xs:string"/><xs:element name="b" type="xs:string"/>
         </xs:sequence></xs:complexType></xs:element>`
      )
      const xml = yield* parseXml(`<t:op xmlns:t="urn:t"><t:b>2</t:b><t:a>1</t:a></t:op>`)
      assert.isNotEmpty(instanceFromXml(catalog, opElement(catalog), xml).issues)
    })
  )

  it.effect("reading XML reports child elements inside a simple-typed element", () =>
    Effect.gen(function* () {
      const catalog = yield* builtinField("string")
      const xml = yield* parseXml(`<t:op xmlns:t="urn:t"><t:v>x<t:bogus>y</t:bogus></t:v></t:op>`)
      assert.isNotEmpty(instanceFromXml(catalog, opElement(catalog), xml).issues)
    })
  )

  it.effect("missing required, extra field and a list for a singleton are reported (control)", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(
        `<xs:element name="op"><xs:complexType><xs:sequence>
           <xs:element name="a" type="xs:string"/><xs:element name="b" type="xs:string" maxOccurs="2"/>
         </xs:sequence></xs:complexType></xs:element>`
      )
      assert.deepStrictEqual(issuesOf(catalog, { b: ["1", "2", "3"], a: ["x"], z: "1" }), [
        "z: not a field of op",
        "a: occurs at most once; write a single value",
        "b: at most 2 occurrences"
      ])
      assert.deepStrictEqual(issuesOf(catalog, { b: "1" }), ["a: required field is missing"])
    })
  )
})

describe("simple-typed root element", () => {
  it.effect("the skeleton of a simple-typed element is a valid instance", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(`<xs:element name="op" type="xs:string"/>`)
      const element = opElement(catalog)
      const value = yield* parseYaml(skeletonYaml(catalog, element, 0).join("\n"))
      assert.deepStrictEqual(validateInstance(catalog, element, value), [])
      assert.notStrictEqual(
        instanceToXml(catalog, element, value),
        `<ns1:op xmlns:ns1="urn:t"></ns1:op>`
      )
    })
  )
})

describe("responses with whitespace", () => {
  it.effect("a pretty-printed numeric value is valid (whiteSpace collapse)", () =>
    Effect.gen(function* () {
      const catalog = yield* builtinField("decimal")
      const xml = yield* parseXml(`<t:op xmlns:t="urn:t"><t:v>\n  100.00\n</t:v></t:op>`)
      assert.deepStrictEqual(instanceFromXml(catalog, opElement(catalog), xml).issues, [])
    })
  )

  it.effect("a token enumeration matches after whitespace collapse", () =>
    Effect.gen(function* () {
      const catalog = yield* simpleField(
        `<xs:restriction base="xs:token"><xs:enumeration value="ATTIVO"/></xs:restriction>`
      )
      assert.deepStrictEqual(issuesOf(catalog, { v: " ATTIVO " }), [])
    })
  )
})

describe("attributes", () => {
  it.effect("a namespaced attribute ref is written with a declared prefix", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(
        `<xs:attribute name="code" type="xs:string"/>
         <xs:element name="op"><xs:complexType><xs:sequence>
           <xs:element name="v" type="xs:string"/>
         </xs:sequence><xs:attribute ref="t:code" use="required"/></xs:complexType></xs:element>`
      )
      const element = opElement(catalog)
      const value = yield* parseYaml(skeletonYaml(catalog, element, 0).join("\n"))
      const xml = instanceToXml(catalog, element, value)
      // Reparse and read back: must parse, and the attribute must be recognised.
      const parsed = yield* parseXml(xml)
      assert.deepStrictEqual(instanceFromXml(catalog, element, parsed).issues, [])
    })
  )
})

describe("XML escaping and round trips", () => {
  it.effect("a carriage return in a value survives YAML → XML → YAML", () =>
    Effect.gen(function* () {
      const catalog = yield* builtinField("string")
      const element = opElement(catalog)
      const value = { v: "line1\r\nline2" }
      const xml = yield* parseXml(instanceToXml(catalog, element, value))
      assert.deepStrictEqual(instanceFromXml(catalog, element, xml).value, value)
    })
  )

  it.effect("escapes markup and round-trips namespaces, nil and repeats (control)", () =>
    Effect.gen(function* () {
      const catalog = yield* wsdlWith(
        `<xs:element name="op"><xs:complexType><xs:sequence>
           <xs:element name="v" type="xs:string"/>
           <xs:element name="n" type="xs:string" nillable="true"/>
           <xs:element name="r" type="xs:string" maxOccurs="unbounded" form="unqualified"/>
         </xs:sequence><xs:attribute name="id" type="xs:string"/></xs:complexType></xs:element>`
      )
      const element = opElement(catalog)
      const value = { "@id": `a"<&>'`, v: "]]> & <x/>", n: null, r: ["1", "2"] }
      const xml = yield* parseXml(instanceToXml(catalog, element, value))
      const read = instanceFromXml(catalog, element, xml)
      assert.deepStrictEqual(read.issues, [])
      assert.deepStrictEqual(read.value, value)
    })
  )
})
