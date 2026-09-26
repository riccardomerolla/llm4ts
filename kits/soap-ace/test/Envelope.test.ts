import { createHash } from "node:crypto"
import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import {
  buildEnvelope,
  passwordDigest,
  readEnvelope,
  safeHeaders,
  soapHeaders,
  stripSecurity,
  usernameTokenHeader
} from "../flows/lib/soap/Envelope.ts"
import { parseXml, renderXml } from "../flows/lib/soap/Xml.ts"

const material = {
  nonce: Uint8Array.from({ length: 16 }, (_, index) => index),
  created: "2026-09-25T10:00:00.000Z"
}

describe("envelopes", () => {
  it("sets version-specific HTTP headers", () => {
    assert.deepStrictEqual(soapHeaders("1.1", "urn:a"), {
      "content-type": "text/xml; charset=utf-8",
      soapaction: '"urn:a"'
    })
    assert.strictEqual(
      soapHeaders("1.2", "urn:a")["content-type"],
      'application/soap+xml; charset=utf-8; action="urn:a"'
    )
  })

  it.effect("wraps a body and a UsernameToken digest header into a parseable envelope", () =>
    Effect.gen(function* () {
      const header = usernameTokenHeader(
        { user: "svc", password: Redacted.make("pw"), passwordType: "digest" },
        material
      )
      const envelope = buildEnvelope("1.1", '<b:ping xmlns:b="urn:b"/>', header)
      assert.notInclude(String(envelope), "svc")
      const xml = Redacted.value(envelope)
      const expected = createHash("sha1")
        .update(Buffer.concat([Buffer.from(material.nonce), Buffer.from(material.created + "pw")]))
        .digest("base64")
      assert.strictEqual(passwordDigest(material, "pw"), expected)
      assert.include(xml, `>${expected}</wsse:Password>`)
      assert.include(xml, "#PasswordDigest")
      assert.notInclude(xml, ">pw<")

      const parsed = yield* parseXml(xml)
      const read = yield* readEnvelope(parsed)
      assert.strictEqual(read.payload?.name.local, "ping")
      const stripped = renderXml(stripSecurity(parsed))
      assert.notInclude(stripped, "UsernameToken")
      assert.include(stripped, "ping")
    })
  )

  it.effect("reads SOAP 1.1 and 1.2 faults", () =>
    Effect.gen(function* () {
      const fault11 = yield* readEnvelope(
        yield* parseXml(
          `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>
            <faultcode>s:Server</faultcode><faultstring>Conto inesistente</faultstring>
            <detail><c:ServizioFault xmlns:c="urn:c"><c:codice>KO12</c:codice></c:ServizioFault></detail>
          </s:Fault></s:Body></s:Envelope>`
        )
      )
      assert.deepStrictEqual(
        [fault11.fault?.code, fault11.fault?.reason, fault11.fault?.detailElement],
        ["s:Server", "Conto inesistente", "ServizioFault"]
      )
      const fault12 = yield* readEnvelope(
        yield* parseXml(
          `<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"><e:Body><e:Fault>
            <e:Code><e:Value>e:Receiver</e:Value></e:Code><e:Reason><e:Text xml:lang="it">Timeout</e:Text></e:Reason>
          </e:Fault></e:Body></e:Envelope>`
        )
      )
      assert.strictEqual(fault12.version, "1.2")
      assert.deepStrictEqual(
        [fault12.fault?.code, fault12.fault?.reason],
        ["e:Receiver", "Timeout"]
      )
    })
  )

  it.effect("refuses non-envelopes", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(readEnvelope(yield* parseXml("<html/>")))
      assert.include(error.message, "not a SOAP Envelope")
    })
  )

  it("drops credential-bearing headers before persistence", () => {
    assert.deepStrictEqual(
      safeHeaders({
        "Content-Type": "text/xml",
        Authorization: "Basic x",
        "Set-Cookie": "JSESSIONID=1",
        "X-Auth-Token": "t",
        "X-Request-Id": "42"
      }),
      { "content-type": "text/xml", "x-request-id": "42" }
    )
  })
})
