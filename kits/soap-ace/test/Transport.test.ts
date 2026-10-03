import { readFileSync } from "node:fs"
import * as http from "node:http"
import * as https from "node:https"
import * as net from "node:net"
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
        tls: undefined,
        proxy: undefined
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

// A server the system roots do not know (signed by the test CA), no client
// certificate asked: the self-signed-chain case `trust` exists for.
const withPlainServer = <A, E>(use: (url: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(
      () =>
        new Promise<https.Server>((resolve) => {
          const server = https.createServer(
            { key: file("server.key"), cert: file("server.pem") },
            (_request, response) => {
              response.writeHead(200, { "content-type": "text/xml" })
              response.end("<pong/>")
            }
          )
          server.listen(0, "127.0.0.1", () => resolve(server))
        })
    ),
    (server) => use(`https://localhost:${portOf(server.address())}/soap`),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections()
            server.close(() => resolve())
          })
      )
  )

interface ProxyLog {
  readonly tunnels: Array<string>
  readonly authorizations: Array<string | undefined>
  /** The tunnelled sockets, detached from the server: closed by hand on release. */
  readonly sockets: Set<{ destroy: () => void }>
}

// An HTTP CONNECT proxy on the loopback: records every tunnel it opens and
// its proxy-authorization header; `requireAuth` answers 407 without one.
const withProxy = <A, E>(
  use: (proxyUrl: string, log: ProxyLog) => Effect.Effect<A, E>,
  requireAuth = false
) =>
  Effect.acquireUseRelease(
    Effect.promise(
      () =>
        new Promise<{ server: http.Server; log: ProxyLog }>((resolve) => {
          const log: ProxyLog = { tunnels: [], authorizations: [], sockets: new Set() }
          const server = http.createServer((_request, response) => {
            response.writeHead(400)
            response.end()
          })
          server.on("connect", (request, clientSocket, head) => {
            log.tunnels.push(request.url ?? "")
            log.authorizations.push(request.headers["proxy-authorization"])
            if (requireAuth && request.headers["proxy-authorization"] === undefined) {
              clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
              return
            }
            const [host, port] = (request.url ?? "").split(":")
            log.sockets.add(clientSocket)
            const upstream = net.connect(Number(port), host, () => {
              log.sockets.add(upstream)
              clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
              upstream.write(head)
              upstream.pipe(clientSocket)
              clientSocket.pipe(upstream)
            })
            upstream.on("error", () => clientSocket.destroy())
            clientSocket.on("error", () => upstream.destroy())
          })
          server.listen(0, "127.0.0.1", () => resolve({ server, log }))
        })
    ),
    ({ server, log }) => use(`http://127.0.0.1:${portOf(server.address())}`, log),
    ({ server, log }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const socket of log.sockets) socket.destroy()
            server.closeAllConnections()
            server.close(() => resolve())
          })
      )
  )

describe("trust and proxies", () => {
  it.live(
    "a chain the system does not know fails with the trust hint, and passes once its CA is added",
    () =>
      withPlainServer((url) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(post(url, undefined))
          assert.strictEqual(error.reason, "tls")
          assert.include(error.detail, "trust <side>")
          const added = yield* post(url, { ca: secret("ca.pem") })
          assert.strictEqual(added.status, 200)
          const only = yield* post(url, { ca: secret("ca.pem"), trust: "ca-only" })
          assert.strictEqual(only.status, 200)
        })
      )
  )

  it.live(
    "peerChain reads the presented chain without a request and says the system does not trust it",
    () =>
      withPlainServer((url) =>
        Effect.gen(function* () {
          const chain = yield* makeNodeSoapTransport().peerChain(url, {
            timeout: Duration.seconds(5)
          })
          assert.strictEqual(chain.host, "localhost")
          assert.isFalse(chain.trustedBySystem)
          assert.isDefined(chain.authorizationError)
          const [leaf] = chain.certificates
          assert.include(leaf?.subject ?? "", "localhost")
          assert.match(leaf?.fingerprint256 ?? "", /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
          assert.isTrue((leaf?.pem ?? "").startsWith("-----BEGIN CERTIFICATE-----"))
          // The captured PEM is enough to verify the next call.
          const pinned = yield* post(url, {
            ca: Redacted.make(
              new TextEncoder().encode(chain.certificates.map((c) => c.pem).join(""))
            )
          })
          assert.strictEqual(pinned.status, 200)
        })
      )
  )

  it.live(
    "tunnels through an explicit CONNECT proxy, bypasses it for no-proxy hosts, and types a refusal",
    () =>
      withPlainServer((url) =>
        withProxy((proxyUrl, log) =>
          Effect.gen(function* () {
            const via = yield* makeNodeSoapTransport().send({
              method: "POST",
              url,
              headers: { "content-type": "text/xml" },
              secretHeaders: [],
              body: Redacted.make("<ping/>"),
              tls: { ca: secret("ca.pem") },
              proxy: { url: proxyUrl, noProxy: [], authorization: Redacted.make("Basic cHg6cHc=") },
              timeout: Duration.seconds(5)
            })
            assert.strictEqual(via.status, 200)
            assert.strictEqual(log.tunnels.length, 1)
            assert.match(log.tunnels[0] ?? "", /^localhost:\d+$/)
            assert.strictEqual(log.authorizations[0], "Basic cHg6cHc=")

            const direct = yield* makeNodeSoapTransport().send({
              method: "POST",
              url,
              headers: { "content-type": "text/xml" },
              secretHeaders: [],
              body: Redacted.make("<ping/>"),
              tls: { ca: secret("ca.pem") },
              proxy: { url: proxyUrl, noProxy: ["localhost"] },
              timeout: Duration.seconds(5)
            })
            assert.strictEqual(direct.status, 200)
            assert.strictEqual(log.tunnels.length, 1)
          })
        )
      )
  )

  it.live("a proxy that refuses the tunnel is a typed proxy failure without the credentials", () =>
    withPlainServer((url) =>
      withProxy(
        (proxyUrl) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(
              makeNodeSoapTransport().send({
                method: "GET",
                url,
                headers: {},
                secretHeaders: [],
                tls: { ca: secret("ca.pem") },
                proxy: { url: proxyUrl, noProxy: [] },
                timeout: Duration.seconds(5)
              })
            )
            assert.strictEqual(error.reason, "proxy")
            assert.include(error.detail, "407")
          }),
        true
      )
    )
  )
})
