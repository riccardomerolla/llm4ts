import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  ComplexTypeDef,
  type ElementDecl,
  elementByName,
  operationByName,
  type QName,
  typeByName,
  type WsdlCatalog
} from "./Catalog.ts"
import { readEnvelope } from "./Envelope.ts"
import { instanceFromXml, simpleView } from "./Instance.ts"
import type { WorkspaceError, WorkspaceShape } from "@llm4ts/flow/Workspace"
import { serviceDirectory } from "./Discover.ts"
import { type Exchange, readExchanges, type SampleError } from "./Samples.ts"
import { parseXml } from "./Xml.ts"
import { isYamlList, isYamlMap, type YamlValue } from "./Yaml.ts"

// Response analysis: what the recorded exchanges of one operation show about
// its real behaviour, as evidence the REST design must cite. Everything is
// computed from masked samples; nothing here calls a model. Paths use `[]`
// for repeated elements (`conto[].saldo.valore`).

export class FieldStats extends Schema.Class<FieldStats>("FieldStats")({
  path: Schema.String,
  /** From the schema, relative to the parent element: can the field be absent, and repeat? */
  optional: Schema.Boolean,
  repeated: Schema.Boolean,
  /** Responses in which the path appears at least once. */
  presentIn: Schema.Int,
  /** Occurrences with an empty string / xsi:nil. */
  empty: Schema.Int,
  nil: Schema.Int,
  occurrences: Schema.Int,
  /** Up to 12 distinct values (masked), most frequent first. */
  values: Schema.Array(Schema.Struct({ value: Schema.String, count: Schema.Int })),
  distinct: Schema.Int,
  /** Declared enumeration, when there is one. */
  declared: Schema.optionalKey(Schema.Array(Schema.String)),
  maxLength: Schema.Int,
  /** For repeated elements: the most items seen in one response. */
  maxItems: Schema.optionalKey(Schema.Int)
}) {}

export class OutcomeCode extends Schema.Class<OutcomeCode>("OutcomeCode")({
  code: Schema.String,
  description: Schema.optionalKey(Schema.String),
  count: Schema.Int,
  samples: Schema.Array(Schema.String)
}) {}

export class FaultStats extends Schema.Class<FaultStats>("FaultStats")({
  code: Schema.String,
  reason: Schema.String,
  detailElement: Schema.optionalKey(Schema.String),
  count: Schema.Int,
  samples: Schema.Array(Schema.String)
}) {}

export class FindingStats extends Schema.Class<FindingStats>("FindingStats")({
  path: Schema.String,
  detail: Schema.String,
  count: Schema.Int
}) {}

export class Pagination extends Schema.Class<Pagination>("Pagination")({
  style: Schema.Literals(["page-number", "offset", "cursor"]),
  requestFields: Schema.Array(Schema.String),
  responseFields: Schema.Array(Schema.String),
  /** The repeated element being paged, when one is evident. */
  items: Schema.optionalKey(Schema.String),
  observed: Schema.String
}) {}

export class OperationAnalysis extends Schema.Class<OperationAnalysis>("OperationAnalysis")({
  version: Schema.Literal(1),
  operation: Schema.String,
  exchanges: Schema.Int,
  fromCalls: Schema.Int,
  fromSoapUi: Schema.Int,
  httpStatuses: Schema.Array(Schema.Struct({ status: Schema.Int, count: Schema.Int })),
  faults: Schema.Array(FaultStats),
  outcomes: Schema.Array(OutcomeCode),
  fields: Schema.Array(FieldStats),
  /** Response fields the schema declares but no sample ever carried. */
  neverObserved: Schema.Array(Schema.String),
  /** Optional request fields no sample request used. */
  requestFieldsUnused: Schema.Array(Schema.String),
  findings: Schema.Array(FindingStats),
  pagination: Schema.optionalKey(Pagination),
  latencyMs: Schema.optionalKey(
    Schema.Struct({ min: Schema.Int, median: Schema.Int, max: Schema.Int })
  ),
  /** Plain statements the design should consider, derived from the numbers above. */
  observations: Schema.Array(Schema.String)
}) {}

// ---------------------------------------------------------------------------
// Schema paths

interface SchemaPath {
  readonly path: string
  readonly type: QName
  readonly optional: boolean
  readonly repeated: boolean
  readonly leaf: boolean
}

export const schemaPaths = (
  catalog: WsdlCatalog,
  element: ElementDecl,
  maxDepth = 8
): ReadonlyArray<SchemaPath> => {
  const paths: Array<SchemaPath> = []
  const walk = (
    typeName: QName,
    prefix: string,
    optional: boolean,
    depth: number,
    seen: ReadonlySet<QName>
  ): void => {
    const type = typeByName(catalog, typeName)
    if (!(type instanceof ComplexTypeDef) || depth > maxDepth || seen.has(typeName)) return
    const next = new Set([...seen, typeName])
    for (const attribute of type.attributes) {
      paths.push({
        path: `${prefix}@${attribute.name}`,
        type: attribute.type,
        optional: !attribute.required,
        repeated: false,
        leaf: true
      })
    }
    for (const field of type.fields) {
      const repeated = field.maxOccurs === "unbounded" || field.maxOccurs > 1
      const path = `${prefix}${field.name}${repeated ? "[]" : ""}`
      const fieldOptional = field.minOccurs === 0 || field.choice !== undefined
      const child = typeByName(catalog, field.type)
      const leaf = !(child instanceof ComplexTypeDef) || child.textType !== undefined
      paths.push({ path, type: field.type, optional: fieldOptional, repeated, leaf })
      if (!leaf) walk(field.type, `${path}.`, fieldOptional, depth + 1, next)
    }
  }
  walk(element.type, "", false, 1, new Set())
  return paths
}

// ---------------------------------------------------------------------------
// Collecting

interface Accumulator {
  presentIn: number
  empty: number
  nil: number
  occurrences: number
  values: Map<string, number>
  maxLength: number
  maxItems: number
}

const newAccumulator = (): Accumulator => ({
  presentIn: 0,
  empty: 0,
  nil: 0,
  occurrences: 0,
  values: new Map(),
  maxLength: 0,
  maxItems: 0
})

/** Leaf and container occurrences of one value, keyed by normalized path. */
const flatten = (
  value: YamlValue,
  prefix: string,
  into: Map<string, Array<YamlValue>>,
  counts: Map<string, number>
): void => {
  if (!isYamlMap(value)) return
  for (const [key, item] of Object.entries(value)) {
    if (key === "#text") continue
    if (isYamlList(item)) {
      const path = `${prefix}${key}[]`
      counts.set(path, Math.max(counts.get(path) ?? 0, item.length))
      for (const entry of item) {
        into.set(path, [...(into.get(path) ?? []), entry])
        flatten(entry, `${path}.`, into, counts)
      }
    } else {
      const path = `${prefix}${key}`
      into.set(path, [...(into.get(path) ?? []), item])
      flatten(item, `${path}.`, into, counts)
    }
  }
}

const bodyOf = (
  catalog: WsdlCatalog,
  envelopeXml: string | undefined,
  element: ElementDecl | undefined
): Effect.Effect<YamlValue | undefined> =>
  envelopeXml === undefined || envelopeXml === "" || element === undefined
    ? Effect.succeed(undefined)
    : Effect.gen(function* () {
        const parsed = yield* parseXml(envelopeXml).pipe(Effect.option)
        if (parsed._tag === "None") return undefined
        const envelope = yield* readEnvelope(parsed.value).pipe(Effect.option)
        if (envelope._tag === "None" || envelope.value.fault !== undefined) return undefined
        const payload = envelope.value.payload
        return payload === undefined ? undefined : instanceFromXml(catalog, element, payload).value
      })

const outcomePath =
  /(^|\.)(esito|outcome|result|risultato)\.(codice|code|returnCode)$|(^|\.)(codiceEsito|returnCode|resultCode|codiceRitorno)$/i
const outcomeDescription = (path: string): ReadonlyArray<string> => {
  const base = path.replace(/[^.]+$/, "")
  return ["descrizione", "description", "messaggio", "message"].map((name) => `${base}${name}`)
}

const pageRequest = /^(.*\.)?(numeroPagina|pagina|page|pageNumber|pageNo)$/i
const pageSize =
  /^(.*\.)?(dimensionePagina|numeroRecord|pageSize|size|limit|maxRecords|maxResults)$/i
const offsetRequest = /^(.*\.)?(offset|startIndex|primoRecord|daRecord|firstRecord)$/i
const cursorField =
  /^(.*\.)?(cursor|continuationToken|nextToken|chiaveRiposizionamento|chiavePaginazione|pagingKey|nextKey)$/i
const lastPageField = /^(.*\.)?(ultimaPagina|lastPage|hasMore|altriDati|moreData|isLast)$/i
const totalField = /^(.*\.)?(totaleRecord|totalRecords|total|totalCount|totaleElementi)$/i

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0
}

export const analyseOperation = (
  catalog: WsdlCatalog,
  operationName: string,
  exchanges: ReadonlyArray<Exchange>
): Effect.Effect<OperationAnalysis> =>
  Effect.gen(function* () {
    const operation = operationByName(catalog, operationName)
    const input = operation === undefined ? undefined : elementByName(catalog, operation.input)
    const output =
      operation?.output === undefined ? undefined : elementByName(catalog, operation.output)
    const mine = exchanges.filter((exchange) => exchange.operation === operationName)

    const statuses = new Map<number, number>()
    const faults = new Map<
      string,
      {
        code: string
        reason: string
        detailElement?: string
        count: number
        samples: Array<string>
      }
    >()
    const outcomes = new Map<
      string,
      { description?: string; count: number; samples: Array<string> }
    >()
    const findings = new Map<string, number>()
    const accumulators = new Map<string, Accumulator>()
    const requestSeen = new Set<string>()
    const latencies: Array<number> = []
    const itemCounts = new Map<string, Array<number>>()
    let lastPageTrue = 0
    let lastPageFalse = 0

    for (const exchange of mine) {
      if (exchange.response !== undefined && exchange.provenance === "call") {
        statuses.set(exchange.response.status, (statuses.get(exchange.response.status) ?? 0) + 1)
        latencies.push(exchange.response.elapsedMs)
      }
      for (const issue of exchange.responseIssues) {
        const detail = issue.detail.replace(/"[^"]*"/g, '"…"')
        const key = `${issue.path.replace(/\[\d+\]/g, "[]")}\u0000${detail}`
        findings.set(key, (findings.get(key) ?? 0) + 1)
      }
      if (exchange.fault !== undefined) {
        const key = `${exchange.fault.code}\u0000${exchange.fault.detailElement ?? ""}\u0000${exchange.fault.reason}`
        const entry = faults.get(key) ?? {
          code: exchange.fault.code,
          reason: exchange.fault.reason,
          ...(exchange.fault.detailElement === undefined
            ? {}
            : { detailElement: exchange.fault.detailElement }),
          count: 0,
          samples: []
        }
        entry.count++
        entry.samples.push(exchange.name)
        faults.set(key, entry)
        continue
      }

      const request = yield* bodyOf(catalog, exchange.request?.envelope, input)
      if (request !== undefined) {
        const flat = new Map<string, Array<YamlValue>>()
        flatten(request, "", flat, new Map())
        for (const path of flat.keys()) requestSeen.add(path)
      }

      const response = yield* bodyOf(catalog, exchange.response?.envelope, output)
      if (response === undefined) continue
      const flat = new Map<string, Array<YamlValue>>()
      const counts = new Map<string, number>()
      flatten(response, "", flat, counts)
      for (const [path, count] of counts)
        itemCounts.set(path, [...(itemCounts.get(path) ?? []), count])
      for (const [path, values] of flat) {
        const accumulator = accumulators.get(path) ?? newAccumulator()
        accumulator.presentIn++
        accumulator.maxItems = Math.max(accumulator.maxItems, counts.get(path) ?? 0)
        for (const value of values) {
          accumulator.occurrences++
          if (value === null) accumulator.nil++
          else if (typeof value === "string") {
            if (value.trim() === "") accumulator.empty++
            accumulator.values.set(value, (accumulator.values.get(value) ?? 0) + 1)
            accumulator.maxLength = Math.max(accumulator.maxLength, [...value].length)
          }
        }
        accumulators.set(path, accumulator)
        if (outcomePath.test(path)) {
          for (const value of values) {
            if (typeof value !== "string") continue
            const description = outcomeDescription(path)
              .map((candidate) => flat.get(candidate)?.[0])
              .find(
                (candidate): candidate is string =>
                  typeof candidate === "string" && candidate !== ""
              )
            const entry = outcomes.get(value) ?? { count: 0, samples: [] }
            entry.count++
            entry.samples.push(exchange.name)
            if (entry.description === undefined && description !== undefined)
              entry.description = description
            outcomes.set(value, entry)
          }
        }
        if (lastPageField.test(path)) {
          for (const value of values) {
            if (value === "true" || value === "1" || value === "S") lastPageTrue++
            else if (value === "false" || value === "0" || value === "N") lastPageFalse++
          }
        }
      }
    }

    const responsePaths = output === undefined ? [] : schemaPaths(catalog, output)
    const withResponse =
      [...accumulators.values()].length === 0
        ? 0
        : Math.max(...[...accumulators.values()].map((entry) => entry.presentIn))
    const fields = responsePaths
      .filter((schemaPath) => accumulators.has(schemaPath.path))
      .map((schemaPath) => {
        const accumulator = accumulators.get(schemaPath.path) ?? newAccumulator()
        const sorted = [...accumulator.values].sort(
          (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
        )
        const declared = schemaPath.leaf
          ? simpleView(catalog, schemaPath.type).facets.find(
              (facets) => facets.enumeration !== undefined
            )?.enumeration
          : undefined
        return new FieldStats({
          path: schemaPath.path,
          optional: schemaPath.optional,
          repeated: schemaPath.repeated,
          presentIn: accumulator.presentIn,
          empty: accumulator.empty,
          nil: accumulator.nil,
          occurrences: accumulator.occurrences,
          values: schemaPath.leaf
            ? sorted.slice(0, 12).map(([value, count]) => ({ value, count }))
            : [],
          distinct: schemaPath.leaf ? sorted.length : 0,
          ...(declared === undefined ? {} : { declared }),
          maxLength: accumulator.maxLength,
          ...(schemaPath.repeated ? { maxItems: accumulator.maxItems } : {})
        })
      })
    const neverObserved = responsePaths
      .filter((schemaPath) => !accumulators.has(schemaPath.path))
      .map((schemaPath) => schemaPath.path)
      .filter(
        (path, _, all) => !all.some((other) => other !== path && path.startsWith(`${other}.`))
      )
    const requestPaths = input === undefined ? [] : schemaPaths(catalog, input)
    const requestFieldsUnused = requestPaths
      .filter((schemaPath) => schemaPath.optional && !requestSeen.has(schemaPath.path))
      .map((schemaPath) => schemaPath.path)
      .filter(
        (path, _, all) => !all.some((other) => other !== path && path.startsWith(`${other}.`))
      )

    // Pagination: named request and response fields, plus what the samples showed.
    const requestNames = requestPaths.map((schemaPath) => schemaPath.path)
    const responseNames = responsePaths.map((schemaPath) => schemaPath.path)
    const byPattern = (names: ReadonlyArray<string>, pattern: RegExp) =>
      names.filter((name) => pattern.test(name))
    const pageFields = [
      ...byPattern(requestNames, pageRequest),
      ...byPattern(requestNames, pageSize)
    ]
    const offsetFields = byPattern(requestNames, offsetRequest)
    const cursorRequest = byPattern(requestNames, cursorField)
    const cursorResponse = byPattern(responseNames, cursorField)
    const responseMarkers = [
      ...byPattern(responseNames, lastPageField),
      ...byPattern(responseNames, totalField)
    ]
    const pagedItems = responsePaths.find(
      (schemaPath) => schemaPath.repeated && !schemaPath.path.includes("[].")
    )?.path
    const style =
      cursorRequest.length > 0 || cursorResponse.length > 0
        ? "cursor"
        : offsetFields.length > 0
          ? "offset"
          : pageFields.length > 0
            ? "page-number"
            : undefined
    const maxItems = pagedItems === undefined ? [] : (itemCounts.get(pagedItems) ?? [])
    const pagination =
      style === undefined
        ? undefined
        : new Pagination({
            style,
            requestFields:
              style === "cursor"
                ? cursorRequest
                : style === "offset"
                  ? [...offsetFields, ...byPattern(requestNames, pageSize)]
                  : pageFields,
            responseFields:
              style === "cursor" ? [...cursorResponse, ...responseMarkers] : responseMarkers,
            ...(pagedItems === undefined ? {} : { items: pagedItems }),
            observed:
              mine.length === 0
                ? "no samples yet"
                : `${lastPageTrue} responses marked last page, ${lastPageFalse} not; at most ${maxItems.length === 0 ? 0 : Math.max(...maxItems)} ${pagedItems ?? "items"} per response`
          })

    const observations: Array<string> = []
    const answered = mine.length - [...faults.values()].reduce((sum, fault) => sum + fault.count, 0)
    if (mine.length === 0)
      observations.push("No samples yet: the design has only the WSDL to go on.")
    for (const field of fields) {
      if (field.declared !== undefined) {
        const undeclared = field.values
          .map((entry) => entry.value)
          .filter((value) => !field.declared?.includes(value))
        if (undeclared.length > 0)
          observations.push(
            `${field.path}: values outside the declared enumeration: ${undeclared.join(", ")}.`
          )
      } else if (
        field.distinct > 0 &&
        field.distinct <= 6 &&
        field.occurrences >= 4 &&
        field.distinct * 2 <= field.occurrences &&
        field.maxLength <= 20 &&
        field.values.every((entry) => /^[A-Z0-9_]+$/.test(entry.value))
      ) {
        observations.push(
          `${field.path}: looks like an undeclared code list (${field.values.map((entry) => entry.value).join(", ")}).`
        )
      }
      if (!field.optional && field.empty === field.occurrences && field.occurrences > 0) {
        observations.push(`${field.path}: required by the schema but always empty in the samples.`)
      }
      if (
        field.optional &&
        field.presentIn === withResponse &&
        withResponse >= 3 &&
        !field.repeated
      ) {
        observations.push(
          `${field.path}: optional in the schema, present in every sample response.`
        )
      }
      if (field.nil > 0)
        observations.push(
          `${field.path}: sent as xsi:nil ${field.nil} times; decide between null and omission.`
        )
    }
    const koCodes = [...outcomes.keys()].filter((code) => !/^(OK|0+|00)/i.test(code))
    if (koCodes.length > 0) {
      observations.push(
        `Business errors arrive inside successful responses (${koCodes.join(", ")}): each needs an HTTP status and a problem type.`
      )
    }
    if (faults.size > 0) {
      observations.push(
        `SOAP faults seen (${[...faults.values()].map((fault) => fault.detailElement ?? fault.code).join(", ")}): map each to a problem type.`
      )
    }
    if (findings.size > 0)
      observations.push(
        `${findings.size} distinct schema findings: the WSDL does not fully describe what the service returns.`
      )
    if (answered > 0 && neverObserved.length > 0)
      observations.push(
        `${neverObserved.length} response fields never observed; confirm they are still produced before exposing them.`
      )

    const sortedLatencies = [...latencies].sort((left, right) => left - right)
    return new OperationAnalysis({
      version: 1,
      operation: operationName,
      exchanges: mine.length,
      fromCalls: mine.filter((exchange) => exchange.provenance === "call").length,
      fromSoapUi: mine.filter((exchange) => exchange.provenance === "soapui").length,
      httpStatuses: [...statuses]
        .sort((left, right) => left[0] - right[0])
        .map(([status, count]) => ({ status, count })),
      faults: [...faults.values()].map((fault) => new FaultStats(fault)),
      outcomes: [...outcomes]
        .sort((left, right) => right[1].count - left[1].count)
        .map(([code, entry]) => new OutcomeCode({ code, ...entry })),
      fields,
      neverObserved,
      requestFieldsUnused,
      findings: [...findings]
        .map(([key, count]) => {
          const [path = "", detail = ""] = key.split("\u0000")
          return new FindingStats({ path, detail, count })
        })
        .sort((left, right) => right.count - left.count),
      ...(pagination === undefined ? {} : { pagination }),
      ...(sortedLatencies.length === 0
        ? {}
        : {
            latencyMs: {
              min: sortedLatencies[0] ?? 0,
              median: median(sortedLatencies),
              max: sortedLatencies[sortedLatencies.length - 1] ?? 0
            }
          }),
      observations
    })
  })

// ---------------------------------------------------------------------------
// Rendering

const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\n/g, " ")

export const renderAnalysis = (analysis: OperationAnalysis, catalog: WsdlCatalog): string => {
  const operation = operationByName(catalog, analysis.operation)
  const lines: Array<string> = [
    `# Analysis: ${analysis.operation}`,
    "",
    `Generated by soap-design from ${analysis.exchanges} masked exchanges (${analysis.fromCalls} calls, ${analysis.fromSoapUi} SoapUI mocks). Regenerate rather than edit.`,
    ...(operation?.documentation === undefined ? [] : ["", `> ${operation.documentation}`]),
    "",
    "## Observations",
    "",
    ...(analysis.observations.length === 0
      ? ["Nothing unusual in the samples."]
      : analysis.observations.map((line) => `- ${line}`)),
    ""
  ]
  if (analysis.outcomes.length > 0) {
    lines.push(
      "## Business outcome codes",
      "",
      "| code | description | count | samples |",
      "| --- | --- | --- | --- |"
    )
    for (const outcome of analysis.outcomes) {
      lines.push(
        `| ${cell(outcome.code)} | ${cell(outcome.description ?? "")} | ${outcome.count} | ${outcome.samples.join(", ")} |`
      )
    }
    lines.push("")
  }
  if (analysis.faults.length > 0) {
    lines.push(
      "## SOAP faults",
      "",
      "| code | detail | reason | count | samples |",
      "| --- | --- | --- | --- | --- |"
    )
    for (const fault of analysis.faults) {
      lines.push(
        `| ${cell(fault.code)} | ${cell(fault.detailElement ?? "")} | ${cell(fault.reason)} | ${fault.count} | ${fault.samples.join(", ")} |`
      )
    }
    lines.push("")
  }
  if (analysis.pagination !== undefined) {
    const pagination = analysis.pagination
    lines.push(
      "## Pagination",
      "",
      `- style: ${pagination.style}`,
      `- request: ${pagination.requestFields.join(", ") || "(none)"}`,
      `- response: ${pagination.responseFields.join(", ") || "(none)"}`,
      ...(pagination.items === undefined ? [] : [`- items: ${pagination.items}`]),
      `- observed: ${pagination.observed}`,
      ""
    )
  }
  if (analysis.fields.length > 0) {
    lines.push(
      "## Response fields",
      "",
      "| path | schema | present | empty/nil | values (masked) |",
      "| --- | --- | --- | --- | --- |"
    )
    for (const field of analysis.fields) {
      const schema = `${field.optional ? "optional" : "required"}${field.repeated ? `, repeated (max ${field.maxItems ?? 0} seen)` : ""}`
      const values =
        field.distinct === 0
          ? ""
          : `${field.values.map((entry) => `${entry.value}${entry.count > 1 ? ` ×${entry.count}` : ""}`).join(", ")}${field.distinct > field.values.length ? ` … (${field.distinct} distinct)` : ""}`
      lines.push(
        `| ${cell(field.path)} | ${schema} | ${field.presentIn} | ${field.empty}/${field.nil} | ${cell(values)} |`
      )
    }
    lines.push("")
  }
  if (analysis.findings.length > 0) {
    lines.push("## Schema findings", "", "| path | finding | count |", "| --- | --- | --- |")
    for (const finding of analysis.findings)
      lines.push(`| ${cell(finding.path)} | ${cell(finding.detail)} | ${finding.count} |`)
    lines.push("")
  }
  if (analysis.neverObserved.length > 0) {
    lines.push(
      "## Never observed in responses",
      "",
      ...analysis.neverObserved.map((path) => `- ${path}`),
      ""
    )
  }
  if (analysis.requestFieldsUnused.length > 0) {
    lines.push(
      "## Optional request fields no sample used",
      "",
      ...analysis.requestFieldsUnused.map((path) => `- ${path}`),
      ""
    )
  }
  if (analysis.latencyMs !== undefined) {
    lines.push(
      "## Latency",
      "",
      `min ${analysis.latencyMs.min} ms, median ${analysis.latencyMs.median} ms, max ${analysis.latencyMs.max} ms over ${analysis.fromCalls} calls.`,
      ""
    )
  }
  return lines.join("\n")
}

export const encodeAnalysis = (analysis: OperationAnalysis): string =>
  `${JSON.stringify(Schema.encodeSync(OperationAnalysis)(analysis), null, 2)}\n`

export const analysisPaths = (service: string, operation: string) => ({
  markdown: `${serviceDirectory(service)}/analysis/${operation}.md`,
  json: `${serviceDirectory(service)}/analysis/${operation}.json`
})

/** Analyse every (or the named) operation from its recorded exchanges and write both files. */
export const writeAnalyses = (
  workspace: WorkspaceShape,
  catalog: WsdlCatalog,
  service: string,
  operations: ReadonlyArray<string> = catalog.operations.map((operation) => operation.name)
): Effect.Effect<ReadonlyArray<OperationAnalysis>, WorkspaceError | SampleError> =>
  Effect.gen(function* () {
    const exchanges = yield* readExchanges(workspace, service)
    return yield* Effect.forEach(operations, (operation) =>
      Effect.gen(function* () {
        const analysis = yield* analyseOperation(catalog, operation, exchanges)
        const paths = analysisPaths(service, operation)
        yield* workspace.write(paths.markdown, renderAnalysis(analysis, catalog))
        yield* workspace.write(paths.json, encodeAnalysis(analysis))
        return analysis
      })
    )
  })
