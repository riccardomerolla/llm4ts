// Promoted to `@llm4ts/flow/endpoint/Transport` in 3.2.0 (ADR 0048); the
// discovery document loader stays here because it reads WSDLs.
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { ResolvedSide } from "@llm4ts/flow/endpoint/Auth"
import { displayUrl, type SoapTransportShape } from "@llm4ts/flow/endpoint/Transport"
import { DocumentLoadError, type DocumentLoaderShape, makeFileDocumentLoader } from "./Wsdl.ts"

export * from "@llm4ts/flow/endpoint/Transport"

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
