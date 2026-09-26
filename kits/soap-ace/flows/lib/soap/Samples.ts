import { randomBytes } from "node:crypto"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { WorkspaceError, WorkspaceShape } from "@llm4ts/flow/Workspace"
import { elementByName, operationByName, type WsdlCatalog } from "./Catalog.ts"
import { readIfPresent, serviceDirectory, servicePaths } from "./Discover.ts"
import { readEnvelope, SoapFault } from "./Envelope.ts"
import { instanceFromXml, type Issue, skeletonYaml } from "./Instance.ts"
import { MaskingOverrides, MaskingReport } from "./Masking.ts"
import { parseXml, type XmlError } from "./Xml.ts"
import { isYamlMap, parseYaml, renderYaml, type YamlError, type YamlValue } from "./Yaml.ts"

// Request files and recorded exchanges under `.llm4ts/soap/<service>/`:
//
//   samples/<operation>/<name>.request.yaml   the user's request (primary form)
//   samples/<operation>/<name>.request.xml    or the raw body element / envelope
//   samples/<operation>/<name>.exchange.json  one masked request/response pair
//   raw/<operation>/<name>.response.xml       only with --keep-raw (gitignored)
//   .masking-key                               the service's pseudonym key (gitignored)
//
// Exchanges are always masked and auth-stripped before they are written.

export const Provenance = Schema.Literals(["call", "soapui"])
export type Provenance = typeof Provenance.Type

export class IssueRecord extends Schema.Class<IssueRecord>("IssueRecord")({
  path: Schema.String,
  detail: Schema.String
}) {}

export class RecordedMessage extends Schema.Class<RecordedMessage>("RecordedMessage")({
  headers: Schema.Record(Schema.String, Schema.String),
  /** The masked envelope, security headers removed. */
  envelope: Schema.String
}) {}

export class RecordedResponse extends Schema.Class<RecordedResponse>("RecordedResponse")({
  status: Schema.Int,
  headers: Schema.Record(Schema.String, Schema.String),
  envelope: Schema.String,
  elapsedMs: Schema.Int
}) {}

export class Exchange extends Schema.Class<Exchange>("Exchange")({
  version: Schema.Literal(1),
  operation: Schema.String,
  name: Schema.String,
  purpose: Schema.String,
  provenance: Provenance,
  recordedAt: Schema.String,
  environment: Schema.optionalKey(Schema.String),
  /** Endpoint without query string or credentials. */
  endpoint: Schema.optionalKey(Schema.String),
  request: Schema.optionalKey(RecordedMessage),
  response: Schema.optionalKey(RecordedResponse),
  fault: Schema.optionalKey(SoapFault),
  requestIssues: Schema.Array(IssueRecord),
  /** Where the response breaks its schema; findings, not errors. */
  responseIssues: Schema.Array(IssueRecord),
  masking: MaskingReport
}) {}

export class SampleError extends Schema.TaggedError<SampleError>()("SampleError", {
  path: Schema.String,
  detail: Schema.String
}) {
  get message(): string {
    return `${this.path}: ${this.detail}`
  }
}

export const isSampleName = (name: string): boolean => /^[a-z0-9][a-z0-9-]{0,62}$/.test(name)

export const toSampleName = (raw: string): string =>
  raw
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63) || "sample"

export const samplePaths = (service: string, operation: string, name: string) => {
  const directory = `${serviceDirectory(service)}/samples/${operation}`
  return {
    directory,
    yaml: `${directory}/${name}.request.yaml`,
    xml: `${directory}/${name}.request.xml`,
    exchange: `${directory}/${name}.exchange.json`,
    raw: `${serviceDirectory(service)}/raw/${operation}/${name}.response.xml`
  }
}

// ---------------------------------------------------------------------------
// Request files

export const renderRequestFile = (options: {
  readonly catalog: WsdlCatalog
  readonly operation: string
  readonly purpose: string
  /** A concrete body (scenario, import); absent → the commented skeleton. */
  readonly body?: YamlValue
  readonly seeds?: ReadonlyMap<string, string>
  /** Validation problems to show at the top of the file. */
  readonly issues?: ReadonlyArray<Issue>
}): string => {
  const operation = operationByName(options.catalog, options.operation)
  const input =
    operation === undefined ? undefined : elementByName(options.catalog, operation.input)
  const header = [
    `# ${options.operation}: ${options.purpose}`,
    '# Edit the values, then: llm4ts run soap-sample "call <operation>/<name>"',
    "# Optional fields are commented out; uncomment to send them. `~` sends xsi:nil.",
    ...(options.issues === undefined || options.issues.length === 0
      ? []
      : [
          "#",
          "# To fix before calling:",
          ...options.issues.map((issue) => `#   ${issue.path}: ${issue.detail}`)
        ])
  ]
  // A body that is not a non-empty map or list is written inline (`body: {}`),
  // never as an indented block the reader would not accept.
  const inline =
    options.body !== undefined &&
    !(
      (isYamlMap(options.body) && Object.keys(options.body).length > 0) ||
      (Array.isArray(options.body) && options.body.length > 0)
    )
  const body =
    options.body !== undefined
      ? inline
        ? []
        : renderYaml(options.body, 2).trimEnd().split("\n")
      : input === undefined
        ? []
        : skeletonYaml(
            options.catalog,
            input,
            2,
            options.seeds === undefined ? {} : { seeds: options.seeds }
          )
  const bodyKey =
    options.body !== undefined && inline ? `body: ${renderYaml(options.body).trim()}` : "body:"
  return [
    ...header,
    `operation: ${options.operation}`,
    `purpose: ${JSON.stringify(options.purpose)}`,
    bodyKey,
    ...body,
    ""
  ].join("\n")
}

export interface RequestFile {
  readonly purpose: string
  readonly body: YamlValue
  readonly form: "yaml" | "xml"
  /** Problems reading an XML form against the schema (namespaces, unknown elements). */
  readonly readIssues: ReadonlyArray<Issue>
}

export const readRequestFile = (
  workspace: WorkspaceShape,
  catalog: WsdlCatalog,
  service: string,
  operation: string,
  name: string
): Effect.Effect<RequestFile, SampleError | WorkspaceError | YamlError | XmlError> =>
  Effect.gen(function* () {
    const paths = samplePaths(service, operation, name)
    const yaml = yield* readIfPresent(workspace, paths.yaml)
    const xml = yield* readIfPresent(workspace, paths.xml)
    if (yaml !== undefined && xml !== undefined) {
      return yield* new SampleError({
        path: paths.directory,
        detail: `${name} has both a .yaml and an .xml request; keep one`
      })
    }
    if (yaml !== undefined) {
      const document = yield* parseYaml(yaml)
      if (!isYamlMap(document) || document["body"] === undefined) {
        return yield* new SampleError({
          path: paths.yaml,
          detail: "expected operation:, purpose:, and body:"
        })
      }
      if (document["operation"] !== undefined && document["operation"] !== operation) {
        return yield* new SampleError({
          path: paths.yaml,
          detail: `operation: says ${String(document["operation"])}, the file sits under ${operation}`
        })
      }
      const purpose = typeof document["purpose"] === "string" ? document["purpose"] : name
      return { purpose, body: document["body"] ?? null, form: "yaml" as const, readIssues: [] }
    }
    if (xml !== undefined) {
      const declared = operationByName(catalog, operation)
      const input = declared === undefined ? undefined : elementByName(catalog, declared.input)
      if (input === undefined) {
        return yield* new SampleError({
          path: paths.xml,
          detail: `${operation} is not in the catalog`
        })
      }
      const root = yield* parseXml(xml, { source: paths.xml })
      const envelope = yield* readEnvelope(root).pipe(Effect.option)
      const bodyElement = envelope._tag === "Some" ? envelope.value.payload : root
      if (bodyElement === undefined) {
        return yield* new SampleError({ path: paths.xml, detail: "the envelope Body is empty" })
      }
      const read = instanceFromXml(catalog, input, bodyElement)
      const purpose = /<!--\s*purpose:\s*([\s\S]*?)-->/.exec(xml)?.[1]?.trim() ?? name
      return { purpose, body: read.value, form: "xml" as const, readIssues: read.issues }
    }
    return yield* new SampleError({
      path: paths.directory,
      detail: `no request ${name}; create one with: soap-sample "init ${operation} ${name}"`
    })
  })

/** Request names under an operation, from either form. */
export const listRequests = (
  workspace: WorkspaceShape,
  service: string,
  operation: string
): Effect.Effect<ReadonlyArray<string>, WorkspaceError> =>
  Effect.map(
    workspace.discover(`${serviceDirectory(service)}/samples/${operation}/*.request.*`),
    (files) =>
      [
        ...new Set(
          files.map((file) => (file.split("/").pop() ?? "").replace(/\.request\.(yaml|xml)$/, ""))
        )
      ].sort()
  )

// ---------------------------------------------------------------------------
// Exchanges

export const encodeExchange = (exchange: Exchange): string =>
  `${JSON.stringify(Schema.encodeSync(Exchange)(exchange), null, 2)}\n`

export const writeExchange = (
  workspace: WorkspaceShape,
  service: string,
  exchange: Exchange
): Effect.Effect<string, WorkspaceError> => {
  const path = samplePaths(service, exchange.operation, exchange.name).exchange
  return Effect.as(workspace.write(path, encodeExchange(exchange)), path)
}

export const readExchanges = (
  workspace: WorkspaceShape,
  service: string,
  operation?: string
): Effect.Effect<ReadonlyArray<Exchange>, WorkspaceError | SampleError> =>
  Effect.gen(function* () {
    const pattern = `${serviceDirectory(service)}/samples/${operation ?? "*"}/*.exchange.json`
    const files = [...(yield* workspace.discover(pattern))].sort()
    return yield* Effect.forEach(files, (file) =>
      Effect.flatMap(workspace.read(file), (text) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Exchange))(text).pipe(
          Effect.mapError(
            (error) => new SampleError({ path: file, detail: `not an exchange: ${error.message}` })
          )
        )
      )
    )
  })

// ---------------------------------------------------------------------------
// Masking key and overrides

const keyPath = (service: string) => `${serviceDirectory(service)}/.masking-key`

/**
 * The service's pseudonym key: 32 random bytes, created on first use and
 * kept (gitignored) so pseudonyms stay stable across runs.
 */
export const loadMaskingKey = (
  workspace: WorkspaceShape,
  service: string,
  random: (size: number) => Uint8Array = (size) => new Uint8Array(randomBytes(size))
): Effect.Effect<Uint8Array, WorkspaceError | SampleError> =>
  Effect.gen(function* () {
    const existing = yield* readIfPresent(workspace, keyPath(service))
    if (existing !== undefined) {
      const hex = existing.trim()
      if (!/^[0-9a-f]{64}$/.test(hex)) {
        return yield* new SampleError({ path: keyPath(service), detail: "not a 64-digit hex key" })
      }
      return Uint8Array.from(Buffer.from(hex, "hex"))
    }
    const key = random(32)
    yield* workspace.write(keyPath(service), `${Buffer.from(key).toString("hex")}\n`)
    yield* workspace.write(
      servicePaths(service).gitignore,
      ["auth.json", "raw/", ".masking-key", ""].join("\n")
    )
    return key
  })

export const loadMaskingOverrides = (
  workspace: WorkspaceShape,
  service: string
): Effect.Effect<MaskingOverrides | undefined, WorkspaceError | SampleError> => {
  const path = servicePaths(service).masking
  return Effect.flatMap(readIfPresent(workspace, path), (text) =>
    text === undefined
      ? Effect.succeed(undefined)
      : Schema.decodeUnknownEffect(Schema.fromJsonString(MaskingOverrides))(text).pipe(
          Effect.mapError(
            () =>
              new SampleError({
                path,
                detail: 'expected { "fields": { "<element>": "mask" | "keep" } }'
              })
          )
        )
  )
}

/** First value seen per field name across request bodies; SoapUI `${...}` expansions skipped. */
export const collectSeeds = (bodies: ReadonlyArray<YamlValue>): ReadonlyMap<string, string> => {
  const seeds = new Map<string, string>()
  const collect = (value: YamlValue): void => {
    if (value === null || typeof value === "string") return
    if (Array.isArray(value)) {
      for (const item of value) collect(item)
      return
    }
    if (!isYamlMap(value)) return
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string") {
        if (!seeds.has(key) && !item.includes("${") && item !== "?") seeds.set(key, item)
      } else collect(item)
    }
  }
  for (const body of bodies) collect(body)
  return seeds
}

/** Request bodies of recorded exchanges (already masked). */
export const bodiesFromExchanges = (
  exchanges: ReadonlyArray<Exchange>,
  catalog: WsdlCatalog
): Effect.Effect<ReadonlyArray<YamlValue>> =>
  Effect.gen(function* () {
    const bodies: Array<YamlValue> = []
    for (const exchange of exchanges) {
      if (exchange.request === undefined) continue
      const operation = operationByName(catalog, exchange.operation)
      const input = operation === undefined ? undefined : elementByName(catalog, operation.input)
      if (input === undefined) continue
      const parsed = yield* parseXml(exchange.request.envelope).pipe(Effect.option)
      if (parsed._tag === "None") continue
      const envelope = yield* readEnvelope(parsed.value).pipe(Effect.option)
      const payload = envelope._tag === "Some" ? envelope.value.payload : undefined
      if (payload !== undefined) bodies.push(instanceFromXml(catalog, input, payload).value)
    }
    return bodies
  })

/** Values seen in earlier requests, by field name, to seed new skeletons. */
export const seedsFromExchanges = (
  exchanges: ReadonlyArray<Exchange>,
  catalog: WsdlCatalog
): Effect.Effect<ReadonlyMap<string, string>> =>
  Effect.map(bodiesFromExchanges(exchanges, catalog), collectSeeds)

/**
 * Seeds from everything on disk for the service: recorded exchanges first
 * (values the service answered to), then request files (imported ones are
 * masked). Unreadable request files are skipped.
 */
export const seedsForService = (
  workspace: WorkspaceShape,
  catalog: WsdlCatalog,
  service: string
): Effect.Effect<ReadonlyMap<string, string>, WorkspaceError | SampleError> =>
  Effect.gen(function* () {
    const fromExchanges = yield* bodiesFromExchanges(
      yield* readExchanges(workspace, service),
      catalog
    )
    const fromFiles: Array<YamlValue> = []
    for (const operation of catalog.operations) {
      for (const name of yield* listRequests(workspace, service, operation.name)) {
        const request = yield* readRequestFile(
          workspace,
          catalog,
          service,
          operation.name,
          name
        ).pipe(Effect.option)
        if (request._tag === "Some") fromFiles.push(request.value.body)
      }
    }
    return collectSeeds([...fromExchanges, ...fromFiles])
  })

export const issueRecords = (issues: ReadonlyArray<Issue>): ReadonlyArray<IssueRecord> =>
  issues.map((issue) => new IssueRecord(issue))
