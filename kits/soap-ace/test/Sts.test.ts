import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import { decodeAuthProfile, type SecretSource } from "../flows/lib/soap/Auth.ts"
import { securityHeader } from "../flows/lib/soap/Envelope.ts"
import {
  extractElementRaw,
  fetchSamlToken,
  fillStsTemplate,
  makeTokenSource,
  notOnOrAfterOf,
  renderDefaultStsTemplate,
  stsTemplatePath,
  templatePlaceholders
} from "../flows/lib/soap/Sts.ts"
import { makeFakeSoapTransport, xmlResponse } from "../flows/lib/soap/Transport.ts"
import { parseXml } from "../flows/lib/soap/Xml.ts"

const secrets: SecretSource = {
  environment: { STS_USER: "svc-sts", STS_PASS: "p<ss&word" },
  readFile: () => Effect.die("no files")
}

const service = "DemoBankService"

const profile = decodeAuthProfile(
  JSON.stringify({
    environment: "test",
    endpoint: "https://esb.bank.local/soap/DemoBank",
    sts: {
      endpoint: "https://sts.bank.local/trust",
      auth: { user: "env:STS_USER", password: "env:STS_PASS" },
      appliesTo: "https://esb.bank.local/soap/DemoBank",
      renewBeforeSeconds: 30
    }
  })
)

// A signed-looking assertion with odd whitespace and a comment: carried as is.
const assertion = [
  '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" Version="2.0"',
  '    IssueInstant="2026-10-03T10:00:00Z">',
  "  <saml2:Issuer>sts.bank.local</saml2:Issuer><!-- keep me -->",
  '  <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignatureValue>AbC=</ds:SignatureValue></ds:Signature>',
  '  <saml2:Conditions NotBefore="2026-10-03T10:00:00Z" NotOnOrAfter="2026-10-03T10:10:00Z"/>',
  "</saml2:Assertion>"
].join("\n")

const rstr = (body: string) =>
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><wst:RequestSecurityTokenResponseCollection xmlns:wst="http://docs.oasis-open.org/ws-sx/ws-trust/200512"><wst:RequestSecurityTokenResponse><wst:RequestedSecurityToken>${body}</wst:RequestedSecurityToken></wst:RequestSecurityTokenResponse></wst:RequestSecurityTokenResponseCollection></s:Body></s:Envelope>`

const fault = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>bad credentials</faultstring></s:Fault></s:Body></s:Envelope>`

describe("the STS template", () => {
  it("fills every placeholder, escaped, and leaves unknown ones alone", () => {
    const template = renderDefaultStsTemplate("1.1")
    assert.deepStrictEqual(templatePlaceholders(template), [
      "appliesTo",
      "created",
      "expires",
      "nonce",
      "password",
      "username"
    ])
    const filled = Redacted.value(
      fillStsTemplate(`${template}{{other}}`, {
        username: "svc",
        password: Redacted.make("p<ss&word"),
        created: "2026-10-03T10:00:00.000Z",
        expires: "2026-10-03T10:05:00.000Z",
        nonce: "bm9uY2U=",
        appliesTo: "https://esb.bank.local/soap?x=1&y=2"
      })
    )
    assert.include(filled, "<wsse:Username>svc</wsse:Username>")
    assert.include(filled, "p&lt;ss&amp;word</wsse:Password>")
    assert.include(filled, "https://esb.bank.local/soap?x=1&amp;y=2")
    assert.include(filled, "{{other}}")
    assert.notInclude(filled, "{{username}}")
  })
})

describe("the token in the response", () => {
  it.effect(
    "is carried as the raw bytes of its element, whitespace, comment and signature intact",
    () =>
      Effect.gen(function* () {
        const text = rstr(assertion)
        const root = yield* parseXml(text)
        assert.strictEqual(extractElementRaw(text, root, "Assertion"), assertion)
        assert.isUndefined(extractElementRaw(text, root, "Nope"))
        assert.strictEqual(
          notOnOrAfterOf(root, "Assertion")?.toISOString(),
          "2026-10-03T10:10:00.000Z"
        )
      })
  )
})

const setup = (responses: ReadonlyArray<ReturnType<typeof xmlResponse>>) =>
  Effect.gen(function* () {
    const workspace = yield* makeMemoryWorkspace()
    const decoded = yield* profile
    const config = decoded.sts!
    let index = 0
    const fake = yield* makeFakeSoapTransport(() =>
      Effect.succeed(responses[Math.min(index++, responses.length - 1)]!)
    )
    return { workspace, config, fake }
  })

describe("fetchSamlToken", () => {
  it.effect(
    "posts the filled template with the sts side and returns the assertion and its expiry",
    () =>
      Effect.gen(function* () {
        const { workspace, config, fake } = yield* setup([xmlResponse(rstr(assertion))])
        yield* workspace.write(stsTemplatePath(service, config), renderDefaultStsTemplate("1.1"))
        const token = yield* fetchSamlToken({
          workspace,
          service,
          config,
          secrets,
          transport: fake.transport,
          now: () => new Date("2026-10-03T10:00:00Z"),
          random: (size) => new Uint8Array(size).fill(2)
        })
        assert.strictEqual(Redacted.value(token.token), assertion)
        assert.strictEqual(token.notOnOrAfter?.toISOString(), "2026-10-03T10:10:00.000Z")
        const [sent] = yield* fake.requests
        assert.strictEqual(sent?.url, "https://sts.bank.local/trust")
        assert.strictEqual(
          sent?.headers["soapaction"],
          '"http://docs.oasis-open.org/ws-sx/ws-trust/200512/RST/Issue"'
        )
        const wire = Redacted.value(sent?.body ?? Redacted.make(""))
        assert.include(wire, "<wsse:Username>svc-sts</wsse:Username>")
        assert.include(wire, "p&lt;ss&amp;word")
        assert.include(wire, "<wsu:Created>2026-10-03T10:00:00.000Z</wsu:Created>")
        assert.include(wire, "<wsa:Address>https://esb.bank.local/soap/DemoBank</wsa:Address>")
      })
  )

  it.effect(
    "fails typed without a template, on a fault, on a non-2xx, and when the element is missing",
    () =>
      Effect.gen(function* () {
        const base = { service, secrets, now: () => new Date("2026-10-03T10:00:00Z") }
        const missing = yield* setup([xmlResponse(rstr(assertion))])
        const noTemplate = yield* Effect.flip(
          fetchSamlToken({
            ...base,
            workspace: missing.workspace,
            config: missing.config,
            transport: missing.fake.transport
          })
        )
        assert.strictEqual(noTemplate._tag, "StsError")
        assert.include(noTemplate.message, "sts init")

        const faulted = yield* setup([xmlResponse(fault, 500)])
        yield* faulted.workspace.write(
          stsTemplatePath(service, faulted.config),
          renderDefaultStsTemplate()
        )
        const faultError = yield* Effect.flip(
          fetchSamlToken({
            ...base,
            workspace: faulted.workspace,
            config: faulted.config,
            transport: faulted.fake.transport
          })
        )
        assert.include(faultError.message, "fault s:Client: bad credentials")

        const denied = yield* setup([xmlResponse(rstr(""), 401)])
        yield* denied.workspace.write(
          stsTemplatePath(service, denied.config),
          renderDefaultStsTemplate()
        )
        const deniedError = yield* Effect.flip(
          fetchSamlToken({
            ...base,
            workspace: denied.workspace,
            config: denied.config,
            transport: denied.fake.transport
          })
        )
        assert.include(deniedError.message, "HTTP 401")

        const empty = yield* setup([xmlResponse(rstr("<x/>"))])
        yield* empty.workspace.write(
          stsTemplatePath(service, empty.config),
          renderDefaultStsTemplate()
        )
        const emptyError = yield* Effect.flip(
          fetchSamlToken({
            ...base,
            workspace: empty.workspace,
            config: empty.config,
            transport: empty.fake.transport
          })
        )
        assert.include(emptyError.message, "no Assertion element")
        assert.include(emptyError.message, "sts.token.element")
      })
  )
})

describe("makeTokenSource", () => {
  it.effect("fetches once, reuses while fresh, and renews before NotOnOrAfter", () =>
    Effect.gen(function* () {
      let clock = new Date("2026-10-03T10:00:00Z")
      const { workspace, config, fake } = yield* setup([xmlResponse(rstr(assertion))])
      yield* workspace.write(stsTemplatePath(service, config), renderDefaultStsTemplate())
      const source = yield* makeTokenSource({
        workspace,
        service,
        config,
        secrets,
        transport: fake.transport,
        now: () => clock
      })
      yield* source.current
      yield* source.current
      assert.strictEqual(yield* source.fetches, 1)
      // 30 s before 10:10 the token is stale: renewed.
      clock = new Date("2026-10-03T10:09:31Z")
      yield* source.current
      assert.strictEqual(yield* source.fetches, 2)
    })
  )
})

describe("securityHeader", () => {
  it("orders Timestamp, UsernameToken, then the token, and is absent with no parts", () => {
    const material = { nonce: new Uint8Array(16).fill(1), created: "2026-10-03T10:00:00.000Z" }
    const header = Redacted.value(
      securityHeader({
        timestamp: { created: material.created },
        usernameToken: { user: "u", password: Redacted.make("p"), passwordType: "text" },
        token: Redacted.make(assertion),
        material
      }) ?? Redacted.make("")
    )
    const timestamp = header.indexOf("<wsu:Timestamp")
    const username = header.indexOf("<wsse:UsernameToken")
    const token = header.indexOf("<saml2:Assertion")
    assert.isTrue(timestamp > 0 && username > timestamp && token > username)
    assert.include(header, "<wsu:Expires>2026-10-03T10:05:00.000Z</wsu:Expires>")
    assert.isTrue(header.endsWith("</wsse:Security>"))
    assert.isUndefined(securityHeader({ material }))
  })
})
