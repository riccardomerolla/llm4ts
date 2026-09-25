import type * as Schema from "effect/Schema"
import {
  type ApiDesign,
  type DesignResponse,
  type Endpoint,
  ErrorMapping,
  type Model,
  type Parameter,
  type Property
} from "./Design.ts"

// The OpenAPI 3.1 contract, projected deterministically from an approved
// design: models become component schemas, collections become `{ items,
// page }` wrappers, every error is an RFC 9457 problem with its stable code,
// and every operation, schema, and property carries `x-soap-*` extensions
// naming where it comes from. Neither a person nor the coder edits it.

type Json = Schema.Json
type JsonObject = { [key: string]: Json }

const ref = (name: string): JsonObject => ({ $ref: `#/components/schemas/${name}` })

const withDefined = (entries: ReadonlyArray<readonly [string, Json | undefined]>): JsonObject =>
  Object.fromEntries(
    entries.filter((entry): entry is readonly [string, Json] => entry[1] !== undefined)
  )

export type Dialect = "3.1" | "3.0"

/**
 * One property. OpenAPI 3.1 is JSON Schema: `type: [t, "null"]`, and keys
 * beside `$ref` are honoured. OpenAPI 3.0 (what IBM ACE 12 imports) needs
 * `nullable: true`, and a `$ref` with siblings wrapped in `allOf`.
 */
const propertySchema = (property: Property, dialect: Dialect): JsonObject => {
  const common = withDefined([
    ["description", property.description],
    ["x-soap-source", property.source],
    ["x-derivation", property.derivation],
    ["x-soap-enum-map", property.enumMap === undefined ? undefined : { ...property.enumMap }]
  ])
  const nullable = property.nullable === true
  if (property.type === "object" && property.ref !== undefined) {
    if (dialect === "3.0") {
      return Object.keys(common).length === 0 && !nullable
        ? ref(property.ref)
        : { allOf: [ref(property.ref)], ...(nullable ? { nullable: true } : {}), ...common }
    }
    return nullable
      ? { oneOf: [ref(property.ref), { type: "null" }], ...common }
      : { ...ref(property.ref), ...common }
  }
  const typeOf = (type: string): JsonObject =>
    dialect === "3.0"
      ? { type, ...(nullable ? { nullable: true } : {}) }
      : { type: nullable ? [type, "null"] : type }
  if (property.type === "array") {
    return {
      ...typeOf("array"),
      items: property.ref !== undefined ? ref(property.ref) : { type: property.items ?? "string" },
      ...common
    }
  }
  return {
    ...typeOf(property.type),
    ...withDefined([
      ["format", property.format],
      ["enum", property.enum === undefined ? undefined : [...property.enum]]
    ]),
    ...common
  }
}

const modelSchema = (model: Model, dialect: Dialect): JsonObject => ({
  type: "object",
  ...withDefined([["description", model.description]]),
  ...(model.properties.some((property) => property.required)
    ? {
        required: model.properties
          .filter((property) => property.required)
          .map((property) => property.name)
      }
    : {}),
  properties: Object.fromEntries(
    model.properties.map((property) => [property.name, propertySchema(property, dialect)])
  ),
  additionalProperties: false,
  ...withDefined([["x-soap-source-type", model.sourceType]])
})

const problemSchema: JsonObject = {
  type: "object",
  description: "RFC 9457 problem details; `code` is the stable, machine-readable error code.",
  required: ["type", "title", "status", "code"],
  properties: {
    type: { type: "string", format: "uri-reference" },
    title: { type: "string" },
    status: { type: "integer", format: "int32" },
    detail: { type: "string" },
    instance: { type: "string", format: "uri-reference" },
    code: { type: "string" }
  }
}

const pageSchema: JsonObject = {
  type: "object",
  required: ["page", "size"],
  properties: {
    page: { type: "integer", format: "int32", minimum: 1 },
    size: { type: "integer", format: "int32", minimum: 1 },
    totalItems: { type: "integer", format: "int64" },
    hasNext: { type: "boolean" }
  }
}

const listName = (response: DesignResponse): string =>
  `${response.model ?? "Item"}${response.paged === true ? "Page" : "List"}`

const parameterObject = (parameter: Parameter): JsonObject => ({
  name: parameter.name,
  in: parameter.in,
  required: parameter.required,
  ...withDefined([["description", parameter.description]]),
  schema: {
    type: parameter.type,
    ...withDefined([
      ["format", parameter.format],
      ["enum", parameter.enum === undefined ? undefined : [...parameter.enum]]
    ])
  },
  ...withDefined([
    ["x-soap-source", parameter.source],
    ["x-derivation", parameter.derivation],
    ["x-soap-enum-map", parameter.enumMap === undefined ? undefined : { ...parameter.enumMap }]
  ])
})

const successObject = (response: DesignResponse, created: boolean): JsonObject => {
  const schema =
    response.model === undefined
      ? undefined
      : response.list === true
        ? ref(listName(response))
        : ref(response.model)
  return {
    description: response.description,
    ...(created && response.status === 201
      ? {
          headers: {
            Location: {
              description: "URL of the created resource",
              schema: { type: "string", format: "uri-reference" }
            }
          }
        }
      : {}),
    ...(schema === undefined ? {} : { content: { "application/json": { schema } } }),
    ...withDefined([["x-soap-source", response.source]])
  }
}

const errorResponses = (errors: ReadonlyArray<ErrorMapping>): JsonObject => {
  const byStatus = new Map<number, Array<ErrorMapping>>()
  for (const mapping of errors)
    byStatus.set(mapping.status, [...(byStatus.get(mapping.status) ?? []), mapping])
  if (!byStatus.has(502)) {
    byStatus.set(502, [
      new ErrorMapping({
        status: 502,
        code: "backend-error",
        title: "The backend service returned an unmapped error",
        from: ["transport"]
      })
    ])
  }
  return Object.fromEntries(
    [...byStatus]
      .sort((left, right) => left[0] - right[0])
      .map(([status, mappings]) => [
        String(status),
        {
          description: mappings.map((mapping) => mapping.title).join("; "),
          content: { "application/problem+json": { schema: ref("Problem") } },
          "x-problem-codes": mappings.map((mapping) => ({
            code: mapping.code,
            title: mapping.title,
            from: [...mapping.from]
          }))
        }
      ])
  )
}

const operationObject = (endpoint: Endpoint): JsonObject => {
  const created = endpoint.method === "POST"
  const tag = endpoint.path.split("/")[1] ?? "default"
  return {
    operationId: endpoint.operationId,
    summary: endpoint.summary,
    ...withDefined([["description", endpoint.description]]),
    tags: [tag],
    ...(endpoint.parameters.length === 0
      ? {}
      : { parameters: endpoint.parameters.map(parameterObject) }),
    ...(endpoint.requestBody === undefined
      ? {}
      : {
          requestBody: {
            required: endpoint.requestBody.required,
            content: { "application/json": { schema: ref(endpoint.requestBody.model) } }
          }
        }),
    responses: {
      ...Object.fromEntries(
        endpoint.responses.map((response) => [
          String(response.status),
          successObject(response, created)
        ])
      ),
      ...errorResponses(endpoint.errors)
    },
    "x-soap-operations": [...endpoint.sources],
    ...(endpoint.evidence.length === 0 ? {} : { "x-evidence": [...endpoint.evidence] })
  }
}

export const projectOpenApi = (
  design: ApiDesign,
  options: { readonly version?: string; readonly dialect?: Dialect } = {}
): JsonObject => {
  const dialect = options.dialect ?? "3.1"
  const paths: Record<string, JsonObject> = {}
  for (const endpoint of design.endpoints) {
    paths[endpoint.path] = {
      ...(paths[endpoint.path] ?? {}),
      [endpoint.method.toLowerCase()]: operationObject(endpoint)
    }
  }
  const schemas: Record<string, Json> = {}
  for (const model of design.models) schemas[model.name] = modelSchema(model, dialect)
  for (const endpoint of design.endpoints) {
    for (const response of endpoint.responses) {
      if (response.list !== true || response.model === undefined) continue
      schemas[listName(response)] = {
        type: "object",
        required: response.paged === true ? ["items", "page"] : ["items"],
        properties: {
          items: { type: "array", items: ref(response.model) },
          ...(response.paged === true ? { page: ref("PageInfo") } : {})
        }
      }
      if (response.paged === true) schemas["PageInfo"] = pageSchema
    }
  }
  schemas["Problem"] = problemSchema
  return {
    openapi: dialect === "3.0" ? "3.0.3" : "3.1.0",
    info: {
      title: design.title,
      version: options.version ?? "1.0.0",
      description:
        "Projected by soap-design from the approved REST design; do not edit. x-soap-* extensions trace every element to the SOAP service."
    },
    servers: [{ url: design.basePath }],
    paths,
    components: { schemas }
  }
}

// ---------------------------------------------------------------------------
// Typed YAML

// A string that a YAML 1.1 or 1.2 reader would turn into something else
// (a number, boolean, null, date) or that is not plain-safe is quoted.
const ambiguous =
  /^(true|false|yes|no|on|off|y|n|null|~|)$|^[-+]?(\.\d+|\d+(\.\d*)?)([eE][-+]?\d+)?$|^0[xob]|^\d{4}-\d{2}-\d{2}|^[-?:,[\]{}#&*!|>'"%@`\s]|\s$|: |\s#|[\n\r\t]/i

const scalar = (value: Json): string =>
  typeof value === "string"
    ? ambiguous.test(value)
      ? JSON.stringify(value)
      : value
    : value === null
      ? "null"
      : String(value)

const key = (name: string): string =>
  /^[A-Za-z_$/][A-Za-z0-9_.$/{}-]*$/.test(name) && !ambiguous.test(name)
    ? name
    : JSON.stringify(name)

const isObject = (value: Json): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** YAML for JSON data, with types preserved for any conforming reader. */
export const renderTypedYaml = (value: Json, indent = 0): string => {
  const pad = " ".repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`
    return value
      .map((item) => {
        if (!isObject(item) && !Array.isArray(item)) return `${pad}- ${scalar(item)}\n`
        if (
          (Array.isArray(item) && item.length === 0) ||
          (isObject(item) && Object.keys(item).length === 0)
        ) {
          return `${pad}- ${Array.isArray(item) ? "[]" : "{}"}\n`
        }
        return `${pad}- ${renderTypedYaml(item, indent + 2).slice(indent + 2)}`
      })
      .join("")
  }
  if (isObject(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) return `${pad}{}\n`
    return entries
      .map(([name, item]) => {
        if (!isObject(item) && !Array.isArray(item)) return `${pad}${key(name)}: ${scalar(item)}\n`
        if (
          (Array.isArray(item) && item.length === 0) ||
          (isObject(item) && Object.keys(item).length === 0)
        ) {
          return `${pad}${key(name)}: ${Array.isArray(item) ? "[]" : "{}"}\n`
        }
        return `${pad}${key(name)}:\n${renderTypedYaml(item, indent + 2)}`
      })
      .join("")
  }
  return `${pad}${scalar(value)}\n`
}
