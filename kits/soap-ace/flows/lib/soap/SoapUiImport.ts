import * as Effect from "effect/Effect"
import type { WorkspaceError, WorkspaceShape } from "@llm4ts/flow/Workspace"
import { elementByName, operationByName, type WsdlCatalog } from "./Catalog.ts"
import { readIfPresent } from "./Discover.ts"
import { readEnvelope, stripSecurity } from "./Envelope.ts"
import { instanceFromXml, type Issue } from "./Instance.ts"
import {
  kindsFromCatalog,
  maskDocument,
  maskText,
  type MaskingOverrides,
  MaskingReport,
  mergeReports
} from "./Masking.ts"
import {
  Exchange,
  issueRecords,
  RecordedResponse,
  renderRequestFile,
  samplePaths,
  toSampleName,
  writeExchange
} from "./Samples.ts"
import {
  attribute,
  elements,
  parseXml,
  renderXml,
  textOf,
  type XmlElement,
  type XmlError
} from "./Xml.ts"

// SoapUI / ReadyAPI projects are where bank teams keep their working
// requests. Import turns each saved request (interface calls and test
// steps) into a request file and each mock response into a recorded
// exchange. Everything passes through the masker first: a project copied
// from a shared drive often holds real customer data. Stored credentials
// (`con:credentials`, WS-S passwords) are counted and never read.

export const SoapUiNamespace = "http://eviware.com/soapui/config"

interface FoundMessage {
  readonly operation: string
  readonly label: string
  readonly envelope: string
  readonly kind: "request" | "response"
}

export interface ImportedRequest {
  readonly operation: string
  readonly name: string
  readonly path: string
  readonly issues: ReadonlyArray<Issue>
}

export interface ImportReport {
  readonly requests: ReadonlyArray<ImportedRequest>
  readonly responses: ReadonlyArray<{
    readonly operation: string
    readonly name: string
    readonly path: string
  }>
  readonly skipped: ReadonlyArray<string>
  /** Calls or steps that carried stored credentials; none were imported. */
  readonly credentialsIgnored: number
  readonly masking: MaskingReport
}

const con = (element: XmlElement, local: string): ReadonlyArray<XmlElement> =>
  elements(element).filter(
    (child) => child.name.namespace === SoapUiNamespace && child.name.local === local
  )

const conText = (element: XmlElement, local: string): string | undefined => {
  const found = con(element, local)[0]
  return found === undefined ? undefined : textOf(found)
}

const hasCredentials = (element: XmlElement): boolean => {
  const credentials = con(element, "credentials")[0]
  if (credentials === undefined) return false
  return elements(credentials).some(
    (child) => textOf(child).trim() !== "" && /password|username|token/i.test(child.name.local)
  )
}

/** Every saved request and mock response in a project, with its operation. */
export const findMessages = (
  project: XmlElement
): { readonly messages: ReadonlyArray<FoundMessage>; readonly credentials: number } => {
  const messages: Array<FoundMessage> = []
  let credentials = 0
  for (const iface of con(project, "interface")) {
    for (const operation of con(iface, "operation")) {
      const name = attribute(operation, "name") ?? ""
      for (const call of con(operation, "call")) {
        if (hasCredentials(call)) credentials++
        const envelope = conText(call, "request")
        if (envelope !== undefined && envelope.trim() !== "") {
          messages.push({
            operation: name,
            label: attribute(call, "name") ?? "call",
            envelope,
            kind: "request"
          })
        }
      }
    }
  }
  const walkSuites = (element: XmlElement, path: ReadonlyArray<string>): void => {
    for (const child of elements(element)) {
      if (child.name.namespace !== SoapUiNamespace) continue
      if (child.name.local === "testSuite" || child.name.local === "testCase") {
        walkSuites(child, [...path, attribute(child, "name") ?? child.name.local])
      } else if (child.name.local === "testStep" && attribute(child, "type") === "request") {
        const config = con(child, "config")[0]
        const operation = config === undefined ? undefined : conText(config, "operation")
        const request = config === undefined ? undefined : con(config, "request")[0]
        if (request !== undefined && hasCredentials(request)) credentials++
        const envelope = request === undefined ? undefined : conText(request, "request")
        if (operation !== undefined && envelope !== undefined && envelope.trim() !== "") {
          messages.push({
            operation: operation.trim(),
            label: [...path, attribute(child, "name") ?? "step"].join(" "),
            envelope,
            kind: "request"
          })
        }
      }
    }
  }
  walkSuites(project, [])
  for (const mock of con(project, "mockService")) {
    for (const operation of con(mock, "mockOperation")) {
      const name = attribute(operation, "operation") ?? attribute(operation, "name") ?? ""
      for (const response of con(operation, "response")) {
        const envelope = conText(response, "responseContent")
        if (envelope !== undefined && envelope.trim() !== "") {
          messages.push({
            operation: name,
            label: `mock ${attribute(response, "name") ?? "response"}`,
            envelope,
            kind: "response"
          })
        }
      }
    }
  }
  return { messages, credentials }
}

export interface ImportOptions {
  readonly workspace: WorkspaceShape
  readonly catalog: WsdlCatalog
  readonly service: string
  /** The project file's contents. */
  readonly project: string
  readonly key: Uint8Array
  readonly overrides?: MaskingOverrides
  readonly now?: () => Date
}

export const importSoapUiProject = (
  options: ImportOptions
): Effect.Effect<ImportReport, WorkspaceError | XmlError> =>
  Effect.gen(function* () {
    const { catalog, workspace, service } = options
    const project = yield* parseXml(options.project, { source: "SoapUI project" })
    const { messages, credentials } = findMessages(project)
    const maskOptions = {
      key: options.key,
      typeKinds: kindsFromCatalog(catalog),
      ...(options.overrides === undefined ? {} : { overrides: options.overrides })
    }
    const requests: Array<ImportedRequest> = []
    const responses: Array<{ operation: string; name: string; path: string }> = []
    const skipped: Array<string> = []
    const reports: Array<MaskingReport> = []
    const used = new Set<string>()

    for (const found of messages) {
      // SoapUI labels are free text people type ("Conti di Mario Rossi …"):
      // they reach file names and headers, so they are masked like values.
      const message = { ...found, label: maskText(options.key, found.label).text }
      const operation = operationByName(catalog, message.operation)
      if (operation === undefined) {
        skipped.push(`${message.label}: operation ${message.operation} is not in the catalog`)
        continue
      }
      // SoapUI keeps property expansions (${#Project#iban}) inside the XML
      // text; they parse fine and are reported by validation.
      const parsed = yield* parseXml(message.envelope, { source: message.label }).pipe(
        Effect.option
      )
      if (parsed._tag === "None") {
        skipped.push(`${message.operation} ${message.label}: not well-formed XML`)
        continue
      }
      const masked = maskDocument(stripSecurity(parsed.value), maskOptions)
      reports.push(masked.report)
      const envelope = yield* readEnvelope(masked.document).pipe(Effect.option)
      const payload = envelope._tag === "Some" ? envelope.value.payload : undefined
      let base = toSampleName(`soapui-${message.label}`)
      for (let suffix = 2; used.has(`${message.operation}/${base}`); suffix++) {
        base = `${toSampleName(`soapui-${message.label}`).slice(0, 58)}-${suffix}`
      }
      used.add(`${message.operation}/${base}`)
      const paths = samplePaths(service, message.operation, base)

      if (message.kind === "request") {
        const input = elementByName(catalog, operation.input)
        if (input === undefined || payload === undefined) {
          skipped.push(`${message.operation} ${message.label}: no request body`)
          continue
        }
        if (
          (yield* readIfPresent(workspace, paths.yaml)) !== undefined ||
          (yield* readIfPresent(workspace, paths.xml)) !== undefined
        ) {
          skipped.push(`${message.operation}/${base}: a request file already exists; kept it`)
          continue
        }
        const read = instanceFromXml(catalog, input, payload)
        const placeholders = read.issues.length > 0 && JSON.stringify(read.value).includes('"?"')
        const issues: ReadonlyArray<Issue> = placeholders
          ? [
              { path: "(root)", detail: "SoapUI placeholders (?) are still in this request" },
              ...read.issues
            ]
          : read.issues
        yield* workspace.write(
          paths.yaml,
          renderRequestFile({
            catalog,
            operation: message.operation,
            purpose: `imported from SoapUI: ${message.label}`,
            body: read.value,
            issues
          })
        )
        requests.push({ operation: message.operation, name: base, path: paths.yaml, issues })
      } else {
        const output =
          operation.output === undefined ? undefined : elementByName(catalog, operation.output)
        const responseIssues =
          envelope._tag === "Some" &&
          envelope.value.fault === undefined &&
          output !== undefined &&
          payload !== undefined
            ? instanceFromXml(catalog, output, payload).issues
            : []
        const exchange = new Exchange({
          version: 1,
          operation: message.operation,
          name: base,
          purpose: `SoapUI ${message.label}`,
          provenance: "soapui",
          recordedAt: (options.now ?? (() => new Date()))().toISOString(),
          response: new RecordedResponse({
            status: 200,
            headers: {},
            envelope: renderXml(masked.document),
            elapsedMs: 0
          }),
          ...(envelope._tag === "Some" && envelope.value.fault !== undefined
            ? { fault: envelope.value.fault }
            : {}),
          requestIssues: [],
          responseIssues: issueRecords(responseIssues),
          masking: masked.report
        })
        const path = yield* writeExchange(workspace, service, exchange)
        responses.push({ operation: message.operation, name: base, path })
      }
    }
    return {
      requests,
      responses,
      skipped,
      credentialsIgnored: credentials,
      masking:
        reports.length === 0 ? new MaskingReport({ entries: [], kept: [] }) : mergeReports(reports)
    }
  })
