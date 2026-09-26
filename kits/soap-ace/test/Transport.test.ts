import { readFileSync } from "node:fs"
import * as https from "node:https"
import type { AddressInfo } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { assert, describe, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import type { ResolvedTls } from "../flows/lib/soap/Auth.ts"
import {
  makeFakeSoapTransport,
  makeNodeSoapTransport,
  makeTransportDocumentLoader,
  xmlResponse
} from "../flows/lib/soap/Transport.ts"

const tlsDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tls")
const file = (name: string) => readFileSync(join(tlsDir, name))
const secret = (name: string) => Redacted.make(new Uint8Array(file(name)))

// A local HTTPS server that requires a client certificate signed by the
// test CA and echoes what it saw. No network beyond the loopback interface.
// These talk to a real loopback server, so they run on the live clock
// (`it.live`): the default test clock would never fire the timeout.
const portOf = (address: AddressInfo | string | null): number =>
  typeof address === "object" && address !== null ? address.port : 0

const Echo = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))

const withServer = <A, E>(
  use: (url: string) => Effect.Effect<A, E>,
  behaviour: "echo" | "silent" = "echo"
) =>
  Effect.acquireUseRelease(
    Effect.promise(
      () =>
        new Promise<https.Server>((resolve) => {
          const server = https.createServer(
            {
              key: file("server.key"),
              cert: file("server.pem"),
              ca: file("ca.pem"),
              requestCert: true,
              rejectUnauthorized: true
            },
            (request, response) => {
              if (behaviour === "silent") return
              const chunks: Array<Buffer> = []
              request.on("data", (chunk: Buffer) => chunks.push(chunk))
              request.on("end", () => {
                response.writeHead(200, { "content-type": "text/xml", "set-cookie": "S=1" })
                response.end(
                  JSON.stringify({
                    action: request.headers["soapaction"],
                    authorization: request.headers["authorization"],
                    body: Buffer.concat(chunks).toString("utf8")
                  })
                )
              })
            }
          )
          server.listen(0, "127.0.0.1", () => resolve(server))
        })
    ),
    (server) => use(`https://localhost:${portOf(server.address())}/soap?token=abc`),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections()
            server.close(() => resolve())
          })
      )
  )

const pemTls: ResolvedTls = {
  cert: secret("client.pem"),
  key: secret("client.key"),
  ca: secret("ca.pem")
}

const post = (url: string, tls: ResolvedTls | undefined, timeout = Duration.seconds(5)) =>
  makeNodeSoapTransport().send({
    method: "POST",
    url,
    headers: { "content-type": "text/xml; charset=utf-8", soapaction: '"urn:ping"' },
    secretHeaders: [["authorization", Redacted.make("Basic c3ZjOnB3")]],
    body: Redacted.make("<ping/>"),
    ...(tls === undefined ? {} : { tls }),
    timeout
  })

describe("node SOAP transport", () => {
  it.live("presents a PEM client certificate and sends secret headers and body", () =>
    withServer((url) =>
      Effect.gen(function* () {
        const response = yield* post(url, pemTls)
        assert.strictEqual(response.status, 200)
        const seen = Schema.decodeUnknownSync(Echo)(new TextDecoder().decode(response.body))
        assert.strictEqual(seen["action"], '"urn:ping"')
        assert.strictEqual(seen["authorization"], "Basic c3ZjOnB3")
        assert.strictEqual(seen["body"], "<ping/>")
      })
    )
  )

  it.live("presents a PKCS#12 bundle with its passphrase", () =>
    withServer((url) =>
      Effect.gen(function* () {
        const response = yield* post(url, {
          pfx: secret("client.p12"),
          passphrase: Redacted.make("test-only-passphrase"),
          ca: secret("ca.pem")
        })
        assert.strictEqual(response.status, 200)
      })
    )
  )

  it.live("fails typed without a client certificate, keeping the query out of the error", () =>
    withServer((url) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(post(url, { ca: secret("ca.pem") }))
        assert.strictEqual(error._tag, "TransportError")
        assert.oneOf(error.reason, ["tls", "network"])
        assert.notInclude(error.message, "token=abc")
        assert.notInclude(error.message, "c3ZjOnB3")
      })
    )
  )

  it.live("rejects an untrusted server", () =>
    withServer((url) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          post(url, { cert: secret("client.pem"), key: secret("client.key") })
        )
        assert.strictEqual(error.reason, "tls")
      })
    )
  )

  it.live("times out", () =>
    withServer(
      (url) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(post(url, pemTls, Duration.millis(300)))
          assert.strictEqual(error.reason, "timeout")
        }),
      "silent"
    )
  )

  it.live("refuses non-http schemes and client TLS over plain http", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        (yield* Effect.flip(post("file:///etc/passwd", undefined))).reason,
        "scheme"
      )
      assert.strictEqual(
        (yield* Effect.flip(post("http://localhost:1/x", pemTls))).reason,
        "scheme"
      )
    })
  )
})

describe("transport document loader", () => {
  it.effect("fetches URLs with the fetch-side auth and reports HTTP errors", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeSoapTransport((request) =>
        Effect.succeed(
          request.url.endsWith("missing.xsd") ? xmlResponse("", 404) : xmlResponse("<definitions/>")
        )
      )
      const loader = makeTransportDocumentLoader(fake.transport, {
        headers: [["authorization", Redacted.make("Bearer t")]],
        tls: undefined
      })
      const bytes = yield* loader.load("https://esb.example/ws/Conti?wsdl")
      assert.strictEqual(new TextDecoder().decode(bytes), "<definitions/>")
      const error = yield* Effect.flip(loader.load("https://esb.example/ws/missing.xsd"))
      assert.include(error.message, "HTTP 404")
      const requests = yield* fake.requests
      assert.strictEqual(requests[0]?.method, "GET")
      assert.strictEqual(requests[0]?.secretHeaders[0]?.[0], "authorization")
    })
  )
})
