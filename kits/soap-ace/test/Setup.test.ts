import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { makeMemoryWorkspace } from "@llm4ts/flow/Workspace"
import {
  bypassesProxy,
  decodeAuthProfile,
  resolveSide,
  resolveTls,
  type SecretSource
} from "../flows/lib/soap/Auth.ts"
import { loadAuthProfile, profilePath, servicePaths } from "../flows/lib/soap/Discover.ts"
import {
  checkReport,
  describeChain,
  initStsTemplate,
  profileWithPinnedCa,
  trustSide
} from "../flows/lib/soap/Setup.ts"
import { renderDefaultStsTemplate } from "../flows/lib/soap/Sts.ts"
import {
  caListFor,
  makeFakeSoapTransport,
  proxyFor,
  xmlResponse,
  type PeerChain
} from "../flows/lib/soap/Transport.ts"

const service = "DemoBankService"
const pem = (name: string) =>
  `-----BEGIN CERTIFICATE-----\n${Buffer.from(name).toString("base64")}\n-----END CERTIFICATE-----\n`

const secrets: SecretSource = {
  environment: { PX_PASS: "proxy-secret", CA_PEM: pem("ca") },
  readFile: (path) =>
    path === "/secure/ca.pem"
      ? Effect.succeed(new TextEncoder().encode(pem("file-ca")))
      : path.startsWith(".llm4ts/")
        ? // A pinned chain, read back by the next resolution.
          Effect.succeed(new TextEncoder().encode(pem("pinned")))
        : Effect.die(`no file ${path}`),
  readPemDirectory: (path) =>
    path === "/secure/cas"
      ? Effect.succeed(new TextEncoder().encode(`${pem("dir-a")}${pem("dir-b")}`))
      : Effect.die(`no dir ${path}`)
}

const text = JSON.stringify({
  environment: "uat",
  endpoint: "https://esb.bank.local/soap/DemoBank",
  call: {
    proxy: {
      url: "http://proxy.bank:3128",
      noProxy: ["*.bank.local"],
      auth: { scheme: "basic", user: "px", password: "env:PX_PASS" }
    },
    tls: { ca: "file:/secure/ca.pem", caDir: "/secure/cas", servername: "esb.bank.local" }
  },
  sts: {
    endpoint: "https://sts.bank.local/trust",
    auth: { user: "svc", password: "env:STS_PASS" },
    proxy: { url: "http://proxy.bank:3128" }
  }
})

describe("profile: proxies and trust", () => {
  it.effect("decodes proxies and CA options, resolves them, and merges CA material", () =>
    Effect.gen(function* () {
      const profile = yield* decodeAuthProfile(text)
      const side = yield* resolveSide(secrets, profile.call)
      assert.strictEqual(side.proxy?.url, "http://proxy.bank:3128")
      assert.deepStrictEqual(side.proxy?.noProxy, ["*.bank.local"])
      assert.isDefined(side.proxy?.authorization)
      assert.strictEqual(side.tls?.servername, "esb.bank.local")
      const ca = new TextDecoder().decode(
        side.tls?.ca === undefined ? new Uint8Array() : Redacted.value(side.tls.ca)
      )
      assert.include(ca, Buffer.from("file-ca").toString("base64"))
      assert.include(ca, Buffer.from("dir-b").toString("base64"))
      // system+ca by default: the list starts with Node's roots and ends with ours.
      const list = caListFor(side.tls)
      assert.isTrue((list?.length ?? 0) > 1)
      assert.include(list?.at(-1) ?? "", Buffer.from("file-ca").toString("base64"))
      const only = yield* resolveTls(secrets, { ...profile.call!.tls!, trust: "ca-only" })
      assert.strictEqual(caListFor(only)?.length, 1)
    })
  )

  it("tells apart hosts that bypass the proxy", () => {
    assert.isTrue(bypassesProxy("esb.bank.local", ["*.bank.local"]))
    assert.isTrue(bypassesProxy("ESB.bank.LOCAL", [".bank.local"]))
    assert.isFalse(bypassesProxy("bank.local", ["*.bank.local"]))
    assert.isTrue(bypassesProxy("sts.other", ["sts.other"]))
    assert.isFalse(bypassesProxy("sts.other", ["other"]))
    const proxy = { url: "http://p:1", noProxy: ["*.bank.local"] }
    assert.isUndefined(proxyFor(new URL("https://esb.bank.local/x"), proxy))
    assert.strictEqual(proxyFor(new URL("https://sts.vendor/x"), proxy)?.url, "http://p:1")
  })

  it.effect("rejects a proxy URL with credentials or a path", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decodeAuthProfile(
          JSON.stringify({ environment: "dev", call: { proxy: { url: "http://u:p@proxy:3128" } } })
        )
      )
      assert.strictEqual(error._tag, "AuthProfileError")
      assert.include(error.message, "call.proxy.url")
      assert.notInclude(error.message, "u:p@")
    })
  )

  it.effect("selects auth.<env>.json and refuses a named environment without a file", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      yield* workspace.write(profilePath(service, undefined), '{"environment":"dev"}')
      yield* workspace.write(profilePath(service, "uat"), text)
      assert.strictEqual((yield* loadAuthProfile(workspace, service))?.environment, "dev")
      assert.strictEqual((yield* loadAuthProfile(workspace, service, "uat"))?.environment, "uat")
      const missing = yield* Effect.flip(loadAuthProfile(workspace, service, "prod"))
      assert.include(missing.message, "auth.prod.json")
      assert.include(missing.message, "no profile for environment 'prod'")
    })
  )
})

describe("check", () => {
  it.effect("reads the profile back as decisions and names ignored proxy variables", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      const profile = yield* decodeAuthProfile(text)
      yield* workspace.write(`${servicePaths(service).trustDir}/esb.bank.local.pem`, pem("x"))
      const lines = yield* checkReport({
        workspace,
        service,
        env: "uat",
        profile,
        environment: { HTTPS_PROXY: "http://corp:8080", NO_PROXY: "" }
      })
      const joined = lines.join("\n")
      assert.include(joined, "profile: .llm4ts/soap/DemoBankService/auth.uat.json")
      assert.include(
        joined,
        "call: no auth; via http://proxy.bank:3128, direct for *.bank.local, with proxy credentials; tls system roots + profile CA, ca file:/secure/ca.pem, caDir /secure/cas, servername esb.bank.local"
      )
      assert.include(joined, "fetch: no auth; direct (no proxy); tls system roots")
      assert.include(joined, "sts: https://sts.bank.local/trust; via http://proxy.bank:3128")
      assert.include(joined, "template .llm4ts/soap/DemoBankService/sts.request.xml missing")
      assert.include(joined, "trusted chains: esb.bank.local.pem")
      assert.include(joined, "ignored: HTTPS_PROXY are set")
      const none = yield* checkReport({
        workspace,
        service,
        env: undefined,
        profile: undefined,
        environment: {}
      })
      assert.include(none[0] ?? "", "auth.json (missing)")
    })
  )
})

const chain = (trusted: boolean, fingerprint = "AA:BB"): PeerChain => ({
  host: "esb.bank.local",
  certificates: [
    {
      subject: "CN=esb.bank.local, O=Bank",
      issuer: "CN=Bank Root CA",
      validFrom: "Jan 1 00:00:00 2026 GMT",
      validTo: "Jan 1 00:00:00 2027 GMT",
      fingerprint256: fingerprint,
      pem: pem(`leaf-${fingerprint}`)
    },
    {
      subject: "CN=Bank Root CA",
      issuer: "CN=Bank Root CA",
      validFrom: "Jan 1 00:00:00 2020 GMT",
      validTo: "Jan 1 00:00:00 2040 GMT",
      fingerprint256: "CC:DD",
      pem: pem("root")
    }
  ],
  trustedBySystem: trusted,
  authorizationError: trusted ? undefined : "SELF_SIGNED_CERT_IN_CHAIN"
})

describe("trust", () => {
  it.effect(
    "shows the chain, pins it on a yes, and sets the side's tls.ca in the selected profile",
    () =>
      Effect.gen(function* () {
        const workspace = yield* makeMemoryWorkspace()
        yield* workspace.write(profilePath(service, "uat"), text)
        const profile = yield* decodeAuthProfile(text)
        const fake = yield* makeFakeSoapTransport(
          () => Effect.succeed(xmlResponse("")),
          () => Effect.succeed(chain(false))
        )
        const shown: Array<ReadonlyArray<string>> = []
        const outcome = yield* trustSide({
          workspace,
          service,
          env: "uat",
          profile,
          side: "call",
          secrets,
          transport: fake.transport,
          confirm: (lines) => {
            shown.push(lines)
            return Effect.succeed(true)
          }
        })
        assert.strictEqual(outcome._tag, "Pinned")
        if (outcome._tag !== "Pinned") return
        assert.strictEqual(outcome.pem, ".llm4ts/soap/DemoBankService/trust/esb.bank.local.pem")
        assert.isFalse(outcome.replaced)
        const lines = shown[0]?.join("\n") ?? ""
        assert.include(lines, "NOT trusted by the system roots (SELF_SIGNED_CERT_IN_CHAIN)")
        assert.include(lines, "sha256: AA:BB")
        assert.include(lines, "issuer: CN=Bank Root CA")
        const written = yield* workspace.read(outcome.pem)
        assert.include(written, Buffer.from("leaf-AA:BB").toString("base64"))
        assert.include(written, Buffer.from("root").toString("base64"))
        const saved = yield* decodeAuthProfile(yield* workspace.read(profilePath(service, "uat")))
        assert.strictEqual(saved.call?.tls?.ca, `file:${outcome.pem}`)
        assert.strictEqual(saved.call?.tls?.servername, "esb.bank.local")
        assert.strictEqual(
          saved.call?.proxy !== "none" ? saved.call?.proxy?.url : "",
          "http://proxy.bank:3128"
        )

        // Changed certificate: the replacement is announced and asked again.
        const changed = yield* makeFakeSoapTransport(
          () => Effect.succeed(xmlResponse("")),
          () => Effect.succeed(chain(false, "EE:FF"))
        )
        const again = yield* trustSide({
          workspace,
          service,
          env: "uat",
          profile: saved,
          side: "call",
          secrets,
          transport: changed.transport,
          confirm: (lines) => Effect.succeed(lines.some((line) => line.includes("replaces it")))
        })
        assert.strictEqual(again._tag, "Pinned")
        if (again._tag === "Pinned") assert.isTrue(again.replaced)
      })
  )

  it.effect("writes nothing when declined or when the system already trusts the chain", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      yield* workspace.write(profilePath(service, undefined), text)
      const profile = yield* decodeAuthProfile(text)
      const declined = yield* makeFakeSoapTransport(
        () => Effect.succeed(xmlResponse("")),
        () => Effect.succeed(chain(false))
      )
      const no = yield* trustSide({
        workspace,
        service,
        env: undefined,
        profile,
        side: "sts",
        secrets,
        transport: declined.transport,
        confirm: () => Effect.succeed(false)
      })
      assert.strictEqual(no._tag, "Declined")
      const trusted = yield* makeFakeSoapTransport(
        () => Effect.succeed(xmlResponse("")),
        () => Effect.succeed(chain(true))
      )
      const already = yield* trustSide({
        workspace,
        service,
        env: undefined,
        profile,
        side: "call",
        secrets,
        transport: trusted.transport,
        confirm: () => Effect.succeed(true)
      })
      assert.strictEqual(already._tag, "AlreadyTrusted")
      assert.deepStrictEqual(yield* workspace.discover(`${servicePaths(service).trustDir}/*`), [])
      assert.strictEqual(yield* workspace.read(profilePath(service, undefined)), text)
      assert.include(describeChain(chain(true))[0] ?? "", "trusted by the system roots")
    })
  )

  it.effect("keeps every other field when pinning into an existing side", () =>
    Effect.gen(function* () {
      const edited = yield* profileWithPinnedCa(
        '{"environment":"dev","call":{"auth":{"scheme":"bearer","token":"env:T"},"tls":{"pfx":"file:/c.p12"}}}',
        "call",
        ".llm4ts/soap/s/trust/h.pem"
      )
      const profile = yield* decodeAuthProfile(edited)
      assert.strictEqual(profile.call?.tls?.pfx, "file:/c.p12")
      assert.strictEqual(profile.call?.tls?.ca, "file:.llm4ts/soap/s/trust/h.pem")
      assert.strictEqual(profile.call?.auth?.scheme, "bearer")
      const fresh = yield* profileWithPinnedCa('{"environment":"dev"}', "sts", "x.pem")
      assert.include(fresh, '"sts": {')
    })
  )
})

describe("sts init", () => {
  it.effect("writes the default template once and refuses without an sts section", () =>
    Effect.gen(function* () {
      const workspace = yield* makeMemoryWorkspace()
      const profile = yield* decodeAuthProfile(text)
      const first = yield* initStsTemplate(workspace, service, profile)
      assert.isTrue(first.written)
      assert.strictEqual(yield* workspace.read(first.path), renderDefaultStsTemplate("1.1"))
      const second = yield* initStsTemplate(workspace, service, profile)
      assert.isFalse(second.written)
      const plain = yield* decodeAuthProfile('{"environment":"dev"}')
      const error = yield* Effect.flip(initStsTemplate(workspace, service, plain))
      assert.include(error.message, 'names no "sts"')
    })
  )
})
