import { readFile } from "node:fs/promises"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import type { WsdlCatalog } from "./Catalog.ts"
import { Soap11Namespace } from "./Envelope.ts"
import type { SoapHttpRequest, SoapHttpResponse, SoapTransportShape } from "./Transport.ts"

// A backend stand-in: answers each call with `<directory>/<operation>.xml`,
// the operation found from the SOAPAction (SOAP 1.1 header or the SOAP 1.2
// content-type `action`). For rehearsals without a reachable service
// (LLM4TS_SOAP_STUB) and for the ACE tests' recorded backend.

export const soapActionOf = (request: SoapHttpRequest): string => {
  const header = request.headers["soapaction"]
  if (header !== undefined) return header.replace(/^"|"$/g, "")
  return /action="([^"]*)"/.exec(request.headers["content-type"] ?? "")?.[1] ?? ""
}

const stubFault = (reason: string): SoapHttpResponse => ({
  status: 500,
  headers: { "content-type": "text/xml; charset=utf-8" },
  body: new TextEncoder().encode(
    `<s:Envelope xmlns:s="${Soap11Namespace}"><s:Body><s:Fault><faultcode>s:Server</faultcode><faultstring>${reason}</faultstring></s:Fault></s:Body></s:Envelope>`
  ),
  elapsedMs: 1
})

export const makeDirectoryStubTransport = (
  directory: string,
  catalog: WsdlCatalog
): SoapTransportShape => ({
  send: (request) => {
    const action = soapActionOf(request)
    const operation = catalog.operations.find((candidate) => candidate.soapAction === action)
    if (operation === undefined)
      return Effect.succeed(stubFault(`stub: no operation for action ${action}`))
    return Effect.tryPromise(() => readFile(join(directory, `${operation.name}.xml`))).pipe(
      Effect.map(
        (bytes): SoapHttpResponse => ({
          status: 200,
          headers: { "content-type": "text/xml; charset=utf-8" },
          body: new Uint8Array(bytes),
          elapsedMs: 1
        })
      ),
      Effect.orElseSucceed(() => stubFault(`stub: no ${operation.name}.xml`))
    )
  }
})
