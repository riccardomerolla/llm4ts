import { randomBytes } from "node:crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import type { WorkspaceError, WorkspaceShape } from "@llm4ts/flow/Workspace"
import {
  type AuthProfile,
  type AuthProfileError,
  resolveSide,
  resolveUsernameToken,
  type SecretSource
} from "./Auth.ts"
import { type CallPermission, type CallRefused, checkCall } from "./CallPolicy.ts"
import { elementByName, type Operation, operationByName, type WsdlCatalog } from "./Catalog.ts"
import { effectiveClass, type OperationsFile } from "./Classification.ts"
import {
  buildEnvelope,
  readEnvelope,
  safeHeaders,
  soapHeaders,
  stripSecurity,
  usernameTokenHeader
} from "./Envelope.ts"
import { instanceFromXml, instanceToXml, type Issue, validateInstance } from "./Instance.ts"
import { kindsFromCatalog, maskDocument, MaskingReport, mergeReports } from "./Masking.ts"
import {
  Exchange,
  issueRecords,
  loadMaskingKey,
  loadMaskingOverrides,
  readRequestFile,
  RecordedMessage,
  RecordedResponse,
  type SampleError,
  samplePaths,
  writeExchange
} from "./Samples.ts"
import { displayUrl, type SoapTransportShape, type TransportError } from "./Transport.ts"
import { parseXml, parseXmlBytes, renderXml, type XmlElement, type XmlError } from "./Xml.ts"
import type { YamlError } from "./Yaml.ts"

// One call, end to end: read and validate the request file, check the call
// policy, render the envelope (WS-Security header when configured), send it
// with the profile's call-side auth and TLS, read the response against the
// output element's schema, mask both messages, and persist the exchange.
// A request that does not validate is never sent. A response that breaks
// its schema is recorded with the issues; that is a finding for the design.

export class RequestInvalid extends Schema.TaggedError<RequestInvalid>()("RequestInvalid", {
  operation: Schema.String,
  name: Schema.String,
  issues: Schema.Array(Schema.Struct({ path: Schema.String, detail: Schema.String }))
}) {
  get message(): string {
    return `${this.operation}/${this.name} not sent; the request does not validate:\n${this.issues
      .map((issue) => `  ${issue.path}: ${issue.detail}`)
      .join("\n")}`
  }
}

export class CallSetupError extends Schema.TaggedError<CallSetupError>()("CallSetupError", {
  operation: Schema.String,
  detail: Schema.String
}) {
  get message(): string {
    return `${this.operation}: ${this.detail}`
  }
}

export type CallError =
  | RequestInvalid
  | CallSetupError
  | CallRefused
  | AuthProfileError
  | TransportError
  | SampleError
  | WorkspaceError
  | YamlError
  | XmlError

export interface CallOptions {
  readonly workspace: WorkspaceShape
  readonly catalog: WsdlCatalog
  readonly service: string
  readonly operation: string
  readonly name: string
  readonly profile: AuthProfile | undefined
  readonly operations: OperationsFile | undefined
  readonly secrets: SecretSource
  readonly transport: SoapTransportShape
  readonly allowMutating: string | undefined
  readonly confirm: (question: string) => Effect.Effect<boolean>
  readonly keepRaw?: boolean
  readonly now?: () => Date
  readonly random?: (size: number) => Uint8Array
}

export interface CallResult {
  readonly exchange: Exchange
  readonly path: string
  readonly permission: CallPermission
}

/** The endpoint for an operation: the profile's override, else the WSDL port of its binding. */
export const endpointFor = (
  catalog: WsdlCatalog,
  operation: Operation,
  profile: AuthProfile
): string | undefined =>
  profile.endpoint ??
  catalog.endpoints.find((endpoint) => endpoint.binding === operation.binding)?.address ??
  catalog.endpoints.find((endpoint) => endpoint.soapVersion === operation.soapVersion)?.address

const maskEnvelope = (
  root: XmlElement,
  key: Uint8Array,
  options: Omit<Parameters<typeof maskDocument>[1], "key">
): { readonly xml: string; readonly report: MaskingReport } => {
  const masked = maskDocument(stripSecurity(root), { key, ...options })
  return { xml: renderXml(masked.document), report: masked.report }
}

export const callOperation = (options: CallOptions): Effect.Effect<CallResult, CallError> =>
  Effect.gen(function* () {
    const { catalog, workspace, service, name } = options
    const operation = operationByName(catalog, options.operation)
    if (operation === undefined) {
      return yield* new CallSetupError({
        operation: options.operation,
        detail: "not an operation of this service"
      })
    }
    const input = elementByName(catalog, operation.input)
    if (input === undefined) {
      return yield* new CallSetupError({
        operation: operation.name,
        detail: "request element missing from the catalog"
      })
    }
    const profile = options.profile
    if (profile === undefined) {
      return yield* new CallSetupError({
        operation: operation.name,
        detail: `no auth profile; write ${`.llm4ts/soap/${service}/auth.json`} with at least {"environment": "dev"}`
      })
    }

    const request = yield* readRequestFile(workspace, catalog, service, operation.name, name)
    const issues: ReadonlyArray<Issue> = [
      ...request.readIssues,
      ...validateInstance(catalog, input, request.body)
    ]
    if (issues.length > 0) {
      return yield* new RequestInvalid({ operation: operation.name, name, issues })
    }

    const permission = yield* checkCall({
      operation: operation.name,
      operationClass: effectiveClass(options.operations, operation.name),
      profile,
      allowMutating: options.allowMutating,
      confirm: options.confirm
    })

    const address = endpointFor(catalog, operation, profile)
    if (address === undefined) {
      return yield* new CallSetupError({
        operation: operation.name,
        detail: 'no endpoint: the WSDL declares none for this binding; set "endpoint" in auth.json'
      })
    }

    const side = yield* resolveSide(options.secrets, profile.call)
    const token = yield* resolveUsernameToken(options.secrets, profile.wsSecurity)
    const now = options.now ?? (() => new Date())
    const random = options.random ?? ((size: number) => new Uint8Array(randomBytes(size)))
    const header =
      token === undefined
        ? undefined
        : usernameTokenHeader(token, { nonce: random(16), created: now().toISOString() })
    const bodyXml = instanceToXml(catalog, input, request.body)
    const envelope = buildEnvelope(operation.soapVersion, bodyXml, header)
    const headers = soapHeaders(operation.soapVersion, operation.soapAction)

    const response = yield* options.transport.send({
      method: "POST",
      url: address,
      headers,
      secretHeaders: side.headers,
      body: envelope,
      ...(side.tls === undefined ? {} : { tls: side.tls }),
      timeout: Duration.seconds(profile.timeoutSeconds ?? 60)
    })

    const key = yield* loadMaskingKey(workspace, service, random)
    const overrides = yield* loadMaskingOverrides(workspace, service)
    const maskOptions = {
      typeKinds: kindsFromCatalog(catalog),
      ...(overrides === undefined ? {} : { overrides })
    }

    // The request is re-parsed from what was sent, so the recorded envelope
    // is exactly the message on the wire minus its security header.
    const sent = yield* parseXml(Redacted.value(envelope))
    const maskedRequest = maskEnvelope(sent, key, maskOptions)

    const responseIssues: Array<Issue> = []
    const parsedResponse = yield* parseXmlBytes(response.body).pipe(Effect.option)
    let maskedResponse: { readonly xml: string; readonly report: MaskingReport } = {
      xml: "",
      report: new MaskingReport({ entries: [], kept: [] })
    }
    let fault: Exchange["fault"]
    if (parsedResponse._tag === "None") {
      responseIssues.push({
        path: "(response)",
        detail: `HTTP ${response.status} with a body that is not XML (${response.body.length} bytes)`
      })
    } else {
      maskedResponse = maskEnvelope(parsedResponse.value, key, maskOptions)
      const read = yield* readEnvelope(parsedResponse.value).pipe(Effect.option)
      if (read._tag === "None") {
        responseIssues.push({ path: "(response)", detail: "XML that is not a SOAP envelope" })
      } else if (read.value.fault !== undefined) {
        fault = read.value.fault
      } else if (operation.output !== undefined) {
        const output = elementByName(catalog, operation.output)
        const payload = read.value.payload
        if (output !== undefined && payload !== undefined) {
          responseIssues.push(...instanceFromXml(catalog, output, payload).issues)
        } else if (payload === undefined) {
          responseIssues.push({ path: "(response)", detail: "empty Body" })
        }
      }
      if (options.keepRaw === true) {
        yield* workspace.write(
          samplePaths(service, operation.name, name).raw,
          renderXml(stripSecurity(parsedResponse.value))
        )
      }
    }

    const exchange = new Exchange({
      version: 1,
      operation: operation.name,
      name,
      purpose: request.purpose,
      provenance: "call",
      recordedAt: now().toISOString(),
      environment: profile.environment,
      endpoint: displayUrl(address),
      request: new RecordedMessage({ headers: safeHeaders(headers), envelope: maskedRequest.xml }),
      response: new RecordedResponse({
        status: response.status,
        headers: safeHeaders(response.headers),
        envelope: maskedResponse.xml,
        elapsedMs: response.elapsedMs
      }),
      ...(fault === undefined ? {} : { fault }),
      requestIssues: [],
      responseIssues: issueRecords(responseIssues),
      masking: mergeReports([maskedRequest.report, maskedResponse.report])
    })
    const path = yield* writeExchange(workspace, service, exchange)
    return { exchange, path, permission }
  })
