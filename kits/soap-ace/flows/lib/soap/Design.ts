import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { type OperationAnalysis, schemaPaths } from "./Analysis.ts"
import {
  ElementDecl,
  elementByName,
  localName,
  operationByName,
  type QName,
  type WsdlCatalog
} from "./Catalog.ts"
import { effectiveClass, type OperationsFile } from "./Classification.ts"
import { simpleView } from "./Instance.ts"

// The REST design: a typed overlay on the 1:1 mapping. Every endpoint names
// the SOAP operations it is built from; every model binds to an XSD type or
// element (`sourceType`) and every property names the path it comes from
// within it; every error names the outcome codes and faults it maps. The
// design lives in `design/api-design.md` as a ```json apidesign block
// under a `Status: proposed | approved` line; editing the block is the
// review, flipping the status is the approval, and the OpenAPI contract is
// projected from it, never written by hand. `checkDesign` is the
// deterministic reviewer: coverage, verbs against confirmed classes, style,
// source paths, enum maps against declared and observed values, and
// errors against observed outcomes.

export const JsonType = Schema.Literals([
  "string",
  "integer",
  "number",
  "boolean",
  "object",
  "array"
])

export class Property extends Schema.Class<Property>("Property")({
  name: Schema.String,
  type: JsonType,
  format: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  required: Schema.Boolean,
  nullable: Schema.optionalKey(Schema.Boolean),
  enum: Schema.optionalKey(Schema.Array(Schema.String)),
  /** SOAP value → REST value; must cover every declared and observed SOAP value. */
  enumMap: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Model name for `object`, or for the items of an `array`. */
  ref: Schema.optionalKey(Schema.String),
  /** Item type of an `array` of scalars. */
  items: Schema.optionalKey(JsonType),
  /** XSD path relative to the model's sourceType (`saldo.valore`, `conto[]`). */
  source: Schema.optionalKey(Schema.String),
  /** How a property without a single source is computed. */
  derivation: Schema.optionalKey(Schema.String)
}) {}

export class Model extends Schema.Class<Model>("Model")({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  /** XSD element or type (local name) the property sources are relative to. */
  sourceType: Schema.optionalKey(Schema.String),
  properties: Schema.Array(Property)
}) {}

export class Parameter extends Schema.Class<Parameter>("Parameter")({
  name: Schema.String,
  in: Schema.Literals(["path", "query", "header"]),
  required: Schema.Boolean,
  type: JsonType,
  format: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  enum: Schema.optionalKey(Schema.Array(Schema.String)),
  enumMap: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** XSD path in the request of the endpoint's first SOAP operation. */
  source: Schema.optionalKey(Schema.String),
  derivation: Schema.optionalKey(Schema.String)
}) {}

export class DesignResponse extends Schema.Class<DesignResponse>("DesignResponse")({
  status: Schema.Int,
  description: Schema.String,
  model: Schema.optionalKey(Schema.String),
  /** A collection: `{ items: [...], page: {...} }`. */
  list: Schema.optionalKey(Schema.Boolean),
  paged: Schema.optionalKey(Schema.Boolean),
  /** XSD path in the SOAP response the model instance(s) come from; `""` is the whole response. */
  source: Schema.optionalKey(Schema.String)
}) {}

export class ErrorMapping extends Schema.Class<ErrorMapping>("ErrorMapping")({
  status: Schema.Int,
  /** Stable problem code, e.g. `invalid-otp`. */
  code: Schema.String,
  title: Schema.String,
  /** Outcome codes (`KO17`), fault detail elements or codes (`ServizioFault`), or `transport`. */
  from: Schema.Array(Schema.String)
}) {}

export class Endpoint extends Schema.Class<Endpoint>("Endpoint")({
  method: Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: Schema.String,
  operationId: Schema.String,
  summary: Schema.String,
  description: Schema.optionalKey(Schema.String),
  /** SOAP operations this endpoint is built from, in call order. */
  sources: Schema.Array(Schema.String),
  parameters: Schema.Array(Parameter),
  requestBody: Schema.optionalKey(
    Schema.Struct({ model: Schema.String, required: Schema.Boolean })
  ),
  responses: Schema.Array(DesignResponse),
  errors: Schema.Array(ErrorMapping),
  /** Analysis findings this endpoint's shape answers, e.g. `analysis/cercaConti: SOSPESO`. */
  evidence: Schema.Array(Schema.String)
}) {}

export class Exclusion extends Schema.Class<Exclusion>("Exclusion")({
  operation: Schema.String,
  reason: Schema.String
}) {}

export class ApiDesign extends Schema.Class<ApiDesign>("ApiDesign")({
  version: Schema.Literal(1),
  title: Schema.String,
  basePath: Schema.String,
  endpoints: Schema.Array(Endpoint),
  models: Schema.Array(Model),
  excluded: Schema.Array(Exclusion),
  notes: Schema.optionalKey(Schema.Array(Schema.String))
}) {}

export class DesignFileError extends Schema.TaggedError<DesignFileError>()("DesignFileError", {
  detail: Schema.String
}) {
  get message(): string {
    return `api-design.md: ${this.detail}`
  }
}

// ---------------------------------------------------------------------------
// The design file

export interface DesignFile {
  readonly approved: boolean
  readonly design: ApiDesign
}

const blockPattern = /```json apidesign\s*\n([\s\S]*?)\n```/

export const parseDesignFile = (text: string): Effect.Effect<DesignFile, DesignFileError> =>
  Effect.gen(function* () {
    const status = /^Status:\s*(proposed|approved)\s*$/im.exec(text)?.[1]?.toLowerCase()
    if (status === undefined)
      return yield* new DesignFileError({ detail: "missing Status: proposed | approved" })
    const block = blockPattern.exec(text)?.[1]
    if (block === undefined)
      return yield* new DesignFileError({ detail: "missing the ```json apidesign block" })
    const design = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ApiDesign))(block).pipe(
      Effect.mapError(
        (error) =>
          new DesignFileError({ detail: `the apidesign block does not decode: ${error.message}` })
      )
    )
    return { approved: status === "approved", design }
  })

export interface DesignIssue {
  readonly severity: "error" | "warning"
  readonly where: string
  readonly detail: string
}

export const renderDesignFile = (
  design: ApiDesign,
  issues: ReadonlyArray<DesignIssue>,
  status: "proposed" | "approved" = "proposed"
): string => {
  const endpointLines = design.endpoints.map(
    (endpoint) =>
      `| ${endpoint.method} | ${design.basePath}${endpoint.path} | ${endpoint.sources.join(", ")} | ${endpoint.summary} |`
  )
  return [
    `# REST design: ${design.title}`,
    "",
    `Status: ${status}`,
    "",
    "Review the design below: edit the JSON block (it is the design of record), rerun",
    '`soap-design "check"` until it reports no errors, then set the status to `approved`.',
    '`soap-design "openapi"` projects the contract from an approved design only.',
    "",
    "## Endpoints",
    "",
    "| method | path | SOAP operations | summary |",
    "| --- | --- | --- | --- |",
    ...endpointLines,
    "",
    ...(design.excluded.length === 0
      ? []
      : [
          "## Excluded operations",
          "",
          ...design.excluded.map((exclusion) => `- ${exclusion.operation}: ${exclusion.reason}`),
          ""
        ]),
    ...(design.notes === undefined || design.notes.length === 0
      ? []
      : ["## Notes", "", ...design.notes.map((note) => `- ${note}`), ""]),
    "## Check",
    "",
    ...(issues.length === 0
      ? ["No issues."]
      : issues.map((issue) => `- **${issue.severity}** ${issue.where}: ${issue.detail}`)),
    "",
    "## Design of record",
    "",
    "```json apidesign",
    JSON.stringify(Schema.encodeSync(ApiDesign)(design), null, 2),
    "```",
    ""
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Checking

/** Resolve a model's sourceType: an element (its type) or a type, by local name. */
export const resolveSourceType = (catalog: WsdlCatalog, name: string): ElementDecl | undefined => {
  const element = catalog.elements.find((candidate) => localName(candidate.name) === name)
  if (element !== undefined) return element
  const type = catalog.types.find(
    (candidate) => localName(candidate.name) === name && !candidate.anonymous
  )
  // A type is wrapped as a pseudo-element so the path walk can start from it.
  return type === undefined
    ? undefined
    : new ElementDecl({ name: type.name, type: type.name, nillable: false })
}

const camel = /^[a-z][a-zA-Z0-9]*$/
const segment = /^([a-z0-9]+(-[a-z0-9]+)*|\{[a-z][a-zA-Z0-9]*\})$/

const pathInfo = (catalog: WsdlCatalog, element: ElementDecl) => {
  const paths = schemaPaths(catalog, element)
  return new Map(paths.map((path) => [path.path, path]))
}

const leafType = (catalog: WsdlCatalog, element: ElementDecl, path: string): QName | undefined =>
  schemaPaths(catalog, element).find((candidate) => candidate.path === path)?.type

export interface CheckContext {
  readonly catalog: WsdlCatalog
  readonly operations: OperationsFile | undefined
  readonly analyses: ReadonlyArray<OperationAnalysis>
}

export const checkDesign = (
  design: ApiDesign,
  context: CheckContext
): ReadonlyArray<DesignIssue> => {
  const { catalog } = context
  const issues: Array<DesignIssue> = []
  const error = (where: string, detail: string) => issues.push({ severity: "error", where, detail })
  const warn = (where: string, detail: string) =>
    issues.push({ severity: "warning", where, detail })
  const models = new Map(design.models.map((model) => [model.name, model]))

  if (!/^\/v\d+$/.test(design.basePath))
    error("basePath", `expected /v<major>, found ${design.basePath}`)

  // Coverage: every SOAP operation exposed, merged, or excluded with a reason.
  const covered = new Set(design.endpoints.flatMap((endpoint) => endpoint.sources))
  for (const exclusion of design.excluded) {
    if (operationByName(catalog, exclusion.operation) === undefined)
      error(`excluded ${exclusion.operation}`, "not an operation of the service")
    if (exclusion.reason.trim() === "") error(`excluded ${exclusion.operation}`, "needs a reason")
    covered.add(exclusion.operation)
  }
  for (const operation of catalog.operations) {
    if (!covered.has(operation.name))
      error(operation.name, "not exposed by any endpoint and not excluded")
  }

  // Enum values the SOAP side can produce: declared, plus observed in samples.
  const observed = (operation: string, path: string): ReadonlyArray<string> =>
    context.analyses
      .filter((analysis) => analysis.operation === operation)
      .flatMap((analysis) =>
        analysis.fields
          .filter((field) => field.path === path)
          .flatMap((field) => field.values.map((entry) => entry.value))
      )

  const checkEnumMap = (
    where: string,
    enumValues: ReadonlyArray<string> | undefined,
    enumMap: Readonly<Record<string, string>> | undefined,
    type: QName | undefined,
    seen: ReadonlyArray<string>
  ) => {
    if (enumMap === undefined) return
    const soapValues = [
      ...new Set([
        ...(type === undefined
          ? []
          : (simpleView(catalog, type).facets.find((facets) => facets.enumeration !== undefined)
              ?.enumeration ?? [])),
        ...seen
      ])
    ]
    for (const value of soapValues) {
      if (!(value in enumMap))
        error(
          where,
          `enumMap has no entry for SOAP value ${value}${seen.includes(value) ? " (seen in samples)" : ""}`
        )
    }
    if (enumValues !== undefined) {
      for (const target of Object.values(enumMap)) {
        if (!enumValues.includes(target)) error(where, `enumMap target ${target} is not in enum`)
      }
    }
  }

  // Models: names, property style, sources within the bound XSD type.
  const modelUse = new Map<string, Set<string>>() // model → SOAP operations whose responses it renders
  for (const model of design.models) {
    const where = `model ${model.name}`
    if (!/^[A-Z][A-Za-z0-9]*$/.test(model.name)) error(where, "model names are PascalCase")
    const bound =
      model.sourceType === undefined ? undefined : resolveSourceType(catalog, model.sourceType)
    if (model.sourceType !== undefined && bound === undefined)
      error(where, `sourceType ${model.sourceType} is not an element or named type`)
    const paths = bound === undefined ? undefined : pathInfo(catalog, bound)
    for (const property of model.properties) {
      const at = `${where}.${property.name}`
      if (!camel.test(property.name)) error(at, "property names are camelCase")
      if (/^(esito|codiceEsito|returnCode)$/i.test(property.name))
        error(at, "the esito envelope does not belong in REST payloads; success is the HTTP status")
      if (
        (property.type === "object" ||
          (property.type === "array" && property.items === undefined)) &&
        (property.ref === undefined || !models.has(property.ref))
      ) {
        error(at, `${property.type} needs ref to a defined model`)
      }
      if (property.source === undefined && property.derivation === undefined)
        warn(at, "no source and no derivation: where does the value come from?")
      if (property.source !== undefined && paths !== undefined) {
        const found = paths.get(property.source)
        if (found === undefined)
          error(at, `source ${property.source} is not a path of ${model.sourceType ?? ""}`)
        else {
          if (property.required && found.optional) {
            warn(
              at,
              `required in REST but optional in the XSD (${property.source}); the analysis must show it is always present, or make it optional`
            )
          }
          const seen = design.endpoints
            .flatMap((endpoint) => endpoint.sources)
            .flatMap((operation) => {
              const responsePath = responsePathFor(design, model.name, operation)
              return responsePath === undefined
                ? []
                : observed(
                    operation,
                    `${responsePath}${responsePath === "" ? "" : "."}${property.source}`.replace(
                      /^\./,
                      ""
                    )
                  )
            })
          checkEnumMap(
            at,
            property.enum,
            property.enumMap,
            bound === undefined ? undefined : leafType(catalog, bound, property.source),
            seen
          )
        }
      } else if (property.source !== undefined && model.sourceType === undefined) {
        error(at, "a source needs the model's sourceType")
      }
      if (
        property.type === "string" &&
        property.format === "decimal" &&
        /amount|importo|saldo|balance/i.test(property.name) &&
        property.ref === undefined
      ) {
        // Amounts travel as { amount, currency } objects (style guide); a bare decimal is fine inside Amount itself.
        if (model.properties.every((other) => !/currency|divisa/i.test(other.name)))
          warn(at, "amounts are { amount, currency } objects in this style guide")
      }
    }
    modelUse.set(model.name, new Set())
  }

  // Endpoints.
  const operationIds = new Set<string>()
  const routes = new Set<string>()
  for (const endpoint of design.endpoints) {
    const where = `${endpoint.method} ${endpoint.path}`
    if (operationIds.has(endpoint.operationId))
      error(where, `duplicate operationId ${endpoint.operationId}`)
    operationIds.add(endpoint.operationId)
    if (!camel.test(endpoint.operationId)) error(where, "operationId is camelCase")
    if (routes.has(where)) error(where, "duplicate route")
    routes.add(where)
    const segments = endpoint.path.split("/").slice(1)
    if (!endpoint.path.startsWith("/") || segments.some((part) => !segment.test(part))) {
      error(where, "path segments are kebab-case nouns or {camelCaseParam}")
    }
    const pathParams = segments
      .filter((part) => part.startsWith("{"))
      .map((part) => part.slice(1, -1))
    for (const name of pathParams) {
      if (
        !endpoint.parameters.some((parameter) => parameter.in === "path" && parameter.name === name)
      )
        error(where, `path parameter {${name}} is not declared`)
    }
    for (const parameter of endpoint.parameters.filter((parameter) => parameter.in === "path")) {
      if (!pathParams.includes(parameter.name))
        error(where, `parameter ${parameter.name} is in: path but not in the path`)
      if (!parameter.required) error(where, `path parameter ${parameter.name} must be required`)
    }

    if (endpoint.sources.length === 0) error(where, "names no SOAP operation")
    const soap = endpoint.sources.map((name) => operationByName(catalog, name))
    endpoint.sources.forEach((name, index) => {
      if (soap[index] === undefined)
        error(where, `source ${name} is not an operation of the service`)
    })
    const classes = endpoint.sources.map((name) => effectiveClass(context.operations, name))
    if (classes.includes("unclassified"))
      warn(
        where,
        "a source operation is unclassified; confirm operations.md so verbs can be checked"
      )
    if (endpoint.method === "GET" && classes.includes("mutating"))
      error(where, "GET must not call a mutating operation")
    if (
      endpoint.method !== "GET" &&
      classes.length > 0 &&
      classes.every((value) => value === "read")
    ) {
      warn(
        where,
        `${endpoint.method} over read-only operations; use GET unless the query cannot be expressed in the URL`
      )
    }
    if (endpoint.method === "GET" && endpoint.requestBody !== undefined)
      error(where, "GET has no request body")

    const first = soap[0]
    const input = first === undefined ? undefined : elementByName(catalog, first.input)
    const requestPaths = input === undefined ? undefined : pathInfo(catalog, input)
    for (const parameter of endpoint.parameters) {
      const at = `${where} ${parameter.in} ${parameter.name}`
      if (parameter.in !== "header" && !camel.test(parameter.name))
        error(at, "parameter names are camelCase")
      if (parameter.source !== undefined && requestPaths !== undefined) {
        const found = requestPaths.get(parameter.source)
        if (found === undefined)
          error(at, `source ${parameter.source} is not in the ${first?.name ?? ""} request`)
        else {
          if (!found.optional && !parameter.required && parameter.derivation === undefined)
            warn(at, `optional here but required by ${first?.name ?? ""}`)
          checkEnumMap(
            at,
            parameter.enum,
            parameter.enumMap,
            input === undefined ? undefined : leafType(catalog, input, parameter.source),
            []
          )
        }
      } else if (parameter.source === undefined && parameter.derivation === undefined) {
        warn(at, "no source and no derivation")
      }
    }
    if (endpoint.requestBody !== undefined && !models.has(endpoint.requestBody.model))
      error(where, `request body model ${endpoint.requestBody.model} is not defined`)

    const successes = endpoint.responses.filter(
      (response) => response.status >= 200 && response.status < 300
    )
    if (successes.length === 0) error(where, "declares no 2xx response")
    if (
      endpoint.method === "POST" &&
      successes.every((response) => response.status === 200) &&
      classes.includes("mutating") &&
      /^\/[a-z-]+$/.test(endpoint.path)
    ) {
      warn(where, "creating POSTs answer 201 with a Location header")
    }
    const output = first?.output === undefined ? undefined : elementByName(catalog, first.output)
    const responsePaths = output === undefined ? undefined : pathInfo(catalog, output)
    for (const response of endpoint.responses) {
      const at = `${where} ${response.status}`
      if (response.model === undefined) continue
      const model = models.get(response.model)
      if (model === undefined) {
        error(at, `model ${response.model} is not defined`)
        continue
      }
      for (const name of endpoint.sources) modelUse.get(model.name)?.add(name)
      if (response.source !== undefined && responsePaths !== undefined && output !== undefined) {
        if (response.source !== "" && !responsePaths.has(response.source)) {
          error(at, `source ${response.source} is not in the ${first?.name ?? ""} response`)
        } else if (model.sourceType !== undefined) {
          const bound = resolveSourceType(catalog, model.sourceType)
          const sourceTypeName =
            response.source === "" ? output.type : responsePaths.get(response.source)?.type
          if (
            bound !== undefined &&
            sourceTypeName !== undefined &&
            bound.type !== sourceTypeName
          ) {
            error(
              at,
              `model ${model.name} is bound to ${model.sourceType}, but ${response.source === "" ? "the response" : response.source} is ${localName(sourceTypeName).replace(/^~/, "")}`
            )
          }
        }
        if (
          response.list === true &&
          response.source !== undefined &&
          response.source !== "" &&
          responsePaths.get(response.source)?.repeated !== true
        ) {
          error(at, `list response from ${response.source}, which does not repeat`)
        }
      }
    }

    // Errors: every business outcome and fault the samples showed is mapped.
    const mapped = new Set(endpoint.errors.flatMap((mapping) => mapping.from))
    for (const mapping of endpoint.errors) {
      if (mapping.status < 400)
        error(`${where} error ${mapping.code}`, "error statuses are 4xx or 5xx")
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(mapping.code))
        error(`${where} error ${mapping.code}`, "problem codes are kebab-case")
    }
    for (const analysis of context.analyses.filter((candidate) =>
      endpoint.sources.includes(candidate.operation)
    )) {
      for (const outcome of analysis.outcomes) {
        if (/^(OK|0+$)/i.test(outcome.code)) continue
        if (!mapped.has(outcome.code))
          warn(
            where,
            `outcome ${outcome.code}${outcome.description === undefined ? "" : ` (${outcome.description})`} seen in ${analysis.operation} is not mapped to an error`
          )
      }
      for (const fault of analysis.faults) {
        const keys = [fault.detailElement, fault.code].filter(
          (key): key is string => key !== undefined
        )
        if (!keys.some((key) => mapped.has(key)))
          warn(
            where,
            `fault ${keys.join("/")} seen in ${analysis.operation} is not mapped to an error`
          )
      }
    }
  }

  for (const [name, users] of modelUse) {
    const used =
      users.size > 0 ||
      design.endpoints.some((endpoint) => endpoint.requestBody?.model === name) ||
      design.models.some((model) => model.properties.some((property) => property.ref === name))
    if (!used) warn(`model ${name}`, "not used by any endpoint")
  }
  return issues
}

/** The response path a model is rendered from for one SOAP operation, if an endpoint says so. */
const responsePathFor = (
  design: ApiDesign,
  modelName: string,
  operation: string
): string | undefined => {
  for (const endpoint of design.endpoints) {
    if (!endpoint.sources.includes(operation)) continue
    for (const response of endpoint.responses) {
      if (response.model === modelName && response.source !== undefined) return response.source
    }
  }
  // Nested models: the parent's property source joined to the parent's path.
  for (const parent of design.models) {
    for (const property of parent.properties) {
      if (property.ref !== modelName || property.source === undefined) continue
      const parentPath = responsePathFor(design, parent.name, operation)
      if (parentPath !== undefined)
        return parentPath === "" ? property.source : `${parentPath}.${property.source}`
    }
  }
  return undefined
}

export const blockingIssues = (issues: ReadonlyArray<DesignIssue>): ReadonlyArray<DesignIssue> =>
  issues.filter((issue) => issue.severity === "error")

export const designPaths = (directory: string) => ({
  design: `${directory}/design/api-design.md`,
  mapping: `${directory}/design/mapping.json`,
  mappingSummary: `${directory}/design/mapping.md`,
  openapi: `${directory}/design/openapi.yaml`
})
