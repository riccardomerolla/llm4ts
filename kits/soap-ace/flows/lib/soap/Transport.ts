import * as http from "node:http"
import * as https from "node:https"
import * as net from "node:net"
import * as tls from "node:tls"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import { bypassesProxy, type ResolvedProxy, type ResolvedSide, type ResolvedTls } from "./Auth.ts"
import { DocumentLoadError, type DocumentLoaderShape, makeFileDocumentLoader } from "./Wsdl.ts"

// The HTTP seam for everything that leaves the machine: fetching WSDLs from
// a URL, calling operations, asking an STS for a token. Secrets travel only
// as `Redacted` values in `secretHeaders`, the body (an envelope may carry a
// WS-Security header), `tls` and the proxy's authorization; errors carry
// the URL and a reason code, never a header or body. The Node implementation
// uses `node:https` directly because global `fetch` cannot present a client
// certificate, tunnels through an explicit proxy with HTTP CONNECT (proxy
// environment variables are never read), and adds the profile's CA
// material to Node's system roots instead of replacing them.

export interface SoapHttpRequest {
  readonly method: "GET" | "POST"
  readonly url: string
  /** Non-secret headers (content type, SOAPAction). */
  readonly headers: Readonly<Record<string, string>>
  /** Secret headers (authorization). */
  readonly secretHeaders: ReadonlyArray<readonly [string, Redacted.Redacted<string>]>
  readonly body?: Redacted.Redacted<string>
  readonly tls?: ResolvedTls
  readonly proxy?: ResolvedProxy
  readonly timeout: Duration.Duration
}

export interface SoapHttpResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
  readonly elapsedMs: number
}

export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  url: Schema.String,
  reason: Schema.Literals(["scheme", "network", "tls", "timeout", "aborted", "proxy"]),
  detail: Schema.String
}) {
  get message(): string {
    return `${this.url}: ${this.reason}: ${this.detail}`
  }
}

/** One certificate of the chain a server presents, as `peerChain` reads it. */
export interface PeerCertificate {
  readonly subject: string
  readonly issuer: string
  readonly validFrom: string
  readonly validTo: string
  /** SHA-256 over the DER, colon-separated hex. */
  readonly fingerprint256: string
  readonly pem: string
}

export interface PeerChain {
  readonly host: string
  /** Leaf first. */
  readonly certificates: ReadonlyArray<PeerCertificate>
  /** Whether Node's system roots already trust this chain. */
  readonly trustedBySystem: boolean
  readonly authorizationError: string | undefined
}

export interface PeerChainOptions {
  readonly proxy?: ResolvedProxy
  readonly servername?: string
  readonly timeout: Duration.Duration
}

export interface SoapTransportShape {
  readonly send: (request: SoapHttpRequest) => Effect.Effect<SoapHttpResponse, TransportError>
  /**
   * The chain an https endpoint presents, read without verifying it and
   * without sending a request: what `trust` shows before pinning. Nothing
   * else may call this.
   */
  readonly peerChain: (
    url: string,
    options: PeerChainOptions
  ) => Effect.Effect<PeerChain, TransportError>
}

export class SoapTransport extends Context.Service<SoapTransport, SoapTransportShape>()(
  "@llm4ts/kits/soap-ace/SoapTransport"
) {}

/** Strip query string and credentials from a URL before it lands in an error or a file. */
export const displayUrl = (raw: string): string => {
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return "(invalid url)"
  }
}

const errorCode = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : "request failed"

const tlsCodes = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO|DEPTH_ZERO|ERR_OSSL/
const unknownIssuer =
  /SELF_SIGNED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER|DEPTH_ZERO|CERT_UNTRUSTED|UNABLE_TO_GET_LOCAL_ISSUER/

export const trustHint = 'the chain is not trusted; capture it with soap-sample "trust <side>"'

const describeTlsFailure = (code: string): string =>
  unknownIssuer.test(code) ? `${code} (${trustHint})` : code

class ProxyRefused extends Error {
  readonly status: number
  constructor(status: number) {
    super(`proxy refused the tunnel: HTTP ${status}`)
    this.status = status
  }
}

const flatHeaders = (headers: http.IncomingHttpHeaders): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]]
    )
  )

const bufferOf = (secret: Redacted.Redacted<Uint8Array> | undefined): Buffer | undefined =>
  secret === undefined ? undefined : Buffer.from(Redacted.value(secret))

/** The CA list a connection verifies against: system roots plus the profile's, or the profile's alone. */
export const caListFor = (resolved: ResolvedTls | undefined): ReadonlyArray<string> | undefined => {
  if (resolved?.ca === undefined) {
    return undefined
  }
  const own = new TextDecoder().decode(Redacted.value(resolved.ca))
  return resolved.trust === "ca-only" ? [own] : [...tls.rootCertificates, own]
}

const tlsOptionsOf = (resolved: ResolvedTls | undefined, host: string): tls.ConnectionOptions => {
  const ca = caListFor(resolved)
  return {
    ...(resolved === undefined
      ? {}
      : {
          cert: bufferOf(resolved.cert),
          key: bufferOf(resolved.key),
          pfx: bufferOf(resolved.pfx),
          passphrase:
            resolved.passphrase === undefined ? undefined : Redacted.value(resolved.passphrase)
        }),
    // A pinned chain may hold only what the server sent (a leaf signed by a
    // CA it never presents): trust it as captured, not only self-signed roots.
    ...(ca === undefined ? {} : { ca: [...ca], allowPartialTrustChain: true }),
    servername: resolved?.servername ?? (net.isIP(host) === 0 ? host : undefined)
  }
}

const portOf = (url: URL): number =>
  url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80

/** Whether this request goes through the proxy: configured and the host not excluded. */
export const proxyFor = (url: URL, proxy: ResolvedProxy | undefined): ResolvedProxy | undefined =>
  proxy === undefined || bypassesProxy(url.hostname, proxy.noProxy) ? undefined : proxy

/** An HTTP CONNECT tunnel to `target` through `proxy`; the raw socket, not yet TLS. */
const connectTunnel = (
  proxy: ResolvedProxy,
  target: URL,
  signal: AbortSignal
): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const proxyUrl = new URL(proxy.url)
    const headers: Record<string, string> = { host: `${target.hostname}:${portOf(target)}` }
    if (proxy.authorization !== undefined) {
      headers["proxy-authorization"] = Redacted.value(proxy.authorization)
    }
    const request = http.request({
      host: proxyUrl.hostname,
      port: portOf(proxyUrl),
      method: "CONNECT",
      path: `${target.hostname}:${portOf(target)}`,
      headers,
      signal
    })
    request.on("connect", (response, socket) => {
      if (response.statusCode === 200) {
        resolve(socket)
      } else {
        socket.destroy()
        reject(new ProxyRefused(response.statusCode ?? 0))
      }
    })
    request.on("error", reject)
    request.end()
  })

/** The socket a request runs on: direct, or through the tunnel; TLS-wrapped for https. */
const openSocket = async (
  url: URL,
  resolved: ResolvedTls | undefined,
  proxy: ResolvedProxy | undefined,
  signal: AbortSignal
): Promise<net.Socket | undefined> => {
  const via = proxyFor(url, proxy)
  if (via === undefined) {
    return undefined
  }
  const tunnel = await connectTunnel(via, url, signal)
  if (url.protocol !== "https:") {
    return tunnel
  }
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ ...tlsOptionsOf(resolved, url.hostname), socket: tunnel }, () =>
      resolve(secure)
    )
    secure.on("error", reject)
  })
}

const transportFailure = (shown: string, cause: unknown): TransportError => {
  if (cause instanceof ProxyRefused) {
    return new TransportError({ url: shown, reason: "proxy", detail: `HTTP ${cause.status}` })
  }
  const code = errorCode(cause)
  return new TransportError({
    url: shown,
    reason: code === "ABORT_ERR" ? "aborted" : tlsCodes.test(code) ? "tls" : "network",
    detail: tlsCodes.test(code) ? describeTlsFailure(code) : code
  })
}

const withTimeout =
  (shown: string, timeout: Duration.Duration) =>
  <A>(effect: Effect.Effect<A, TransportError>): Effect.Effect<A, TransportError> =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            new TransportError({
              url: shown,
              reason: "timeout",
              detail: `no response within ${Duration.format(timeout)}`
            })
          )
      })
    )

const parseTarget = (raw: string, needsTls: boolean): URL | TransportError => {
  const shown = displayUrl(raw)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return new TransportError({ url: shown, reason: "scheme", detail: "invalid URL" })
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return new TransportError({
      url: shown,
      reason: "scheme",
      detail: `${url.protocol} is not http(s)`
    })
  }
  if (url.protocol === "http:" && needsTls) {
    return new TransportError({
      url: shown,
      reason: "scheme",
      detail: "client TLS needs an https URL"
    })
  }
  return url
}

const pemOf = (der: Buffer): string =>
  `-----BEGIN CERTIFICATE-----\n${der
    .toString("base64")
    .replace(/(.{64})/g, "$1\n")
    .trimEnd()}\n-----END CERTIFICATE-----\n`

const nameOf = (subject: tls.PeerCertificate["subject"]): string =>
  Object.entries(subject ?? {})
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("+") : String(value)}`)
    .join(", ")

/** Walk `issuerCertificate` links, leaf first, stopping at the self-signed root. */
const chainOf = (leaf: tls.DetailedPeerCertificate): ReadonlyArray<PeerCertificate> => {
  const out: Array<PeerCertificate> = []
  const seen = new Set<string>()
  let current: tls.DetailedPeerCertificate | undefined = leaf
  while (current !== undefined && current.raw !== undefined && !seen.has(current.fingerprint256)) {
    seen.add(current.fingerprint256)
    out.push({
      subject: nameOf(current.subject),
      issuer: nameOf(current.issuer),
      validFrom: current.valid_from,
      validTo: current.valid_to,
      fingerprint256: current.fingerprint256,
      pem: pemOf(current.raw)
    })
    current = current.issuerCertificate === current ? undefined : current.issuerCertificate
  }
  return out
}

export const makeNodeSoapTransport = (): SoapTransportShape => ({
  send: (request) => {
    const shown = displayUrl(request.url)
    const target = parseTarget(request.url, request.tls !== undefined)
    if (target instanceof TransportError) {
      return Effect.fail(target)
    }
    const url = target
    const headers: Record<string, string> = { ...request.headers }
    for (const [name, value] of request.secretHeaders) headers[name] = Redacted.value(value)
    const body =
      request.body === undefined ? undefined : Buffer.from(Redacted.value(request.body), "utf8")
    if (body !== undefined) headers["content-length"] = String(body.length)

    return Effect.tryPromise({
      try: (signal) => {
        const started = performance.now()
        return openSocket(url, request.tls, request.proxy, signal).then(
          (socket) =>
            new Promise<SoapHttpResponse>((resolve, reject) => {
              const options: https.RequestOptions = {
                method: request.method,
                headers,
                signal,
                ...(url.protocol === "https:" ? tlsOptionsOf(request.tls, url.hostname) : {}),
                ...(socket === undefined ? {} : { createConnection: () => socket })
              }
              const handler = (response: http.IncomingMessage) => {
                const chunks: Array<Buffer> = []
                response.on("data", (chunk: Buffer) => chunks.push(chunk))
                response.on("error", reject)
                response.on("end", () =>
                  resolve({
                    status: response.statusCode ?? 0,
                    headers: flatHeaders(response.headers),
                    body: new Uint8Array(Buffer.concat(chunks)),
                    elapsedMs: Math.round(performance.now() - started)
                  })
                )
              }
              const outgoing =
                url.protocol === "https:"
                  ? https.request(url, options, handler)
                  : http.request(url, options, handler)
              outgoing.on("error", reject)
              if (body !== undefined) outgoing.write(body)
              outgoing.end()
            })
        )
      },
      catch: (cause) => transportFailure(shown, cause)
    }).pipe(withTimeout(shown, request.timeout))
  },
  peerChain: (raw, options) => {
    const shown = displayUrl(raw)
    const target = parseTarget(raw, false)
    if (target instanceof TransportError) {
      return Effect.fail(target)
    }
    const url = target
    if (url.protocol !== "https:") {
      return Effect.fail(
        new TransportError({
          url: shown,
          reason: "scheme",
          detail: "only an https endpoint has a chain"
        })
      )
    }
    return Effect.tryPromise({
      try: (signal) => {
        const via = proxyFor(url, options.proxy)
        const tunnelled: Promise<net.Socket | undefined> =
          via === undefined ? Promise.resolve(undefined) : connectTunnel(via, url, signal)
        return tunnelled.then(
          (tunnel) =>
            new Promise<PeerChain>((resolve, reject) => {
              const socket = tls.connect(
                {
                  ...(tunnel === undefined
                    ? { host: url.hostname, port: portOf(url) }
                    : { socket: tunnel }),
                  servername:
                    options.servername ?? (net.isIP(url.hostname) === 0 ? url.hostname : undefined),
                  rejectUnauthorized: false
                },
                () => {
                  const leaf = socket.getPeerCertificate(true)
                  const chain = {
                    host: url.hostname,
                    certificates: chainOf(leaf),
                    trustedBySystem: socket.authorized,
                    authorizationError:
                      socket.authorizationError === undefined || socket.authorizationError === null
                        ? undefined
                        : String(socket.authorizationError)
                  }
                  socket.end()
                  resolve(chain)
                }
              )
              socket.on("error", reject)
              signal.addEventListener("abort", () => socket.destroy())
            })
        )
      },
      catch: (cause) => transportFailure(shown, cause)
    }).pipe(withTimeout(shown, options.timeout))
  }
})

/**
 * A scripted transport for tests: each request goes to `respond`, and every
 * request is recorded (secrets still redacted) for assertions. `chain`
 * answers `peerChain`; by default an endpoint presents nothing.
 */
export const makeFakeSoapTransport = (
  respond: (request: SoapHttpRequest) => Effect.Effect<SoapHttpResponse, TransportError>,
  chain: (url: string) => Effect.Effect<PeerChain, TransportError> = (url) =>
    Effect.succeed({
      host: new URL(url).hostname,
      certificates: [],
      trustedBySystem: true,
      authorizationError: undefined
    })
) =>
  Effect.map(Ref.make<ReadonlyArray<SoapHttpRequest>>([]), (log) => ({
    transport: {
      send: (request: SoapHttpRequest) =>
        Effect.andThen(
          Ref.update(log, (all) => [...all, request]),
          respond(request)
        ),
      peerChain: (url: string) => chain(url)
    } satisfies SoapTransportShape,
    requests: Ref.get(log)
  }))

export const xmlResponse = (xml: string, status = 200): SoapHttpResponse => ({
  status,
  headers: { "content-type": "text/xml; charset=utf-8" },
  body: new TextEncoder().encode(xml),
  elapsedMs: 5
})

const isUrl = (location: string): boolean => /^https?:\/\//i.test(location)

/**
 * The document loader for discovery: local paths from disk, http(s) URLs
 * through the transport with the profile's fetch-side auth, TLS and proxy.
 */
export const makeTransportDocumentLoader = (
  transport: SoapTransportShape,
  side: ResolvedSide,
  timeout: Duration.Duration = Duration.seconds(30)
): DocumentLoaderShape => {
  const files = makeFileDocumentLoader()
  return {
    load: (location) =>
      !isUrl(location)
        ? files.load(location)
        : transport
            .send({
              method: "GET",
              url: location,
              headers: { accept: "text/xml, application/xml, */*" },
              secretHeaders: side.headers,
              ...(side.tls === undefined ? {} : { tls: side.tls }),
              ...(side.proxy === undefined ? {} : { proxy: side.proxy }),
              timeout
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new DocumentLoadError({
                    location: displayUrl(location),
                    detail: `${error.reason}: ${error.detail}`
                  })
              ),
              Effect.flatMap((response) =>
                response.status >= 200 && response.status < 300
                  ? Effect.succeed(response.body)
                  : Effect.fail(
                      new DocumentLoadError({
                        location: displayUrl(location),
                        detail: `HTTP ${response.status}`
                      })
                    )
              )
            )
  }
}
