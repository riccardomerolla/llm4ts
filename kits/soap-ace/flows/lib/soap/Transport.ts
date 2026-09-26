import * as http from "node:http"
import * as https from "node:https"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import type { ResolvedSide, ResolvedTls } from "./Auth.ts"
import { DocumentLoadError, type DocumentLoaderShape, makeFileDocumentLoader } from "./Wsdl.ts"

// The HTTP seam for everything that leaves the machine: fetching WSDLs from
// a URL and calling operations. Secrets travel only as `Redacted` values in
// `secretHeaders`, the body (an envelope may carry a WS-Security header),
// and `tls`; errors carry the URL and a reason code, never a header or body.
// The Node implementation uses `node:https` directly because global `fetch`
// cannot present a client certificate.

export interface SoapHttpRequest {
  readonly method: "GET" | "POST"
  readonly url: string
  /** Non-secret headers (content type, SOAPAction). */
  readonly headers: Readonly<Record<string, string>>
  /** Secret headers (authorization). */
  readonly secretHeaders: ReadonlyArray<readonly [string, Redacted.Redacted<string>]>
  readonly body?: Redacted.Redacted<string>
  readonly tls?: ResolvedTls
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
  reason: Schema.Literals(["scheme", "network", "tls", "timeout", "aborted"]),
  detail: Schema.String
}) {
  get message(): string {
    return `${this.url}: ${this.reason}: ${this.detail}`
  }
}

export interface SoapTransportShape {
  readonly send: (request: SoapHttpRequest) => Effect.Effect<SoapHttpResponse, TransportError>
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

const flatHeaders = (headers: http.IncomingHttpHeaders): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value]]
    )
  )

const bufferOf = (secret: Redacted.Redacted<Uint8Array> | undefined): Buffer | undefined =>
  secret === undefined ? undefined : Buffer.from(Redacted.value(secret))

export const makeNodeSoapTransport = (): SoapTransportShape => ({
  send: (request) => {
    const shown = displayUrl(request.url)
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return Effect.fail(
        new TransportError({ url: shown, reason: "scheme", detail: "invalid URL" })
      )
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return Effect.fail(
        new TransportError({
          url: shown,
          reason: "scheme",
          detail: `${url.protocol} is not http(s)`
        })
      )
    }
    if (url.protocol === "http:" && request.tls !== undefined) {
      return Effect.fail(
        new TransportError({
          url: shown,
          reason: "scheme",
          detail: "client TLS needs an https URL"
        })
      )
    }
    const headers: Record<string, string> = { ...request.headers }
    for (const [name, value] of request.secretHeaders) headers[name] = Redacted.value(value)
    const body =
      request.body === undefined ? undefined : Buffer.from(Redacted.value(request.body), "utf8")
    if (body !== undefined) headers["content-length"] = String(body.length)

    return Effect.tryPromise({
      try: (signal) =>
        new Promise<SoapHttpResponse>((resolve, reject) => {
          const started = performance.now()
          const tls = request.tls
          const options: https.RequestOptions = {
            method: request.method,
            headers,
            signal,
            ...(tls === undefined
              ? {}
              : {
                  cert: bufferOf(tls.cert),
                  key: bufferOf(tls.key),
                  pfx: bufferOf(tls.pfx),
                  ca: bufferOf(tls.ca),
                  passphrase:
                    tls.passphrase === undefined ? undefined : Redacted.value(tls.passphrase)
                })
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
        }),
      catch: (cause) => {
        const code = errorCode(cause)
        return new TransportError({
          url: shown,
          reason: code === "ABORT_ERR" ? "aborted" : tlsCodes.test(code) ? "tls" : "network",
          detail: code
        })
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: request.timeout,
        orElse: () =>
          Effect.fail(
            new TransportError({
              url: shown,
              reason: "timeout",
              detail: `no response within ${Duration.format(request.timeout)}`
            })
          )
      })
    )
  }
})

/**
 * A scripted transport for tests: each request goes to `respond`, and every
 * request is recorded (secrets still redacted) for assertions.
 */
export const makeFakeSoapTransport = (
  respond: (request: SoapHttpRequest) => Effect.Effect<SoapHttpResponse, TransportError>
) =>
  Effect.map(Ref.make<ReadonlyArray<SoapHttpRequest>>([]), (log) => ({
    transport: {
      send: (request: SoapHttpRequest) =>
        Effect.andThen(
          Ref.update(log, (all) => [...all, request]),
          respond(request)
        )
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
 * through the transport with the profile's fetch-side auth and TLS.
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
