import { basename } from "node:path"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { JudgmentShape } from "@llm4ts/core/judgment/Judgment"
import type { WorkspaceError, WorkspaceShape } from "@llm4ts/flow/Workspace"
import {
  ComplexTypeDef,
  elementByName,
  localName,
  type Operation,
  splitClark,
  typeByName,
  WsdlCatalog
} from "./Catalog.ts"
import type { OperationsFileError } from "./Classification.ts"
import {
  type ClassProposal,
  classifyOperations,
  type OperationsFile,
  operationsDrift,
  parseOperationsFile,
  renderOperationsFile
} from "./Classification.ts"
import { type DocumentLoader, type DocumentLoadError, readCatalog, type WsdlError } from "./Wsdl.ts"
import type { XmlError } from "./Xml.ts"

// `soap-discover` as a library call: read the catalog, persist it with a
// human summary, and propose operation classes unless a classification file
// already exists (the existing file wins, as every approval file does).

export class CatalogFileError extends Schema.TaggedError<CatalogFileError>()("CatalogFileError", {
  path: Schema.String,
  detail: Schema.String
}) {
  get message(): string {
    return `${this.path}: ${this.detail}`
  }
}

/** `.llm4ts/soap/<service>` */
export const serviceDirectory = (service: string): string => `.llm4ts/soap/${service}`

export const servicePaths = (service: string) => {
  const directory = serviceDirectory(service)
  return {
    directory,
    catalog: `${directory}/catalog.json`,
    summary: `${directory}/catalog.md`,
    operations: `${directory}/operations.md`
  }
}

/** A directory-safe service name: explicit, else the WSDL's service, else the file name. */
export const serviceName = (
  catalog: WsdlCatalog,
  location: string,
  explicit: string | undefined
): string => {
  const raw =
    explicit ??
    catalog.endpoints[0]?.service ??
    basename(location.replace(/[?#].*$/, "")).replace(/\.[^.]*$/, "")
  const safe = raw.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return safe === "" ? "service" : safe
}

export const readIfPresent = (
  workspace: WorkspaceShape,
  path: string
): Effect.Effect<string | undefined, WorkspaceError> =>
  Effect.flatMap(workspace.discover(path), (found) =>
    found.includes(path) ? workspace.read(path) : Effect.succeed(undefined)
  )

export const encodeCatalog = (catalog: WsdlCatalog): string =>
  `${JSON.stringify(Schema.encodeSync(WsdlCatalog)(catalog), null, 2)}\n`

export const loadCatalog = (
  workspace: WorkspaceShape,
  service: string
): Effect.Effect<WsdlCatalog, WorkspaceError | CatalogFileError> => {
  const path = servicePaths(service).catalog
  return Effect.flatMap(workspace.read(path), (text) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(WsdlCatalog))(text).pipe(
      Effect.mapError(
        (error) => new CatalogFileError({ path, detail: `not a catalog: ${error.message}` })
      )
    )
  )
}

export const loadOperationsFile = (
  workspace: WorkspaceShape,
  service: string
): Effect.Effect<OperationsFile | undefined, WorkspaceError | OperationsFileError> =>
  Effect.flatMap(readIfPresent(workspace, servicePaths(service).operations), (text) =>
    text === undefined ? Effect.succeed(undefined) : parseOperationsFile(text)
  )

const occurs = (min: number, max: number | "unbounded"): string =>
  max === "unbounded" ? `${min}..*` : min === max ? `${min}` : `${min}..${max}`

const fieldLines = (catalog: WsdlCatalog, element: string | undefined): ReadonlyArray<string> => {
  if (element === undefined) return ["  (none)"]
  const declared = elementByName(catalog, element)
  const type = typeByName(catalog, declared?.type ?? "")
  if (!(type instanceof ComplexTypeDef)) {
    return [`  - value: ${localName(declared?.type ?? element)}`]
  }
  return type.fields.map(
    (field) =>
      `  - ${field.name}: ${localName(field.type)} [${occurs(field.minOccurs, field.maxOccurs)}]${field.nillable ? " nillable" : ""}`
  )
}

const operationSection = (catalog: WsdlCatalog, operation: Operation): ReadonlyArray<string> => [
  `### ${operation.name}`,
  "",
  ...(operation.documentation === undefined ? [] : [operation.documentation, ""]),
  `- SOAPAction: \`${operation.soapAction}\``,
  `- SOAP ${operation.soapVersion}, binding ${operation.binding}, ${operation.wrapped ? "wrapped" : "bare"}`,
  `- request \`${localName(operation.input)}\`:`,
  ...fieldLines(catalog, operation.input),
  `- response \`${operation.output === undefined ? "(one-way)" : localName(operation.output)}\`:`,
  ...fieldLines(catalog, operation.output),
  `- faults: ${operation.faults.length === 0 ? "none" : operation.faults.map((fault) => `${fault.name} (${localName(fault.element)})`).join(", ")}`,
  ""
]

export const renderCatalogSummary = (service: string, catalog: WsdlCatalog): string => {
  const namedTypes = catalog.types.filter((type) => !type.anonymous)
  const namespaces = [...new Set(catalog.types.map((type) => splitClark(type.name).namespace))]
  return [
    `# SOAP catalog: ${service}`,
    "",
    `WSDL ${catalog.wsdlVersion}, target namespace \`${catalog.targetNamespace}\`. Generated by`,
    "`soap-discover` from the documents below; regenerate rather than edit.",
    "",
    "## Summary",
    "",
    `- ${catalog.operations.length} operations, ${catalog.endpoints.length} endpoints`,
    `- ${namedTypes.length} named types, ${catalog.elements.length} global elements across ${namespaces.length} namespaces`,
    `- ${catalog.openQuestions.length} open questions`,
    "",
    "## Documents",
    "",
    ...catalog.documents.map((document) => `- ${document}`),
    "",
    "## Endpoints",
    "",
    ...(catalog.endpoints.length === 0
      ? ["(none declared)"]
      : catalog.endpoints.map(
          (endpoint) =>
            `- ${endpoint.service}/${endpoint.port} — SOAP ${endpoint.soapVersion} — ${endpoint.address}`
        )),
    "",
    "## Open questions",
    "",
    ...(catalog.openQuestions.length === 0
      ? ["None: every construct in the WSDL and its schemas is modelled."]
      : catalog.openQuestions.map(
          (question) =>
            `- **${question.code}** ${question.subject} (${question.location}): ${question.detail}`
        )),
    "",
    "## Operations",
    "",
    ...catalog.operations.flatMap((operation) => operationSection(catalog, operation))
  ].join("\n")
}

export interface DiscoverOptions {
  readonly workspace: WorkspaceShape
  /** WSDL path or URL, as the loader understands it. */
  readonly location: string
  readonly service?: string
  readonly judgment?: JudgmentShape
}

export interface DiscoverResult {
  readonly service: string
  readonly paths: ReturnType<typeof servicePaths>
  readonly catalog: WsdlCatalog
  /** Present when `operations.md` was written by this run. */
  readonly proposals: ReadonlyArray<ClassProposal> | undefined
  /** Present when an existing `operations.md` was kept. */
  readonly existing: OperationsFile | undefined
  readonly drift: {
    readonly missing: ReadonlyArray<string>
    readonly unknown: ReadonlyArray<string>
  }
}

export const discoverService = (
  options: DiscoverOptions
): Effect.Effect<
  DiscoverResult,
  DocumentLoadError | XmlError | WsdlError | WorkspaceError | OperationsFileError,
  DocumentLoader
> =>
  Effect.gen(function* () {
    const catalog = yield* readCatalog(options.location)
    const service = serviceName(catalog, options.location, options.service)
    const paths = servicePaths(service)
    yield* options.workspace.write(paths.catalog, encodeCatalog(catalog))
    yield* options.workspace.write(paths.summary, renderCatalogSummary(service, catalog))

    const existing = yield* loadOperationsFile(options.workspace, service)
    if (existing !== undefined) {
      return {
        service,
        paths,
        catalog,
        proposals: undefined,
        existing,
        drift: operationsDrift(existing, catalog)
      }
    }
    const proposals = yield* classifyOperations(catalog, options.judgment)
    yield* options.workspace.write(
      paths.operations,
      renderOperationsFile(service, catalog, proposals)
    )
    return {
      service,
      paths,
      catalog,
      proposals,
      existing: undefined,
      drift: { missing: [], unknown: [] }
    }
  })
