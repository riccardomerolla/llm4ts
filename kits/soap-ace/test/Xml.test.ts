import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import type { XmlError } from "../flows/lib/soap/Xml.ts"
import {
  attribute,
  childrenNamed,
  elements,
  parseXml,
  parseXmlBytes,
  renderXml,
  resolveQName,
  textOf
} from "../flows/lib/soap/Xml.ts"

const failure = <A>(effect: Effect.Effect<A, XmlError>): Effect.Effect<XmlError, A> =>
  Effect.flip(effect)

describe("Xml", () => {
  it.effect("resolves default and prefixed namespaces with prefix scoping", () =>
    Effect.gen(function* () {
      const root = yield* parseXml(
        [
          '<?xml version="1.0"?>',
          '<a:root xmlns:a="urn:a" xmlns="urn:default">',
          "  <child id='1'>x</child>",
          '  <b:child xmlns:b="urn:b" b:flag="y"/>',
          '  <inner xmlns="urn:other"><deep/></inner>',
          "</a:root>"
        ].join("\n")
      )
      assert.deepStrictEqual(root.name, { namespace: "urn:a", local: "root" })
      const [first, second, inner] = elements(root)
      assert.deepStrictEqual(first?.name, { namespace: "urn:default", local: "child" })
      assert.strictEqual(first === undefined ? "" : attribute(first, "id"), "1")
      assert.deepStrictEqual(second?.name, { namespace: "urn:b", local: "child" })
      assert.strictEqual(second === undefined ? "" : attribute(second, "flag", "urn:b"), "y")
      assert.deepStrictEqual(inner === undefined ? [] : elements(inner).map((e) => e.name), [
        { namespace: "urn:other", local: "deep" }
      ])
      assert.strictEqual(childrenNamed(root, "urn:default", "child").length, 1)
    })
  )

  it.effect("keeps xmlns declarations out of the attribute list", () =>
    Effect.gen(function* () {
      const root = yield* parseXml('<r xmlns="urn:x" xmlns:p="urn:p" p:a="1" b="2"/>')
      assert.deepStrictEqual(
        root.attributes.map((a) => a.name.local),
        ["a", "b"]
      )
    })
  )

  it.effect("decodes entities, character references, and CDATA; skips comments and PIs", () =>
    Effect.gen(function* () {
      const root = yield* parseXml(
        "<r>a &lt;b&gt; &amp; &quot;&apos; &#65;&#x42;<!-- c --><?pi x?><![CDATA[<raw & text>]]></r>"
      )
      assert.strictEqual(textOf(root), "a <b> & \"' AB<raw & text>")
    })
  )

  it.effect("resolves QName-valued attributes against the element scope", () =>
    Effect.gen(function* () {
      const root = yield* parseXml(
        '<xs:element xmlns:xs="urn:xs" xmlns:tns="urn:t" name="e" type="tns:Conto"/>'
      )
      assert.deepStrictEqual(resolveQName(root, attribute(root, "type") ?? ""), {
        namespace: "urn:t",
        local: "Conto"
      })
      assert.strictEqual(resolveQName(root, "nope:Conto"), undefined)
    })
  )

  it.effect("refuses a document type declaration (XXE and entity expansion)", () =>
    Effect.gen(function* () {
      const error = yield* failure(
        parseXml(
          '<?xml version="1.0"?>\n<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n<r>&x;</r>'
        )
      )
      assert.strictEqual(error.reason, "doctype")
      assert.strictEqual(error.line, 2)
    })
  )

  it.effect("refuses undeclared entities", () =>
    Effect.gen(function* () {
      const error = yield* failure(parseXml("<r>&lol;</r>"))
      assert.strictEqual(error.reason, "syntax")
      assert.include(error.detail, "&lol;")
    })
  )

  it.effect("reports mismatched tags, unbound prefixes, and trailing content", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* failure(parseXml("<a><b></a></b>"))).reason, "syntax")
      assert.strictEqual((yield* failure(parseXml("<p:a/>"))).reason, "namespace")
      assert.strictEqual((yield* failure(parseXml("<a/><b/>"))).reason, "syntax")
      assert.strictEqual((yield* failure(parseXml("<a x='1' x='2'/>"))).reason, "syntax")
    })
  )

  it.effect("enforces the nesting limit", () =>
    Effect.gen(function* () {
      const deep = "<a>".repeat(10) + "</a>".repeat(10)
      const error = yield* failure(parseXml(deep, { limits: { maxDepth: 5, maxChars: 1000 } }))
      assert.strictEqual(error.reason, "limit")
    })
  )

  it.effect("renders a parsed tree back to an equivalent document", () =>
    Effect.gen(function* () {
      const source =
        '<s:E xmlns:s="urn:s"><s:B><r xmlns="urn:r" a="x &amp; &quot;y&quot;">1 &lt; 2<i/></r></s:B></s:E>'
      const once = renderXml(yield* parseXml(source))
      assert.strictEqual(once, source)
      assert.strictEqual(renderXml(yield* parseXml(once)), once)
    })
  )

  it.effect("decodes latin-1 documents by their declaration", () =>
    Effect.gen(function* () {
      const text = '<?xml version="1.0" encoding="ISO-8859-1"?><r>Città più</r>'
      const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0))
      const root = yield* parseXmlBytes(bytes)
      assert.strictEqual(textOf(root), "Città più")
    })
  )

  it.effect("rejects bytes that do not match the declared encoding", () =>
    Effect.gen(function* () {
      const bytes = Uint8Array.from([...Buffer.from("<r>"), 0xe0, ...Buffer.from("</r>")])
      const error = yield* failure(parseXmlBytes(bytes, { source: "bad.xml" }))
      assert.strictEqual(error.reason, "encoding")
      assert.strictEqual(error.source, "bad.xml")
    })
  )

  it.effect("rejects unsupported encodings", () =>
    Effect.gen(function* () {
      const bytes = Buffer.from('<?xml version="1.0" encoding="EBCDIC-CP-IT"?><r/>')
      assert.strictEqual((yield* failure(parseXmlBytes(bytes))).reason, "encoding")
    })
  )
})
